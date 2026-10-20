let db = null; // SQLite database instance

// Common helper to get today's date string (YYYY-MM-DD)
function getTodayString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Settlement tags: exact tags only (#支払 ≠ #支払い). Fullwidth ＃ is accepted.
// TAG_SEPARATORS is shared by the JS regexes and the SQL GLOB so both judge the same rows.
const TAG_SEPARATORS = ' \t\n\r　,、。.・()（）「」#＃';
const TAG_BOUNDARY = `(?=$|[${TAG_SEPARATORS}])`;
const SETTLEMENT_TAG_RE = new RegExp(`[#＃](入金|支払|決済)${TAG_BOUNDARY}`);
const SETTLEMENT_TAG_RE_G = new RegExp(`[#＃](入金|支払|決済)${TAG_BOUNDARY}`, 'g');
const SETTLEMENT_TAG_EXACT_RE = /^#(入金|支払|決済)$/;
const MINUS_LIKE_RE = /[ー−△▲－‐‑–—\uFF0D]/g;
const DRAFT_DEBOUNCE_MS = 10000;
const DRAFT_MAX_INTERVAL_MS = 30000;

function isSettlementMemo(memo) {
  return SETTLEMENT_TAG_RE.test(memo || '');
}

function hasExactTag(memo, name) {
  return new RegExp(`[#＃]${name}${TAG_BOUNDARY}`).test(memo || '');
}

function stripSettlementTags(memo) {
  return (memo || '')
    .replace(SETTLEMENT_TAG_RE_G, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// SQLite GLOB: settlement tag at end, or followed by a separator (not a longer word)
function settlementExclusionSql(columnExpr) {
  const m = `REPLACE(${columnExpr}, '＃', '#')`;
  const seps = TAG_SEPARATORS;
  const tags = ['入金', '支払', '決済'];
  const parts = [];
  for (const tag of tags) {
    parts.push(`${m} GLOB '*#${tag}'`);
    parts.push(`${m} GLOB '*#${tag}[${seps}]*'`);
  }
  return `NOT (${parts.join(' OR ')})`;
}

function hasRecordsTable(database) {
  try {
    const check = database.exec(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'records'",
    );
    return check.length > 0;
  } catch (e) {
    return false;
  }
}

function roundAwayFromZero(value) {
  if (!isFinite(value) || isNaN(value)) return null;
  const rounded = Math.sign(value) * Math.round(Math.abs(value));
  return Object.is(rounded, -0) || rounded === 0 ? 0 : rounded;
}

function normalizeGroupedNumber(match) {
  const lastComma = match.lastIndexOf(',');
  const lastDot = match.lastIndexOf('.');
  if (lastComma > lastDot && lastDot !== -1) return match.replace(/\./g, '').replace(/,/g, '.');
  if (lastDot > lastComma && lastComma !== -1) return match.replace(/,/g, '');
  if (lastComma !== -1) {
    if (/,\d{3}$/.test(match)) return match.replace(/,/g, '');
    return match.replace(/,/g, '.');
  }
  if ((match.match(/\./g) || []).length > 1) return null;
  return match;
}

function normalizeAmountText(raw) {
  let normalized = String(raw).trim();
  // Map minus-like glyphs before fullwidth digit conversion (U+FF0D must not go through -0xFEE0)
  normalized = normalized.replace(MINUS_LIKE_RE, '-');
  normalized = normalized.replace(/[０-９＋＊／．（）]/g, (s) =>
    String.fromCharCode(s.charCodeAt(0) - 0xfee0),
  );
  normalized = normalized.replace(/×/g, '*').replace(/÷/g, '/');

  let invalidGroup = false;
  normalized = normalized.replace(/(?:\d+[.,])+\d+/g, (match) => {
    const fixed = normalizeGroupedNumber(match);
    if (fixed === null) {
      invalidGroup = true;
      return match;
    }
    return fixed;
  });
  if (invalidGroup) return null;

  // Strip currency / whitespace before sign detection so "(¥1,500)" stays negative
  normalized = normalized.replace(/[¥￥$円\s]/g, '');
  if (/^\([\d,.]+\)$/.test(normalized)) {
    normalized = '-' + normalized.replace(/[()]/g, '');
  }
  if (normalized.endsWith('-') && !normalized.startsWith('-')) {
    normalized = '-' + normalized.slice(0, -1);
  }
  return normalized;
}

function clearMigratedLocalStorageIfPresent() {
  const keysToMigrate = ['customAccountDict', 'fiscalMonth', 'accountDict'];
  for (const key of keysToMigrate) {
    if (localStorage.getItem(key) === null) continue;
    if (getDbSetting(key) !== null) {
      localStorage.removeItem(key);
    }
  }
}

let SQL = null; // sql.js module
let fileHandle = null; // File System Access API file handle
let isDirty = false; // Unsaved changes flag
let dirtyEpoch = 0; // Counts edits so a save can tell whether new ones arrived while it ran
let pendingCSVData = []; // Temporary storage for CSV parsing
let lastUsedDates = {}; // Remember last used date per block
let lastUsedAccounts = {}; // Remember last used account per block
let pendingCSVBuffer = null; // CSV binary data
let currentDisplayedTotal = 0; // For count up animation
let collapsedBlocks = new Set(); // Set of collapsed block IDs
let totalAnimationId = null; // Prevent duplicate animations
let draftTimer = null; // Debounced draft save timer
let draftMaxTimer = null; // Max-interval draft save timer
let draftGeneration = 0; // Draft generation (prevent stale overwrite)
let draftSaveInFlight = null; // Promise for the current draft save
let statusTimeoutId = null; // Status bar notification timer
let isSaving = false; // Prevent concurrent saves flag
let lastSavedPasswordHash = ''; // Track password changes via hash

const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);

let customAccountDict = []; // カスタム科目辞書の配列

// 🌟 パフォーマンス最適化: 数値フォーマッターをグローバルに1回だけインスタンス化して使い回す
const jpyFormatter = new Intl.NumberFormat('ja-JP');

// --- 設定保存用ユーティリティ (SQLiteベース) ---
function getDbSetting(key, defaultValue = null) {
  if (!db) return defaultValue;
  let stmt;
  try {
    stmt = db.prepare('SELECT value FROM settings WHERE key = ?');
    stmt.bind([key]);
    if (stmt.step()) {
      return stmt.get()[0];
    }
  } catch (e) {
    console.error('Setting read error:', e);
  } finally {
    if (stmt) stmt.free();
  }
  return defaultValue;
}

function setDbSetting(key, value) {
  if (!db) return;
  try {
    db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value]);
    setDirty(true);
  } catch (e) {
    console.error('Setting write error:', e);
  }
}

// --- セキュアな状態管理用ユーティリティ ---
async function getPasswordHash(password) {
  if (!password) return '';
  const msgUint8 = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// --- 自動バックアップ (IndexedDB) ロジック ---
const DB_NAME = 'GrindMoneyDB';
const STORE_NAME = 'drafts';

function openDB() {
  return new Promise((resolve, reject) => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = (e) => {
        const idb = e.target.result;
        if (!idb.objectStoreNames.contains(STORE_NAME)) {
          idb.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    } catch (e) {
      console.warn('IndexedDB is blocked. Draft autosave is disabled.');
      reject(e);
    }
  });
}

// Multi-tab guard: only the primary tab may read, write or delete the shared draft
let isSecondaryTab = false;

async function markSecondaryTab() {
  if (isSecondaryTab) return;
  isSecondaryTab = true;
  await appAlert(
    '⚠️ GrindMoneyは既に別のタブまたはウィンドウで開かれています。\n\nデータ競合（バックアップの巻き戻り）を防ぐため、このタブでは編集できません。\n元のタブを閉じてから再読み込みしてください。',
  );
  document.body.style.opacity = '0.5';
  document.body.style.pointerEvents = 'none';
  // inert also blocks keyboard focus and shortcuts reaching the app
  document.body.inert = true;
}

// Web Locks gives an atomic "first tab wins"; the lock is held until the tab closes.
// Returns null when the API is unavailable (BroadcastChannel fallback decides instead).
function acquirePrimaryTabLock() {
  if (!navigator.locks || typeof navigator.locks.request !== 'function') {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    navigator.locks
      .request('grindmoney_primary_tab', { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false);
          return undefined;
        }
        resolve(true);
        return new Promise(() => {});
      })
      .catch(() => resolve(null));
  });
}

// Resolve true when the draft is stored; the tab that does not own the data stores nothing
async function saveDraft(uints) {
  if (isSecondaryTab) return true;
  try {
    const idb = await openDB();
    const tx = idb.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(uints, 'latest_draft');
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return true;
  } catch (e) {
    console.error('Draft save failed', e);
    return false;
  }
}

async function loadDraft() {
  if (isSecondaryTab) return null;
  try {
    const idb = await openDB();
    const tx = idb.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).get('latest_draft');
    return new Promise((resolve) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });
  } catch (e) {
    return null;
  }
}

async function clearDraft() {
  if (isSecondaryTab) return;
  try {
    const idb = await openDB();
    const tx = idb.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete('latest_draft');
  } catch (e) {
    console.error('Draft clear failed', e);
  }
}

async function persistDraftSnapshot() {
  if (!isDirty || !db) return true;
  const generation = ++draftGeneration;
  try {
    if (lastSavedPasswordHash !== '' && currentMasterKey === null) {
      console.warn('Draft save aborted: Password removed from an encrypted session.');
      return false;
    }
    let data = db.export();
    if (currentMasterKey) {
      data = await encryptData(data, currentMasterKey);
    }
    if (!isDirty) return true;
    if (generation !== draftGeneration) return true;
    return await saveDraft(data);
  } catch (e) {
    console.error('Draft save failed', e);
    return false;
  }
}

function clearDraftTimers() {
  if (draftTimer) {
    clearTimeout(draftTimer);
    draftTimer = null;
  }
  if (draftMaxTimer) {
    clearTimeout(draftMaxTimer);
    draftMaxTimer = null;
  }
}

function armDraftMaxTimer() {
  if (draftMaxTimer || !isDirty) return;
  draftMaxTimer = setTimeout(() => {
    draftMaxTimer = null;
    if (draftTimer) {
      clearTimeout(draftTimer);
      draftTimer = null;
    }
    void runScheduledDraftSave();
  }, DRAFT_MAX_INTERVAL_MS);
}

async function runScheduledDraftSave() {
  if (draftMaxTimer) {
    clearTimeout(draftMaxTimer);
    draftMaxTimer = null;
  }
  draftSaveInFlight = persistDraftSnapshot().finally(() => {
    draftSaveInFlight = null;
  });
  await draftSaveInFlight;
}

function scheduleDraftSave() {
  if (!db) return;
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    draftTimer = null;
    void runScheduledDraftSave();
  }, DRAFT_DEBOUNCE_MS);
  armDraftMaxTimer();
}

async function flushDraftNow() {
  clearDraftTimers();
  if (!isDirty || !db) return true;
  if (draftSaveInFlight) await draftSaveInFlight;
  return persistDraftSnapshot();
}

// Unsaved-state flag + UI badge + draft autosave scheduling
function setDirty(state) {
  if (state) dirtyEpoch++;
  if (state && db) {
    scheduleDraftSave();
  } else if (!state) {
    clearDraftTimers();
    clearDraft();
  }

  if (isDirty === state) return;

  isDirty = state;
  const badge = document.getElementById('dirty-badge');
  if (badge) {
    if (state) {
      badge.classList.remove('hidden');
      badge.classList.add('flex');
    } else {
      badge.classList.add('hidden');
      badge.classList.remove('flex');
    }
  }

  const floatingSave = document.getElementById('floating-save-btn');
  if (floatingSave) {
    if (state) {
      floatingSave.classList.remove('hidden');
      floatingSave.classList.add('flex');
    } else {
      floatingSave.classList.add('hidden');
      floatingSave.classList.remove('flex');
    }
  }

  // タブのタイトルとファイル名バッジの反映
  const fileName = fileHandle && fileHandle.name ? fileHandle.name : 'Unsaved.money';
  const titleBase = `${fileName} - GrindMoney`;
  document.title = state ? `* ${titleBase}` : titleBase;
  const filenameBadge = document.getElementById('current-filename');
  if (filenameBadge) {
    filenameBadge.textContent = fileName;
    filenameBadge.classList.remove('hidden');
  }
}

// --- 共通ユーティリティ ---
function escapeHtml(unsafe) {
  return (unsafe ?? '')
    .toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// 🌟 Focus Trap: モーダル展開時に背景を非アクティブ(inert)化するヘルパー
function setAppInert(state) {
  const appUi = document.getElementById('app-ui');
  const tocContainer = document.getElementById('toc-container');
  const header = document.querySelector('header');
  if (appUi) appUi.inert = state;
  if (tocContainer) tocContainer.inert = state;
  if (header) header.inert = state;
}

// セキュアなパスワード入力プロンプト (Promiseラッパー)
function requestPasswordPrompt(message, title = 'パスワードの入力') {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    window.isSystemModalOpen = true;
    const modal = document.getElementById('password-prompt-modal');
    const msgEl = document.getElementById('password-prompt-message');
    document.getElementById('password-prompt-title').textContent = title;
    const input = document.getElementById('password-prompt-input');
    const btnSubmit = document.getElementById('password-prompt-submit');
    const btnCancel = document.getElementById('password-prompt-cancel');

    msgEl.textContent = message;
    input.value = '';
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    setAppInert(true);
    setTimeout(() => input.focus(), 100);

    const cleanup = () => {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
      if (!document.querySelector('.flex[role="dialog"]')) {
        window.isSystemModalOpen = false;
        document.body.style.overflow = '';
        setAppInert(false);
      }
      btnSubmit.removeEventListener('click', onSubmit);
      btnCancel.removeEventListener('click', onCancel);
      modal.removeEventListener('keydown', onKeyDown);
      if (previousFocus && previousFocus.focus) previousFocus.focus({ preventScroll: true });
    };
    const onSubmit = () => {
      const pwd = input.value;
      input.value = '';
      cleanup();
      resolve(pwd);
    };
    const onCancel = () => {
      input.value = '';
      cleanup();
      resolve(null);
    };
    // The handler is on the modal so Escape works from the buttons too; Enter submits only from the field
    const onKeyDown = (e) => {
      if (e.isComposing || (e.key !== 'Enter' && e.key !== 'Escape')) return;
      if (e.key === 'Enter' && e.target !== input) return;
      // Keep the global Escape handler from also closing the modal underneath
      e.stopPropagation();
      if (e.key === 'Enter') onSubmit();
      else onCancel();
    };

    btnSubmit.addEventListener('click', onSubmit);
    btnCancel.addEventListener('click', onCancel);
    modal.addEventListener('keydown', onKeyDown);
  });
}

// Shared dialog API: appAlert, appConfirm and appPrompt return Promises (native alert/confirm/prompt are not used)
function requestTextPrompt(message, defaultValue = '', title = '入力') {
  return new Promise((resolve) => {
    window.isSystemModalOpen = true;
    const modal = document.getElementById('text-prompt-modal');
    const msgEl = document.getElementById('text-prompt-message');
    document.getElementById('text-prompt-title').textContent = title;
    const input = document.getElementById('text-prompt-input');
    const btnSubmit = document.getElementById('text-prompt-submit');
    const btnCancel = document.getElementById('text-prompt-cancel');
    const previousFocus = document.activeElement;

    msgEl.textContent = message;
    input.value = defaultValue;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    setAppInert(true);
    setTimeout(() => {
      input.focus();
      input.select();
    }, 50);

    const cleanup = () => {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
      if (!document.querySelector('.flex[role="dialog"]')) {
        window.isSystemModalOpen = false;
        document.body.style.overflow = '';
        setAppInert(false);
      }
      btnSubmit.removeEventListener('click', onSubmit);
      btnCancel.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKeyDown);
      if (previousFocus && previousFocus.focus) previousFocus.focus({ preventScroll: true });
    };
    const onSubmit = () => {
      cleanup();
      resolve(input.value);
    };
    const onCancel = () => {
      cleanup();
      resolve(null);
    };
    const onKeyDown = (e) => {
      if (e.isComposing || (e.key !== 'Enter' && e.key !== 'Escape')) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Enter') onSubmit();
      else onCancel();
    };

    btnSubmit.addEventListener('click', onSubmit);
    btnCancel.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKeyDown);
  });
}

function appPrompt(message, defaultValue = '', { type = 'text', title } = {}) {
  return type === 'password'
    ? requestPasswordPrompt(message, title)
    : requestTextPrompt(message, defaultValue, title);
}

// An open alert or confirm is closed as cancelled when a newer dialog replaces it
let pendingAppDialog = null;

function appAlert(message, title = '通知') {
  return new Promise((resolve) => {
    if (pendingAppDialog) pendingAppDialog();
    const previousFocus = document.activeElement;
    window.isSystemModalOpen = true;
    document.body.style.overflow = 'hidden';

    const modal = document.getElementById('custom-alert-modal');
    document.getElementById('custom-alert-title').textContent = title;
    const escapedMessage = escapeHtml(String(message)).replace(/\n/g, '<br>');
    document.getElementById('custom-alert-message').innerHTML = escapedMessage;

    modal.classList.remove('hidden');
    modal.classList.add('flex');
    setAppInert(true);

    const okBtn = document.getElementById('custom-alert-ok-btn');

    const handleOk = () => {
      cleanup();
      resolve();
    };

    const handleKeydown = (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        handleOk();
      }
    };

    const cleanup = () => {
      pendingAppDialog = null;
      modal.classList.add('hidden');
      modal.classList.remove('flex');
      if (!document.querySelector('.flex[role="dialog"]')) {
        window.isSystemModalOpen = false;
        document.body.style.overflow = '';
        setAppInert(false);
      }
      okBtn.removeEventListener('click', handleOk);
      document.removeEventListener('keydown', handleKeydown, true);
      if (previousFocus && previousFocus.focus) previousFocus.focus({ preventScroll: true });
    };

    pendingAppDialog = handleOk;
    okBtn.addEventListener('click', handleOk);
    document.addEventListener('keydown', handleKeydown, true);
    setTimeout(() => okBtn.focus(), 10);
  });
}

function appConfirm(message, title = '確認') {
  return new Promise((resolve) => {
    if (pendingAppDialog) pendingAppDialog();
    const previousFocus = document.activeElement;
    window.isSystemModalOpen = true;
    document.body.style.overflow = 'hidden';

    const modal = document.getElementById('custom-confirm-modal');
    document.getElementById('custom-confirm-title').textContent = title;
    const escapedMessage = escapeHtml(String(message)).replace(/\n/g, '<br>');
    document.getElementById('custom-confirm-message').innerHTML = escapedMessage;

    modal.classList.remove('hidden');
    modal.classList.add('flex');
    setAppInert(true);

    const okBtn = document.getElementById('custom-confirm-ok-btn');
    const cancelBtn = document.getElementById('custom-confirm-cancel-btn');

    const handleOk = () => {
      cleanup();
      resolve(true);
    };
    const handleCancel = () => {
      cleanup();
      resolve(false);
    };

    const handleKeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (document.activeElement === okBtn) handleOk();
        else handleCancel();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        handleCancel();
      }
    };

    const cleanup = () => {
      pendingAppDialog = null;
      modal.classList.add('hidden');
      modal.classList.remove('flex');
      if (!document.querySelector('.flex[role="dialog"]')) {
        window.isSystemModalOpen = false;
        document.body.style.overflow = '';
        setAppInert(false);
      }
      okBtn.removeEventListener('click', handleOk);
      cancelBtn.removeEventListener('click', handleCancel);
      document.removeEventListener('keydown', handleKeydown, true);
      if (previousFocus && previousFocus.focus) previousFocus.focus({ preventScroll: true });
    };

    pendingAppDialog = handleCancel;
    okBtn.addEventListener('click', handleOk);
    cancelBtn.addEventListener('click', handleCancel);
    document.addEventListener('keydown', handleKeydown, true);
    setTimeout(() => cancelBtn.focus(), 10);
  });
}

function handlePlainTextPaste(event) {
  event.preventDefault();
  const text = (event.clipboardData || window.clipboardData).getData('text/plain');
  const cleanText = text.replace(/[\r\n\t]+/g, ' ').trim();
  const target = event.target;

  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    target.value = target.value.slice(0, start) + cleanText + target.value.slice(end);
    target.selectionStart = target.selectionEnd = start + cleanText.length;
    target.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }

  const selection = window.getSelection();
  if (!selection.rangeCount) return;
  
  const textNode = document.createTextNode(cleanText);
  const range = selection.getRangeAt(0);
  range.deleteContents();
  range.insertNode(textNode);
  
  range.setStartAfter(textNode);
  range.setEndAfter(textNode);
  selection.removeAllRanges();
  selection.addRange(range);

  // 【追加】 手動でイベントを発火させ、setDirty(true) を確実にトリガーする
  event.target.dispatchEvent(new Event('input', { bubbles: true }));
}

// --- セキュアなパスワード管理（メモリ上のみに保持） ---
let currentMasterKey = null; // CryptoKey (extractable: false)
let currentMasterKeyHash = ''; // string (SHA-256 hex)

async function setMasterPassword(password) {
  const pwInput = document.getElementById('file-password');
  
  if (!password) {
    currentMasterKey = null;
    currentMasterKeyHash = '';
    if (pwInput) pwInput.value = '';
    updatePasswordUI();
    return;
  }

  const enc = new TextEncoder();
  currentMasterKey = await window.crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false, // メモリからの抽出不可
    ['deriveKey']
  );
  currentMasterKeyHash = await getPasswordHash(password);
  
  // 即座にDOMから平文パスワードを消去
  if (pwInput) pwInput.value = '';
  updatePasswordUI();
}

function updatePasswordUI() {
  const container = document.getElementById('password-input-container');
  const badge = document.getElementById('password-set-badge');
  if (!container || !badge) return;

  if (currentMasterKey) {
    container.classList.add('hidden');
    badge.classList.remove('hidden');
    badge.classList.add('flex');
  } else {
    container.classList.remove('hidden');
    badge.classList.remove('flex');
    badge.classList.add('hidden');
  }
}

// --- 暗号化ロジック (Web Crypto API) ---
const MAGIC_BYTES = new TextEncoder().encode('GRINDEN2'); // 最新仕様 (60万回)
const MAGIC_BYTES_LEGACY = new TextEncoder().encode('GRINDENC'); // 過去仕様 (10万回)

async function deriveKey(keyMaterial, salt, iterations = 600000) {
  return window.crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt, iterations: iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptData(data, keyMaterial) {
  const salt = window.crypto.getRandomValues(new Uint8Array(16));
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  // 新規暗号化時はOWASP推奨の60万回を使用
  const key = await deriveKey(keyMaterial, salt, 600000);
  const encrypted = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, data);

  const result = new Uint8Array(
    MAGIC_BYTES.length + salt.length + iv.length + encrypted.byteLength,
  );
  result.set(MAGIC_BYTES, 0);
  result.set(salt, MAGIC_BYTES.length);
  result.set(iv, MAGIC_BYTES.length + salt.length);
  result.set(new Uint8Array(encrypted), MAGIC_BYTES.length + salt.length + iv.length);
  return result;
}

async function decryptData(encryptedData, keyMaterial) {
  const magic = encryptedData.slice(0, 8);
  const magicStr = new TextDecoder().decode(magic);
  const isEncryptedV2 = magicStr === 'GRINDEN2';
  const isEncryptedLegacy = magicStr === 'GRINDENC';
  if (!isEncryptedV2 && !isEncryptedLegacy) return encryptedData; // 暗号化されていないファイルはそのまま返す

  const salt = encryptedData.slice(8, 24);
  const iv = encryptedData.slice(24, 36);
  const data = encryptedData.slice(36);

  try {
    if (isEncryptedV2) {
      const key = await deriveKey(keyMaterial, salt, 600000);
      const decrypted = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, data);
      return new Uint8Array(decrypted);
    } else {
      // Legacy (10万回仕様)
      const legacyKey = await deriveKey(keyMaterial, salt, 100000);
      const decrypted = await window.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv },
        legacyKey,
        data,
      );
      return new Uint8Array(decrypted);
    }
  } catch (e) {
    throw new Error('パスワードが間違っているか、ファイルが破損しています。');
  }
}
// --------------------------------------

// データベースの後方互換性（スキーマ移行）を担保する
function migrateDatabase() {
  if (!db) return;
  try {
    const res = db.exec('PRAGMA table_info(records)');
    if (res.length > 0) {
      const columns = res[0].values.map((col) => col[1]);
      if (!columns.includes('account')) {
        db.run('ALTER TABLE records ADD COLUMN account TEXT');
        setDirty(true);
      }
      if (!columns.includes('sort_order')) {
        db.run('ALTER TABLE records ADD COLUMN sort_order INTEGER DEFAULT 0');
        setDirty(true);
      }
      // 決済行から元の発生行を辿るための列（エクスポート時の相手科目判定に使う）
      if (!columns.includes('source_id')) {
        db.run('ALTER TABLE records ADD COLUMN source_id INTEGER');
        setDirty(true);
      }
    }
    // テンプレート用テーブルの作成
    db.run(`
      CREATE TABLE IF NOT EXISTS templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        data TEXT
      );
    `);
    // 設定用テーブルの作成
    db.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);

    // Migrate legacy localStorage settings into SQLite.
    // Do not remove localStorage until a successful file save (see clearMigratedLocalStorageIfPresent).
    try {
      const keysToMigrate = ['customAccountDict', 'fiscalMonth', 'accountDict'];
      let checkStmt, insertStmt;
      try {
        checkStmt = db.prepare('SELECT 1 FROM settings WHERE key = ?');
        insertStmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');

        for (const key of keysToMigrate) {
          const oldVal = localStorage.getItem(key);
          if (oldVal !== null && oldVal !== undefined) {
            checkStmt.bind([key]);
            const exists = checkStmt.step();
            checkStmt.reset();

            if (!exists) {
              // No setDirty: localStorage keeps the value until a save, so nothing is lost
              insertStmt.run([key, oldVal]);
            }
          }
        }
      } finally {
        if (checkStmt) checkStmt.free();
        if (insertStmt) insertStmt.free();
      }
    } catch (e) {
      console.warn('Skipped running the migration', e);
    }
  } catch (e) {
    console.error('Migration error:', e);
  }
}

// 1. WebAssembly版 SQLiteエンジンの初期化
async function initSQLite() {
  try {
    if (typeof initSqlJs === 'undefined') {
      throw new Error('sql.js が読み込まれていません。assets/sql-wasm.js の配置を確認してください。');
    }

    const wasmUrl = './assets/sql-wasm.wasm';
    const isFileProtocol = location.protocol === 'file:';

    let wasmBinaryData = null;
    try {
      const response = await fetch(wasmUrl);
      if (!response.ok) throw new Error(`WASM_FETCH_${response.status}`);
      wasmBinaryData = await response.arrayBuffer();
      const isWasmSupported = WebAssembly.validate(new Uint8Array(wasmBinaryData));
      if (!isWasmSupported) throw new Error('WASM_INVALID');
    } catch (e) {
      const reason = isFileProtocol
        ? 'file:// では WebAssembly を読み込めません。HTTPS または localhost で開いてください。'
        : e && String(e.message || e).startsWith('WASM_FETCH_')
          ? '同梱の sql-wasm.wasm が見つかりません。assets フォルダの配置を確認してください。'
          : 'このブラウザ環境では WebAssembly がブロックされている可能性があります（企業ポリシーや Lockdown Mode など）。';
      document.body.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background-color:#f8fafc;color:#0f172a;font-family:sans-serif;padding:2rem;text-align:center;">
          <h1 style="color:#ef4444;margin-bottom:1rem;font-size:2rem;">起動に失敗しました</h1>
          <p style="font-size:1.1rem;margin-bottom:0.5rem;max-width:600px;">${reason}</p>
          <p style="color:#64748b;font-size:0.95rem;max-width:500px;margin-top:1.5rem;">
            GrindMoney はブラウザ内の SQLite (WebAssembly) で動作します。HTTPS または localhost で配信してください。
          </p>
        </div>
      `;
      throw new Error('WebAssembly bootstrap failed: ' + reason);
    }

    const config = {
      wasmBinary: new Uint8Array(wasmBinaryData),
    };
    SQL = await initSqlJs(config);

    let initialData = null;
    // Decide the tab role before touching the draft, so a second tab never restores or deletes it
    if ((await acquirePrimaryTabLock()) === false) markSecondaryTab();
    const draft = await loadDraft();
    if (draft) {
      if (
        (await appConfirm(
          '⚠️ 前回終了時の未保存データ（バックアップ）が見つかりました。\n\n復元しますか？\n（「キャンセル」を押すと次の確認で破棄できます）',
        ))
      ) {
        let Uints = draft;
        const magic = Uints.slice(0, 8);
        const magicStr = new TextDecoder().decode(magic);
        const isEncrypted = magicStr === 'GRINDENC' || magicStr === 'GRINDEN2';

        if (isEncrypted) {
          let keyMaterial = currentMasterKey;
          let success = false;
          while (!success) {
            try {
              if (!keyMaterial) {
                throw new Error('Need password');
              }
              Uints = await decryptData(Uints, keyMaterial);
              success = true;
              lastSavedPasswordHash = currentMasterKeyHash;
            } catch (err) {
              const promptPw = await requestPasswordPrompt(
                'バックアップデータは暗号化されています。解除パスワードを入力してください:',
              );
              if (promptPw === null) {
                await appAlert('起動をキャンセルしました。リロードしてやり直してください。');
                document.body.innerHTML =
                  "<h1 style='text-align:center; margin-top:20vh;'>保護のため停止しました。<br>リロードしてください。</h1>";
                return;
              }
              await setMasterPassword(promptPw);
              keyMaterial = currentMasterKey;
            }
          }
        }
        initialData = Uints;
      } else if (
        (await appConfirm('バックアップを破棄しますか？\nこの操作は取り消せません。'))
      ) {
        await clearDraft();
      } else {
        await appAlert(
          'バックアップを残したまま起動します。\n次回起動時に再度確認します。\n※ このまま編集すると、新しい内容でバックアップが上書きされます。',
        );
      }
    }

    if (initialData) {
      try {
        db = new SQL.Database(initialData);
        if (!hasRecordsTable(db)) throw new Error('records table not found');
        migrateDatabase();
        setDirty(true);

        showToast('未保存データを復元しました', '<span class="text-orange-400">↺</span>');
      } catch (dbError) {
        console.error('Failed to restore the draft. The data is damaged.', dbError);
        await appAlert('⚠️ 前回の未保存データが破損しているため、復元を中止しました。');
        try {
          if (db) db.close();
        } catch (e) {}
        await clearDraft();
        db = new SQL.Database();
        db.run(`
          CREATE TABLE IF NOT EXISTS records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            parent_id INTEGER,
            memo TEXT,
            amount INTEGER,
            account TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            sort_order INTEGER DEFAULT 0,
            source_id INTEGER
          );
        `);
        migrateDatabase();
      }
    } else {
      // 新規の空のデータベースを作成
      db = new SQL.Database();

      // テーブルの作成（これが .money ファイルの骨格になります）
      db.run(`
        CREATE TABLE IF NOT EXISTS records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          parent_id INTEGER,
          memo TEXT,
          amount INTEGER,
          account TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          sort_order INTEGER DEFAULT 0,
          source_id INTEGER
        );
      `);

      migrateDatabase();

      showToast('SQLite起動完了', '<span class="text-green-400">●</span>');
    }

    // DB内の設定を読み込んでUIに反映
    loadSettingsFromDb();

    // 【パフォーマンス対策】データ数が多い場合は、起動時のフリーズを防ぐためデフォルトで「今年度」のみを表示
    const countRes = db.exec('SELECT COUNT(*) FROM records');
    const recordCount = countRes.length > 0 ? countRes[0].values[0][0] : 0;
    if (recordCount > 50 && !window.currentActiveMonths) {
      setFiscalYearFilter();
    } else {
      renderData();
    }

    // 🌟 FOUC防止: レンダリング完了直後にフェードインさせる
    const appUi = document.getElementById('app-ui');
    if (appUi) {
      appUi.classList.remove('hidden');
      appUi.classList.add('animate-fade-in');
    }

    // PWAとしてOSからファイルがダブルクリックされた場合の処理
    handleLaunchFiles();
  } catch (err) {
    showToast('エラー: SQLiteの起動に失敗しました', '<span>⚠️</span>');
    console.error(err);

    // ステータスバーを消し、代わりに致命的エラー画面を大きく表示する
    const statusEl = document.getElementById('status');
    if (statusEl) statusEl.style.display = 'none';

    const errorScreen = document.getElementById('fatal-error-screen');
    if (errorScreen) {
      errorScreen.classList.remove('hidden');
      errorScreen.classList.add('flex');
    }
  }
}

// OS上で .money または .grind ファイルがダブルクリックされた時の処理 (File Handling API)
function handleLaunchFiles() {
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (launchParams) => {
      if (!launchParams.files || launchParams.files.length === 0) return;

      if (isDirty) {
        if (!(await appConfirm('未保存のデータがあります。変更を破棄して別のファイルを開きますか？'))) return;
      }
      await processFileHandle(launchParams.files[0]);
    });
  }
}

// トースト通知を表示するヘルパー関数
function showToast(message, iconHtml = '✅', options = {}) {
  const { duration = 3000, rawHtml = false } = options;
  const statusEl = document.getElementById('status');
  if (!statusEl) return;

  // 既存のタイマーがあればクリア
  if (statusTimeoutId) clearTimeout(statusTimeoutId);

  // 通知の種類に関わらず、システム通知らしく安定した黒背景に統一
  const bgClass = 'bg-slate-900/95 border-slate-800/50';

  const messageHtml = rawHtml ? message : `<span>${escapeHtml(message)}</span>`;
  statusEl.innerHTML = `${iconHtml} ${messageHtml}`;

  // 💡 スマホでの表示崩れを防ぐため、コンテンツの長さに応じて幅を可変にする
  // `max-w-[90vw]` を追加し、`px-5` を `px-4` に少し詰める
  statusEl.className = `fixed top-4 sm:top-8 left-1/2 -translate-x-1/2 max-w-[90vw] backdrop-blur-sm text-white px-4 py-2.5 rounded-full text-xs font-medium shadow-xl border transition-all duration-500 z-50 flex items-center gap-2 translate-y-0 opacity-100 ${bgClass}`;
  statusEl.style.pointerEvents = 'auto';

  if (duration > 0 && duration !== Infinity) {
    statusTimeoutId = setTimeout(() => {
      if (statusEl) {
        statusEl.classList.remove('opacity-100', 'translate-y-0');
        statusEl.classList.add('opacity-0', '-translate-y-4');
        statusEl.style.pointerEvents = 'none';
      }
    }, duration);
  }
}

// 2. ブロックまたはアイテムの追加
function addBlock() {
  const memoInput = document.getElementById('new-block-memo');
  const trimmedMemo = memoInput.value.trim();
  if (!trimmedMemo) return;

  db.run('INSERT INTO records (memo, amount) VALUES (?, ?)', [trimmedMemo, null]);
  const res = db.exec('SELECT last_insert_rowid()');
  const newId = res[0].values[0][0];

  memoInput.value = '';
  setDirty(true);
  renderData(newId);
}

// Smart amount / formula evaluation (e.g. "1500 / 3" -> 500)
function evaluateMath(expr) {
  if (expr === null || expr === '') return null;

  if (String(expr).length > 50) return null;

  try {
    const trimmedExpr = String(expr).trim();
    // Accidental date paste into amount field
    if (/^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}$/.test(trimmedExpr)) return null;

    let normalized = normalizeAmountText(trimmedExpr);
    if (normalized === null) return null;

    // Strip only currency / whitespace; reject other junk instead of silently joining digits
    const withoutCurrency = normalized.replace(/[¥￥$円\s,]/g, '');
    if (/[^0-9+\-*/().]/.test(withoutCurrency)) return null;
    const sanitized = withoutCurrency;
    if (!sanitized) return null;
    if (sanitized.includes('**')) return null;

    // CSP環境 (unsafe-eval禁止) 対応のため、new Function を排除し
    // Shunting-yard アルゴリズムによる安全な数式評価パーサーを実装
    let tokens = [];
    let numStr = '';
    for (let i = 0; i < sanitized.length; i++) {
      const c = sanitized[i];
      if (/[0-9.]/.test(c)) {
        numStr += c;
      } else {
        if (c === '-' && (i === 0 || /[+\-*/(]/.test(sanitized[i - 1]))) {
          numStr += c;
        } else {
          if (numStr) {
            // 単項マイナスの直後が括弧だった場合の救済措置
            if (numStr === '-') {
              tokens.push('-1', '*');
            } else {
              tokens.push(numStr);
            }
            numStr = '';
          }
          tokens.push(c);
        }
      }
    }
    if (numStr) {
      if (numStr === '-') tokens.push('-1', '*');
      else tokens.push(numStr);
    }

    const precedence = { '+': 1, '-': 1, '*': 2, '/': 2 };
    const outputQueue = [];
    const operatorStack = [];

    for (const token of tokens) {
      if (!isNaN(parseFloat(token))) {
        if (String(token).split('.').length > 2) return null;
        outputQueue.push(parseFloat(token));
      } else if ('+-*/'.includes(token)) {
        while (
          operatorStack.length > 0 &&
          operatorStack[operatorStack.length - 1] !== '(' &&
          precedence[operatorStack[operatorStack.length - 1]] >= precedence[token]
        ) {
          outputQueue.push(operatorStack.pop());
        }
        operatorStack.push(token);
      } else if (token === '(') {
        operatorStack.push(token);
      } else if (token === ')') {
        while (operatorStack.length > 0 && operatorStack[operatorStack.length - 1] !== '(')
          outputQueue.push(operatorStack.pop());
        if (operatorStack.length === 0) return null;
        operatorStack.pop();
      }
    }
    while (operatorStack.length > 0) {
      const op = operatorStack.pop();
      if (op === '(' || op === ')') return null;
      outputQueue.push(op);
    }

    const evalStack = [];
    for (const token of outputQueue) {
      if (typeof token === 'number') evalStack.push(token);
      else {
        const b = evalStack.pop();
        const a = evalStack.pop();
        if (a === undefined || b === undefined) return null;
        if (token === '+') evalStack.push(a + b);
        else if (token === '-') evalStack.push(a - b);
        else if (token === '*') evalStack.push(a * b);
        else if (token === '/') evalStack.push(a / b);
      }
    }

    if (evalStack.length !== 1) return null;
    const result = evalStack[0];

    const rounded = roundAwayFromZero(result);
    if (rounded === null) return null;
    if (rounded > 10000000000000 || rounded < -10000000000000) return null;
    return rounded;
  } catch (e) {
    return null;
  }
}

async function addItem(parentId, memo, amount, dateStr, accountStr) {
  const safeMemo = (memo || '').trim();
  if (!safeMemo || amount === '' || amount === null) return;

  // 登録に失敗した場合は入力中の内容を残すため、記憶・フィルター解除・再描画を行わない
  if (!(await insertRecord(parentId, safeMemo, amount, dateStr, accountStr))) return;

  if (parentId) {
    if (dateStr) lastUsedDates[parentId] = dateStr;
    if (accountStr) lastUsedAccounts[parentId] = accountStr;
  }

  if (dateStr) {
    const todayStr = getTodayString();
    if (dateStr > todayStr) {
      showToast('未来の日付で登録しました', '<span class="text-orange-400">⚠️</span>');
    }
  }

  // フィルター外の日付を追加した場合、自動で「すべての期間」に表示を戻す
  showAllPeriodsIfOutsideFilter(dateStr);

  // The re-render keeps in-progress form values, so clear the submitted ones first
  const submittedForm = document.getElementById(`block-form-${parentId}`);
  if (submittedForm) {
    submittedForm.querySelector('.item-memo').value = '';
    submittedForm.querySelector('.item-amount').value = '';
  }

  renderData(parentId);
}

// 追加した日付が現在の期間フィルター外なら「すべての期間」に戻す（追加した行が見えなくなるのを防ぐ）
function showAllPeriodsIfOutsideFilter(dateStr) {
  if (!dateStr) return;
  const filterVal = document.getElementById('period-filter')?.value;
  let isOutsideFilter = false;

  if (window.currentActiveMonths) {
    // カスタム期間（1-3月、今年度など）が適用されている場合
    if (!window.currentActiveMonths.some((m) => dateStr.startsWith(m))) isOutsideFilter = true;
  } else if (filterVal && filterVal !== 'all') {
    // 単一月・年のドロップダウンが適用されている場合
    if (!dateStr.startsWith(filterVal)) isOutsideFilter = true;
  }

  if (!isOutsideFilter) return;

  window.currentActiveMonths = null;
  setActiveQuickPeriodButton(null);
  if (document.getElementById('period-filter')) {
    document.getElementById('period-filter').value = 'all';
  }

  // ステータスバーで通知
  showToast(
    '追加した日付がフィルター外のため、「すべての期間」に表示を戻しました',
    '<span class="text-blue-400">👀</span>',
  );
}

async function insertRecord(parentId, memo, amountExpr, dateStr = null, accountStr = null) {
  const parsedAmount = evaluateMath(amountExpr);
  // 金額が入力されたのに数式のパースに失敗した場合（不正な文字列など）は弾く
  if (amountExpr !== null && amountExpr !== '' && parsedAmount === null) {
    await appAlert('金額の入力、または数式が正しくありません。');
    return false;
  }

  // 新しいアイテムが常にブロックの一番下に追加されるよう、現在の最大sort_orderを取得
  let maxSort = -1;
  if (parentId) {
    let checkStmt;
    try {
      checkStmt = db.prepare('SELECT MAX(sort_order) FROM records WHERE parent_id = ?');
      checkStmt.bind([parentId]);
      if (checkStmt.step()) {
        const val = checkStmt.get()[0];
        if (val !== null) maxSort = val;
      }
    } catch (e) {
      console.warn(e);
    } finally {
      if (checkStmt) checkStmt.free();
    }
  }
  const newSortOrder = maxSort + 1;

  // Always set created_at explicitly (never rely on CURRENT_TIMESTAMP / UTC)
  const safeDate = dateStr && String(dateStr).trim() ? String(dateStr).trim() : getTodayString();
  const query =
    'INSERT INTO records (parent_id, memo, amount, account, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)';
  const params = [parentId, memo, parsedAmount, accountStr, newSortOrder, safeDate + ' 00:00:00'];

  let stmt;
  try {
    stmt = db.prepare(query);
    stmt.run(params);
  } finally {
    if (stmt) stmt.free();
  }
  setDirty(true);
  return true;
}

// 【新機能 1】 過去のメモ履歴を抽出して Datalist に登録する
function renderMemoSuggestions() {
  if (!db) return;
  const datalist = document.getElementById('memo-suggestions');
  if (!datalist) return;

  try {
    // 親ブロックではない(parent_id IS NOT NULL)過去のメモを重複排除して直近使った順に取得
    // SQLiteでの安全な書き方(GROUP BY + MAX)を採用
    const res = db.exec(
      "SELECT memo FROM records WHERE parent_id IS NOT NULL AND memo != '' GROUP BY memo ORDER BY MAX(id) DESC",
    );
    datalist.innerHTML = '';
    if (res.length > 0) {
      res[0].values.forEach(([memo]) => {
        const option = document.createElement('option');
        option.value = memo;
        datalist.appendChild(option);
      });
    }
  } catch (e) {
    console.error('Failed to render memo suggestions:', e);
  }
}

// 【新機能 2】 入力されたメモから、過去の科目を自動推論して埋める
function autoSuggestAccount(memoInput) {
  if (!db) return;
  const memo = memoInput.value.trim();
  if (!memo) return;

  const form = memoInput.closest('form');
  const accountInput = form.querySelector('.item-account');

  // すでにユーザーが科目を手入力している場合は、上書きせずに尊重する
  if (accountInput.value.trim() !== '') return;

  let stmt;
  try {
    // 過去の明細から「同じメモ」で使われた最新の「科目」を1件だけ検索
    stmt = db.prepare(
      "SELECT account FROM records WHERE parent_id IS NOT NULL AND memo = ? AND account IS NOT NULL AND account != '' ORDER BY id DESC LIMIT 1",
    );
    stmt.bind([memo]);

    if (stmt.step()) {
      const account = stmt.get()[0];
      if (account) {
        accountInput.value = account; // 科目を自動入力

        // （おまけ）自動入力されたことがユーザーに伝わるよう、一瞬だけ色を変えるマイクロインタラクション
        accountInput.classList.add('!bg-purple-100', '!text-purple-700', 'transition-colors');
        setTimeout(() => accountInput.classList.remove('!bg-purple-100', '!text-purple-700'), 1000);
      }
    }
  } catch (e) {
    console.error('Auto suggest account failed:', e);
  } finally {
    if (stmt) stmt.free();
  }
}

// --- 決済（回収・支払）行の自動生成ロジック ---
window.createCollectionRecord = async function (id) {
  if (!db) return;
  let stmt;
  let insertStmt = null;
  try {
    stmt = db.prepare('SELECT parent_id, memo, amount, account FROM records WHERE id = ?');
    stmt.bind([id]);
    if (stmt.step()) {
      const [parent_id, memo, amount, account] = stmt.get();

      // 今日の日付を取得
      const today = new Date();
      const dateStr = `${getTodayString()} 00:00:00`;

      // 💡 修正1: 科目コードから収入か支出(経費)かをスマート判定（エクスポートと同じ判定）
      const isIncome = isIncomeEntry(amount, account);
      const accountName = account || '雑費';
      if (
        !getFreewayCode(accountName) &&
        !(await appConfirm(
          `⚠️ 科目「${accountName}」は科目コード表にないため、収支の向きを判定できません。\n\n金額の符号から「${isIncome ? '入金（回収）' : '支払'}」として決済行を作成します。よろしいですか？`,
        ))
      ) {
        return;
      }

      const tag = isIncome ? '#入金' : '#支払';
      const newAccount = '普通預金'; // 回収・支払のデフォルト科目

      const cleanMemo = stripSettlementTags(memo);
      const newMemo = `${cleanMemo} (決済) ${tag}`;

      // 💡 修正3: ブロック内の最大 sort_order を取得して順番を壊さないようにする
      let maxSort = -1;
      let sortStmt = null;
      try {
        sortStmt = db.prepare('SELECT MAX(sort_order) FROM records WHERE parent_id = ?');
        sortStmt.bind([parent_id]);
        if (sortStmt.step()) {
          const val = sortStmt.get()[0];
          if (val !== null) maxSort = val;
        }
      } catch (e) {
        console.warn('Failed to read the sort order', e);
      } finally {
        if (sortStmt) sortStmt.free();
      }

      insertStmt = db.prepare(
        'INSERT INTO records (parent_id, memo, amount, account, created_at, sort_order, source_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      insertStmt.run([parent_id, newMemo, amount, newAccount, dateStr, maxSort + 1, id]);

      const res = db.exec('SELECT last_insert_rowid()');
      const newId = res[0].values[0][0];

      setDirty(true);
      // 決済行は今日の日付で作られるため、過去の期間を表示中でも見えるようにする
      showAllPeriodsIfOutsideFilter(dateStr);
      renderData(parent_id);

      showToast(
        '決済行を作成しました。日付と金額を調整してください',
        '<span class="text-emerald-400">✅</span>',
      );

      // 複製された行の日付入力欄にフォーカスを当てる
      requestAnimationFrame(() => {
        const newDateEl = document.querySelector(
          `span[data-id="${newId}"][data-field="created_at"]`,
        );
        if (newDateEl) {
          newDateEl.focus();
          window.getSelection().selectAllChildren(newDateEl);
        }
      });
    }
  } catch (e) {
    console.error(e);
  } finally {
    if (stmt) stmt.free();
    if (insertStmt) insertStmt.free();
  }
};

// --- インプレース編集機能 ---
async function updateRecord(id, field, newValue, element) {
  if (!db) return;

  // ホワイトリストによるSQLインジェクション対策
  const allowedFields = ['amount', 'memo', 'account', 'created_at'];
  if (!allowedFields.includes(field)) {
    console.error('Invalid field name');
    return;
  }

  let val = (newValue || '').toString().replace(/\u00A0/g, ' ').trim();
  if (field === 'amount') {
    if (val === '') {
      val = null; // 空文字の場合は未入力(null)として扱う
    } else {
      // 表示時のカンマを除去してから数式評価
      val = evaluateMath(val);
      if (val === null) {
        await appAlert('金額の入力、または数式が正しくありません。');
        if (element) {
          // 拒否した文字列が画面に残らないよう、DBの現在値に表示を戻す
          let revertStmt;
          try {
            revertStmt = db.prepare('SELECT amount FROM records WHERE id = ?');
            revertStmt.bind([id]);
            if (revertStmt.step()) {
              const cur = revertStmt.get()[0];
              const text = cur !== null ? jpyFormatter.format(cur) : '';
              if (element.tagName === 'INPUT') element.value = text;
              else element.innerText = text;
            }
          } finally {
            if (revertStmt) revertStmt.free();
          }
        }
        return;
      }
      if (element) {
        element.classList.remove('!bg-red-100', '!text-red-600');
      }
    }
  } else if (field === 'created_at') {
    // 全角数字・記号を半角に変換（スマホフリック入力対応）
    val = val.replace(/[０-９／－]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xfee0));
    val = val.replace(/[ー−]/g, '-');

    // "12/31" などの簡易形式をパース
    let match = val.match(/^(\d{1,2})[\/\-](\d{1,2})$/);
    if (match) {
      let year = new Date().getFullYear();
      if (element && element.hasAttribute('data-year')) {
        year = parseInt(element.getAttribute('data-year'), 10);
      }
      const m = parseInt(match[1], 10);
      const d = parseInt(match[2], 10);

      const dateObj = new Date(year, m - 1, d);
      if (
        dateObj.getFullYear() !== year ||
        dateObj.getMonth() !== m - 1 ||
        dateObj.getDate() !== d
      ) {
        await appAlert('存在しない日付です。カレンダーを確認してください。');
        renderData();
        return;
      }
      val = `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} 00:00:00`;
    } else {
      let matchFull = val.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
      if (matchFull) {
        const y = parseInt(matchFull[1], 10);
        const m = parseInt(matchFull[2], 10);
        const d = parseInt(matchFull[3], 10);

        // 実在する日付かどうかの厳密チェック (例: 2月30日や13月を弾く)
        const dateObj = new Date(y, m - 1, d);
        if (
          dateObj.getFullYear() !== y ||
          dateObj.getMonth() !== m - 1 ||
          dateObj.getDate() !== d
        ) {
          await appAlert('存在しない日付です。カレンダーを確認してください。');
          renderData();
          return;
        }

        val = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')} 00:00:00`;
      } else {
        await appAlert('日付の形式が正しくありません。(例: 12/31 または 2025-12-31)');
        renderData();
        return;
      }
    }

    // 未来の日付チェック
    const today = new Date();
    const todayStr = `${getTodayString()} 00:00:00`;
    if (val > todayStr) {
      showToast('未来の日付が入力されました', '<span class="text-orange-400">⚠️</span>');
    }
  }

  // 変更があるかチェック (内容が変わっていない場合は何もしない)
  let oldVal = null;
  let checkStmt;
  try {
    checkStmt = db.prepare(`SELECT ${field} FROM records WHERE id = ?`);
    checkStmt.bind([id]);
    if (checkStmt.step()) {
      const currentVal = checkStmt.get()[0];
      oldVal = currentVal;
      if (currentVal == val) {
        // 型の違い（"100"と100など）を許容するため == を使用
        // カンマが除去された表示を元に戻す
        if (element && field === 'amount') {
          if (element.tagName === 'INPUT') {
            element.value = val !== null ? jpyFormatter.format(val) : '';
          } else {
            element.innerText = val !== null ? jpyFormatter.format(val) : '';
          }
        }
        return; // 変更なし
      }
    }
  } finally {
    if (checkStmt) checkStmt.free();
  }

  let stmt;
  try {
    stmt = db.prepare(`UPDATE records SET ${field} = ? WHERE id = ?`);
    stmt.run([val, id]);
  } finally {
    if (stmt) stmt.free();
  }

  setDirty(true);

  // Tabキー等によるフォーカス移動を追跡して復元するマジック
  const activeEl = document.activeElement;
  let focusSelector = null;

  if (activeEl) {
    if (
      typeof activeEl.hasAttribute === 'function' &&
      activeEl.hasAttribute('data-field') &&
      activeEl.hasAttribute('data-id')
    ) {
      const focusField = activeEl.getAttribute('data-field');
      const focusId = activeEl.getAttribute('data-id');
      focusSelector = `[data-id="${focusId}"][data-field="${focusField}"]`;
    } else if (activeEl.classList.contains('item-memo')) {
      const form = activeEl.closest('form');
      if (form) focusSelector = `#${form.id} .item-memo`;
    } else if (activeEl.classList.contains('item-amount')) {
      const form = activeEl.closest('form');
      if (form) focusSelector = `#${form.id} .item-amount`;
    } else if (activeEl.classList.contains('item-account')) {
      const form = activeEl.closest('form');
      if (form) focusSelector = `#${form.id} .item-account`;
    } else if (activeEl.classList.contains('item-date')) {
      const form = activeEl.closest('form');
      if (form) focusSelector = `#${form.id} .item-date`;
    }
  }

  // タグ集計（PROJECTS）に影響する変更かどうか
  const hasTag = (s) => /[#＃]/.test(s || '');
  let affectsTags = false;
  if (field === 'memo') {
    affectsTags = hasTag(val) || hasTag(oldVal);
  }

  // ★ 金額や日付が変更された場合のみ再計算・再描画
  if (field === 'amount') {
    // DOM全体を破壊せず、金額表示と合計値のみをソフトに更新する（クリック消失バグ防止）
    if (element) {
      if (element.tagName === 'INPUT') {
        element.value = val !== null ? jpyFormatter.format(val) : '';
      } else {
        element.innerText = val !== null ? jpyFormatter.format(val) : '';
      }
    }
    updateTotalsOnly();
    // タグ（PROJECTS）の合計も、ブロックDOMを壊さずに更新する
    renderTagSections(computeTagTotals(buildFilteredTree()));
  } else if (field === 'created_at') {
    // ✅ フィルター期間外に変更された場合の神隠し（消失）を防ぐフェイルセーフ
    const filterVal = document.getElementById('period-filter')?.value;
    let isOutsideFilter = false;

    if (window.currentActiveMonths) {
      const match = window.currentActiveMonths.some((m) => val.startsWith(m));
      if (!match) isOutsideFilter = true;
    } else if (filterVal && filterVal !== 'all') {
      if (!val.startsWith(filterVal)) isOutsideFilter = true;
    }

    if (isOutsideFilter) {
      window.currentActiveMonths = null;
      setActiveQuickPeriodButton(null);
      if (document.getElementById('period-filter')) {
        document.getElementById('period-filter').value = 'all';
      }
      showToast(
        '日付がフィルター外に変更されたため、「すべての期間」を表示します',
        '<span class="text-blue-400">👀</span>',
      );
    }

    renderData();
    // 再描画で失われたフォーカスを即座に復元
    if (focusSelector) {
      requestAnimationFrame(() => {
        try {
          const target = document.querySelector(focusSelector);
          if (target) {
            target.focus();
            if (target.hasAttribute('contenteditable')) {
              const range = document.createRange();
              const sel = window.getSelection();
              range.selectNodeContents(target);
              range.collapse(false);
              sel.removeAllRanges();
              sel.addRange(range);
            }
          }
        } catch (e) {
          console.warn('Skipped restoring focus (invalid selector)', e);
        }
      });
    }
  } else {
    // 💡 修正2: 変更前後のメモにハッシュタグがある場合は、集計や決済行判定が変わるため再描画を行う
    if (affectsTags) {
      renderData();

      if (focusSelector) {
        requestAnimationFrame(() => {
          try {
            const target = document.querySelector(focusSelector);
            if (target) {
              target.focus();
              if (target.hasAttribute('contenteditable')) {
                const range = document.createRange();
                const sel = window.getSelection();
                range.selectNodeContents(target);
                range.collapse(false);
                sel.removeAllRanges();
                sel.addRange(range);
              }
            }
          } catch (e) {
            console.warn('Skipped restoring focus (invalid selector)', e);
          }
        });
      }
      return;
    }

    // メモや科目の変更は、すでに画面上の文字（innerText / value）が書き換わっているため、
    // DBへの保存(UPDATE)と setDirty(true) だけで十分。DOMの再構築はスキップし、超速タイピングを邪魔しない。

    // 親ブロックのタイトルが変更された場合、左側の目次(TOC)を即座に同期する
    if (field === 'memo' && element && element.tagName === 'H2') {
      const tocItem = document.querySelector(`.toc-item[href="#block-${id}"]`);
      if (tocItem) {
        tocItem.textContent = val || '名称未設定';
        tocItem.title = val || '名称未設定';
      }
    }

    // 🌟 修正：タイピングを邪魔せずに、オートコンプリート用の辞書だけを裏で最新化する
    if (field === 'memo') {
      renderMemoSuggestions();
    }
  }
}

// Current period filter as a parameterized SQL fragment (" AND (...)") shared by totals and exports
function getPeriodWhereClause() {
  const filterVal = document.getElementById('period-filter')?.value || 'all';
  const params = [];
  let whereClause = '';
  if (window.currentActiveMonths) {
    const orConditions = window.currentActiveMonths
      .map((m) => {
        params.push(`${m}%`);
        return 'created_at LIKE ?';
      })
      .join(' OR ');
    whereClause = ` AND (${orConditions})`;
  } else if (filterVal !== 'all') {
    whereClause = ` AND created_at LIKE ?`;
    params.push(`${filterVal}%`);
  }
  return { whereClause, params };
}

// 金額編集時に画面全体を再描画せず、合計金額のみを更新する
function updateTotalsOnly() {
  if (!db) return;

  const { whereClause, params } = getPeriodWhereClause();

  let stmtTotal;
  let stmtBlock;
  try {
    // 1. 総合計を更新
    let grandTotal = 0;
    stmtTotal = db.prepare(
      `SELECT SUM(amount) FROM records WHERE parent_id IS NOT NULL AND ${settlementExclusionSql("COALESCE(memo, '')")}${whereClause}`,
    );
    stmtTotal.bind(params);
    if (stmtTotal.step()) {
      grandTotal = stmtTotal.get()[0] || 0;
    }
    animateTotal(Math.round(grandTotal));

    // 2. 各ブロックの合計を更新
    stmtBlock = db.prepare(
      `SELECT SUM(amount) FROM records WHERE parent_id = ? AND ${settlementExclusionSql("COALESCE(memo, '')")}${whereClause}`,
    );
    const blocksRes = db.exec('SELECT id FROM records WHERE parent_id IS NULL');
    if (blocksRes.length > 0) {
      blocksRes[0].values.forEach(([blockId]) => {
        stmtBlock.bind([blockId, ...params]);
        let blockTotal = 0;
        if (stmtBlock.step()) blockTotal = stmtBlock.get()[0] || 0;
        stmtBlock.reset();
        const el = document.getElementById(`block-total-${blockId}`);
        if (el) el.innerText = jpyFormatter.format(blockTotal);
      });
    }
  } catch (e) {
    console.error('Totals update failed:', e);
  } finally {
    if (stmtTotal) stmtTotal.free();
    if (stmtBlock) stmtBlock.free();
  }
}

// 日付の「+1日」「-1日」ボタンの処理
function adjustDate(btn, days) {
  const form = btn.closest('form');
  const dateInput = form.querySelector('.item-date');

  let d;
  const parts = dateInput.value.split('-');
  if (parts.length === 3) {
    d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
  } else {
    d = new Date(dateInput.value);
  }

  // Invalid Date の場合は今日を基準にする
  if (isNaN(d.getTime())) {
    d = new Date();
  }

  d.setDate(d.getDate() + days);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  dateInput.value = `${yyyy}-${mm}-${dd}`;

  if (typeof checkFutureDate === 'function') checkFutureDate(dateInput);
}

// 未来の日付入力時に警告色にする
function checkFutureDate(input) {
  const today = new Date();
  const todayStr = getTodayString();
  if (input.value > todayStr) {
    input.classList.add('text-red-600', 'font-bold', 'bg-red-50', 'rounded');
    input.classList.remove('text-slate-600', 'bg-transparent');
  } else {
    input.classList.add('text-slate-600', 'bg-transparent');
    input.classList.remove('text-red-600', 'font-bold', 'bg-red-50', 'rounded');
  }
}

// ハッカー的カウントアップ演出
function animateTotal(newTotal) {
  const el = document.getElementById('grand-total-num');
  if (!el) return;

  // 既に実行中のアニメーションがあればキャンセル（描画の暴走・CPUスパイク防止）
  if (totalAnimationId !== null) {
    cancelAnimationFrame(totalAnimationId);
  }

  const start = currentDisplayedTotal;
  const duration = 500;
  const startTime = performance.now();

  function update(currentTime) {
    const progress = Math.min((currentTime - startTime) / duration, 1);
    const ease = 1 - Math.pow(1 - progress, 3); // easeOutCubic
    const current = Math.floor(start + (newTotal - start) * ease);
    el.textContent = jpyFormatter.format(current);
    currentDisplayedTotal = current;
    if (progress < 1) {
      totalAnimationId = requestAnimationFrame(update);
    } else {
      el.textContent = jpyFormatter.format(newTotal);
      currentDisplayedTotal = newTotal;
      totalAnimationId = null; // 完了時にリセット
    }
  }
  totalAnimationId = requestAnimationFrame(update);
}

// ブロックの折りたたみ（アコーディオン）切り替え
function toggleBlock(id) {
  if (collapsedBlocks.has(id)) {
    collapsedBlocks.delete(id);
  } else {
    collapsedBlocks.add(id);
  }
  const bodyEl = document.getElementById(`block-body-${id}`);
  const iconEl = document.getElementById(`block-icon-${id}`);
  if (bodyEl && iconEl) {
    if (collapsedBlocks.has(id)) {
      bodyEl.style.maxHeight = bodyEl.scrollHeight + 'px';
      bodyEl.offsetHeight; // リフローを強制してトランジションを有効化する
      bodyEl.style.maxHeight = '0px';
      bodyEl.style.opacity = '0';
      iconEl.style.transform = 'rotate(-90deg)';
    } else {
      bodyEl.style.maxHeight = bodyEl.scrollHeight + 500 + 'px';
      bodyEl.style.opacity = '1';
      iconEl.style.transform = 'rotate(0deg)';
      setTimeout(() => {
        if (!collapsedBlocks.has(id)) {
          bodyEl.style.maxHeight = '99999px';
        }
      }, 300);
    }
  }
}

// --- すべて展開 / すべて折りたたみ ---
function toggleAllBlocks(collapse) {
  if (!db) return;

  if (collapse) {
    // 現在画面に表示されているブロックすべてのIDをセットに追加
    document.querySelectorAll('.group\\/block').forEach((el) => {
      const id = parseInt(el.id.replace('block-', ''), 10);
      if (!isNaN(id)) collapsedBlocks.add(id);
    });
  } else {
    // セットを空にして全展開
    collapsedBlocks.clear();
  }

  // ✅ View Transition API を使って、滑らかに一斉開閉させる
  renderData();
}

// --- 期間表示フォーマットの共通ヘルパー ---
function getFormattedPeriodText(activeMonths) {
  if (!activeMonths || activeMonths.length === 0) {
    return null;
  }

  const sorted = [...activeMonths].sort();
  const formatMonth = (ym) => {
    const [y, m] = ym.split('-');
    return `${y}年${parseInt(m, 10)}月`;
  };

  if (sorted.length === 1) {
    return formatMonth(sorted[0]);
  }

  // 12ヶ月連続しているかチェック -> 年度表示
  if (sorted.length === 12) {
    let isContinuous = true;
    let [currentY, currentM] = sorted[0].split('-').map(Number);

    for (let i = 1; i < 12; i++) {
      currentM++;
      if (currentM > 12) {
        currentM = 1;
        currentY++;
      }
      const expectedYm = `${currentY}-${String(currentM).padStart(2, '0')}`;
      if (sorted[i] !== expectedYm) {
        isContinuous = false;
        break;
      }
    }
    if (isContinuous) {
      const [y, m] = sorted[0].split('-').map(Number);
      return m === 1 ? `${y}年 (暦年)` : `${y}年度 (${m}月始)`;
    }
  }

  return `${formatMonth(sorted[0])} 〜 ${formatMonth(sorted[sorted.length - 1])}`;
}

// --- 期間フィルターの選択肢を自動生成する ---
function updatePeriodDropdown() {
  if (!db) return;
  const select = document.getElementById('period-filter');
  if (!select) return;

  const currentVal = select.value;
  // DB内のすべての日付から「YYYY-MM」を重複なしで抽出
  const res = db.exec(
    'SELECT DISTINCT substr(created_at, 1, 7) FROM records WHERE parent_id IS NOT NULL AND created_at IS NOT NULL ORDER BY substr(created_at, 1, 7) DESC',
  );

  let years = new Set();
  let months = [];
  if (res.length > 0) {
    res[0].values.forEach((row) => {
      if (row[0]) {
        months.push(row[0]);
        years.add(row[0].split('-')[0]);
      }
    });
  }

  let html = `<option value="all">すべての期間</option>`;
  if (years.size > 0) {
    html += `<optgroup label="--- 年で絞り込み ---">`;
    [...years].forEach(
      (y) => (html += `<option value="${escapeHtml(y)}">${escapeHtml(y)}年</option>`),
    );
    html += `</optgroup><optgroup label="--- 月別で絞り込み ---">`;
    months.forEach((ym) => {
      const [y, m] = ym.split('-');
      html += `<option value="${escapeHtml(ym)}">${escapeHtml(y)}年${parseInt(m, 10)}月</option>`;
    });
    html += `</optgroup>`;
  }

  // 選択肢が更新された場合のみDOMを書き換える（フォーカス消失防止）
  if (select.innerHTML !== html) {
    select.innerHTML = html;
  }

  // 🎯 カスタム期間が選択されている場合の表示上書き
  if (window.currentActiveMonths && window.currentActiveMonths.length > 0) {
    const existingCustom = select.querySelector('option[value="custom"]');
    if (existingCustom) existingCustom.remove();

    const customPeriodText = getFormattedPeriodText(window.currentActiveMonths) || 'カスタム期間';

    const customOpt = new Option(customPeriodText, 'custom', true, true);
    customOpt.disabled = true;
    select.insertBefore(customOpt, select.firstChild);
    select.value = 'custom';
    select.classList.add('!text-primary');
  } else {
    select.classList.remove('!text-primary');
    if (select.querySelector(`option[value="${currentVal}"]`)) {
      select.value = currentVal;
    } else {
      select.value = 'all';
    }
  }
}

// --- 期間制御用のヘルパー関数群 ---

// ドロップダウンの手動変更ハンドラ
function handleDropdownChange() {
  window.currentActiveMonths = null;
  setActiveQuickPeriodButton(null);
  renderData();
}

// クイックセレクターのアクティブ状態を更新
function setActiveQuickPeriodButton(btn, keepYear = false) {
  const container = document.getElementById('quick-period-selectors');
  if (!container) return;
  const btns = container.querySelectorAll('button');
  btns.forEach((b) => {
    // 🎯 keepYearがtrueの場合、年度系のボタン(今年/今年度/前年度)の点灯は消さずに保持する
    if (keepYear) {
      const action = b.getAttribute('data-action') || '';
      const isYearGroup = action.includes('YearFilter');
      if (isYearGroup) return; // 年度系ボタンはリセットをスキップ
    }

    b.classList.remove('ring-2', 'ring-primary', 'ring-offset-1'); // 古い仕様の枠線をクリア
    b.classList.remove('!bg-primary', '!text-white', '!border-primary'); // 色反転をクリア

    const activeClasses = b.getAttribute('data-active-classes');
    if (activeClasses) {
      b.classList.remove(...activeClasses.split(' ').filter(Boolean));
    }
    b.setAttribute('aria-pressed', 'false');
  });
  if (btn) {
    const activeClasses = btn.getAttribute('data-active-classes');
    if (activeClasses) {
      btn.classList.add(...activeClasses.split(' ').filter(Boolean));
    }
    btn.setAttribute('aria-pressed', 'true');
  }
}

function isQuickPeriodButtonActive(id) {
  return document.getElementById(id)?.getAttribute('aria-pressed') === 'true';
}

// 単一期間（2025-04 など）のセット
function setPeriodFilter(val, btn = null) {
  window.currentActiveMonths = null;
  setActiveQuickPeriodButton(btn);
  const select = document.getElementById('period-filter');
  if (select) {
    select.value = val;
  renderData();
  }
}

// 複数月（[4,5,6] など）のセット
function setMultiMonthFilter(monthArray, btn = null) {
  let baseYear = new Date().getFullYear();
  const select = document.getElementById('period-filter');
  const currentFilter = select ? select.value : 'all';

  // 🎯 今年度・前年度がアクティブかどうかを判定する
  const isFiscalYearActive = isQuickPeriodButtonActive('fiscal-year-btn');
  const isPrevFiscalYearActive = isQuickPeriodButtonActive('prev-fiscal-year-btn');
  const startMonth = parseInt(getDbSetting('fiscalMonth', '4'), 10);
  let targetMonths = [];

  if (isFiscalYearActive || isPrevFiscalYearActive) {
    // === 年度ベースの複合フィルター ===
    const today = new Date();
    let startYear = today.getFullYear();
    if (today.getMonth() + 1 < startMonth) {
      startYear--;
    }
    if (isPrevFiscalYearActive) {
      startYear--; // 前年度ならさらに1年戻す
    }

    targetMonths = monthArray.map((m) => {
      let y = startYear;
      // 決算期を跨ぐ月（例：4月開始における1〜3月）は、西暦を翌年に進める
      if (m < startMonth) {
        y++;
      }
      return `${y}-${String(m).padStart(2, '0')}`;
    });
  } else {
    // === 暦年ベース（今年、または特定年）のフィルター ===
    if (window.currentActiveMonths && window.currentActiveMonths.length > 0) {
      baseYear = parseInt(window.currentActiveMonths[0].split('-')[0], 10);
    } else if (currentFilter !== 'all' && currentFilter.includes('-')) {
      baseYear = parseInt(currentFilter.split('-')[0], 10);
    } else if (currentFilter !== 'all' && currentFilter.length === 4) {
      baseYear = parseInt(currentFilter, 10);
    }

    targetMonths = monthArray.map((m) => `${baseYear}-${String(m).padStart(2, '0')}`);
  }

  window.currentActiveMonths = targetMonths;

  // 🎯 第2引数を true にすることで「年度の紫・緑色」を消さずに「月ボタンの青色」を両立させる
  setActiveQuickPeriodButton(btn, true);

  renderData();
}

// カレンダー年フィルター (1月〜12月: 個人事業主・12月決算向け)
function setCalendarYearFilter(btn = null) {
  const today = new Date();
  const year = today.getFullYear();
  let months = [];
  for (let m = 1; m <= 12; m++) months.push(`${year}-${String(m).padStart(2, '0')}`);
  window.currentActiveMonths = months;
  setActiveQuickPeriodButton(btn);
  renderData();
}

// 年度の開始月を更新するUI
function updateFiscalYearButton() {
  const m = parseInt(getDbSetting('fiscalMonth', '4'), 10);
  const gearBtn = document.getElementById('fiscal-month-gear-btn');
  if (gearBtn) {
    gearBtn.title = `開始月を変更 (現在の設定: ${m}月始)`;
  }
}

async function changeFiscalMonth() {
  const current = getDbSetting('fiscalMonth', '4');
  const input = (await appPrompt('年度の開始月（1〜12）を入力してください:', current));
  if (input !== null) {
    const halfInput = input.replace(/[０-９]/g, (s) =>
      String.fromCharCode(s.charCodeAt(0) - 0xfee0),
    );
    const month = parseInt(halfInput, 10);
    if (month >= 1 && month <= 12) {
      setDbSetting('fiscalMonth', month.toString());
      updateFiscalYearButton();

      const isFiscalYearActive = isQuickPeriodButtonActive('fiscal-year-btn');
      const isPrevFiscalYearActive = isQuickPeriodButtonActive('prev-fiscal-year-btn');

      if (isFiscalYearActive) {
        setFiscalYearFilter(document.getElementById('fiscal-year-btn'));
      } else if (isPrevFiscalYearActive) {
        setPreviousFiscalYearFilter(document.getElementById('prev-fiscal-year-btn'));
      } else {
        // その他のフィルター時でも、ドロップダウンや画面の再描画だけは行っておく
  renderData();
      }
    } else {
      await appAlert('1から12の数字を入力してください。');
    }
  }
}

// 前年度フィルター (設定された開始月から12ヶ月、さらに1年前)
function setPreviousFiscalYearFilter(btn = null) {
  const today = new Date();
  const startMonth = parseInt(getDbSetting('fiscalMonth', '4'), 10);
  let startYear = today.getFullYear();

  if (today.getMonth() + 1 < startMonth) {
    startYear--;
  }
  startYear--; // ここでさらに1年引くことで「前年度」にする

  let months = [];
  for (let i = 0; i < 12; i++) {
    let m = startMonth + i;
    let y = startYear;
    if (m > 12) {
      m -= 12;
      y++;
    }
    months.push(`${y}-${String(m).padStart(2, '0')}`);
  }

  window.currentActiveMonths = months;
  setActiveQuickPeriodButton(btn || document.getElementById('prev-fiscal-year-btn'));
  renderData();
}

// 年度フィルター (設定された開始月から12ヶ月)
function setFiscalYearFilter(btn = null) {
  const today = new Date();
  const startMonth = parseInt(getDbSetting('fiscalMonth', '4'), 10);
  let startYear = today.getFullYear();

  if (today.getMonth() + 1 < startMonth) {
    startYear--;
  }

  let months = [];
  for (let i = 0; i < 12; i++) {
    let m = startMonth + i;
    let y = startYear;
    if (m > 12) {
      m -= 12;
      y++;
    }
    months.push(`${y}-${String(m).padStart(2, '0')}`);
  }

  window.currentActiveMonths = months;
  setActiveQuickPeriodButton(btn || document.getElementById('fiscal-year-btn'));
  renderData();
}

// メモ欄から「#タグ」を抽出して集計する（全角ハッシュタグも吸収）
function computeTagTotals(filteredTree) {
  const tagTotals = Object.create(null); // プロトタイプ汚染防止
  filteredTree.forEach((block) => {
    block.children.forEach((item) => {
      const safeAmount = parseInt(item.amount || 0, 10);
      const isCollection = isSettlementMemo(item.memo);

      const tags = (item.memo || '').match(/[#＃][^\s　,、。\.・()（）「」#＃]+/g) || [];
      const blockTags = (block.memo || '').match(/[#＃][^\s　,、。\.・()（）「」#＃]+/g) || [];
      const rawTags = [...tags, ...blockTags].map((t) => t.replace('＃', '#'));
      let allTags = [...new Set(rawTags)];

      // Settlement rows inherit project tags; only count settlement tags (avoid double-counting)
      if (isCollection) allTags = allTags.filter((tag) => SETTLEMENT_TAG_EXACT_RE.test(tag));

      allTags.forEach((tag) => {
        if (!tagTotals[tag]) tagTotals[tag] = { amount: 0, items: [] };
        tagTotals[tag].amount += safeAmount;
        tagTotals[tag].items.push({
          date: item.created_at,
          memo: item.memo,
          amount: safeAmount,
        });
      });
    });
  });
  return tagTotals;
}

// タグ集計を左側 TOC の下部とスマホ用エリアに（既存表示を置き換えて）描画する
const TAG_SECTION_LIMIT = 10;
let showAllTags = false; // Kept across re-renders

function createTagToggleButton(total, className, tagTotals) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.textContent = showAllTags ? '上位10件に戻す' : `すべて表示（${total}件）`;
  btn.setAttribute('aria-expanded', String(showAllTags));
  btn.onclick = (e) => {
    e.preventDefault();
    showAllTags = !showAllTags;
    renderTagSections(tagTotals);
  };
  return btn;
}

function renderTagSections(tagTotals) {
  const tocList = document.getElementById('toc-list');
  if (tocList) tocList.querySelectorAll('.toc-tag-section').forEach((el) => el.remove());

  // Sort by amount (largest first); show the top entries unless the user expanded the list
  const sortedTags = Object.entries(tagTotals).sort((a, b) => b[1].amount - a[1].amount);
  const visibleTags = showAllTags ? sortedTags : sortedTags.slice(0, TAG_SECTION_LIMIT);
  const hasMoreTags = sortedTags.length > TAG_SECTION_LIMIT;

  // 左側 TOC の下部にタグ一覧を生成
  if (tocList && Object.keys(tagTotals).length > 0) {
    const tagDivider = document.createElement('div');
    tagDivider.className =
      'toc-tag-section mt-8 font-bold text-slate-400 mb-2 px-2 uppercase text-[10px] tracking-widest flex items-center gap-1';
    tagDivider.innerHTML = `<svg class="w-3 h-3"><use href="#icon-folder"></use></svg> PROJECTS`;
    tocList.appendChild(tagDivider);

    visibleTags.forEach(([tag, data]) => {
      const a = document.createElement('a');
      a.href = '#';
      a.className =
        'toc-tag-section group block px-2 py-1.5 hover:bg-slate-100 rounded transition-colors cursor-pointer flex justify-between items-center';
      a.innerHTML = `
        <span class="text-sm font-medium text-slate-600 group-hover:text-primary transition-colors truncate">${escapeHtml(tag)}</span>
        <span class="text-[10px] tabular-nums tracking-tight font-bold text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded group-hover:bg-white transition-colors">¥${jpyFormatter.format(data.amount)}</span>
      `;
      a.onclick = (e) => {
        e.preventDefault();
        showTagModal(tag, data);
      };
      tocList.appendChild(a);
    });

    if (hasMoreTags) {
      tocList.appendChild(
        createTagToggleButton(
          sortedTags.length,
          'toc-tag-section block w-full text-left px-2 py-1.5 text-xs font-medium text-primary hover:bg-slate-100 rounded transition-colors cursor-pointer',
          tagTotals,
        ),
      );
    }
  }

  // スマホ用のタグ表示エリアを（既存のものがあれば削除して）再生成
  const mainContainer = document.getElementById('blocks-container');
  let mobileTagContainer = document.getElementById('mobile-tag-container');
  if (mobileTagContainer) mobileTagContainer.remove();

  if (Object.keys(tagTotals).length > 0) {
    mobileTagContainer = document.createElement('div');
    mobileTagContainer.id = 'mobile-tag-container';
    mobileTagContainer.className =
      'xl:hidden mt-12 mb-8 bg-white p-6 rounded-xl border border-slate-200 shadow-sm';
    mobileTagContainer.innerHTML = `<h3 class="text-xs font-bold text-slate-400 mb-4 tracking-widest flex items-center gap-1"><svg class="w-4 h-4"><use href="#icon-folder"></use></svg> PROJECTS (TAGS)</h3>`;

    const grid = document.createElement('div');
    grid.className = 'grid grid-cols-2 gap-3';

    visibleTags.forEach(([tag, data]) => {
      const btn = document.createElement('button');
      btn.className =
        'text-left p-3 rounded-lg bg-slate-50 hover:bg-slate-100 border border-slate-100 transition-colors cursor-pointer flex flex-col gap-1';
      btn.innerHTML = `<span class="text-sm font-bold text-slate-700 truncate">${escapeHtml(tag)}</span><span class="text-xs tabular-nums tracking-tight text-slate-500">¥${jpyFormatter.format(data.amount)}</span>`;
      btn.onclick = () => showTagModal(tag, data);
      grid.appendChild(btn);
    });

    mobileTagContainer.appendChild(grid);
    if (hasMoreTags) {
      mobileTagContainer.appendChild(
        createTagToggleButton(
          sortedTags.length,
          'mt-4 w-full text-center py-2 text-xs font-medium text-primary hover:bg-slate-50 rounded-lg transition-colors cursor-pointer',
          tagTotals,
        ),
      );
    }
    mainContainer.appendChild(mobileTagContainer);
  }
}

// DBから期間フィルター適用済みのブロックツリーを構築する
function buildFilteredTree() {
  const res = db.exec(
    'SELECT id, parent_id, memo, amount, created_at, account FROM records ORDER BY sort_order ASC, id ASC',
  );

  const records =
    res.length > 0
      ? res[0].values.map(([id, parent_id, memo, rawAmount, created_at, account]) => {
          // SQLiteの型汚染攻撃 (Type Juggling) を防ぐためのサニタイズ
          let safeAmount = null;
          if (rawAmount !== null && rawAmount !== '') {
            const num = Number(rawAmount);
            safeAmount = Number.isFinite(num) ? num : null;
          }
          return {
            id,
            parent_id,
            memo,
            amount: safeAmount,
            created_at,
            account,
            children: [],
          };
        })
      : [];

  const recordMap = records.reduce((acc, record) => {
    acc[record.id] = record;
    return acc;
  }, {});

  const tree = [];
  records.forEach((record) => {
    if (record.parent_id && recordMap[record.parent_id]) {
      recordMap[record.parent_id].children.push(record);
    } else {
      tree.push(record);
    }
  });

  const periodFilter = document.getElementById('period-filter')?.value || 'all';

  // 配列が指定されているかチェック
  const activeMonths =
    window.currentActiveMonths || (periodFilter !== 'all' ? [periodFilter] : null);

  // 期間フィルターに一致しない明細を除外する
  const filteredTree = [];
  tree.forEach((block) => {
    if (!activeMonths) {
      filteredTree.push(block);
    } else {
      const filteredChildren = block.children.filter((item) => {
        if (!item.created_at) return false;
        // activeMonths配列内のいずれかの文字列で始まっていればOK
        return activeMonths.some((m) => item.created_at.startsWith(m));
      });
      // フィルター条件に合致する明細がある、または新規作成直後の空ブロックの場合は残す
      if (filteredChildren.length > 0 || block.children.length === 0) {
        filteredTree.push({ ...block, children: filteredChildren });
      }
    }
  });

  // 親ブロックを「新しいものが一番上」になるようID降順でソート
  filteredTree.sort((a, b) => b.id - a.id);

  return filteredTree;
}

// 3. ブロック構造の描画
function renderData(focusBlockId = null) {
  if (!db) return;
  const container = document.getElementById('blocks-container');

  updatePeriodDropdown();
  const periodFilter = document.getElementById('period-filter')?.value || 'all';
  const filteredTree = buildFilteredTree();

  // 合計金額ラベルの表記更新
  const filterEl = document.getElementById('period-filter');
  const totalLabelEl = document.getElementById('grand-total-label');
  if (totalLabelEl && filterEl) {
    // 💡 ご指摘に基づき、期間表示をドロップダウンに集約し、ラベルは常に 'Total Amount' に固定
    totalLabelEl.textContent = 'Total Amount';
  }

  // 左側 TOC (目次) の構築
  const tocContainer = document.getElementById('toc-container');
  const tocList = document.getElementById('toc-list');
  if (tocContainer && tocList) {
    const prevScrollTop = tocContainer.scrollTop; // スクロール位置を記憶
    tocList.innerHTML = '';
    tocContainer.querySelectorAll('.toc-tag-section').forEach(el => el.remove());

    filteredTree.forEach((block) => {
      const a = document.createElement('a');
      a.href = `#block-${block.id}`;
      a.className =
        'toc-item block px-2 py-1 hover:text-slate-900 hover:bg-slate-100 rounded truncate transition-colors text-slate-500 cursor-pointer text-sm font-medium';
      a.textContent = block.memo;
      a.title = block.memo;
      a.onclick = (e) => {
        e.preventDefault();
        document
          .getElementById(`block-${block.id}`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
      tocList.appendChild(a);
    });

    // レンダリング後にスクロール位置を復元
    requestAnimationFrame(() => {
      tocContainer.scrollTop = prevScrollTop;
      // 検索フィルターが入力中なら再適用
      const tocFilter = document.getElementById('toc-filter');
      if (tocFilter && tocFilter.value) {
        applyTocFilter(tocFilter.value);
      }
    });
  }

  // ブロック要素の簡易差分更新 (AutoAnimateのチラつき防止)
  const existingBlocks = Array.from(container.children);
  const existingBlockMap = new Map();
  existingBlocks.forEach((el) => {
    if (el.id.startsWith('block-')) {
      const id = parseInt(el.id.replace('block-', ''), 10);
      existingBlockMap.set(id, el);
    } else if (el.id === 'empty-state') {
      el.remove();
    }
  });

  const blockControls = document.getElementById('block-controls');

  if (filteredTree.length === 0) {
    // データがない時はコントロールを隠す
    if (blockControls) {
      blockControls.classList.add('hidden');
      blockControls.classList.remove('flex');
    }

    const isFilterActive = periodFilter !== 'all' || window.currentActiveMonths;
    let emptyHtml = '';
    if (isFilterActive) {
      // フィルター適用時のEmpty State
      emptyHtml = `
        <div id="empty-state" class="flex flex-col items-center justify-center py-20 px-6 text-center border border-slate-200 rounded-3xl bg-slate-50 relative overflow-hidden transition-colors">
           <!-- 洗練された方眼紙（グリッド）パターン背景 -->
           <div class="absolute inset-0 pointer-events-none" style="background-image: linear-gradient(to right, #e2e8f0 1px, transparent 1px), linear-gradient(to bottom, #e2e8f0 1px, transparent 1px); background-size: 24px 24px; opacity: 0.6;"></div>
           <div class="absolute inset-0 pointer-events-none bg-gradient-to-b from-slate-50 via-transparent to-slate-50 opacity-80"></div>

           <div class="relative z-10 flex flex-col items-center">
              <div class="relative flex items-center justify-center mb-6">
                <!-- アイコンの影(shadow-inner)を削除してフラットに -->
                <div class="relative w-16 h-16 bg-slate-200 rounded-full flex items-center justify-center border border-slate-300">
                  <svg class="w-8 h-8 text-slate-500"><use href="#icon-search"></use></svg>
                </div>
              </div>

              <h2 class="text-2xl sm:text-3xl font-extrabold text-slate-900 mb-3 tracking-tight">該当する記録がありません</h2>
              <p class="text-sm text-slate-500 max-w-sm mx-auto leading-relaxed mb-8">
                指定された期間（フィルター）にはデータが存在しません。<br>フィルター条件を変更して再度お試しください。
              </p>

              <button data-action="setPeriodFilter" data-period="all" class="bg-white border border-slate-200 hover:bg-slate-100 text-slate-700 px-6 py-2.5 rounded-full text-sm font-bold shadow-sm transition-all active:scale-95">
                すべての期間を表示
              </button>
           </div>
        </div>
      `;
    } else {
      // 初期状態のウェルカム画面（GrindPeopleスタイル）

      // ✅ File System Access APIの対応状況を自動判定
      const isFsaSupported = 'showSaveFilePicker' in window;
      const browserNoticeHtml = isFsaSupported
        ? `<div class="mt-8 flex flex-col items-center gap-1 text-[11px] text-slate-400">
             <p class="font-bold flex items-center gap-1">
               <svg class="w-3.5 h-3.5"><use href="#icon-sparkles"></use></svg> 推奨ブラウザ環境 (Chrome / Edge)
             </p>
             <p class="opacity-80">ファイルの直接上書き保存（File System API）が有効です</p>
           </div>`
        : `<div class="mt-8 flex flex-col items-center gap-1.5 text-[11px] text-orange-600 bg-orange-50 px-4 py-2.5 rounded-xl border border-orange-200">
             <p class="font-bold flex items-center gap-1 text-xs">
               ⚠️ 推奨ブラウザ: Chrome または Edge
             </p>
             <p class="opacity-90 max-w-[260px] leading-relaxed">現在のブラウザは直接上書き保存に非対応のため、保存時に毎回ダウンロードが発生します。</p>
           </div>`;

      emptyHtml = `
        <div id="empty-state" class="flex flex-col items-center justify-center py-20 px-6 text-center border border-slate-200 rounded-3xl bg-slate-50 relative overflow-hidden transition-colors">
           <!-- 洗練された方眼紙（グリッド）パターン背景 -->
           <div class="absolute inset-0 pointer-events-none" style="background-image: linear-gradient(to right, #e2e8f0 1px, transparent 1px), linear-gradient(to bottom, #e2e8f0 1px, transparent 1px); background-size: 24px 24px; opacity: 0.6;"></div>
           <div class="absolute inset-0 pointer-events-none bg-gradient-to-b from-slate-50 via-transparent to-slate-50 opacity-80"></div>

           <div class="relative z-10 flex flex-col items-center">
              <!-- アイコングループを完全にフラット化 -->
              <div class="relative flex items-center justify-center mb-6">
                <div class="relative w-16 h-16 bg-primary-100 rounded-full flex items-center justify-center border border-blue-200">
                  <svg class="w-8 h-8 text-primary"><use href="#icon-money"></use></svg>
                </div>
              </div>

              <h2 class="text-2xl sm:text-3xl font-extrabold text-slate-900 mb-3 tracking-tight">Welcome to GrindMoney</h2>
              <p class="text-sm text-slate-500 max-w-md mx-auto leading-relaxed mb-8">
                .money ファイルをドラッグ＆ドロップするか、<br>上の入力欄から最初のブロックを作成しましょう。
              </p>

              <!-- ボタンから shadow-blue-500/30 などの光彩を削除し、shadow-sm に統一 -->
              <div class="flex flex-col sm:flex-row items-center gap-3">
                <button data-action="focusNewBlockMemo" class="bg-primary hover:bg-primary-hover text-white px-6 py-3 rounded-full text-sm font-bold shadow-sm transition-all active:scale-95 flex items-center gap-2">
                  <span class="text-lg font-light leading-none mb-0.5">+</span> 新しいブロックを作る
                </button>
                <button data-action="clickCsvInput" class="bg-white hover:bg-primary-50 text-blue-700 border border-blue-200 px-6 py-3 rounded-full text-sm font-bold shadow-sm transition-all active:scale-95 flex items-center gap-2">
                  <svg class="w-4 h-4"><use href="#icon-import"></use></svg> CSVをインポート
                </button>
              </div>

              <!-- ブラウザ推奨の通知 -->
              ${browserNoticeHtml}
           </div>
        </div>
      `;
    }

    container.innerHTML = emptyHtml;
    existingBlockMap.forEach((el) => el.remove());

    let mobileTagContainer = document.getElementById('mobile-tag-container');
    if (mobileTagContainer) mobileTagContainer.remove();

    animateTotal(0);
    renderMemoSuggestions();
    return;
  }

  // データがある時はコントロールを表示
  if (blockControls) {
    blockControls.classList.remove('hidden');
    blockControls.classList.add('flex');
  }

  let currentDomIndex = 0;
  let grandTotal = 0;

  filteredTree.forEach((block) => {
    block.children.forEach((item) => {
      const safeAmount = parseInt(item.amount || 0, 10);

      if (!isSettlementMemo(item.memo)) {
        grandTotal += safeAmount;
      }
    });

    // 既存のDOMがあれば再利用し、なければ新規作成
    let blockEl = existingBlockMap.get(block.id);
    blockEl = updateOrCreateBlockElement(block, blockEl);
    existingBlockMap.delete(block.id);

    // 要素の順序が異なっていればDOM上の位置を修正する
    if (container.children[currentDomIndex] !== blockEl) {
      container.insertBefore(blockEl, container.children[currentDomIndex] || null);
    }
    currentDomIndex++;
  });

  // 存在しなくなった古いブロックを削除
  existingBlockMap.forEach((el) => el.remove());

  // 左側 TOC の下部とスマホ用エリアにタグ（PROJECTS）集計を表示
  renderTagSections(computeTagTotals(filteredTree));

  // 数字のアニメーション更新
  animateTotal(Math.round(grandTotal));

  renderMemoSuggestions();

  if (focusBlockId) {
    const targetInput = document.querySelector(`#block-form-${focusBlockId} .item-memo`);
    if (targetInput) {
      targetInput.focus({ preventScroll: false });
    }
  }

  // --- TOC（目次）の自動ハイライト (Scrollspy) ---
  if (!window.tocObserver) {
    window.tocObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            document.querySelectorAll('.toc-item').forEach((el) => {
              el.classList.remove('text-primary', 'bg-primary-50', 'font-bold');
              el.classList.add('text-slate-500', 'font-medium');
            });
            const activeToc = document.querySelector(`.toc-item[href="#${entry.target.id}"]`);
            if (activeToc) {
              activeToc.classList.remove('text-slate-500', 'font-medium');
              activeToc.classList.add('text-primary', 'bg-primary-50', 'font-bold');
              const tocContainer = document.getElementById('toc-container');
              if (tocContainer && !tocContainer.matches(':hover')) {
                // scrollIntoViewはページ全体のスクロールを阻害してカクつきを生むため、コンテナ内の相対位置で安全にスクロールさせる
                const scrollPos =
                  activeToc.offsetTop - tocContainer.clientHeight / 2 + activeToc.clientHeight / 2;
                tocContainer.scrollTo({
                  top: scrollPos,
                  behavior: 'smooth',
                });
              }
            }
          }
        });
      },
      { rootMargin: '-20% 0px -60% 0px' },
    );
  } else {
    window.tocObserver.disconnect();
  }

  // ブロック要素 (.group/block) のみを安全に監視対象にする
  document.querySelectorAll('.group\\/block').forEach((block) => {
    window.tocObserver.observe(block);
  });
}

function updateOrCreateBlockElement(block, existingEl = null) {
  const blockEl = existingEl || document.createElement('div');
  if (!existingEl) {
    blockEl.id = `block-${block.id}`; // TOCアンカー用
    blockEl.className = 'group/block relative scroll-mt-36 sm:scroll-mt-48';
  }

  const blockTotal = block.children.reduce((sum, item) => {
    return isSettlementMemo(item.memo) ? sum : sum + parseInt(item.amount || 0, 10);
  }, 0);

  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const todayStr = `${yyyy}-${mm}-${dd}`;
  let defaultDate = lastUsedDates[block.id] || todayStr;
  const defaultAccount = lastUsedAccounts[block.id] || '';

  // 年度を計算
  const startMonth = parseInt(getDbSetting('fiscalMonth', '4'), 10);
  let currentFiscalYear = yyyy;
  if (today.getMonth() + 1 < startMonth) {
    currentFiscalYear--;
  }
  // 🎯 フィルター期間外によるリセット（アクティブ消失）を防ぐためのスマート補正
  if (window.currentActiveMonths && window.currentActiveMonths.length > 0) {
    const isInside = window.currentActiveMonths.some((m) => defaultDate.startsWith(m));
    if (!isInside) {
      // フィルター内の最新月（最後の月）の月末日をデフォルトにする
      const sortedMonths = [...window.currentActiveMonths].sort();
      const targetMonth = sortedMonths[sortedMonths.length - 1]; // 例: "2026-03"
      if (targetMonth === `${yyyy}-${mm}`) {
        defaultDate = todayStr; // 今月が含まれているなら今日
      } else {
        const [tYear, tMonth] = targetMonth.split('-');
        const lastDay = new Date(parseInt(tYear, 10), parseInt(tMonth, 10), 0).getDate();
        defaultDate = `${targetMonth}-${String(lastDay).padStart(2, '0')}`; // 例: "2026-03-31"
      }
    }
  }

  let itemsHtml = '';
  block.children.forEach((item) => {
    const isCollection = isSettlementMemo(item.memo);

    let dateDisp = '';
    let badgeHtml = '';
    let yyyy = today.getFullYear();
    if (item.created_at) {
      // 文字列から直接日付をパースして表示（タイムゾーン安全）
      const dStr = item.created_at.split(' ')[0]; // "YYYY-MM-DD"
      const parts = dStr.split('-');
      if (parts.length === 3) {
        const displayYear = escapeHtml(parts[0]);
        const imm = escapeHtml(parts[1]);
        const idd = escapeHtml(parts[2]);

        // 年度判定バッジの生成
        const itemYear = parseInt(parts[0], 10);
        const itemMonth = parseInt(imm, 10);
        let itemFiscalYear = itemYear;
        if (itemMonth < startMonth) itemFiscalYear--;

        const diff = currentFiscalYear - itemFiscalYear;
        if (diff === 1) {
          badgeHtml = `<span class="text-[9px] font-bold px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 mr-1.5 shrink-0 select-none" title="前年度の記録です">前期</span>`;
        } else if (diff >= 2) {
          badgeHtml = `<span class="text-[9px] font-bold px-1.5 py-0.5 rounded bg-slate-200 text-slate-600 mr-1.5 shrink-0 select-none" title="前々期以前の記録です">過年度</span>`;
        }

        let dateClasses =
          'text-xs font-mono mr-2 sm:mr-3 border px-1.5 py-0.5 rounded outline-none focus:ring-2 cursor-text transition-colors';
        let dateTitle = 'クリックして日付を編集';
        if (dStr > todayStr) {
          dateClasses +=
            ' text-red-600 bg-red-50 border-red-200 focus:ring-red-300 hover:bg-red-100 font-bold';
          dateTitle = '未来の日付です（クリックして編集）';
        } else {
          // 決済行の場合は日付の背景色を少し控えめにする
          dateClasses += isCollection
            ? ' text-slate-400 bg-transparent border-transparent hover:bg-slate-100'
            : ' text-slate-500 bg-slate-100 border-slate-200 focus:ring-blue-200 hover:bg-slate-200';
        }

        dateDisp = `${badgeHtml}<span data-id="${item.id}" data-field="created_at" data-year="${displayYear}" contenteditable="true" role="textbox" aria-label="日付（月/日）"    class="${dateClasses}" title="${dateTitle}">${imm}/${idd}</span>`;
      }
    }

    const accStr = item.account || '';
    // 決済行の場合は科目の色をミュートする
    const accClasses = isCollection
      ? 'text-slate-400 bg-transparent border-transparent hover:bg-slate-100 focus:bg-slate-100'
      : 'text-primary bg-primary-50 border-blue-200 hover:bg-primary-100 focus:bg-primary-100';

    let accountDisp = `<input type="text" data-id="${item.id}" data-field="account" aria-label="科目" list="account-suggestions" value="${escapeHtml(accStr)}" placeholder="科目"     class="text-xs px-1.5 py-0.5 rounded mr-2 outline-none focus:ring-2 focus:ring-blue-400 cursor-text transition-colors w-[84px] sm:w-[100px] shrink-0 text-left placeholder-blue-300 border ${accClasses}">`;

    // 決済ボタンの表示制御（すでに決済済みの行には表示しない）
    let checkBtnHtml = '';
    if (!isCollection) {
      checkBtnHtml = `
        <button data-action="createCollectionRecord" data-id="${item.id}" aria-label="決済(回収・支払)済にする" class="text-slate-300 hover:text-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-200 rounded p-1.5 sm:p-2 -m-1 transition-colors cursor-pointer" title="この取引の「決済行」を自動生成する">
          <svg class="w-4 h-4 pointer-events-none"><use href="#icon-check-circle"></use></svg>
        </button>
      `;
    }

    itemsHtml += `
      <div class="flex justify-between items-center px-4 sm:px-8 py-3 sm:py-3.5 border-b border-slate-50 group/item transition-colors ${isCollection ? 'bg-slate-50/60' : 'hover:bg-slate-50/80'}">
        <div class="flex items-center flex-1 min-w-0">
          ${dateDisp}
          ${accountDisp}
          <span data-id="${item.id}" data-field="memo" contenteditable="true" role="textbox" aria-label="メモ"     class="${isCollection ? 'text-slate-500' : 'text-slate-900'} font-medium truncate outline-none focus:bg-primary-50 focus:ring-2 focus:ring-blue-200 px-1 rounded cursor-text transition-colors empty:inline-block empty:min-w-12 empty:bg-slate-100 empty:before:content-['✎_未入力'] empty:before:text-slate-400 empty:before:text-xs empty:before:font-normal empty:before:pointer-events-none empty:focus:before:opacity-50">${escapeHtml(item.memo)}</span>
        </div>
        <div class="flex items-center space-x-1.5 sm:space-x-4 ml-2 sm:ml-auto shrink-0">
          <input type="text" data-id="${item.id}" data-field="amount" aria-label="金額" inputmode="decimal" placeholder="0" value="${item.amount !== null && item.amount !== '' && item.amount !== undefined ? jpyFormatter.format(item.amount) : ''}"      class="bg-transparent border-0 p-0 font-medium tabular-nums tracking-tight ${isCollection ? 'text-slate-400' : 'text-slate-900'} text-right outline-none focus:bg-primary-50 focus:ring-2 focus:ring-blue-200 px-1 rounded cursor-text transition-colors w-[50px] sm:w-[80px]"><span class="text-slate-400 text-xs font-sans hidden sm:inline">円</span>
          <div class="flex items-center space-x-0.5 sm:space-x-1 md:opacity-0 md:group-hover/item:opacity-100 focus-within:opacity-100 transition-opacity">
            ${checkBtnHtml}
            <button data-action="duplicateRecord" data-id="${item.id}" aria-label="複製" class="text-slate-300 hover:text-primary focus:outline-none focus:ring-2 focus:ring-primary/30 rounded p-1.5 sm:p-2 -m-1 transition-colors cursor-pointer" title="複製">
              <svg class="w-4 h-4 pointer-events-none"><use href="#icon-copy"></use></svg>
            </button>
            <button data-action="deleteRecord" data-id="${item.id}" aria-label="削除" class="text-slate-300 hover:text-red-500 focus:outline-none focus:ring-2 focus:ring-red-200 rounded transition-colors text-xl sm:text-2xl leading-none p-1.5 sm:p-2 -m-1 cursor-pointer" title="削除">&times;</button>
          </div>
        </div>
      </div>
    `;
  });

  const isCollapsed = collapsedBlocks.has(block.id);
  const maxH = isCollapsed ? '0px' : '99999px';
  const op = isCollapsed ? '0' : '1';
  const iconRotation = isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)';

  // ブロック全体が前期・過年度の場合、タイトル横にもバッジを出す
  let blockBadgeHtml = '';
  if (block.children.length > 0) {
    let diffs = block.children.map((item) => {
      if (!item.created_at) return null; // Exclude
      const parts = item.created_at.split(' ')[0].split('-');
      if (parts.length !== 3) return null;
      const itemYear = parseInt(parts[0], 10);
      const itemMonth = parseInt(parts[1], 10);
      let itemFiscalYear = itemYear;
      if (itemMonth < startMonth) itemFiscalYear--;
      return currentFiscalYear - itemFiscalYear;
    });
    const validDiffs = diffs.filter((d) => d !== null && !isNaN(d));
    if (validDiffs.length > 0) {
      // ⚠️ スプレッド構文は引数の数に上限があり、数万件のデータでRangeErrorを引き起こすため、
      // 安全な reduce を使って最小値を計算する
      const minDiff = validDiffs.reduce((min, curr) => Math.min(min, curr), Infinity);

      if (minDiff === 1) {
        blockBadgeHtml = `<span class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 ml-2 shrink-0 select-none" title="このブロックは前年度のデータです">前期</span>`;
      } else if (minDiff >= 2) {
        blockBadgeHtml = `<span class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-200 text-slate-600 ml-2 shrink-0 select-none" title="このブロックは前々期以前のデータです">過年度</span>`;
      }
    }
  }

  let dateInputClass =
    'item-date appearance-none bg-transparent border-0 focus:ring-0 p-0 text-xs w-[110px] text-center outline-none cursor-pointer transition-colors';
  if (defaultDate > todayStr) {
    dateInputClass += ' text-red-600 font-bold bg-red-50 rounded';
  } else {
    dateInputClass += ' text-slate-600 bg-transparent';
  }

  // Preserve in-progress add-form values across re-renders
  const existingForm = existingEl ? document.getElementById(`block-form-${block.id}`) : null;
  const formDraft = existingForm
    ? {
        date: existingForm.querySelector('.item-date')?.value ?? '',
        account: existingForm.querySelector('.item-account')?.value ?? '',
        memo: existingForm.querySelector('.item-memo')?.value ?? '',
        amount: existingForm.querySelector('.item-amount')?.value ?? '',
      }
    : null;

  blockEl.innerHTML = `
    <button data-action="saveTemplate" data-block-id="${block.id}" class="absolute -top-3 -left-3 opacity-100 md:opacity-0 group-hover/block:opacity-100 bg-white border border-slate-200 text-slate-400 hover:text-primary hover:border-primary/50 hover:shadow-[0_0_15px_rgba(37,99,235,0.3)] hover:scale-110 p-2 rounded-xl transition-all duration-300 cursor-pointer flex items-center justify-center z-10" title="このブロックをテンプレートとして保存">
      <svg class="w-5 h-5"><use href="#icon-squares-plus"></use></svg>
    </button>
    <div class="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden transition-all hover:border-slate-300 hover:shadow-md">
    <div data-action="toggleBlock" data-block-id="${block.id}" class="bg-slate-50/50 px-8 py-5 border-b border-slate-100 flex justify-between items-center transition-colors cursor-pointer select-none group/header hover:bg-slate-100">
      <div class="flex items-center gap-3 overflow-hidden">
        <svg id="block-icon-${block.id}" class="w-5 h-5 text-slate-400 transition-transform duration-200" style="transform: ${iconRotation};"><use href="#icon-chevron-down"></use></svg>
        <h2 data-id="${block.id}" data-field="memo" contenteditable="true"      class="select-text text-xl font-extrabold text-slate-900 tracking-tight outline-none focus:bg-white focus:ring-2 focus:ring-primary/30 px-1 rounded cursor-text truncate transition-colors empty:inline-block empty:min-w-20 empty:bg-slate-100 empty:before:content-['✎_タイトル未入力'] empty:before:text-slate-400 empty:before:text-sm empty:before:font-normal empty:before:pointer-events-none empty:focus:before:opacity-50">${escapeHtml(block.memo)}</h2>
        ${blockBadgeHtml}
      </div>
      <div class="flex items-center shrink-0">
        <div class="font-bold tabular-nums tracking-tight text-slate-900 text-lg"><span id="block-total-${block.id}">${jpyFormatter.format(blockTotal)}</span> <span class="text-slate-400 text-sm font-sans">円</span></div>
        <div class="flex items-center pl-4 border-l border-slate-200/50 ml-4 shrink-0 h-8">
          <button data-action="sortBlockByDate" data-block-id="${block.id}" aria-label="日付順に並べ替え" class="w-8 h-8 flex items-center justify-center rounded text-slate-300 hover:bg-slate-100 hover:text-slate-600 md:opacity-0 md:group-hover/block:opacity-100 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-slate-200 transition-all cursor-pointer mr-1 ${block.children.length < 2 ? 'opacity-30 pointer-events-none md:!opacity-30' : ''}" title="日付の古い順に並べ替える">
            <svg class="w-5 h-5"><use href="#icon-sort"></use></svg>
          </button>
          <button data-action="deleteRecord" data-id="${block.id}" data-is-block="true" aria-label="ブロックを削除" class="w-8 h-8 flex items-center justify-center rounded text-slate-300 hover:bg-red-50 hover:text-red-500 md:opacity-0 md:group-hover/block:opacity-100 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-red-200 transition-all cursor-pointer" title="ブロックを丸ごと削除">
            <svg class="w-5 h-5"><use href="#icon-trash"></use></svg>
          </button>
        </div>
      </div>
    </div>
    <div id="block-body-${block.id}" class="transition-all duration-300 ease-in-out overflow-hidden" style="max-height: ${maxH}; opacity: ${op};">
      <div class="">${itemsHtml}</div>
      <div class="px-8 py-4 bg-white transition-colors">
      <form id="block-form-${block.id}" class="block-form flex flex-wrap sm:flex-nowrap items-center gap-2 sm:gap-3 px-3 py-2 -mx-3 rounded-md transition-all focus-within:bg-slate-50 focus-within:ring-1 focus-within:ring-slate-200" data-block-id="${block.id}">
        <span class="text-primary text-xl leading-none font-light hidden sm:inline">+</span>

        <div class="flex items-center gap-2 sm:gap-3 w-full sm:w-auto">
          <button type="submit" aria-label="明細を追加" class="text-primary bg-primary/10 hover:bg-primary/20 rounded-full w-8 h-8 flex items-center justify-center text-xl leading-none font-light sm:hidden transition-colors outline-none focus:ring-2 focus:ring-primary/50 shrink-0">+</button>
          <div class="flex items-center bg-slate-50 rounded-md px-1 py-1 border border-slate-200 transition-colors">
            <button type="button" data-action="adjustDate" data-delta="-1" aria-label="1日戻す" class="text-slate-400 hover:text-slate-800 w-8 h-8 flex items-center justify-center font-bold cursor-pointer outline-none transition-colors touch-manipulation" title="-1日">-</button>
            <input type="date" aria-label="追加する明細の日付" class="${dateInputClass}" value="${defaultDate}">
            <button type="button" data-action="adjustDate" data-delta="1" aria-label="1日進める" class="text-slate-400 hover:text-slate-800 w-8 h-8 flex items-center justify-center font-bold cursor-pointer outline-none transition-colors touch-manipulation" title="+1日">+</button>
          </div>
          <input type="text" aria-label="追加する明細の科目" placeholder="科目" value="${escapeHtml(defaultAccount)}" list="account-suggestions"    class="item-account bg-transparent border-0 focus:ring-0 p-0 text-slate-600 placeholder-slate-400 w-20 shrink-0 text-sm outline-none text-center" style="min-width: 60px;">
        </div>

        <div class="flex items-center gap-2 sm:gap-3 w-full sm:w-auto sm:flex-1 pl-6 sm:pl-0 mt-2 sm:mt-0">
          <input type="text" aria-label="追加する明細のメモ" placeholder="明細を追加..." list="memo-suggestions"     class="item-memo bg-transparent border-0 focus:ring-0 p-0 text-slate-900 placeholder-slate-400 flex-1 text-sm font-medium outline-none min-w-[100px]">
          <input type="text" aria-label="追加する明細の金額（数式可）" inputmode="decimal" placeholder="金額(数式OK)" class="item-amount bg-transparent border-0 focus:ring-0 p-0 text-right tabular-nums tracking-tight text-slate-900 placeholder-slate-400 w-24 sm:w-32 shrink-0 text-sm outline-none" style="min-width: 104px;"    title="数式計算（+ - * /）が使えます">
        </div>
        <button type="submit" class="hidden">追加</button>
      </form>
      </div>
    </div>
  `;

  if (formDraft) {
    const form = blockEl.querySelector(`#block-form-${block.id}`);
    if (form) {
      const dateEl = form.querySelector('.item-date');
      const accountEl = form.querySelector('.item-account');
      const memoEl = form.querySelector('.item-memo');
      const amountEl = form.querySelector('.item-amount');
      if (dateEl) dateEl.value = formDraft.date;
      if (accountEl) accountEl.value = formDraft.account;
      if (memoEl) memoEl.value = formDraft.memo;
      if (amountEl) amountEl.value = formDraft.amount;
    }
  }
  return blockEl;
}

// --- テンプレート（1Shot生成）機能 ---
async function saveTemplate(blockId) {
  if (!db) return;

  // ブロックのタイトルを取得
  let blockMemo = '名称未設定';
  let blockStmt;
  try {
    blockStmt = db.prepare('SELECT memo FROM records WHERE id = ?');
    blockStmt.bind([blockId]);
    if (blockStmt.step()) {
      blockMemo = blockStmt.get()[0] || '名称未設定';
    } else {
      return;
    }
  } finally {
    if (blockStmt) blockStmt.free();
  }

  // 子要素（明細）の構成を取得
  let items = [];
  let itemsStmt;
  try {
    itemsStmt = db.prepare(
      'SELECT memo, account, amount FROM records WHERE parent_id = ? ORDER BY sort_order ASC, id ASC',
    );
    itemsStmt.bind([blockId]);
    while (itemsStmt.step()) {
      const row = itemsStmt.get();
      items.push({
        memo: row[0],
        account: row[1],
        amount: row[2],
      });
    }
  } finally {
    if (itemsStmt) itemsStmt.free();
  }

  let tplName = (await appPrompt(
    'このブロックをテンプレートとして保存します。\n呼び出し用の名前を入力してください:',
    blockMemo + ' (雛形)',
  ));
  if (!tplName) return;

  let stmt;
  try {
    stmt = db.prepare('INSERT INTO templates (name, data) VALUES (?, ?)');
    stmt.run([tplName, JSON.stringify(items)]);
  } finally {
    if (stmt) stmt.free();
  }
  setDirty(true);
  await appAlert(
    `✅ テンプレート「${tplName}」を保存しました。\nコマンドパレット(Cmd+K)からいつでも一発で呼び出せます。`,
  );
}

async function insertTemplate(templateId) {
  if (!db) return;

  let tplName = '';
  let rawData = '[]';
  let stmt;
  try {
    stmt = db.prepare('SELECT name, data FROM templates WHERE id = ?');
    stmt.bind([templateId]);
    if (!stmt.step()) return;
    const row = stmt.get();
    tplName = row[0];
    rawData = row[1];
  } finally {
    if (stmt) stmt.free();
  }

  let tplData = [];
  try {
    tplData = JSON.parse(rawData || '[]');
  } catch (e) {
    await appAlert('テンプレートデータの読み込みに失敗しました。データが破損している可能性があります。');
    return;
  }

  // 万が一パース結果がオブジェクト等で配列でない場合のクラッシュ(TypeError)を防止
  if (!Array.isArray(tplData)) {
    await appAlert('テンプレートデータが破損しています（配列ではありません）。');
    return;
  }

  // Validate every item before inserting anything, so a broken template never leaves an empty block
  const items = [];
  for (const item of tplData) {
    if (!item || typeof item !== 'object') {
      await appAlert('テンプレートデータが破損しています（不正な明細が含まれています）。');
      return;
    }
    const memo = typeof item.memo === 'string' ? item.memo : '';
    const account = typeof item.account === 'string' ? item.account : null;
    // テンプレート保存時の金額をそのまま展開する（固定費などで便利にするため）
    let amount = null;
    if (typeof item.amount === 'number' && Number.isFinite(item.amount)) {
      amount = Math.trunc(item.amount);
    } else if (typeof item.amount === 'string' && /^-?\d+$/.test(item.amount.trim())) {
      amount = parseInt(item.amount.trim(), 10);
    } else if (item.amount !== '' && item.amount !== undefined && item.amount !== null) {
      await appAlert('テンプレートデータが破損しています（金額が数値ではありません）。');
      return;
    }
    items.push({ memo, amount, account });
  }

  const dateStr = `${getTodayString()} 00:00:00`;

  let insertStmt = null;
  let parentId;
  db.run('BEGIN TRANSACTION;');
  try {
    db.run('INSERT INTO records (memo, amount) VALUES (?, ?)', [String(tplName || ''), null]);
    const parentRes = db.exec('SELECT last_insert_rowid()');
    parentId = parentRes[0].values[0][0];

    insertStmt = db.prepare(
      'INSERT INTO records (parent_id, memo, amount, account, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    for (const item of items) {
      insertStmt.run([parentId, item.memo, item.amount, item.account, dateStr]);
    }
    db.run('COMMIT;');
  } catch (e) {
    db.run('ROLLBACK;');
    console.error('Template insert failed', e);
    await appAlert('テンプレートの展開に失敗しました。');
    return;
  } finally {
    if (insertStmt) insertStmt.free();
  }

  // フィルター外の日付を追加した場合、自動で「すべての期間」に表示を戻すフェイルセーフ
  showAllPeriodsIfOutsideFilter(dateStr);

  setDirty(true);
  renderData(parentId);
}

// 3.5 データの削除（DELETE文の実行）
async function deleteRecord(id, isBlock = false) {
  const msg = isBlock 
    ? '⚠️ 警告 ⚠️\nこのブロックを削除しますか？\n（中に含まれるすべての明細データも完全に削除されます）'
    : 'この記録を削除しますか？';
  if (!(await appConfirm(msg))) return;
  let stmt;
  try {
    stmt = db.prepare('DELETE FROM records WHERE id = ? OR parent_id = ?');
    stmt.run([id, id]);
  } finally {
    if (stmt) stmt.free();
  }

  // ゾンビステートのクリーンアップ
  collapsedBlocks.delete(id);
  delete lastUsedDates[id];
  delete lastUsedAccounts[id];

  setDirty(true);
  renderData();
}

// 手動でブロック内の明細を日付順に並べ替える
async function sortBlockByDate(blockId) {
  if (!db) return;
  if (
    !(await appConfirm(
      'このブロック内の明細を「日付が古い順」に並べ替えますか？\n（同じ日付の場合は入力した順になります）',
    ))
  )
    return;

  let stmt;
  let items = [];
  try {
    stmt = db.prepare('SELECT id, created_at FROM records WHERE parent_id = ?');
    stmt.bind([blockId]);
    while (stmt.step()) {
      const [id, created_at] = stmt.get();
      items.push({ id, created_at: created_at || '' });
    }
  } finally {
    if (stmt) stmt.free();
  }

  items.sort((a, b) => {
    if (a.created_at < b.created_at) return -1;
    if (a.created_at > b.created_at) return 1;
    return a.id - b.id; // 日付が同じなら元の順序を維持
  });

  let updateStmt;
  try {
    updateStmt = db.prepare('UPDATE records SET sort_order = ? WHERE id = ?');
    items.forEach((item, index) => {
      updateStmt.run([index, item.id]);
    });
    setDirty(true);
    renderData();
    showToast('日付順に並べ替えました', '🧹');
  } catch (e) {
    console.error('Failed to reorder', e);
  } finally {
    if (updateStmt) updateStmt.free();
  }
}

// 3.6 明細の複製
function duplicateRecord(id) {
  if (!db) return;

  let stmt;
  let insertStmt;
  try {
    stmt = db.prepare(
      'SELECT parent_id, memo, amount, account, created_at, sort_order, source_id FROM records WHERE id = ?',
    );
    stmt.bind([id]);
    if (stmt.step()) {
      const [parent_id, memo, amount, account, created_at, sort_order, source_id] = stmt.get();

      // 決済行を複製した場合（分割払いなど）も、同じ発生行への紐づけを引き継ぐ
      insertStmt = db.prepare(
        'INSERT INTO records (parent_id, memo, amount, account, created_at, sort_order, source_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      insertStmt.run([parent_id, memo, amount, account, created_at, sort_order, source_id]);

      // 新しく挿入されたレコードのIDを取得
      const res = db.exec('SELECT last_insert_rowid()');
      const newId = res[0].values[0][0];

      setDirty(true);
      renderData();

      showToast('明細を複製しました', '<span class="text-green-400">📋</span>');

      // 画面の再描画が終わった直後に、新しい行の日付にフォーカスを当てて全選択する
      requestAnimationFrame(() => {
        const newDateEl = document.querySelector(
          `span[data-id="${newId}"][data-field="created_at"]`,
        );
        if (newDateEl) {
          newDateEl.focus();
          window.getSelection().selectAllChildren(newDateEl);
        }
      });
    }
  } catch (e) {
    console.error('Duplicate failed:', e);
  } finally {
    if (stmt) stmt.free();
    if (insertStmt) insertStmt.free();
  }
}

// 4. 【核心部】 File System Access API を使った保存
async function saveGrindFile(isSaveAs = false) {
  if (!db) return;
  if (isSaving) return;
  isSaving = true;

  // 🎯 Gold-Rank: 現在フォーカス中の要素を特定・記憶する
  let activeSelector = null;
  const activeEl = document.activeElement;
  if (
    activeEl &&
    typeof activeEl.blur === 'function' &&
    activeEl.tagName !== 'BODY' &&
    activeEl.id !== 'cmd-input'
  ) {
    if (
      typeof activeEl.hasAttribute === 'function' &&
      activeEl.hasAttribute('data-id') &&
      activeEl.hasAttribute('data-field')
    ) {
      activeSelector = `[data-id="${activeEl.getAttribute('data-id')}"][data-field="${activeEl.getAttribute('data-field')}"]`;
    } else if (activeEl.classList.contains('item-memo')) {
      const form = activeEl.closest('form');
      if (form) activeSelector = `#${form.id} .item-memo`;
    } else if (activeEl.classList.contains('item-amount')) {
      const form = activeEl.closest('form');
      if (form) activeSelector = `#${form.id} .item-amount`;
    } else if (activeEl.classList.contains('item-account')) {
      const form = activeEl.closest('form');
      if (form) activeSelector = `#${form.id} .item-account`;
    } else if (activeEl.classList.contains('item-date')) {
      const form = activeEl.closest('form');
      if (form) activeSelector = `#${form.id} .item-date`;
    } else if (activeEl.id) {
      activeSelector = `#${activeEl.id}`;
    }
    activeEl.blur(); // 一旦フォーカスを外してDBに値を確定(UPDATE)させる
  }

  try {
    // ★ 抽出前にDBをデフラグし、ファイルサイズを最小化する
    db.run('VACUUM');

    let data = db.export();
    const epochAtExport = dirtyEpoch;
    const hasPasswordSet = currentMasterKey !== null;
    const currentHash = currentMasterKeyHash;

    // 【セキュリティ修正 1】: パスワードを空にして暗号化を解除しようとした場合の警告
    if (lastSavedPasswordHash !== '' && !hasPasswordSet) {
      if (
        !(await appConfirm(
          '⚠️ 警告 ⚠️\nパスワードが解除されています。\nこのまま保存すると、ファイルの暗号化が解除され「平文」で保存されます。\n\n本当に暗号化を解除して保存しますか？',
        ))
      ) {
        await appAlert('保存を中断しました。もう一度パスワードを設定してください。');
        isSaving = false;
        return;
      }
    }

    // 【セキュリティ修正 2】: 新規パスワード設定時、または変更時の「確認ダイアログ」
    if (hasPasswordSet && currentHash !== lastSavedPasswordHash) {
      const confirmPw = await requestPasswordPrompt(
        '🔒 新しいパスワードを設定（または変更）します。\n確認のため、同じパスワードをもう一度入力してください:',
      );
      if (confirmPw === null) {
        isSaving = false;
        return;
      } // キャンセル
      const confirmHash = await getPasswordHash(confirmPw);
      if (confirmHash !== currentHash) {
        await appAlert('❌ パスワードが一致しません。保存を中止しました。');
        isSaving = false;
        return;
      }
    }

    if (hasPasswordSet) {
      data = await encryptData(data, currentMasterKey);
    }

    // 保存成功時の視覚的なタクタイル・フィードバックを共通化
    const showSaveSuccessFeedback = () => {
      const saveBtn = document.getElementById('btn-save');
      if (saveBtn) {
        const iconSvg = saveBtn.querySelector('svg');
        if (iconSvg && !iconSvg.hasAttribute('data-animating')) {
          iconSvg.setAttribute('data-animating', 'true');
          // 万が一の重複を防ぐためハードコードで復元元を指定
          const originalUse = `<use href="#icon-save"></use>`;
          iconSvg.innerHTML = `<use href="#icon-check"></use>`;
          iconSvg.classList.add('text-green-500', 'scale-125');
          saveBtn.classList.add('ring-2', 'ring-green-500/20', 'bg-green-50');

          setTimeout(() => {
            iconSvg.innerHTML = originalUse;
            iconSvg.classList.remove('text-green-500', 'scale-125');
            saveBtn.classList.remove('ring-2', 'ring-green-500/20', 'bg-green-50');
            iconSvg.removeAttribute('data-animating');
          }, 1500);
        }
      }
    };

    if (isSaveAs || !fileHandle || fileHandle.isDummy) {
      if ('showSaveFilePicker' in window) {
        try {
          const todayStr = getTodayString().replace(/-/g, '');
          fileHandle = await window.showSaveFilePicker({
            suggestedName: `GrindMoney_${todayStr}.money`,
            types: [
              {
                description: 'GrindMoney Database',
                accept: { 'application/x-sqlite3': ['.money'] },
              },
            ],
          });
        } catch (err) {
          if (err && err.name !== 'AbortError') {
            showToast(
              '保存先の選択に失敗しました',
              '<span class="text-red-400">❌</span>',
            );
          }
          return;
        }
      } else {
        // API非対応ブラウザ向けのフォールバック保存
        const blob = new Blob([data], { type: 'application/x-sqlite3' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const todayStr = getTodayString().replace(/-/g, '');
        a.download = fileHandle && fileHandle.name ? fileHandle.name : `GrindMoney_${todayStr}.money`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);

        if (dirtyEpoch === epochAtExport) setDirty(false);
        clearMigratedLocalStorageIfPresent();
        showToast(
          `データを "${a.download}" としてダウンロードしました`,
          '<span class="text-green-400">💾</span>',
        );
        showSaveSuccessFeedback();
        lastSavedPasswordHash = currentHash;
        return;
      }
    }

    // --- File System権限の「サイレント没収」からのリカバリ ---
    if (fileHandle && !fileHandle.isDummy) {
      try {
        const permission = await fileHandle.queryPermission({
          mode: 'readwrite',
        });
        if (permission !== 'granted') {
          const request = await fileHandle.requestPermission({
            mode: 'readwrite',
          });
          if (request !== 'granted') {
            throw new Error('書き込み権限が拒否されました');
          }
        }
      } catch (e) {
        await appAlert(
          'ファイルの書き込み権限が取得できませんでした。時間経過によりブラウザが権限を取り消した可能性があります。\n\n「複製して保存する (Save As)」をお試しください。',
        );
        return; // 権限がなければクラッシュを防ぐため中断
      }
    }

    const writable = await fileHandle.createWritable();
    await writable.write(data);
    await writable.close();
    if (dirtyEpoch === epochAtExport) setDirty(false);
    clearMigratedLocalStorageIfPresent();

    showToast(
      `データを "${fileHandle.name}" に保存しました`,
      '<span class="text-green-400">💾</span>',
    );
    showSaveSuccessFeedback();
    lastSavedPasswordHash = currentHash;
  } catch (err) {
    console.error('Save failed:', err);
    showToast(
      'エラー: ファイルの保存に失敗しました。容量や権限を確認してください',
      '<span class="text-red-400">❌</span>',
    );
  } finally {
    isSaving = false;

    // 🎯 Gold-Rank: 保存が終わったら、超高速でフォーカスを元の位置に戻す
    if (activeSelector) {
      requestAnimationFrame(() => {
        try {
          const el = document.querySelector(activeSelector);
          if (el) {
            el.focus({ preventScroll: true });
            // contenteditable要素なら、カーソルを一番最後に移動させる魔法
            if (el.hasAttribute('contenteditable')) {
              const range = document.createRange();
              const sel = window.getSelection();
              range.selectNodeContents(el);
              range.collapse(false);
              sel.removeAllRanges();
              sel.addRange(range);
            }
          }
        } catch (e) {
          console.warn('Skipped restoring focus (invalid selector)', e);
        }
      });
    }
  }
}

// 5. 【核心部】 ファイル読み込みの共通処理
async function processFileHandle(handle, isDummy = false) {
  if (!SQL) {
    await appAlert('データベースエンジンを起動中です。数秒待ってから再度お試しください。');
    return;
  }

  // 読み込みに失敗・中断した場合に、開いているファイルのパスワード状態を元に戻すための退避
  const prevMasterKey = currentMasterKey;
  const prevMasterKeyHash = currentMasterKeyHash;
  const restorePasswordState = () => {
    currentMasterKey = prevMasterKey;
    currentMasterKeyHash = prevMasterKeyHash;
    updatePasswordUI();
  };
  let committed = false; // 新しいDBへの切り替えが完了したか

  try {
    const file = await handle.getFile();

    // 巨大ファイルによるOOMクラッシュを防止
    if (file.size > 50 * 1024 * 1024) {
      await appAlert('ファイルサイズが大きすぎます（50MB上限）。不正なファイルの可能性があります。');
      return;
    }

    const arrayBuffer = await file.arrayBuffer();
    let Uints = new Uint8Array(arrayBuffer);

    const magic = Uints.slice(0, 8);
    const magicStr = new TextDecoder().decode(magic);
    const isEncrypted = magicStr === 'GRINDENC' || magicStr === 'GRINDEN2';

    if (isEncrypted) {
      let keyMaterial = currentMasterKey;
      let success = false;
      while (!success) {
        try {
          if (!keyMaterial) {
            throw new Error('Need password'); // Force prompt if no key
          }
          Uints = await decryptData(Uints, keyMaterial);
          success = true;
        } catch (err) {
          const promptPw = await requestPasswordPrompt(
            'ファイルは暗号化されています。解除パスワードを入力してください:',
          );
          if (promptPw === null) {
            restorePasswordState(); // 誤入力したパスワードを、開いているファイルに残さない
            return; // キャンセルして処理を中断
          }
          
          await setMasterPassword(promptPw);
          keyMaterial = currentMasterKey;
        }
      }
    }

    let newDb;
    try {
      newDb = new SQL.Database(Uints);
      if (!hasRecordsTable(newDb)) throw new Error('records table not found');
    } catch (e) {
      if (newDb) newDb.close();
      throw new Error('Invalid GrindMoney database file.');
    }

    // 読み込みが確定してから、パスワード状態を新しいファイルに合わせる
    if (isEncrypted) {
      lastSavedPasswordHash = currentMasterKeyHash;
    } else {
      lastSavedPasswordHash = '';
      await setMasterPassword('');
    }

    if (db) {
      db.close();
    }
    db = newDb;
    committed = true;
    migrateDatabase();

    // Block ids repeat across files: drop old block elements so their form input is not carried over
    document.querySelectorAll('#blocks-container > [id^="block-"]').forEach((el) => el.remove());

    loadSettingsFromDb(); // ファイル固有の設定をUIに反映

    // 🎯 ファイル切り替え時のグローバル状態完全リセット（データ汚染防止）
    lastUsedDates = {};
    lastUsedAccounts = {};
    collapsedBlocks.clear();
    window.currentActiveMonths = null;
    currentDisplayedTotal = 0;

    const filterEl = document.getElementById('period-filter');
    if (filterEl) filterEl.value = 'all';
    setActiveQuickPeriodButton(null);

    // UI更新の前にハンドルをセットして正しいファイル名を反映させる
    fileHandle = handle;
    setDirty(false);

    showToast(
      `ファイル "${file.name}" を読み込みました`,
      '<span class="text-blue-400">📂</span>',
    );

    // 【パフォーマンス対策】ファイル読み込み時も同様にデフォルト期間を最適化
    const countRes = db.exec('SELECT COUNT(*) FROM records');
    const recordCount = countRes.length > 0 ? countRes[0].values[0][0] : 0;
    if (recordCount > 50) {
      setFiscalYearFilter();
    } else {
      renderData();
    }
  } catch (err) {
    console.error('processFileHandle error:', err);
    // 読み込み前のファイルを開いたままなので、パスワード状態も元に戻す
    if (!committed) restorePasswordState();
    await appAlert('ファイルの読み込みに失敗しました。');
  }
}

// 5.1 「開く」ボタンから File System Access API を使った読み込み
async function loadGrindFile() {
  if (isDirty) {
    if (!(await appConfirm('未保存のデータがあります。変更を破棄して別のファイルを開きますか？'))) return;
  }

  if ('showOpenFilePicker' in window) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [
          {
            description: 'GrindMoney Database',
            accept: {
              'application/x-sqlite3': ['.money', '.grind', '.sqlite'],
            },
          },
        ],
        multiple: false,
      });
      await processFileHandle(handle);
    } catch (err) {}
  } else {
    // Safari / Firefox 等のフォールバック (input type="file" を使う)
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.money,.grind,.sqlite';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      // ダミーハンドルを作って共通処理へ流す
      const dummyHandle = {
        getFile: async () => file,
        name: file.name,
        isDummy: true,
      };
      await processFileHandle(dummyHandle, true);
    };
    input.click();
  }
}

// エクスポートモーダルの制御
function showExportModal() {
  const modal = document.getElementById('export-modal');

  // 現在の抽出対象期間をモーダルに表示する
  const infoEl = document.getElementById('export-period-info');
  if (infoEl) {
    const filterEl = document.getElementById('period-filter');
    let periodText = 'すべての期間';

    if (window.currentActiveMonths && window.currentActiveMonths.length > 0) {
      const sorted = [...window.currentActiveMonths].sort();
      const formatMonth = (ym) => {
        const [y, m] = ym.split('-');
        return `${y}年${parseInt(m, 10)}月`;
      };
      periodText = `${formatMonth(sorted[0])} 〜 ${formatMonth(sorted[sorted.length - 1])}`;
    } else if (filterEl && filterEl.value !== 'all') {
      periodText = filterEl.options[filterEl.selectedIndex].text;
    }
    infoEl.innerHTML = `💡 現在表示中の <b>「${escapeHtml(periodText)}」</b> が出力されます。`;
  }

  modal.classList.remove('hidden');
  modal.classList.add('flex');
  window.isSystemModalOpen = true;
  document.body.style.overflow = 'hidden';
  setAppInert(true);
}

function closeExportModal() {
  const modal = document.getElementById('export-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
  if (!document.querySelector('.flex[role="dialog"]')) {
    window.isSystemModalOpen = false;
    document.body.style.overflow = '';
  }
  setAppInert(false);
}

function executeExport() {
  const format = document.getElementById('export-format').value;
  closeExportModal();
  exportCSV(format);
}

// 6. CSVエクスポート
async function exportCSV(format = 'yayoi') {
  if (!db) return;

  const filterVal = document.getElementById('period-filter')?.value || 'all';
  let whereClause = '';
  let params = [];

  if (window.currentActiveMonths) {
    const orConditions = window.currentActiveMonths
      .map((m) => {
        params.push(`${m}%`);
        return 'c.created_at LIKE ?';
      })
      .join(' OR ');
    whereClause = ` AND (${orConditions})`;
  } else if (filterVal !== 'all') {
    whereClause = ` AND c.created_at LIKE ?`;
    params.push(`${filterVal.replace(/[^0-9-]/g, '')}%`);
  }

  let query = `SELECT c.id,
    CASE
      WHEN p.memo = 'CSVインポート' OR p.memo IS NULL OR p.memo = '' THEN COALESCE(c.memo, '')
      WHEN c.memo IS NOT NULL AND c.memo != '' THEN COALESCE(p.memo, '') || ' - ' || c.memo
      ELSE COALESCE(p.memo, '')
    END AS memo,
    c.amount, c.created_at, c.account,
    c.memo AS child_memo
    FROM records c JOIN records p ON c.parent_id = p.id
    WHERE c.parent_id IS NOT NULL${whereClause} ORDER BY c.id ASC`;

  const values = [];
  let exportStmt;
  try {
    exportStmt = db.prepare(query);
    exportStmt.bind(params);
    while (exportStmt.step()) {
      values.push(exportStmt.get());
    }
  } finally {
    if (exportStmt) exportStmt.free();
  }

  if (values.length === 0) {
    await appAlert('エクスポートするデータがありません。');
    return;
  }

  const includeCollection = document.getElementById('export-collections')?.checked;
  const isCollectionMemo = isSettlementMemo;

  // 決済行と元の発生行の対応（期間フィルターに関係なく、ファイル全体から求める）
  const { sourceOf, sourceInfo } = getCollectionSources();
  const settledIds = new Set(sourceOf.values());

  // 決済行の元の発生行に、タグで指定された相手科目（特定できない場合は null）
  const sourcePartnerOf = (collectionId) => {
    const info = sourceInfo.get(sourceOf.get(collectionId));
    return info ? getTaggedPartnerAccount(info.tagMemo, info.isIncome) : null;
  };
  // #現金 / #預金 / #振込 の行は、発生時点で支払い（入金）が済んでいる
  const isPaidOnTheSpotPartner = (partner) => partner === '現金' || partner === '普通預金';

  // 出力対象を確定する（金額が空欄の行は未入力とみなして除外し、明示的な 0 円は残す）
  let blankAmountCount = 0;
  let paidOnTheSpotCollectionCount = 0;
  const rowsToExport = values.filter((row) => {
    if (row[2] === null || row[2] === '') {
      blankAmountCount++;
      return false;
    }
    if (isCollectionMemo(row[5])) {
      // 「自動連携しているため決済行は出力しない」設定の場合はスキップ
      if (!includeCollection) return false;
      // その場で支払済みの行の決済行は、同じ支払いを二重に計上するため出力しない
      if (isPaidOnTheSpotPartner(sourcePartnerOf(row[0]))) {
        paidOnTheSpotCollectionCount++;
        return false;
      }
    }
    return true;
  });

  const exclusionNotes = [];
  if (blankAmountCount > 0) exclusionNotes.push(`金額未入力の${blankAmountCount}件を除外しました`);
  if (paidOnTheSpotCollectionCount > 0) {
    exclusionNotes.push(
      `その場で支払済みの行に決済行があるため、決済行${paidOnTheSpotCollectionCount}件を除外しました`,
    );
  }

  if (rowsToExport.length === 0) {
    await appAlert(
      exclusionNotes.length > 0
        ? `出力できる仕訳がありません。（${exclusionNotes.join('。')}）`
        : 'エクスポートするデータがありません。',
    );
    return;
  }

  // 科目コード表に無い科目は、収支の向きを判定できず、フリーウェイでは科目コードが 000 になるため事前に確認する
  const unknownAccounts = new Map();
  rowsToExport.forEach((row) => {
    const account = row[4] ? row[4].toString() : '雑費';
    if (!getFreewayCode(account)) unknownAccounts.set(account, (unknownAccounts.get(account) || 0) + 1);
  });
  if (unknownAccounts.size > 0) {
    const list = [...unknownAccounts]
      .map(([name, count]) => `・${name}（${count}件）`)
      .join('\n');
    const notes = ['・発生行のプラスの金額は「収入」として仕訳されます（費用の場合は貸借が逆になります）。'];
    if (format === 'freeway') notes.push('・フリーウェイ形式では科目コードが「000」として出力されます。');
    if (
      !(await appConfirm(
        `⚠️ 次の科目は科目コード表にありません。\n\n${list}\n\n${notes.join('\n')}\n\nこのまま出力しますか？`,
      ))
    ) {
      return;
    }
  }

  function sanitizeCsvCell(value) {
    let str = value ? value.toString() : '';
    str = str.replace(/\r?\n/g, ' ');
    if (/^[=+\-@\t\r]/.test(str)) str = "'" + str;
    return `"${str.replace(/"/g, '""')}"`;
  }

  function basicCsvCell(value) {
    let str = value ? value.toString() : '';
    str = str.replace(/\r?\n/g, ' ');
    return `"${str.replace(/"/g, '""')}"`;
  }

  let csvRows = [];
  if (format === 'freee') {
    csvRows.push(
      '"収支区分","管理番号","発生日","支払期日","取引先","勘定科目","税区分","金額","税計算区分","税額","備考","品目","部門","メモタグ","決済期日","決済口座","決済金額"',
    );
  } else if (format === 'mf') {
    csvRows.push(
      '"取引No","取引日","借方勘定科目","借方補助科目","借方部門","借方税区分","借方金額","借方税額","貸方勘定科目","貸方補助科目","貸方部門","貸方税区分","貸方金額","貸方税額","摘要","仕訳メモ","タグ"',
    );
  } else if (format === 'generic') {
    csvRows.push('"ID","日付","借方勘定科目","貸方勘定科目","金額","摘要"');
  }

  rowsToExport.forEach((row) => {
    const id = row[0];
    const memo = row[1] ? row[1].toString() : '';
    const rawAmount = parseInt(row[2] || 0, 10);
    const absAmount = Math.abs(rawAmount); // 複式簿記のためマイナスを絶対値に変換
    const account = row[4] ? row[4].toString() : '雑費';
    const childMemo = row[5] ? row[5].toString() : '';
    const escapedMemo = sanitizeCsvCell(memo);

    // 🌟 タグ判定による「発生」か「決済(消込)」かの判別
    const isCollection = isCollectionMemo(childMemo);

    // 🚨 デグレ修正: プラス/マイナス入力された「費用」や「資産」の仕訳をスマート反転
    let isIncome = isIncomeEntry(rawAmount, account);

    // 決済行の向きはタグで確定する（口座科目は借方科目扱いのため、符号反転で入出金が逆転するのを防ぐ）
    if (isCollection) {
      if (hasExactTag(childMemo, '入金')) isIncome = true;
      else if (hasExactTag(childMemo, '支払')) isIncome = false;
    }

    // メモのタグで指定された相手科目（発生行のみ）
    const taggedPartner = isCollection ? null : getTaggedPartnerAccount(memo, isIncome);

    // 🌟 最終調整：空気を読む自動仕訳ロジック
    let debitAcc, creditAcc;

    if (!isCollection) {
      // --- パターンA: 発生行 ---
      // 収入は「売掛金」、経費は「現金」をデフォルトの相手科目にする
      let partnerAcc = isIncome ? '売掛金' : '現金';
      let isPartnerSpecified = true; // 利用者のタグや科目による相手科目の指定があるか

      // メモに特定のタグがあれば、相手科目を上書き
      if (taggedPartner) partnerAcc = taggedPartner;
      else if (account === '売掛金' || account === '買掛金') partnerAcc = '普通預金'; // 掛金のデフォルト相手科目
      else isPartnerSpecified = false;

      // 決済行が作られている経費は、発生時点では未払いだったとみなす
      // （決済行は「未払金」を消し込むため、発生行が「現金」のままだと支払いが二重になる）
      if (!isIncome && !isPartnerSpecified && settledIds.has(id)) partnerAcc = '未払金';

      if (isIncome) {
        debitAcc = partnerAcc;
        creditAcc = account;
        // 🚨 デグレ修正: 売掛金発生の特例
        if (account === '売掛金') {
          debitAcc = '売掛金';
          creditAcc = '売上高';
        }
      } else {
        debitAcc = account;
        creditAcc = partnerAcc;
      }
    } else {
      // --- パターンB: 決済（回収・支払）行 ---
      if (isIncome) {
        debitAcc = account; // [借] 普通預金 など（画面で指定した口座）
        creditAcc = '売掛金'; // [貸] 売掛金（消込）
      } else {
        // [借] 未払金（消込）。元の経費が #掛 で買掛金に計上されている場合は買掛金を消し込む
        debitAcc = sourcePartnerOf(id) === '買掛金' ? '買掛金' : '未払金';
        creditAcc = account; // [貸] 普通預金 など
      }
    }

    // 🚨 デグレ修正: 借方貸方が一致してしまった場合のフェイルセーフ
    if (debitAcc === creditAcc) {
      if (isIncome) {
        creditAcc = '仮受金'; // 理由不明な入金として逃がす
      } else {
        debitAcc = '仮払金'; // 理由不明な出金として逃がす
      }
    }

    const escDebit = sanitizeCsvCell(debitAcc);
    const escCredit = sanitizeCsvCell(creditAcc);

    // 日付フォーマット変換
    const dStr = row[3] ? row[3].split(' ')[0] : '';
    let fwYear = '00',
      mm = '00',
      dd = '00',
      sl = '',
      hy = '';
    const parts = dStr.split('-');
    if (parts.length === 3) {
      const yyyy = parseInt(parts[0], 10);
      mm = parts[1];
      dd = parts[2];
      sl = `${yyyy}/${mm}/${dd}`;
      hy = `${yyyy}-${mm}-${dd}`;
      fwYear = yyyy - 1925;
      if (yyyy > 2019 || (yyyy === 2019 && parseInt(mm, 10) >= 5)) fwYear = 30 + (yyyy - 2018);
      else if (
        yyyy > 1989 ||
        (yyyy === 1989 &&
          (parseInt(mm, 10) > 1 || (parseInt(mm, 10) === 1 && parseInt(dd, 10) >= 8)))
      )
        fwYear = yyyy - 1988;
    }
    const fwDate = `${String(fwYear).padStart(2, '0')}${mm}${dd}`;

    // 各フォーマットへの出力
    if (format === 'mf') {
      let cols = Array(17).fill('');
      cols[0] = basicCsvCell(id);
      cols[1] = basicCsvCell(sl);
      cols[2] = escDebit;
      cols[5] = basicCsvCell('対象外');
      cols[6] = absAmount.toString();
      cols[8] = escCredit;
      cols[11] = basicCsvCell('対象外');
      cols[12] = absAmount.toString();
      cols[14] = escapedMemo;
      csvRows.push(cols.join(','));
    } else if (format === 'yayoi') {
      let cols = Array(25).fill('');
      cols[0] = '2111';
      cols[1] = basicCsvCell(id); // ★ 伝票Noを指定（複合仕訳化による諸口表示を防止）
      cols[2] = '0';
      cols[3] = basicCsvCell(sl);
      cols[4] = escDebit;
      cols[7] = basicCsvCell('対象外');
      cols[8] = absAmount.toString();
      cols[10] = escCredit;
      cols[13] = basicCsvCell('対象外');
      cols[14] = absAmount.toString();
      cols[16] = escapedMemo;
      cols[19] = '0';
      csvRows.push(cols.join(','));
    } else if (format === 'freeway') {
      let cols = Array(17).fill('');
      cols[0] = id.toString(); // 伝票No (数値として出力)
      cols[3] = fwDate; // 日付 (数値的文字列として出力)
      cols[5] = getFreewayCode(debitAcc) || '000'; // 借方科目コード
      cols[8] = getFreewayCode(creditAcc) || '000'; // 貸方科目コード
      cols[10] = absAmount.toString();
      cols[11] = escapedMemo;
      cols[12] = '0';
      cols[13] = '0';
      cols[15] = '0';
      csvRows.push(cols.join(','));
    } else if (format === 'freee') {
      let cols = Array(17).fill('');
      cols[0] = isIncome ? basicCsvCell('収入') : basicCsvCell('支出');
      cols[1] = basicCsvCell(id);
      cols[2] = basicCsvCell(hy);
      cols[5] = !isCollection ? sanitizeCsvCell(account) : basicCsvCell('口座振替');
      cols[6] = isIncome ? basicCsvCell('対象外') : basicCsvCell('課税仕入');
      cols[7] = absAmount.toString();
      cols[8] = basicCsvCell('税込');
      cols[10] = escapedMemo;
      if (isCollection) {
        cols[14] = basicCsvCell(hy); // 決済日
        cols[15] = sanitizeCsvCell(account); // 決済口座
        cols[16] = absAmount.toString();
      } else if (isPaidOnTheSpotPartner(taggedPartner)) {
        // #現金 / #預金 / #振込 の行は発生日に決済済みとして出力する（決済行は上で除外済み）
        cols[14] = basicCsvCell(hy); // 決済日
        cols[15] = basicCsvCell(taggedPartner); // 決済口座（現金 / 普通預金）
        cols[16] = absAmount.toString();
      }
      csvRows.push(cols.join(','));
    } else if (format === 'generic') {
      csvRows.push(
        [
          basicCsvCell(id),
          basicCsvCell(sl),
          escDebit,
          escCredit,
          absAmount.toString(),
          escapedMemo,
        ].join(','),
      );
    }
  });

  const csvContent = csvRows.join('\r\n') + '\r\n';
  const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
  const blob = new Blob([bom, csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const today = new Date();
  const dateSuffix = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = format === 'freeway' ? 'KAI0000-Shiwake.CSV' : `${format}_${dateSuffix}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  if (exclusionNotes.length > 0) {
    showToast(exclusionNotes.join('。'), '<span class="text-orange-400">⚠️</span>', { duration: 6000 });
  }
}

// Partner account from explicit tags only (fullwidth ＃ accepted; no keyword heuristics)
function getTaggedPartnerAccount(memo, isIncome) {
  const hasTag = (name) => hasExactTag(memo, name);
  if (hasTag('現金')) return '現金';
  if (hasTag('預金') || hasTag('振込')) return '普通預金';
  if (hasTag('クレカ') || hasTag('カード') || hasTag('未払')) return '未払金';
  if (hasTag('掛')) return isIncome ? '売掛金' : '買掛金';
  return null;
}

// 決済行と元の発生行の対応を求める
// sourceOf: 決済行ID -> 発生行ID
// sourceInfo: 発生行ID -> { tagMemo: タグ判定用のメモ（ブロック名 + 明細メモ。出力時の判定と同じ範囲）, isIncome }
// source_id を持たない古い決済行は、同じブロック内で「メモ + (決済)」に一致する行が1件だけの場合に限り結び付ける
function getCollectionSources() {
  const sourceOf = new Map();
  const sourceInfo = new Map();
  const res = db.exec(
    'SELECT c.id, c.parent_id, c.memo, c.source_id, p.memo, c.amount, c.account FROM records c LEFT JOIN records p ON p.id = c.parent_id WHERE c.parent_id IS NOT NULL',
  );
  if (res.length === 0) return { sourceOf, sourceInfo };

  const occurrenceIndex = new Map(); // "ブロックID + メモ" -> 一致する発生行IDの配列
  const legacyCollections = [];

  res[0].values.forEach(([id, parentId, memo, sourceId, blockMemo, amount, account]) => {
    if (isSettlementMemo(memo)) {
      if (sourceId !== null && sourceId !== undefined) sourceOf.set(id, sourceId);
      else legacyCollections.push({ id, parentId, memo: memo || '' });
    } else {
      sourceInfo.set(id, {
        tagMemo: `${blockMemo || ''} ${memo || ''}`,
        isIncome: isIncomeEntry(amount, account),
      });
      const key = `${parentId}\u0000${(memo || '').trim()}`;
      if (!occurrenceIndex.has(key)) occurrenceIndex.set(key, []);
      occurrenceIndex.get(key).push(id);
    }
  });

  legacyCollections.forEach(({ id, parentId, memo }) => {
    const match = memo.match(/^(.*?)\s*\(決済\)\s*[#＃](?:入金|支払)\s*$/);
    if (!match) return;
    const candidates = occurrenceIndex.get(`${parentId}\u0000${match[1].trim()}`) || [];
    if (candidates.length === 1) sourceOf.set(id, candidates[0]); // 複数候補は推測しない
  });

  return { sourceOf, sourceInfo };
}

// 7. CSVインポート
async function importCSV(event) {
  const file = event.target.files[0];
  if (!file) return;

  // 5MB (5 * 1024 * 1024 bytes) を超える場合は警告してクラッシュを防ぐ
  if (file.size > 5242880) {
    await appAlert(
      'ファイルサイズが大きすぎます（5MB上限）。ブラウザがクラッシュするのを防ぐため読み込みを中止しました。',
    );
    event.target.value = '';
    return;
  }

  const inputEl = event.target;
  const reader = new FileReader();
  reader.onload = function (e) {
    pendingCSVBuffer = e.target.result; // ArrayBufferを保存
    showCSVModal();
    inputEl.value = '';
  };
  reader.onerror = async function () {
    await appAlert('ファイルの読み込みに失敗しました。ファイルが破損しているか、メモリが不足しています。');
    inputEl.value = '';
  };
  reader.readAsArrayBuffer(file); // ArrayBufferとして読み込む
}

// CSVマッピングモーダルを表示
function showCSVModal() {
  const modal = document.getElementById('csv-mapping-modal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  window.isSystemModalOpen = true;
  document.body.style.overflow = 'hidden';
  setAppInert(true);
  updateCSVPreview(); // プレビューとマッピングを初期描画
}

// CSVプレビューとマッピングを更新する (文字コード変更時にも呼ばれる)
function updateCSVPreview() {
  if (!pendingCSVBuffer) return;

  const encoding = document.getElementById('csv-encoding').value;
  const previewBody = document.getElementById('csv-preview-body');

  try {
    const decoder = new TextDecoder(encoding, { fatal: true });
    const text = decoder.decode(pendingCSVBuffer);

    pendingCSVData = []; // グローバル変数を更新
    let currentLine = [];
    let currentCellStr = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const nextChar = text[i + 1];

      // BOMのスキップ
      if (i === 0 && char.charCodeAt(0) === 0xfeff) continue;

      if (char === '"' && nextChar === '"') {
        currentCellStr += '"';
        i++; // エスケープされたクオートをスキップ
      } else if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        currentLine.push(currentCellStr);
        currentCellStr = '';
      } else if ((char === '\n' || char === '\r') && !inQuotes) {
        if (char === '\r' && nextChar === '\n') i++; // \r\n の対応
        currentLine.push(currentCellStr);
        pendingCSVData.push(currentLine);
        currentLine = [];
        currentCellStr = '';
      } else {
        if (currentCellStr.length > 10000) {
          throw new Error(
            'セルの文字数が制限(10,000文字)を超えました。不正なCSVの可能性があります。',
          );
        }
        currentCellStr += char;
      }
    }
    // 最後の行をプッシュ
    if (currentLine.length > 0 || currentCellStr.length > 0) {
      currentLine.push(currentCellStr);
      pendingCSVData.push(currentLine);
    }
    // 最終行の空行を無視
    if (
      pendingCSVData.length > 0 &&
      pendingCSVData[pendingCSVData.length - 1].length === 1 &&
      pendingCSVData[pendingCSVData.length - 1][0].trim() === ''
    ) {
      pendingCSVData.pop();
    }

    if (inQuotes) {
      throw new Error('未閉じのクォーテーションが存在します。不正なCSVの可能性があります。');
    }
  } catch (e) {
    pendingCSVData = []; // エラー時はデータをクリア
    document.getElementById('map-date').innerHTML = `<option value="-1">-- 選択しない --</option>`;
    if (document.getElementById('map-account'))
      document.getElementById('map-account').innerHTML =
        `<option value="-1">-- 選択しない --</option>`;
    document.getElementById('map-memo').innerHTML = `<option value="-1">-- 選択しない --</option>`;
    document.getElementById('map-amount').innerHTML =
      `<option value="-1">-- 選択しない --</option>`;
    const previewHead = document.getElementById('csv-preview-head');
    if (previewHead) previewHead.innerHTML = '';
    previewBody.innerHTML = `<tr><td colspan="99" class="p-4 text-center text-red-500">文字コード「${encoding}」でのデコードに失敗しました。ファイルが破損しているか、文字コードの指定が間違っています。</td></tr>`;
    return;
  }

  // --- UI更新 ---
  const mapDate = document.getElementById('map-date');
  const mapAccount = document.getElementById('map-account');
  const mapMemo = document.getElementById('map-memo');
  const mapAmount = document.getElementById('map-amount');

  const maxCols = Math.min(
    50,
    pendingCSVData.reduce((max, row) => Math.max(max, row.length), 0),
  );
  const firstRow = pendingCSVData.length > 0 ? pendingCSVData[0] : [];

  const oldVals = {
    date: mapDate.value || '-1',
    account: mapAccount ? mapAccount.value || '-1' : '-1',
    memo: mapMemo.value || '-1',
    amount: mapAmount.value || '-1',
  };

  let defaultDate = oldVals.date;
  let defaultAccount = oldVals.account;
  let defaultMemo = oldVals.memo;
  let defaultAmount = oldVals.amount;

  // Header-based auto-mapping: exact labels first, then fuzzy. No blind column fallback.
  const findCol = (exactList, fuzzyRe) => {
    for (const label of exactList) {
      const exactIdx = firstRow.findIndex((c) => c && String(c).trim() === label);
      if (exactIdx !== -1) return exactIdx.toString();
    }
    const fuzzyIdx = firstRow.findIndex((c) => c && fuzzyRe.test(String(c)));
    return fuzzyIdx !== -1 ? fuzzyIdx.toString() : '-1';
  };
  if (defaultDate === '-1' && maxCols >= 1) {
    defaultDate = findCol(
      ['日付', '取引日', '利用日', '年月日', 'Date', 'date'],
      /日付|取引日|利用日|年月日|日時|^date$/i,
    );
  }
  if (mapAccount && defaultAccount === '-1' && maxCols >= 1) {
    defaultAccount = findCol(['勘定科目', '科目', 'Account', 'account'], /勘定科目|^科目$|account/i);
  }
  if (defaultMemo === '-1' && maxCols >= 1) {
    defaultMemo = findCol(
      ['摘要', 'メモ', '内容', '店名', '利用先', '支払先', 'Memo', 'Description'],
      /摘要|メモ|内容|店名|利用先|支払先|memo|description/i,
    );
  }
  if (defaultAmount === '-1' && maxCols >= 1) {
    defaultAmount = findCol(
      ['金額', '利用額', '出金額', '入金額', 'Amount', 'amount'],
      /金額|利用額|出金額|入金額|^amount$/i,
    );
  }

  let optionsHtml = `<option value="-1">-- 選択しない --</option>`;
  for (let i = 0; i < maxCols; i++) {
    const sample = firstRow[i] !== undefined ? firstRow[i].substring(0, 15) : '';
    optionsHtml += `<option value="${i}">列 ${i + 1} (${escapeHtml(sample)})</option>`;
  }

  mapDate.innerHTML = optionsHtml;
  if (mapAccount) mapAccount.innerHTML = optionsHtml;
  mapMemo.innerHTML = optionsHtml;
  mapAmount.innerHTML = optionsHtml;

  mapDate.value = defaultDate;
  if (mapAccount) mapAccount.value = defaultAccount;
  mapMemo.value = defaultMemo;
  mapAmount.value = defaultAmount;

  renderCSVPreview();
}

function renderCSVPreview() {
  const previewHead = document.getElementById('csv-preview-head');
  const previewBody = document.getElementById('csv-preview-body');
  if (!previewHead || !previewBody || pendingCSVData.length === 0) return;

  const mapDate = parseInt(document.getElementById('map-date').value, 10);
  const mapAccount = document.getElementById('map-account')
    ? parseInt(document.getElementById('map-account').value, 10)
    : -1;
  const mapMemo = parseInt(document.getElementById('map-memo').value, 10);
  const mapAmount = parseInt(document.getElementById('map-amount').value, 10);

  const maxCols = Math.min(
    50,
    pendingCSVData.reduce((max, row) => Math.max(max, row.length), 0),
  );

  // ヘッダーの構築
  let thHtml = `<th class="px-3 py-2 w-8 text-center border-r border-gray-200">行</th>`;
  for (let i = 0; i < maxCols; i++) {
    let label = '';
    let badgeClass = 'bg-slate-200 text-slate-500';
    if (i === mapDate) {
      label = '日付';
      badgeClass = 'bg-primary-100 text-blue-700';
    } else if (i === mapAccount) {
      label = '科目';
      badgeClass = 'bg-purple-100 text-purple-700';
    } else if (i === mapMemo) {
      label = 'メモ';
      badgeClass = 'bg-green-100 text-green-700';
    } else if (i === mapAmount) {
      label = '金額';
      badgeClass = 'bg-orange-100 text-orange-700';
    }

    if (label) {
      thHtml += `<th class="px-3 py-2"><span class="px-2 py-0.5 rounded text-[10px] font-bold ${badgeClass}">${label}</span></th>`;
    } else {
      thHtml += `<th class="px-3 py-2"><span class="px-2 py-0.5 rounded text-[10px] font-medium ${badgeClass}">列 ${i + 1}</span></th>`;
    }
  }
  previewHead.innerHTML = `<tr>${thHtml}</tr>`;

  // プレビューの構築 (安全のためHTMLエスケープを行う)
  previewBody.innerHTML = '';
  const skipRowsInput = document.getElementById('csv-skip-rows');
  const skipRows = skipRowsInput ? Math.max(0, parseInt(skipRowsInput.value, 10) || 0) : 0;
  const previewRows = pendingCSVData.slice(skipRows, skipRows + 4); // スキップ行を考慮して最初の4行をプレビュー
  previewRows.forEach((row, rowIndex) => {
    const tr = document.createElement('tr');
    tr.className = rowIndex === 0 ? 'bg-slate-50' : 'bg-white';
    let tdHtml = `<td class="px-3 py-2 font-bold text-slate-400 border-r border-slate-200 w-8 text-center">${skipRows + rowIndex + 1}</td>`;
    for (let i = 0; i < maxCols; i++) {
      const val = row[i] !== undefined ? row[i] : '';
      // 長すぎる文字列は省略して表示し、title属性で全文を確認できるようにする
      const displayVal = val.length > 20 ? val.substring(0, 20) + '...' : val;

      // マッピングされている列はハイライト
      let highlightClass = '';
      if (i === mapDate || i === mapAccount || i === mapMemo || i === mapAmount) {
        highlightClass = 'text-slate-900 font-medium bg-slate-50/50';
      }

      tdHtml += `<td class="px-3 py-2 truncate max-w-[150px] ${highlightClass}" title="${escapeHtml(val)}">${escapeHtml(displayVal)}</td>`;
    }
    tr.innerHTML = tdHtml;
    previewBody.appendChild(tr);
  });
}

function closeCSVModal() {
  const modal = document.getElementById('csv-mapping-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
  if (!document.querySelector('.flex[role="dialog"]')) {
    window.isSystemModalOpen = false;
    document.body.style.overflow = '';
  }
  setAppInert(false);
  pendingCSVData = [];
  pendingCSVBuffer = null;
}

async function executeCSVImport() {
  const mapDate = parseInt(document.getElementById('map-date').value, 10);
  const mapAccount = parseInt(document.getElementById('map-account').value, 10);
  const mapMemo = parseInt(document.getElementById('map-memo').value, 10);
  const mapAmount = parseInt(document.getElementById('map-amount').value, 10);
  const skipRows = Math.max(0, parseInt(document.getElementById('csv-skip-rows').value, 10) || 0);

  if (mapMemo === -1 || mapAmount === -1) {
    await appAlert('「メモ」と「金額」の列は必須です。');
    return;
  }

  // 同じ列が重複して割り当てられていないかチェック
  const selectedCols = [mapDate, mapAccount, mapMemo, mapAmount].filter((val) => val !== -1);
  const uniqueCols = new Set(selectedCols);
  if (selectedCols.length !== uniqueCols.size) {
    await appAlert('同じ列が複数の項目に割り当てられています。\nマッピング（列の選択）を見直してください。');
    return;
  }

  // モーダルを閉じると pendingCSVData がクリアされてしまうため、退避しておく
  const dataToImport = [...pendingCSVData];

  // Keep the modal (and pending data) open on a date error so the mapping can be fixed
  let keepModalOpen = false;
  let successCount = 0;
  let skippedAmountCount = 0;
  let skippedInsertCount = 0;
  let suggestStmt = null;
  let insertStmt = null;

  const startIndex = Math.max(0, skipRows);
  const MAX_IMPORT_ROWS = 3000;
  const rowsToProcess = dataToImport.length - startIndex;
  // Ask before BEGIN: a draft save during an open transaction would close the database under it
  if (rowsToProcess > MAX_IMPORT_ROWS) {
    await appAlert(
      `⚠️ データが多すぎます（${rowsToProcess}行）。\nブラウザのフリーズを防ぐため、最初の${MAX_IMPORT_ROWS}行のみをインポートします。\n残りのデータはCSVを分割してインポートしてください。`,
    );
  }
  const endIndex = Math.min(dataToImport.length, startIndex + MAX_IMPORT_ROWS);

  db.run('BEGIN TRANSACTION;');
  try {
    db.run('INSERT INTO records (memo, amount) VALUES (?, ?)', ['CSVインポート', null]);
    const parentRes = db.exec('SELECT last_insert_rowid()');
    const parentId = parentRes[0].values[0][0];

    try {
      suggestStmt = db.prepare(
        "SELECT account FROM records WHERE parent_id IS NOT NULL AND memo = ? AND account IS NOT NULL AND account != '' ORDER BY id DESC LIMIT 1",
      );
    } catch (e) {
      console.warn('Failed to prepare the account suggestion SQL', e);
    }

    try {
      insertStmt = db.prepare(
        'INSERT INTO records (parent_id, memo, amount, created_at, account) VALUES (?, ?, ?, ?, ?)',
      );
    } catch (e) {
      console.warn('Failed to prepare the import SQL', e);
    }

    const strictDate = (y, m, d) => {
      const dt = new Date(y, m - 1, d);
      return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
        ? dt
        : null;
    };
    const TIME_SUFFIX = '(?:[ T]\\d{1,2}:\\d{2}(?::\\d{2})?)?';

    for (let i = startIndex; i < endIndex; i++) {
      const cols = dataToImport[i];
      if (cols.length === 0 || cols.every((c) => !c.trim())) continue;

      const dateStr = mapDate !== -1 && cols[mapDate] !== undefined ? cols[mapDate].trim() : '';
      const accountStr =
        mapAccount !== -1 && cols[mapAccount] !== undefined ? cols[mapAccount].trim() : '';
      const memo = mapMemo !== -1 && cols[mapMemo] !== undefined ? cols[mapMemo].trim() : '';

      const rawAmount =
        mapAmount !== -1 && cols[mapAmount] !== undefined ? String(cols[mapAmount]) : '';

      let amount = NaN;
      if (rawAmount.trim() !== '') {
        const normalizedAmount = normalizeAmountText(rawAmount);
        if (normalizedAmount !== null) {
          const withoutCurrency = normalizedAmount.replace(/[¥￥$円\s,]/g, '');
          // "1.234" may be a thousands separator or a decimal: skip and report instead of guessing
          const isAmbiguousDot =
            !rawAmount.includes(',') && /^-?\d{1,3}\.\d{3}$/.test(withoutCurrency);
          if (!isAmbiguousDot && /^-?\d+(\.\d+)?$/.test(withoutCurrency)) {
            amount = roundAwayFromZero(parseFloat(withoutCurrency));
            if (amount === null || amount > 10000000000000 || amount < -10000000000000) {
              amount = NaN;
            }
          }
        }
      }

      if (isNaN(amount)) {
        skippedAmountCount++;
        continue;
      }

      let parsedDate = null;
      const dStr = dateStr.trim();
      if (dStr !== '') {
        const ymd = dStr.match(
          new RegExp(`^(\\d{4})[\\/\\-.年](\\d{1,2})[\\/\\-.月](\\d{1,2})日?${TIME_SUFFIX}$`),
        );
        const mdy = dStr.match(
          new RegExp(`^(\\d{1,2})[\\/\\-.](\\d{1,2})[\\/\\-.](\\d{4})${TIME_SUFFIX}$`),
        );
        const compact = dStr.match(/^(\d{4})(\d{2})(\d{2})$/);
        if (compact) {
          parsedDate = strictDate(
            parseInt(compact[1], 10),
            parseInt(compact[2], 10),
            parseInt(compact[3], 10),
          );
        } else if (ymd) {
          parsedDate = strictDate(
            parseInt(ymd[1], 10),
            parseInt(ymd[2], 10),
            parseInt(ymd[3], 10),
          );
        } else if (mdy) {
          const p0 = parseInt(mdy[1], 10);
          const p1 = parseInt(mdy[2], 10);
          const p2 = parseInt(mdy[3], 10);
          if (p0 > 12) {
            parsedDate = strictDate(p2, p1, p0);
          } else {
            parsedDate = strictDate(p2, p0, p1);
          }
        }
        if (!parsedDate) {
          db.run('ROLLBACK;');
          keepModalOpen = true;
          await appAlert(
            `${i + 1}行目の日付形式が不正です: "${dateStr}"\nデータ破損を防ぐためインポートを中止しました。\n列の割り当てを見直して再実行できます。`,
          );
          return;
        }
      }

      let finalAccountStr = accountStr;
      if (!finalAccountStr && memo && suggestStmt) {
        try {
          suggestStmt.bind([memo]);
          if (suggestStmt.step()) finalAccountStr = suggestStmt.get()[0];
        } catch (e) {
        } finally {
          suggestStmt.reset();
        }
      }

      let finalDateStr = '';
      if (parsedDate) {
        const yyyy = parsedDate.getFullYear();
        const mm = String(parsedDate.getMonth() + 1).padStart(2, '0');
        const dd = String(parsedDate.getDate()).padStart(2, '0');
        finalDateStr = `${yyyy}-${mm}-${dd} 00:00:00`;
      } else {
        finalDateStr = `${getTodayString()} 00:00:00`;
      }

      if (insertStmt) {
        try {
          insertStmt.run([parentId, memo, amount, finalDateStr, finalAccountStr]);
          successCount++;
        } catch (e) {
          console.warn(e);
          skippedInsertCount++;
        }
      }
    }

    if (successCount === 0) {
      db.run('DELETE FROM records WHERE id = ?', [parentId]);
    }

    db.run('COMMIT;');
    setDirty(true);

    collapsedBlocks.add(parentId);

    if (document.getElementById('period-filter')) {
      document.getElementById('period-filter').value = 'all';
    }
    window.currentActiveMonths = null;
    setActiveQuickPeriodButton(null);

    const skipTotal = skippedAmountCount + skippedInsertCount;
    const skipNote =
      skipTotal > 0
        ? `（スキップ ${skipTotal} 件: 金額不明 ${skippedAmountCount} / 登録失敗 ${skippedInsertCount}）`
        : '';
    showToast(
      `${successCount} 件のデータをインポートしました${skipNote}`,
      '<span class="text-green-400">✨</span>',
      { duration: skipTotal > 0 ? 6000 : 3000 },
    );
  } catch (err) {
    db.run('ROLLBACK;');
    await appAlert('インポート中にエラーが発生しました。');
    console.error(err);
  } finally {
    if (suggestStmt) suggestStmt.free();
    if (insertStmt) insertStmt.free();
    if (!keepModalOpen) closeCSVModal();
  }
  renderData();
}

// 8. AI連携用のプロンプトコピー機能 (BYO-AIアプローチ)
function copyAIPrompt() {
  const promptText = `あなたは優秀なデータ変換アシスタントです。
私がこれから提示する『未知の会計ソフトのサンプルCSV』を解析し、GrindMoney（お金管理アプリ）に取り込むための『列の割り当て（マッピング）』を教えてください。

GrindMoneyがインポートで必要とするデータは以下の4つです：
・日付
・勘定科目 (任意)
・摘要 または メモ
・金額

以下の枠内にサンプルCSVを貼り付けるので、上記の4つがそれぞれ「左から何列目」にあるかを解析して教えてください。

[ここにサンプルCSVを貼り付けてください]`;

  navigator.clipboard
    .writeText(promptText)
    .then(() => {
      showToast('AI用プロンプトをコピーしました', '📋');
    })
    .catch((err) => {
      console.error('Failed to copy', err);
    });
}

// 8.5 データ一覧を Markdown 形式でコピーする機能
function escapeMarkdown(text) {
  return String(text)
    .replace(/[\r\n]+/g, ' ')
    // Inline-significant characters only (memo never starts a line, so -, +, #, . are safe)
    .replace(/([\\`*_\[\]<>|~])/g, '\\$1');
}

async function copyAsMarkdown() {
  if (!db) return;
  // Same period filter as the on-screen totals, newest first
  const { whereClause, params } = getPeriodWhereClause();
  let rows = [];
  let stmt;
  try {
    stmt = db.prepare(
      `SELECT created_at, account, memo, amount FROM records WHERE parent_id IS NOT NULL${whereClause} ORDER BY created_at DESC`,
    );
    stmt.bind(params);
    while (stmt.step()) rows.push(stmt.get());
  } finally {
    if (stmt) stmt.free();
  }
  if (rows.length === 0) {
    await appAlert('表示中の期間にコピーするデータがありません。');
    return;
  }

  let markdown = '## 出力データ (Markdown)\n\n';
  rows.forEach((row) => {
    const date = row[0] ? row[0].split(' ')[0] : '日付なし';
    const account = escapeMarkdown(row[1] || '未分類');
    const memo = escapeMarkdown(row[2] || '名称未設定');
    const amountStr =
      row[3] !== null ? jpyFormatter.format(parseInt(row[3], 10)) + '円' : '金額未定';

    markdown += `- **${date}** \\[${account}\\] ${memo} : **${amountStr}**\n`;
  });

  if (!navigator.clipboard || !navigator.clipboard.writeText) {
    showToast('この環境ではクリップボードにコピーできません', '<span class="text-orange-400">⚠️</span>');
    return;
  }
  navigator.clipboard
    .writeText(markdown)
    .then(() => {
      showToast(`${rows.length} 件を Markdown でコピーしました`, '📋');
    })
    .catch((err) => {
      console.error('Failed to copy', err);
      showToast('コピーに失敗しました', '<span class="text-red-400">❌</span>');
    });
}

// 9. PWAインストールプロンプトの制御
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
  // ブラウザ標準の目立たないインストール通知をキャンセル
  e.preventDefault();
  // イベントを保持しておく
  deferredPrompt = e;

  // カスタムのインストールボタンを表示する
  const installBtn = document.getElementById('install-button');
  if (installBtn) {
    // 💡 [UI FIX] インストールボタンが表示されると、ヘッダーの合計金額表示と重なることがある問題の修正。
    // ボタンが表示されることで右側の要素の幅が広がり、flexコンテナの中央要素が圧迫されるのを防ぐため、
    // 合計金額表示エリアが縮まないように `shrink-0` を付与する。
    const grandTotalContainer = document.getElementById('grand-total-label')?.parentElement;
    if (grandTotalContainer) {
      // このコンテナはflexアイテムであり、縮むことでレイアウト崩れが起きていた。
      grandTotalContainer.classList.add('shrink-0');
    }

    installBtn.classList.remove('hidden');
    // 多重登録を防ぐため、addEventListenerではなく onclick を使用
    installBtn.onclick = async () => {
      installBtn.classList.add('hidden');
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      deferredPrompt = null;
    };
  }
});

window.addEventListener('appinstalled', () => {
  const installBtn = document.getElementById('install-button');
  if (installBtn) installBtn.classList.add('hidden');
});

// --- コマンドパレット制御 ---
let isCommandPaletteOpen = false;
let selectedCommandIndex = 0;
let prePaletteActiveElement = null; // 🎯 Gold-Rank用: パレットを開く直前のフォーカス要素
const commandsList = [
  {
    id: 'save',
    icon: '<svg class="w-5 h-5"><use href="#icon-save"></use></svg>',
    title: 'データを保存する (Save)',
    shortcut: isMac ? '⌘S' : 'Ctrl+S',
    action: () => saveGrindFile(),
  },
  {
    id: 'open',
    icon: '<svg class="w-5 h-5"><use href="#icon-folder"></use></svg>',
    title: 'ファイルを開く (Open)',
    shortcut: isMac ? '⌘O' : 'Ctrl+O',
    action: () => loadGrindFile(),
  },
  {
    id: 'saveas',
    icon: '<svg class="w-5 h-5"><use href="#icon-copy"></use></svg>',
    title: '複製して保存する (Save As)',
    shortcut: isMac ? '⇧⌘S' : 'Ctrl+Shift+S',
    action: () => saveGrindFile(true),
  },
  {
    id: 'new',
    icon: '<svg class="w-5 h-5"><use href="#icon-sparkles"></use></svg>',
    title: '新しいブロックを作成する (New)',
    shortcut: isMac ? '⌥N' : 'Alt+N',
    action: () => document.getElementById('new-block-memo').focus(),
  },
  {
    id: 'import',
    icon: '<svg class="w-5 h-5"><use href="#icon-import"></use></svg>',
    title: 'CSVインポート (Import CSV)',
    action: () => document.getElementById('csv-input').click(),
  },
  {
    id: 'export',
    icon: '<svg class="w-5 h-5"><use href="#icon-export"></use></svg>',
    title: 'CSVエクスポート (Export CSV)',
    action: showExportModal,
  },
  {
    id: 'editdict',
    icon: '<svg class="w-5 h-5"><use href="#icon-pencil"></use></svg>',
    title: 'カスタム科目辞書を編集',
    action: () => showAccountDictEditor(),
  },
  {
    id: 'ai',
    icon: '<svg class="w-5 h-5"><use href="#icon-bot"></use></svg>',
    title: 'AI用プロンプトをコピー (AI)',
    action: copyAIPrompt,
  },
  {
    id: 'markdown',
    icon: '<svg class="w-5 h-5"><use href="#icon-copy"></use></svg>',
    title: 'Markdownとしてコピー (GrindSite用)',
    action: copyAsMarkdown,
  },
  {
    id: 'expandall',
    icon: '<svg class="w-5 h-5"><use href="#icon-chevron-down"></use></svg>',
    title: 'すべてのブロックを展開する',
    action: () => toggleAllBlocks(false),
  },
  {
    id: 'collapseall',
    icon: '<svg class="w-5 h-5" style="transform: rotate(-90deg)"><use href="#icon-chevron-down"></use></svg>',
    title: 'すべてのブロックを折りたたむ',
    action: () => toggleAllBlocks(true),
  },
];

function toggleCommandPalette() {
  const palette = document.getElementById('cmd-palette');
  const input = document.getElementById('cmd-input');

  if (!isCommandPaletteOpen) {
    // 🎯 開く瞬間に、どこにフォーカスしていたかを記憶
    prePaletteActiveElement = document.activeElement;
  }

  isCommandPaletteOpen = !isCommandPaletteOpen;
  if (isCommandPaletteOpen) {
    palette.classList.remove('hidden');
    palette.classList.add('flex');
    window.isSystemModalOpen = true;
  document.body.style.overflow = 'hidden';
    setAppInert(true);
    input.value = '';
    selectedCommandIndex = 0;
    renderCommandList();

    if (window.innerWidth > 768) {
      setTimeout(() => input.focus(), 50);
    } else {
      input.blur(); // スマホの場合はソフトウェアキーボードを出さず、リスト表示を優先
    }
  } else {
    palette.classList.add('hidden');
    palette.classList.remove('flex');
    if (!document.querySelector('.flex[role="dialog"]')) {
      window.isSystemModalOpen = false;
      document.body.style.overflow = '';
    }
    setAppInert(false);
  }
}

// パスワード操作（ヘッダーの入力欄は lg 未満で非表示のため、画面幅に関係なく使えるようパレットにも置く）
function getPasswordCommands() {
  const commands = [
    {
      id: 'password',
      icon: '<span class="text-base leading-none">🔒</span>',
      title: currentMasterKey
        ? 'パスワードを変更する (Password)'
        : 'パスワードを設定してファイルを暗号化する (Password)',
      action: async () => {
        const pw = await requestPasswordPrompt(
          currentMasterKey
            ? '新しいパスワードを入力してください:'
            : 'ファイルを暗号化するパスワードを入力してください:',
        );
        if (pw === null) return;
        if (pw === '') {
          await appAlert('パスワードが空です。設定を中止しました。');
          return;
        }
        await setMasterPassword(pw);
        showToast('パスワードを設定しました。次回の保存時に確認と暗号化を行います', '🔒');
      },
    },
  ];
  if (currentMasterKey) {
    commands.push({
      id: 'password-clear',
      icon: '<span class="text-base leading-none">🔓</span>',
      title: 'パスワードを解除する (Password)',
      action: async () => {
        if ((await appConfirm('パスワード設定を解除しますか？\n（次回保存時にファイルが暗号化されなくなります）'))) {
          await setMasterPassword('');
          showToast('パスワードを解除しました', '🔓');
        }
      },
    });
  }
  return commands;
}

function getDynamicCommands() {
  let dynamicCommands = [...commandsList, ...getPasswordCommands()];
  if (db) {
    try {
      const res = db.exec('SELECT id, name FROM templates ORDER BY id DESC');
      if (res.length > 0) {
        res[0].values.forEach((row) => {
          // 挿入コマンド
          dynamicCommands.push({
            id: `tpl_insert_${row[0]}`,
            icon: '<svg class="w-5 h-5 text-amber-500"><use href="#icon-sparkles"></use></svg>',
            title: `[挿入] ${escapeHtml(row[1])}`,
            action: () => insertTemplate(row[0]),
          });
          // 削除コマンドを追加
          dynamicCommands.push({
            id: `tpl_delete_${row[0]}`,
            icon: '<svg class="w-5 h-5 text-red-400"><use href="#icon-trash"></use></svg>',
            title: `<span class="text-slate-400">[削除] ${escapeHtml(row[1])}</span>`,
            keepOpen: true, // パレットを閉じない設定
            action: async () => {
              if ((await appConfirm(`テンプレート「${row[1]}」を削除しますか？`))) {
                db.run('DELETE FROM templates WHERE id = ?', [row[0]]);
                setDirty(true);
                // パレットを閉じずにリストだけを再描画して更新を反映
                renderCommandList(document.getElementById('cmd-input').value);
              }
            },
          });
        });
      }
    } catch (e) {}
  }
  return dynamicCommands;
}

function getFilteredCommands(query) {
  const q = query.toLowerCase();
  const dynamicCommands = getDynamicCommands();
  let filtered = dynamicCommands.filter(
    (c) => c.title.toLowerCase().includes(q) || c.id.includes(q),
  );

  // 入力が数式として評価できる場合、一番上に「電卓コマンド」を挿入
  if (q.match(/[0-9]/) && q.match(/[+\-*/×÷ー−]/)) {
    try {
      const calcResult = evaluateMath(q);
      if (calcResult !== null) {
        filtered.unshift({
          id: 'calculator',
          icon: '<svg class="w-5 h-5 text-green-500"><use href="#icon-sparkles"></use></svg>',
          title: `= ${jpyFormatter.format(calcResult)} <span class="text-xs text-slate-400 ml-2">(Enterで適用またはコピー)</span>`,
          action: () => {
            const resultStr = calcResult.toString();
            const target = prePaletteActiveElement;

            // Only an amount field may receive the result; memo / date / block name are never overwritten
            const isAmountField =
              target &&
              target.isConnected &&
              target.tagName === 'INPUT' &&
              (target.getAttribute('data-field') === 'amount' ||
                target.classList.contains('item-amount'));

            if (isAmountField) {
              target.value = resultStr;
              target.focus();
              // Existing rows are saved on blur (updateRecord); the add form is saved on submit
              target.dispatchEvent(new Event('input', { bubbles: true }));
              showToast(
                `${resultStr} を金額欄に入力しました`,
                '<span class="text-green-400">✨</span>',
              );
              return;
            }

            if (!navigator.clipboard || !navigator.clipboard.writeText) {
              showToast(
                `= ${jpyFormatter.format(calcResult)}（コピーできない環境です）`,
                '<span class="text-orange-400">⚠️</span>',
              );
              return;
            }
            navigator.clipboard.writeText(resultStr).then(
              () => {
                showToast(
                  `${jpyFormatter.format(calcResult)} をコピーしました`,
                  '<span class="text-green-400">📋</span>',
                );
              },
              () => {
                showToast(
                  `= ${jpyFormatter.format(calcResult)}（コピーに失敗しました）`,
                  '<span class="text-orange-400">⚠️</span>',
                );
              },
            );
          },
        });
      }
    } catch (e) {
      console.error('Calculator command failed:', e);
    }
  }
  return filtered;
}

function renderCommandList(query = '') {
  const list = document.getElementById('cmd-list');
  list.innerHTML = '';

  const filtered = getFilteredCommands(query);

  if (selectedCommandIndex >= filtered.length) selectedCommandIndex = 0;

  filtered.forEach((cmd, i) => {
    const div = document.createElement('div');
    const isSelected = i === selectedCommandIndex;
    div.className = `px-4 py-3 my-1 flex justify-between items-center rounded-md cursor-pointer transition-colors ${isSelected ? 'bg-primary-50 text-primary' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`;

    let innerHtml = `<div class="flex items-center gap-3"><span class="text-xl">${cmd.icon}</span><span class="font-medium tracking-wide">${cmd.title}</span></div>`;
    if (cmd.shortcut) {
      // コマンドが選択されている時はバッジの色も少し強調する
      innerHtml += `<kbd class="font-mono text-[10px] bg-white border border-slate-200 px-1.5 py-0.5 rounded shadow-sm ${isSelected ? 'text-primary border-primary/20' : 'text-slate-400'}">${cmd.shortcut}</kbd>`;
    }
    div.innerHTML = innerHtml;

    div.onclick = () => {
      if (!cmd.keepOpen) {
        toggleCommandPalette();
      }
      cmd.action();
    };
    list.appendChild(div);

    if (isSelected) {
      setTimeout(() => div.scrollIntoView({ block: 'nearest' }), 0);
    }
  });
}

document.addEventListener('keydown', (e) => {
  const key = e.key?.toLowerCase();
  if (!key) return; // キー情報が取得できない特殊なイベントは無視

  // Shortcuts must not reach the app behind an open dialog
  const isAppShortcut =
    ((e.metaKey || e.ctrlKey) && ['KeyK', 'KeyS', 'KeyO'].includes(e.code)) ||
    (e.altKey && e.code === 'KeyN');
  if (isAppShortcut && window.isSystemModalOpen && !isCommandPaletteOpen) {
    e.preventDefault();
    return;
  }

  if ((e.metaKey || e.ctrlKey) && (key === 'k' || key === 'ｋ' || e.code === 'KeyK')) {
    e.preventDefault();
    toggleCommandPalette();
    return;
  }

  // 新規ブロック作成 (Option+N / Alt+N)
  if (e.altKey && !e.metaKey && !e.ctrlKey && (key === 'n' || key === 'ｎ' || e.code === 'KeyN')) {
    e.preventDefault();
    document.getElementById('new-block-memo').focus();
    return;
  }

  // 上書き保存 (Cmd+S / Ctrl+S) & 複製保存 (Cmd+Shift+S / Ctrl+Shift+S)
  if ((e.metaKey || e.ctrlKey) && (key === 's' || key === 'ｓ' || e.code === 'KeyS')) {
    e.preventDefault();
    if (e.shiftKey) {
      saveGrindFile(true); // Save As
    } else {
      saveGrindFile(); // Save
    }
    return;
  }

  // ファイルを開く (Cmd+O / Ctrl+O)
  if ((e.metaKey || e.ctrlKey) && (key === 'o' || key === 'ｏ' || e.code === 'KeyO')) {
    e.preventDefault();
    loadGrindFile();
    return;
  }

  if (e.key === 'Escape') {
    // モーダルやパレットが開いていれば閉じる
    // 💡 Gold-Rank: 2段階クローズ（文字がある場合はクリア、空なら閉じる）
    if (isCommandPaletteOpen) {
      const input = document.getElementById('cmd-input');
      if (input.value !== '') {
        // 文字がある場合はクリアするだけ（パレットは開いたまま）
        input.value = '';
        selectedCommandIndex = 0;
        renderCommandList('');
      } else {
        // 空の場合はパレットを閉じる
        toggleCommandPalette();
      }
      return;
    }
    if (!document.getElementById('csv-mapping-modal').classList.contains('hidden')) {
      closeCSVModal();
      return;
    }
    if (!document.getElementById('export-modal').classList.contains('hidden')) {
      closeExportModal();
      return;
    }
    if (!document.getElementById('tag-modal').classList.contains('hidden')) {
      closeTagModal();
      return;
    }
    if (!document.getElementById('account-dict-editor-modal').classList.contains('hidden')) {
      closeAccountDictEditor();
      return;
    }
  }

  if (isCommandPaletteOpen) {
    const input = document.getElementById('cmd-input');

    const filtered = getFilteredCommands(input.value);

    // ✅ 結果が0件の時の NaN クラッシュを防止
    if (
      filtered.length === 0 &&
      (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter')
    ) {
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedCommandIndex = (selectedCommandIndex + 1) % filtered.length;
      renderCommandList(input.value);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedCommandIndex = (selectedCommandIndex - 1 + filtered.length) % filtered.length;
      renderCommandList(input.value);
    } else if (e.key === 'Enter' && !e.isComposing && filtered[selectedCommandIndex]) {
      e.preventDefault();
      const cmd = filtered[selectedCommandIndex];
      if (!cmd.keepOpen) {
        toggleCommandPalette();
      }
      cmd.action();
    }
  }
});

// --- TOC（目次）の絞り込み機能 ---
function applyTocFilter(query) {
  const q = query.toLowerCase();
  const tocItems = document.querySelectorAll('#toc-list a.toc-item');

  tocItems.forEach((item) => {
    const text = item.textContent.toLowerCase();
    if (text.includes(q)) {
      item.style.display = 'block';
    } else {
      item.style.display = 'none';
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const tocFilter = document.getElementById('toc-filter');
  if (tocFilter) {
    tocFilter.addEventListener('input', (e) => {
      applyTocFilter(e.target.value);
    });
  }
});

// --- マルチタブ起動によるデータ競合の防止 ---
// Fallback for browsers without Web Locks (best effort; can race when tabs open simultaneously)
if (
  typeof BroadcastChannel !== 'undefined' &&
  !(navigator.locks && typeof navigator.locks.request === 'function')
) {
  const bc = new BroadcastChannel('grindmoney_app_channel');

  bc.onmessage = (e) => {
    if (e.data === 'ping') {
      if (!isSecondaryTab) bc.postMessage('pong'); // すでに開いているタブが応答する
    } else if (e.data === 'pong') {
      markSecondaryTab(); // 自分が後から開いたタブだった場合
    }
  };
  bc.postMessage('ping');
}

document.getElementById('cmd-input')?.addEventListener('input', (e) => {
  selectedCommandIndex = 0;
  renderCommandList(e.target.value);
});

// --- パスワードイベント設定 ---
document.addEventListener('DOMContentLoaded', () => {
  const pwInput = document.getElementById('file-password');
  if (pwInput) {
    pwInput.addEventListener('change', async (e) => {
      await setMasterPassword(e.target.value);
    });
    pwInput.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        await setMasterPassword(e.target.value);
        pwInput.blur();
      }
    });
  }

  const btnClearPw = document.getElementById('btn-clear-password');
  if (btnClearPw) {
    btnClearPw.addEventListener('click', async () => {
      if ((await appConfirm('パスワード設定を解除しますか？\n（次回保存時にファイルが暗号化されなくなります）'))) {
        await setMasterPassword('');
      }
    });
  }

  const btnTogglePw = document.getElementById('btn-toggle-password');
  if (btnTogglePw) {
    btnTogglePw.addEventListener('click', togglePasswordVisibility);
  }
});

// --- パスワード表示トグル ---
function togglePasswordVisibility() {
  const pwInput = document.getElementById('file-password');
  const iconOpen = document.getElementById('icon-eye-open');
  const iconClosed = document.getElementById('icon-eye-closed');
  if (pwInput.type === 'password') {
    pwInput.type = 'text';
    iconOpen.classList.remove('hidden');
    iconClosed.classList.add('hidden');
  } else {
    pwInput.type = 'password';
    iconOpen.classList.add('hidden');
    iconClosed.classList.remove('hidden');
  }
}

// --- 科目サジェスト (オートコンプリート) 機能 ---
const baseAccountingDict = [
  '売上高',
  '現金',
  '普通預金',
  '当座預金',
  '売掛金',
  '買掛金',
  '未払金',
  '預り金',
  '前払金',
  '前受金',
  '立替金',
  '仮払金',
  '仮受金',
  '事業主貸',
  '事業主借',
  '元入金',
  '役員借入金',
  '役員貸付金',
  '租税公課',
  '荷造運賃',
  '水道光熱費',
  '旅費交通費',
  '通信費',
  '広告宣伝費',
  '接待交際費',
  '損害保険料',
  '修繕費',
  '消耗品費',
  '減価償却費',
  '福利厚生費',
  '給料手当',
  '専従者給与',
  '外注工賃',
  '利子割引料',
  '地代家賃',
  '貸倒金',
  '雑費',
  '支払手数料',
  '会議費',
  '新聞図書費',
  '車両費',
  '諸会費',
  'リース料',
];

const accountDictionaries = {
  custom: [], // ユーザー定義の辞書
  none: [],
  yayoi: baseAccountingDict,
  freee: baseAccountingDict,
  mf: [
    '売上高',
    '現金',
    '普通預金',
    '当座預金',
    '売掛金',
    '買掛金',
    '未払金',
    '預り金',
    '前払前渡金',
    '前受金',
    '立替金',
    '仮払金',
    '仮受金',
    '事業主貸',
    '事業主借',
    '元入金',
    '役員借入金',
    '役員貸付金',
    '租税公課',
    '荷造運賃',
    '水道光熱費',
    '旅費交通費',
    '通信費',
    '広告宣伝費',
    '接待交際費',
    '損害保険料',
    '修繕費',
    '消耗品費',
    '減価償却費',
    '福利厚生費',
    '給料手当',
    '専従者給与',
    '外注工賃',
    '利子割引料',
    '地代家賃',
    '貸倒金',
    '雑費',
    '支払手数料',
    '会議費',
    '新聞図書費',
    '車両費',
    '諸会費',
    'リース料',
  ],
  freeway: baseAccountingDict,
};

const FREEWAY_CODE_MAP = {
  現金: '1100',
  当座預金: '1110',
  普通預金: '1120',
  定期預金: '1130',
  受取手形: '1150',
  売掛金: '1160',
  有価証券: '1170',
  商品: '1210',
  貯蔵品: '1270',
  前渡金: '1410',
  前払金: '1410',
  立替金: '1411',
  仮払金: '1412',
  前払費用: '1420',
  未収収益: '1430',
  短期貸付金: '1440',
  未収入金: '1450',
  仮払消費税: '1500',
  建物: '2110',
  構築物: '2120',
  機械装置: '2130',
  車両運搬具: '2150',
  工具器具備品: '2160',
  一括償却資産: '2170',
  土地: '2210',
  ソフトウェア: '2350',
  出資金: '2620',
  長期貸付金: '2630',
  長期前払費用: '2810',
  創立費: '3110',
  開業費: '3120',
  事業主貸: '3180',
  店主貸: '3180',
  支払手形: '4110',
  買掛金: '4120',
  短期借入金: '4130',
  未払金: '4140',
  未払費用: '4150',
  前受金: '4160',
  預り金: '4170',
  未払法人税等: '4180',
  未払消費税等: '4182',
  仮受金: '4190',
  前受収益: '4210',
  賞与引当金: '4350',
  仮受消費税: '4500',
  長期借入金: '5110',
  退職給与引当金: '5310',
  資本金: '7110',
  資本準備金: '7210',
  利益準備金: '7310',
  事業主借: '7320',
  店主借: '7320',
  元入金: '7330',
  繰越利益剰余金: '7330',
  売上高: '8000',
  売上値引戻り高: '8050',
  期首商品棚卸高: '8100',
  当期仕入高: '8110',
  仕入値引戻し高: '8150',
  期末棚卸高: '8190',
  給料手当: '8310',
  給与手当: '8310',
  役員報酬: '8310',
  賞与: '8327',
  退職金: '8330',
  法定福利費: '8350',
  福利厚生費: '8351',
  外注工賃: '8352',
  外注費: '8352',
  旅費交通費: '8410',
  通信費: '8420',
  運賃: '8421',
  荷造運賃: '8421',
  車両費: '8430',
  交際費: '8440',
  接待交際費: '8440',
  諸会費: '8441',
  寄付金: '8442',
  広告宣伝費: '8450',
  会議費: '8460',
  賃借料: '8510',
  地代家賃: '8511',
  地代: '8511',
  家賃: '8512',
  保険料: '8520',
  損害保険料: '8520',
  修繕費: '8530',
  水道光熱費: '8540',
  消耗品費: '8550',
  事務用消耗品: '8550',
  新聞図書費: '8560',
  租税公課: '8570',
  販売手数料: '8580',
  支払手数料: '8581',
  貸倒損失: '8590',
  貸倒金: '8590',
  減価償却費: '8592',
  雑費: '8599',
  受取利息: '8610',
  受取配当金: '8620',
  雑収入: '8790',
  支払利息割引料: '8810',
  支払利息: '8810',
  利子割引料: '8810',
  雑損失: '8990',
  専従者給与: '9810',
  リース料: '8510',
  役員借入金: '5110',
  役員貸付金: '2630',
  前払前渡金: '1410',
};

// 他社ソフトでよく使われる科目名の別名（保存済みの科目名は変えず、コード表の参照にだけ使う）
const ACCOUNT_ALIASES = {
  仕入高: '当期仕入高',
  商品仕入高: '当期仕入高',
  期首棚卸高: '期首商品棚卸高',
  期末商品棚卸高: '期末棚卸高',
};

function canonicalAccountName(account) {
  return ACCOUNT_ALIASES[account] || account;
}

// フリーウェイ科目コード（コード表に無い科目は空文字）
function getFreewayCode(account) {
  return FREEWAY_CODE_MAP[canonicalAccountName(account)] || '';
}

// プラス入力を「費用・資産の増加（借方）」として扱う科目かどうか
// フリーウェイ科目コードの1桁目で判定し、コード上は同じ区分でも正常残高が貸方の科目を除外する
const CREDIT_NORMAL_EXCEPTIONS = new Set([
  '売上高',
  '雑収入',
  '受取利息',
  '受取配当金',
  '仕入値引戻し高',
  '期末棚卸高',
  '売掛金',
  '未収入金',
  '前受金',
]);
// 金額の符号と科目から、収入側の取引かどうかを判定する（借方科目はプラスが支出側）
// 科目が空の行は、エクスポート時と同じく「雑費」として扱う
function isIncomeEntry(amount, account) {
  const isPositive = parseInt(amount || 0, 10) >= 0;
  return isDebitNormalAccount(account || '雑費') ? !isPositive : isPositive;
}

function isDebitNormalAccount(account) {
  if (CREDIT_NORMAL_EXCEPTIONS.has(canonicalAccountName(account))) return false;
  const acctCode = getFreewayCode(account);
  // 9810 専従者給与（青色申告特別控除前の経費）も借方
  return /^[12389]/.test(acctCode);
}

function changeAccountDict() {
  const select = document.getElementById('dict-select');
  const dictKey = select.value;
  setDbSetting('accountDict', dictKey);
  renderAccountSuggestions(dictKey);
}

function renderAccountSuggestions(dictKey) {
  const datalist = document.getElementById('account-suggestions');
  if (!datalist) return;
  datalist.innerHTML = '';

  const dict = accountDictionaries[dictKey] || [];
  const fragment = document.createDocumentFragment();
  dict.forEach((account) => {
    const option = document.createElement('option');
    option.value = account;
    fragment.appendChild(option);
  });
  datalist.appendChild(fragment);
}

function loadCustomDict() {
  const savedDict = getDbSetting('customAccountDict');
  if (savedDict) {
    try {
      const parsed = JSON.parse(savedDict);
      if (Array.isArray(parsed)) {
        // Accept the legacy string form and the {name, hidden} form per element; drop anything else
        const seen = new Set();
        customAccountDict = [];
        for (const entry of parsed) {
          const rawName =
            typeof entry === 'string'
              ? entry
              : entry && typeof entry === 'object' && typeof entry.name === 'string'
                ? entry.name
                : null;
          const name = rawName === null ? '' : rawName.trim().slice(0, 100);
          if (!name || seen.has(name)) continue;
          seen.add(name);
          customAccountDict.push({
            name,
            hidden: typeof entry === 'object' && entry.hidden === true,
          });
        }
      } else {
        throw new Error('Invalid format'); // catchブロックに飛ばしてデフォルト値をセットさせる
      }
    } catch (e) {
      // パースに失敗したらデフォルトで上書き
      customAccountDict = accountDictionaries.yayoi.map((name) => ({
        name,
        hidden: false,
      }));
    }
  } else {
    // 初回起動時は弥生会計のリストをデフォルトとしてセット
    customAccountDict = accountDictionaries.yayoi.map((name) => ({
      name,
      hidden: false,
    }));
  }
  accountDictionaries.custom = customAccountDict.filter((i) => !i.hidden).map((i) => i.name);
}

function saveCustomDict() {
  setDbSetting('customAccountDict', JSON.stringify(customAccountDict));
  accountDictionaries.custom = customAccountDict.filter((i) => !i.hidden).map((i) => i.name);
  // 現在の選択がカスタムなら、datalistを即時更新
  if (document.getElementById('dict-select').value === 'custom') {
    renderAccountSuggestions('custom');
  }
  return true;
}

// --- カスタム科目辞書エディタ ---
let draggedItemIndex = null;

function showAccountDictEditor() {
  const modal = document.getElementById('account-dict-editor-modal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  window.isSystemModalOpen = true;
  document.body.style.overflow = 'hidden';
  setAppInert(true);
  renderCustomDictEditor();

  document.getElementById('add-custom-dict-form').onsubmit = (e) => {
    e.preventDefault();
    const input = document.getElementById('new-custom-account');
    const newAccountName = input.value.trim();
    if (newAccountName) {
      const existing = customAccountDict.find((item) => item.name === newAccountName);
      if (existing) {
        existing.hidden = false; // 存在していれば再表示
      } else {
        customAccountDict.push({ name: newAccountName, hidden: false });
      }
      renderCustomDictEditor();
    }
    input.value = '';
    input.focus();
  };
}

function closeAccountDictEditor() {
  const modal = document.getElementById('account-dict-editor-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
  if (!document.querySelector('.flex[role="dialog"]')) {
    window.isSystemModalOpen = false;
    document.body.style.overflow = '';
  }
  setAppInert(false);
  // 変更を保存せずに閉じた場合は、元の状態に戻す
  loadCustomDict();
}

function saveCustomDictAndClose() {
  if (!saveCustomDict()) return; // 失敗時は閉じない

  const modal = document.getElementById('account-dict-editor-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
  if (!document.querySelector('.flex[role="dialog"]')) {
    window.isSystemModalOpen = false;
    document.body.style.overflow = '';
  }
  setAppInert(false);
}

function renderCustomDictEditor() {
  const list = document.getElementById('custom-dict-list');
  list.innerHTML = '';
  customAccountDict.forEach((item, index) => {
    const li = document.createElement('li');
    li.dataset.index = index;
    li.draggable = true;
    li.className = `flex items-center justify-between p-3 bg-slate-50 border border-slate-200 rounded-md cursor-grab active:cursor-grabbing active:bg-slate-100 transition-opacity ${item.hidden ? 'opacity-50' : 'opacity-100'}`;

    const icon = item.hidden ? 'icon-eye-slash' : 'icon-eye';
    const title = item.hidden ? '表示する' : '非表示にする';
    const textClass = item.hidden ? 'text-slate-400 line-through' : 'text-slate-700';

    li.innerHTML = `
      <div class="flex items-center gap-3 min-w-0 flex-1">
        <!-- PC用のドラッグハンドル -->
        <svg class="hidden sm:block w-5 h-5 text-slate-400 shrink-0"><use href="#icon-drag"></use></svg>
        <span class="font-medium ${textClass} truncate">${escapeHtml(item.name)}</span>
      </div>
      <div class="flex items-center gap-1 shrink-0">
        <!-- スマホ用の上下移動ボタン -->
        <div class="flex flex-col sm:hidden mr-2">
          <button type="button" data-action="moveCustomDictItem" data-index="${index}" data-delta="-1" class="text-slate-400 hover:text-slate-700 px-1 py-0.5 leading-none ${index === 0 ? 'opacity-30 cursor-not-allowed' : ''}" ${index === 0 ? 'disabled' : ''}>▲</button>
          <button type="button" data-action="moveCustomDictItem" data-index="${index}" data-delta="1" class="text-slate-400 hover:text-slate-700 px-1 py-0.5 leading-none ${index === customAccountDict.length - 1 ? 'opacity-30 cursor-not-allowed' : ''}" ${index === customAccountDict.length - 1 ? 'disabled' : ''}>▼</button>
        </div>
        <!-- 表示/非表示トグル -->
        <button data-action="toggleCustomAccountHidden" data-index="${index}" class="text-slate-400 hover:text-slate-600 transition-colors shrink-0" title="${title}">
          <svg class="w-5 h-5"><use href="#${icon}"></use></svg>
        </button>
        <!-- 削除ボタン -->
        <button data-action="deleteCustomDictItem" data-index="${index}" class="text-slate-300 hover:text-red-500 transition-colors shrink-0 ml-1" title="完全に削除する">
          <svg class="w-5 h-5"><use href="#icon-trash"></use></svg>
        </button>
      </div>
    `;
    // Drag and Drop イベント
    li.addEventListener('dragstart', (e) => {
      draggedItemIndex = index;
      // Firefoxでドラッグ＆ドロップを有効化するための必須コード
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', index);
      }
      setTimeout(() => e.target.classList.add('opacity-30'), 0);
    });
    li.addEventListener('dragover', (e) => e.preventDefault());
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      if (typeof draggedItemIndex !== 'number' || draggedItemIndex === null) return;

      let droppedOnIndex = index;
      if (draggedItemIndex === droppedOnIndex) return;

      const [reorderedItem] = customAccountDict.splice(draggedItemIndex, 1);
      customAccountDict.splice(droppedOnIndex, 0, reorderedItem);
      draggedItemIndex = null;
      renderCustomDictEditor();
    });
    li.addEventListener('dragend', (e) => {
      e.target.classList.remove('opacity-30');
      draggedItemIndex = null;
    });
    list.appendChild(li);
  });
}

// スマホタップ用のカスタム科目並び替え関数
function moveCustomDictItem(index, direction) {
  if (index + direction < 0 || index + direction >= customAccountDict.length) return;
  const item = customAccountDict.splice(index, 1)[0];
  customAccountDict.splice(index + direction, 0, item);
  renderCustomDictEditor();
}

async function deleteCustomDictItem(index) {
  if ((await appConfirm(`「${customAccountDict[index].name}」を辞書から完全に削除しますか？`))) {
    customAccountDict.splice(index, 1);
    renderCustomDictEditor();
  }
}

function toggleCustomAccountHidden(index) {
  if (customAccountDict[index]) {
    customAccountDict[index].hidden = !customAccountDict[index].hidden;
    renderCustomDictEditor();
  }
}

function setAllCustomAccountsHidden(isHidden) {
  customAccountDict.forEach((item) => {
    item.hidden = isHidden;
  });
  renderCustomDictEditor();
}

// --- ハッシュタグモーダル制御 ---
function showTagModal(tag, data) {
  const modal = document.getElementById('tag-modal');
  // 💡 Gold-Rank: タグ名の横に (全○件) と表示して分析しやすくする
  document.getElementById('tag-modal-title').textContent = `${tag} (${data.items.length}件)`;
  document.getElementById('tag-modal-total').textContent = '¥' + jpyFormatter.format(data.amount);

  const tbody = document.getElementById('tag-modal-body');
  tbody.innerHTML = '';

  // 日付の降順にソートして明細を表示
  const sortedItems = [...data.items].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  sortedItems.forEach((item) => {
    let dateDisp = '日付なし';
    if (item.date) {
      const parts = item.date.split(' ')[0].split('-');
      if (parts.length === 3) dateDisp = `${escapeHtml(parts[1])}/${escapeHtml(parts[2])}`;
    }

    tbody.innerHTML += `
      <tr class="hover:bg-slate-50 transition-colors border-b border-slate-50 last:border-0">
        <td class="py-4 px-6 w-20 text-xs text-slate-400 font-mono">${dateDisp}</td>
        <td class="py-4 px-4 text-slate-700 font-medium">${escapeHtml(item.memo)}</td>
        <td class="py-4 px-6 text-right tabular-nums tracking-tight font-bold text-slate-600">¥${jpyFormatter.format(item.amount)}</td>
      </tr>
    `;
  });

  modal.classList.remove('hidden');
  modal.classList.add('flex');
  window.isSystemModalOpen = true;
  document.body.style.overflow = 'hidden';
  setAppInert(true);
}

function closeTagModal() {
  const modal = document.getElementById('tag-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
  if (!document.querySelector('.flex[role="dialog"]')) {
    window.isSystemModalOpen = false;
    document.body.style.overflow = '';
  }
  setAppInert(false);
}

if (!window.isSecureContext) {
  appAlert(
    '⚠️ セキュリティ警告 ⚠️\n\n現在のアクセス環境 (HTTP) では、ブラウザのセキュリティ制限によりファイルの読み書きや暗号化機能がブロックされます。\n\nGrindMoneyを正常に動作させるには、必ず「HTTPS」環境にアップロードするか、「localhost」で実行してください。',
  );
  showToast(
    'エラー: HTTPS環境またはlocalhostでの実行が必要です',
    '<span class="text-red-400">⚠️</span>',
  );
} else {
  // アプリ起動時にSQLiteをロード
  initSQLite();
}

// --- ファイル固有の設定を読み込んでUIに反映する ---
function loadSettingsFromDb() {
  loadCustomDict();
  const savedDict = getDbSetting('accountDict', 'custom');
  const dictSelect = document.getElementById('dict-select');
  if (dictSelect) dictSelect.value = savedDict;
  renderAccountSuggestions(savedDict);
  updateFiscalYearButton();
}

// ページ離脱時の警告（データ未保存防止）
window.addEventListener('beforeunload', (e) => {
  if (isDirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// --- ドラッグ＆ドロップによるファイル読み込み ---
const dropOverlay = document.getElementById('drop-overlay');
let dragCounter = 0;

// 安全にファイルドラッグかどうかを判定する関数（Safariのエラー回避用）
function hasFiles(e) {
  if (!e.dataTransfer || !e.dataTransfer.types) return false;
  for (let i = 0; i < e.dataTransfer.types.length; i++) {
    if (e.dataTransfer.types[i] === 'Files') return true;
  }
  return false;
}

// 1. デフォルト挙動をキャンセル (documentに対して行うことでSafariでの誤発火を防ぐ)
document.addEventListener('dragover', (e) => {
  if (hasFiles(e)) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }
});
document.addEventListener('drop', (e) => {
  if (hasFiles(e)) {
    e.preventDefault();
  }
});

// 2. ファイルがウィンドウに入ってきたときの処理 (カウンタ方式)
document.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (dragCounter === 0) {
    dropOverlay.classList.remove('hidden');
    dropOverlay.classList.add('flex');
  }
  dragCounter++;
});

// 3. ファイルがウィンドウから出ていったときの処理 (カウンタ方式)
document.addEventListener('dragleave', (e) => {
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0; // 念のためリセット
    dropOverlay.classList.add('hidden');
    dropOverlay.classList.remove('flex');
  }
});

// 4. ドロップされたときの処理
document.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;

  // カウンタとオーバーレイをリセット
  dragCounter = 0;
  dropOverlay.classList.add('hidden');
  dropOverlay.classList.remove('flex');

  let file = null;
  let handle = null;

  if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
    for (let i = 0; i < e.dataTransfer.items.length; i++) {
      const item = e.dataTransfer.items[i];
      if (item.kind === 'file') {
        file = item.getAsFile();
        if (item.getAsFileSystemHandle) {
          try {
            handle = await item.getAsFileSystemHandle();
          } catch (err) {
            console.warn('Failed to get the file handle. Falling back:', err);
          }
        }
        break;
      }
    }
  } else if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    file = e.dataTransfer.files[0];
  }

  if (!file) return;

  // すべてのUI状態をリセットし、安全な状態に初期化する
  if (isCommandPaletteOpen) toggleCommandPalette();
  closeCSVModal();
  closeExportModal();
  closeTagModal();
  closeAccountDictEditor();

  // 万が一パスワードプロンプトが開いていたら、キャンセル扱いで閉じる
  // （非表示にするだけだと待機中の Promise が解決されず、保存処理が isSaving のまま止まる）
  const pwModal = document.getElementById('password-prompt-modal');
  if (pwModal && !pwModal.classList.contains('hidden')) {
    document.getElementById('password-prompt-cancel')?.click();
  }

  // 拡張子に応じて処理を分岐
  const lowerName = file.name.toLowerCase();
  if (
    lowerName.endsWith('.money') ||
    lowerName.endsWith('.grind') ||
    lowerName.endsWith('.sqlite')
  ) {
    if (isDirty) {
      if (!(await appConfirm('未保存のデータがあります。変更を破棄して別のファイルを開きますか？'))) return;
    }
    if (handle && handle.kind === 'file') {
      await processFileHandle(handle);
    } else {
      const dummyHandle = {
        getFile: async () => file,
        name: file.name,
        isDummy: true,
      };
      await processFileHandle(dummyHandle, true);
    }
  } else if (lowerName.endsWith('.csv')) {
    // 隠された <input type="file"> を利用して、既存のインポートフローに流す
    const csvInput = document.getElementById('csv-input');
    if (csvInput) {
      // FileListを作成してinputにセット
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      csvInput.files = dataTransfer.files;
      // onchangeイベントを手動で発火させる
      csvInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
  } else {
    await appAlert(
      'サポートされていないファイルです。.money、.grind または .csv 形式のファイルをドロップしてください。',
    );
  }
});

// OSを判定してショートカットキーのUI表示を最適化
const shortcutEl = document.getElementById('cmd-shortcut-key');
if (shortcutEl) {
  shortcutEl.textContent = isMac ? '⌘K' : 'Ctrl+K';
}

const btnSaveTooltip = document.getElementById('btn-save');
if (btnSaveTooltip) btnSaveTooltip.title = `保存 (${isMac ? '⌘S' : 'Ctrl+S'})`;

const btnOpenTooltip = document.getElementById("btn-open-file");
if (btnOpenTooltip) btnOpenTooltip.title = `開く (${isMac ? '⌘O' : 'Ctrl+O'})`;

// --- Event Delegation ---
function initEventDelegation() {
  document.addEventListener('click', (e) => {
    let target = e.target.closest('[data-action]');
    if (target) {
      const action = target.getAttribute('data-action');
      if (action === 'setPeriodFilter') setPeriodFilter(target.getAttribute('data-period'), target);
      else if (action === 'setMultiMonthFilter') setMultiMonthFilter(target.getAttribute('data-months').split(',').map(Number), target);
      else if (action === 'setCalendarYearFilter') setCalendarYearFilter(target);
      else if (action === 'setPreviousFiscalYearFilter') setPreviousFiscalYearFilter(target);
      else if (action === 'setFiscalYearFilter') setFiscalYearFilter(target);
      else if (action === 'changeFiscalMonth') changeFiscalMonth();
      else if (action === 'toggleAllBlocks') toggleAllBlocks(target.getAttribute('data-open') === 'true');
      else if (action === 'closeCSVModal') closeCSVModal();
      else if (action === 'stopPropagation') e.stopPropagation();
      else if (action === 'executeCSVImport') executeCSVImport();
      else if (action === 'closeExportModal') closeExportModal();
      else if (action === 'executeExport') executeExport();
      else if (action === 'closeTagModal') closeTagModal();
      else if (action === 'closeAccountDictEditor') closeAccountDictEditor();
      else if (action === 'saveCustomDictAndClose') saveCustomDictAndClose();
      else if (action === 'toggleCommandPalette') toggleCommandPalette();
      else if (action === 'saveGrindFile') saveGrindFile();
      else if (action === 'loadGrindFile') loadGrindFile();
      else if (action === 'dismissDropOverlay') {
        target.classList.add('hidden');
        target.classList.remove('flex');
        dragCounter = 0;
      }
      else if (action === 'reloadPage') { location.reload(); e.preventDefault(); }
      else if (action === 'setAllCustomAccountsHidden') setAllCustomAccountsHidden(target.getAttribute('data-hidden') === 'true');
      
      // Main UI actions
      else if (action === 'createCollectionRecord') createCollectionRecord(Number(target.getAttribute('data-id')));
      else if (action === 'duplicateRecord') duplicateRecord(Number(target.getAttribute('data-id')));
      else if (action === 'deleteRecord') deleteRecord(Number(target.getAttribute('data-id')), target.getAttribute('data-is-block') === 'true');
      else if (action === 'saveTemplate') { e.stopPropagation(); saveTemplate(Number(target.getAttribute('data-block-id'))); }
      else if (action === 'toggleBlock') {
        // タイトル編集や入力要素のクリックでは折りたたまない
        if (e.target.closest('h2, [contenteditable], button, input')) return;
        toggleBlock(Number(target.getAttribute('data-block-id')));
      }
      else if (action === 'sortBlockByDate') { e.stopPropagation(); sortBlockByDate(Number(target.getAttribute('data-block-id'))); }
      else if (action === 'adjustDate') adjustDate(target, Number(target.getAttribute('data-delta')));
      else if (action === 'moveCustomDictItem') { e.stopPropagation(); moveCustomDictItem(Number(target.getAttribute('data-index')), Number(target.getAttribute('data-delta'))); }
      else if (action === 'toggleCustomAccountHidden') toggleCustomAccountHidden(Number(target.getAttribute('data-index')));
      else if (action === 'deleteCustomDictItem') deleteCustomDictItem(Number(target.getAttribute('data-index')));
      else if (action === 'focusNewBlockMemo') { const el = document.getElementById('new-block-memo'); el.focus(); el.scrollIntoView({behavior: 'smooth', block: 'center'}); }
      else if (action === 'clickCsvInput') document.getElementById('csv-input').click();
    }
  });

  document.addEventListener('change', (e) => {
    let target = e.target;
    if (target.id === 'dict-select') changeAccountDict();
    else if (target.id === 'csv-input') importCSV(e);
    else if (target.id === 'period-filter') handleDropdownChange();
    else if (target.getAttribute('data-action') === 'renderCSVPreview') renderCSVPreview();
    else if (target.getAttribute('data-action') === 'updateCSVPreview') updateCSVPreview();
  });

  document.addEventListener('input', (e) => {
    let target = e.target;
    if (target.hasAttribute('data-field') || target.classList.contains('item-memo') || target.classList.contains('item-amount') || target.classList.contains('item-account') || target.tagName === 'H2') {
      setDirty(true);
    }
    if (target.getAttribute('data-action') === 'renderCSVPreview') renderCSVPreview();
    if (target.type === 'date') checkFutureDate(target);
  });

  document.addEventListener('submit', (e) => {
    let target = e.target;
    if (target.getAttribute('data-action') === 'prevent-submit-and-add-block') {
      e.preventDefault();
      addBlock();
    } else if (target.getAttribute('data-action') === 'prevent-submit') {
      e.preventDefault();
    } else if (target.classList.contains('block-form')) {
      e.preventDefault();
      const blockId = Number(target.getAttribute('data-block-id'));
      addItem(blockId, target.querySelector('.item-memo').value, target.querySelector('.item-amount').value, target.querySelector('.item-date').value, target.querySelector('.item-account').value);
    }
  });

  document.addEventListener('focus', (e) => {
    let target = e.target;
    if (target.classList.contains('item-account')) target.select();
    if (target.hasAttribute('data-field') && target.getAttribute('data-field') === 'amount') {
      if (target.tagName === 'INPUT') {
        target.value = target.value.replace(/,/g, '');
        target.select();
      }
    }
    if ((target.classList.contains('item-memo') || target.classList.contains('item-amount')) && target.tagName === 'INPUT') {
      if(window.innerWidth < 640) { setTimeout(() => target.closest('form')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300); }
    }
  }, true);

  document.addEventListener('blur', (e) => {
    let target = e.target;
    if (target.hasAttribute('data-field')) {
      const id = Number(target.getAttribute('data-id'));
      const field = target.getAttribute('data-field');
      const val = target.tagName === 'INPUT' ? target.value : target.innerText;
      updateRecord(id, field, val, target);
    }
    if (target.classList.contains('item-memo') && target.tagName === 'INPUT') {
      autoSuggestAccount(target);
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    let target = e.target;
    if (target.getAttribute('data-action') === 'handleNewBlockKeydown') {
      if (e.key === 'Enter' && e.isComposing) { e.preventDefault(); return false; }
    }
    if (target.hasAttribute('data-field') || target.tagName === 'H2') {
      if(e.key === 'Enter' && !e.isComposing) { e.preventDefault(); target.blur(); }
    }
    if (target.classList.contains('item-account')) {
      if(e.key === 'Enter'){ 
        if(e.isComposing){ e.preventDefault(); return false; } 
        e.preventDefault(); 
        const memo = target.closest('form')?.querySelector('.item-memo');
        if(memo) memo.focus();
      }
    }
    if (target.classList.contains('item-memo') && target.tagName === 'INPUT') {
      if(e.key === 'Enter'){ 
        if(e.isComposing){ e.preventDefault(); return false; } 
        e.preventDefault(); 
        const amount = target.closest('form')?.querySelector('.item-amount');
        if(amount) amount.focus();
      }
    }
    if (target.classList.contains('item-amount') && target.tagName === 'INPUT') {
      if(e.key === 'Enter' && e.isComposing){ e.preventDefault(); return false; }
      else if(e.key === 'Tab' && !e.shiftKey){
        if (target.value.trim() !== '') {
          e.preventDefault();
          target.closest('form')?.requestSubmit();
        }
      }
    }
  });

  document.addEventListener('paste', (e) => {
    let target = e.target;
    if (target.hasAttribute('contenteditable')) {
      handlePlainTextPaste(e);
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initEventDelegation();
});

// Flush draft when the tab is hidden or closing
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    void flushDraftNow();
  }
});
window.addEventListener('pagehide', () => {
  void flushDraftNow();
});

// Service Worker: an update waits until the user chooses to reload
function showUpdateToast() {
  if (document.getElementById('update-toast')) return;
  const toast = document.createElement('div');
  toast.id = 'update-toast';
  toast.setAttribute('role', 'status');
  toast.className =
    'fixed inset-x-0 bottom-6 z-[9999] mx-auto flex w-max max-w-[90vw] items-center gap-3 rounded-full border border-slate-800/50 bg-slate-900/95 py-2 pr-2 pl-5 text-xs font-medium text-white shadow-xl backdrop-blur-sm';
  const label = document.createElement('span');
  label.textContent = '✨ 新しいバージョンがあります。';
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'rounded-full bg-white px-3 py-1.5 font-semibold text-slate-900 hover:bg-slate-200';
  apply.textContent = '再読み込み';
  apply.addEventListener('click', applyAppUpdate);
  const later = document.createElement('button');
  later.type = 'button';
  later.className = 'rounded-full px-2 py-1 text-slate-400 hover:text-white';
  later.setAttribute('aria-label', 'あとで');
  later.textContent = '×';
  later.addEventListener('click', () => toast.remove());
  toast.append(label, apply, later);
  document.body.appendChild(toast);
}

// Activate the waiting worker only after the draft is safe, then reload once it controls the page
async function applyAppUpdate() {
  if (isDirty && !(await flushDraftNow())) {
    showToast('先にファイルを保存してから、再読み込みしてください。', '⚠️', { duration: 6000 });
    return;
  }
  const registration = await navigator.serviceWorker.getRegistration();
  if (registration && registration.waiting) {
    navigator.serviceWorker.addEventListener(
      'controllerchange',
      () => {
        isDirty = false;
        location.reload();
      },
      { once: true },
    );
    registration.waiting.postMessage('SKIP_WAITING');
  } else {
    isDirty = false;
    location.reload();
  }
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then(
      (registration) => {
        // An update may have finished installing during an earlier visit
        if (registration.waiting && navigator.serviceWorker.controller) showUpdateToast();
        registration.addEventListener('updatefound', () => {
          const worker = registration.installing;
          worker.addEventListener('statechange', () => {
            // Installed while an old worker controls the page: this is an update
            if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdateToast();
          });
        });
      },
      (err) => console.error('ServiceWorker registration failed:', err),
    );
  });
}
