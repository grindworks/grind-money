let db = null; // SQLiteデータベースのインスタンス
let SQL = null; // sql.jsのモジュール
let fileHandle = null; // File System Access APIのファイルハンドル
let isDirty = false; // 未保存の変更があるかどうか
let pendingCSVData = []; // CSVパース結果の一時保存
let lastUsedDates = {}; // ブロックごとの最終使用日付を記憶
let pendingCSVBuffer = null; // CSVのバイナリデータ
let currentDisplayedTotal = 0; // カウントアップ用
let collapsedBlocks = new Set(); // 折りたたまれたブロックのIDを記憶
let totalAnimationId = null; // アニメーションの多重起動防止用ID
let draftTimer = null; // ドラフト自動保存用タイマー
let statusTimeoutId = null; // ステータスバー通知のタイマーID
let isSaving = false; // 保存処理の多重実行防止フラグ
let lastSavedPassword = ""; // パスワードの変更・解除検知用

const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;

let customAccountDict = []; // カスタム科目辞書の配列

// --- ダークモード管理 ---
function initDarkMode() {
  const saved = localStorage.getItem("theme");
  if (
    saved === "dark" ||
    (!saved && window.matchMedia("(prefers-color-scheme: dark)").matches)
  ) {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
  updateMetaThemeColor(document.documentElement.classList.contains("dark"));
}

function toggleDarkMode() {
  if (document.startViewTransition) {
    document.startViewTransition(() => executeThemeToggle());
  } else {
    executeThemeToggle();
  }
}

function executeThemeToggle() {
  const isDark = document.documentElement.classList.toggle("dark");
  localStorage.setItem("theme", isDark ? "dark" : "light");
  updateMetaThemeColor(isDark);
  // DBが初期化済みなら設定も保存
  if (db) {
    try {
      setDbSetting("theme", isDark ? "dark" : "light");
    } catch (e) {}
  }
}

function updateMetaThemeColor(isDark) {
  const metaTheme = document.getElementById("meta-theme-color");
  if (metaTheme) {
    metaTheme.setAttribute("content", isDark ? "#0f172a" : "#f8fafc");
  }
}

// ページロード時にダークモードを即座に適用（FOUC防止）
initDarkMode();

// --- 設定保存用ユーティリティ (SQLiteベース) ---
function getDbSetting(key, defaultValue = null) {
  if (!db) return defaultValue;
  let stmt;
  try {
    stmt = db.prepare("SELECT value FROM settings WHERE key = ?");
    stmt.bind([key]);
    if (stmt.step()) {
      return stmt.get()[0];
    }
  } catch (e) {
    console.error("Setting read error:", e);
  } finally {
    if (stmt) stmt.free();
  }
  return defaultValue;
}

function setDbSetting(key, value) {
  if (!db) return;
  try {
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [
      key,
      value,
    ]);
    setDirty(true);
  } catch (e) {
    console.error("Setting write error:", e);
  }
}

// --- 自動バックアップ (IndexedDB) ロジック ---
const DB_NAME = "GrindMoneyDB";
const STORE_NAME = "drafts";

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
      console.warn(
        "IndexedDBがブロックされています。ドラフト自動保存は無効化されます。",
      );
      reject(e);
    }
  });
}

async function saveDraft(uints) {
  try {
    const idb = await openDB();
    const tx = idb.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(uints, "latest_draft");
    return new Promise((resolve) => {
      tx.oncomplete = () => resolve();
    });
  } catch (e) {
    console.error("Draft save failed", e);
  }
}

async function loadDraft() {
  try {
    const idb = await openDB();
    const tx = idb.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get("latest_draft");
    return new Promise((resolve) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });
  } catch (e) {
    return null;
  }
}

async function clearDraft() {
  try {
    const idb = await openDB();
    const tx = idb.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete("latest_draft");
  } catch (e) {
    console.error("Draft clear failed", e);
  }
}

// 未保存状態（isDirty）のセットとUIバッジの更新
function setDirty(state) {
  isDirty = state;
  const badge = document.getElementById("dirty-badge");
  if (badge) {
    if (state) {
      badge.classList.remove("hidden");
      badge.classList.add("flex");
    } else {
      badge.classList.add("hidden");
      badge.classList.remove("flex");
    }
  }

  // タブのタイトルとファイル名バッジの反映
  const fileName =
    fileHandle && fileHandle.name ? fileHandle.name : "Unsaved.money";
  const titleBase = `${fileName} - GrindMoney`;
  document.title = state ? `* ${titleBase}` : titleBase;
  const filenameBadge = document.getElementById("current-filename");
  if (filenameBadge) {
    filenameBadge.textContent = fileName;
    filenameBadge.classList.remove("hidden");
  }

  // 自動バックアップの実行 (10秒デバウンス: 入力が落ち着いたタイミングで実行し、db.export() によるタイピング中のフリーズを防止)
  if (state && db) {
    if (draftTimer) {
      clearTimeout(draftTimer);
    }
    draftTimer = setTimeout(async () => {
      try {
        if (!isDirty) return; // 【追加】タイマー発火時点でのキャンセル確認

        let data = db.export();
        const password = document.getElementById("file-password").value;
        if (password) {
          data = await encryptData(data, password);
        }

        if (!isDirty) return; // 【追加】非同期処理中に手動保存された場合は破棄する

        await saveDraft(data);
      } catch (e) {
        console.error("Draft save failed", e);
      } finally {
        draftTimer = null; // 保存完了後にタイマーを解放
      }
    }, 10000);
  } else if (!state) {
    if (draftTimer) {
      clearTimeout(draftTimer);
      draftTimer = null;
    }
    clearDraft();
  }
}

// --- 共通ユーティリティ ---
function escapeHtml(unsafe) {
  return (unsafe ?? "")
    .toString()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// セキュアなパスワード入力プロンプト (Promiseラッパー)
function requestPasswordPrompt(message) {
  return new Promise((resolve) => {
    const modal = document.getElementById("password-prompt-modal");
    const msgEl = document.getElementById("password-prompt-message");
    const input = document.getElementById("password-prompt-input");
    const btnSubmit = document.getElementById("password-prompt-submit");
    const btnCancel = document.getElementById("password-prompt-cancel");

    msgEl.textContent = message;
    input.value = "";
    modal.classList.remove("hidden");
    modal.classList.add("flex");
    setTimeout(() => input.focus(), 100);

    const cleanup = () => {
      modal.classList.add("hidden");
      modal.classList.remove("flex");
      btnSubmit.removeEventListener("click", onSubmit);
      btnCancel.removeEventListener("click", onCancel);
      input.removeEventListener("keydown", onKeyDown);
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
      if (e.key === "Enter") onSubmit();
      if (e.key === "Escape") onCancel();
    };

    btnSubmit.addEventListener("click", onSubmit);
    btnCancel.addEventListener("click", onCancel);
    input.addEventListener("keydown", onKeyDown);
  });
}

function handlePlainTextPaste(event) {
  event.preventDefault();
  const text = (event.clipboardData || window.clipboardData).getData(
    "text/plain",
  );
  const cleanText = text.replace(/[\r\n\t]+/g, " ").trim();
  document.execCommand("insertText", false, cleanText);
}

// --- 暗号化ロジック (Web Crypto API) ---
const MAGIC_BYTES = new TextEncoder().encode("GRINDEN2"); // 最新仕様 (60万回)
const MAGIC_BYTES_LEGACY = new TextEncoder().encode("GRINDENC"); // 過去仕様 (10万回)

async function deriveKey(password, salt, iterations = 600000) {
  const enc = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  return window.crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt, iterations: iterations, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptData(data, password) {
  const salt = window.crypto.getRandomValues(new Uint8Array(16));
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  // 新規暗号化時はOWASP推奨の60万回を使用
  const key = await deriveKey(password, salt, 600000);
  const encrypted = await window.crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv },
    key,
    data,
  );

  const result = new Uint8Array(
    MAGIC_BYTES.length + salt.length + iv.length + encrypted.byteLength,
  );
  result.set(MAGIC_BYTES, 0);
  result.set(salt, MAGIC_BYTES.length);
  result.set(iv, MAGIC_BYTES.length + salt.length);
  result.set(
    new Uint8Array(encrypted),
    MAGIC_BYTES.length + salt.length + iv.length,
  );
  return result;
}

async function decryptData(encryptedData, password) {
  const magic = encryptedData.slice(0, 8);
  const magicStr = new TextDecoder().decode(magic);
  const isEncryptedV2 = magicStr === "GRINDEN2";
  const isEncryptedLegacy = magicStr === "GRINDENC";
  if (!isEncryptedV2 && !isEncryptedLegacy) return encryptedData; // 暗号化されていないファイルはそのまま返す

  const salt = encryptedData.slice(8, 24);
  const iv = encryptedData.slice(24, 36);
  const data = encryptedData.slice(36);

  try {
    if (isEncryptedV2) {
      const key = await deriveKey(password, salt, 600000);
      const decrypted = await window.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv },
        key,
        data,
      );
      return new Uint8Array(decrypted);
    } else {
      // Legacy (10万回仕様)
      const legacyKey = await deriveKey(password, salt, 100000);
      const decrypted = await window.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv },
        legacyKey,
        data,
      );
      return new Uint8Array(decrypted);
    }
  } catch (e) {
    throw new Error("パスワードが間違っているか、ファイルが破損しています。");
  }
}
// --------------------------------------

// データベースの後方互換性（スキーマ移行）を担保する
function migrateDatabase() {
  if (!db) return;
  try {
    const res = db.exec("PRAGMA table_info(records)");
    if (res.length > 0) {
      const columns = res[0].values.map((col) => col[1]);
      if (!columns.includes("account")) {
        db.run("ALTER TABLE records ADD COLUMN account TEXT");
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

    // 🎯 God-Rank: 既存のlocalStorageからSQLiteへのシームレスな移行
    try {
      const keysToMigrate = ["customAccountDict", "fiscalMonth", "accountDict"];
      let checkStmt, insertStmt;
      try {
        checkStmt = db.prepare("SELECT 1 FROM settings WHERE key = ?");
        insertStmt = db.prepare(
          "INSERT INTO settings (key, value) VALUES (?, ?)",
        );

        for (const key of keysToMigrate) {
          const oldVal = localStorage.getItem(key);
          if (oldVal !== null && oldVal !== undefined) {
            checkStmt.bind([key]);
            const exists = checkStmt.step();
            checkStmt.reset();

            if (!exists) {
              insertStmt.run([key, oldVal]);
              localStorage.removeItem(key); // 吸い上げ完了後、古いデータを消去
              setDirty(true);
            }
          }
        }
      } finally {
        if (checkStmt) checkStmt.free();
        if (insertStmt) insertStmt.free();
      }
    } catch (e) {
      console.warn("マイグレーションの実行をスキップしました", e);
    }
  } catch (e) {
    console.error("Migration error:", e);
  }
}

// 1. WebAssembly版 SQLiteエンジンの初期化
async function initSQLite() {
  try {
    if (typeof initSqlJs === "undefined") {
      throw new Error(
        "sql.js が読み込まれていません。通信環境またはCDNの障害が疑われます。",
      );
    }

    const config = {
      locateFile: (filename) =>
        `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${filename}`,
    };
    SQL = await initSqlJs(config);

    let initialData = null;
    const draft = await loadDraft();
    if (draft) {
      if (
        confirm(
          "⚠️ 前回終了時の未保存データ（バックアップ）が見つかりました。\n\n復元しますか？\n（「キャンセル」を押すとバックアップは破棄されます）",
        )
      ) {
        initialData = draft;
        let Uints = draft;
        const magic = Uints.slice(0, 8);
        const magicStr = new TextDecoder().decode(magic);
        const isEncrypted = magicStr === "GRINDENC" || magicStr === "GRINDEN2";

        if (isEncrypted) {
          let password = document.getElementById("file-password").value;
          let success = false;
          while (!success) {
            try {
              Uints = await decryptData(Uints, password);
              success = true;
              if (password) {
                document.getElementById("file-password").value = password;
                lastSavedPassword = password;
              }
            } catch (err) {
              password = await requestPasswordPrompt(
                "バックアップデータは暗号化されています。解除パスワードを入力してください:",
              );
              if (password === null) {
                alert(
                  "起動をキャンセルしました。リロードしてやり直してください。",
                );
                document.body.innerHTML =
                  "<h1 style='text-align:center; margin-top:20vh;'>保護のため停止しました。<br>リロードしてください。</h1>";
                throw new Error("User canceled decryption");
              }
            }
          }
        }
        initialData = Uints;
      } else {
        await clearDraft();
      }
    }

    if (initialData) {
      try {
        db = new SQL.Database(initialData);
        migrateDatabase();
        setDirty(true);

        showToast(
          "未保存データを復元しました",
          '<span class="text-orange-400">↺</span>',
        );
      } catch (dbError) {
        // バックアップデータが破損している場合のセーフティーネット
        console.error(
          "ドラフトの復元に失敗しました。データが破損しています。",
          dbError,
        );
        alert("⚠️ 前回の未保存データが破損しているため、復元を中止しました。");
        await clearDraft();
        db = new SQL.Database(); // 空のDBで再スタート
        db.run(`
          CREATE TABLE IF NOT EXISTS records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            parent_id INTEGER,
            memo TEXT,
            amount INTEGER,
            account TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            sort_order INTEGER DEFAULT 0
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
          sort_order INTEGER DEFAULT 0
        );
      `);

      migrateDatabase();

      showToast("SQLite起動完了", '<span class="text-green-400">●</span>');
    }

    // DB内の設定を読み込んでUIに反映
    loadSettingsFromDb();

    document.getElementById("app-ui").classList.remove("hidden");

    // 【パフォーマンス対策】データ数が多い場合は、起動時のフリーズを防ぐためデフォルトで「今年度」のみを表示
    const countRes = db.exec("SELECT COUNT(*) FROM records");
    const recordCount = countRes.length > 0 ? countRes[0].values[0][0] : 0;
    if (recordCount > 50 && !window.currentActiveMonths) {
      setFiscalYearFilter();
    } else {
      renderData();
    }

    // PWAとしてOSからファイルがダブルクリックされた場合の処理
    handleLaunchFiles();
  } catch (err) {
    showToast("エラー: SQLiteの起動に失敗しました", "<span>⚠️</span>", "error");
    console.error(err);

    // ステータスバーを消し、代わりに致命的エラー画面を大きく表示する
    const statusEl = document.getElementById("status");
    if (statusEl) statusEl.style.display = "none";

    const errorScreen = document.getElementById("fatal-error-screen");
    if (errorScreen) {
      errorScreen.classList.remove("hidden");
      errorScreen.classList.add("flex");
    }
  }
}

// OS上で .money または .grind ファイルがダブルクリックされた時の処理 (File Handling API)
function handleLaunchFiles() {
  if ("launchQueue" in window) {
    window.launchQueue.setConsumer(async (launchParams) => {
      if (!launchParams.files || launchParams.files.length === 0) return;

      if (isDirty) {
        if (
          !confirm(
            "未保存のデータがあります。変更を破棄して別のファイルを開きますか？",
          )
        )
          return;
      }
      await processFileHandle(launchParams.files[0]);
    });
  }
}

// ステータス表示を数秒後に消す関数
function hideStatus() {
  if (statusTimeoutId) clearTimeout(statusTimeoutId);

  statusTimeoutId = setTimeout(() => {
    const statusEl = document.getElementById("status");
    if (statusEl) {
      statusEl.classList.remove("opacity-100", "translate-y-0");
      statusEl.classList.add("opacity-0", "-translate-y-4");
      statusEl.style.pointerEvents = "none";
    }
  }, 3000);
}

// トースト通知を表示するヘルパー関数
function showToast(message, iconHtml = "✅", type = "normal") {
  const statusEl = document.getElementById("status");
  if (!statusEl) return;

  const bgClass =
    type === "error"
      ? "bg-red-500/90 border-red-600/50"
      : type === "warning"
        ? "bg-red-900/90 border-red-700/50"
        : "bg-slate-800/90 border-slate-700/50";

  statusEl.innerHTML = `${iconHtml} <span>${message}</span>`;
  statusEl.className = `fixed top-4 sm:top-8 left-1/2 -translate-x-1/2 backdrop-blur-sm text-white px-5 py-2.5 rounded-full text-xs font-medium shadow-xl border transition-all duration-500 z-50 flex items-center gap-2 translate-y-0 opacity-100 ${bgClass}`;
  statusEl.style.pointerEvents = "auto";

  hideStatus();
}

// 2. ブロックまたはアイテムの追加
function addBlock() {
  const memoInput = document.getElementById("new-block-memo");
  const trimmedMemo = memoInput.value.trim();
  if (!trimmedMemo) return;

  db.run("INSERT INTO records (memo, amount) VALUES (?, ?)", [
    trimmedMemo,
    null,
  ]);
  const res = db.exec("SELECT last_insert_rowid()");
  const newId = res[0].values[0][0];

  memoInput.value = "";
  setDirty(true);
  renderData(newId);
}

// スマート入力用の数式評価 (例: "1500 / 3" -> 500)
function evaluateMath(expr) {
  if (expr === null || expr === "") return null;

  // 異常に長い入力によるフリーズを防止
  if (String(expr).length > 50) return null;

  try {
    // 全角数字・記号を半角に変換する
    let normalized = String(expr).replace(
      /[０-９＋－＊／．（）]/g,
      function (s) {
        return String.fromCharCode(s.charCodeAt(0) - 0xfee0);
      },
    );
    // 全角の「×」「÷」「ー」などを半角記号にマッピング
    normalized = normalized
      .replace(/×/g, "*")
      .replace(/÷/g, "/")
      .replace(/[ー−]/g, "-");

    // 数字と四則演算記号以外を除去して安全化
    const sanitized = normalized.replace(/[^0-9+\-*/().]/g, "");
    if (!sanitized) return null;
    if (sanitized.includes("**")) return null;

    // CSP環境 (unsafe-eval禁止) 対応のため、new Function を排除し
    // Shunting-yard アルゴリズムによる安全な数式評価パーサーを実装
    let tokens = [];
    let numStr = "";
    for (let i = 0; i < sanitized.length; i++) {
      const c = sanitized[i];
      if (/[0-9.]/.test(c)) {
        numStr += c;
      } else {
        if (c === "-" && (i === 0 || /[+\-*/(]/.test(sanitized[i - 1]))) {
          numStr += c;
        } else {
          if (numStr) {
            // 単項マイナスの直後が括弧だった場合の救済措置
            if (numStr === "-") {
              tokens.push("-1", "*");
            } else {
              tokens.push(numStr);
            }
            numStr = "";
          }
          tokens.push(c);
        }
      }
    }
    if (numStr) {
      if (numStr === "-") tokens.push("-1", "*");
      else tokens.push(numStr);
    }

    const precedence = { "+": 1, "-": 1, "*": 2, "/": 2 };
    const outputQueue = [];
    const operatorStack = [];

    for (const token of tokens) {
      if (!isNaN(parseFloat(token))) {
        outputQueue.push(parseFloat(token));
      } else if ("+-*/".includes(token)) {
        while (
          operatorStack.length > 0 &&
          operatorStack[operatorStack.length - 1] !== "(" &&
          precedence[operatorStack[operatorStack.length - 1]] >=
            precedence[token]
        ) {
          outputQueue.push(operatorStack.pop());
        }
        operatorStack.push(token);
      } else if (token === "(") {
        operatorStack.push(token);
      } else if (token === ")") {
        while (
          operatorStack.length > 0 &&
          operatorStack[operatorStack.length - 1] !== "("
        )
          outputQueue.push(operatorStack.pop());
        if (operatorStack.length === 0) return null;
        operatorStack.pop();
      }
    }
    while (operatorStack.length > 0) {
      const op = operatorStack.pop();
      if (op === "(" || op === ")") return null;
      outputQueue.push(op);
    }

    const evalStack = [];
    for (const token of outputQueue) {
      if (typeof token === "number") evalStack.push(token);
      else {
        const b = evalStack.pop();
        const a = evalStack.pop();
        if (a === undefined || b === undefined) return null;
        if (token === "+") evalStack.push(a + b);
        else if (token === "-") evalStack.push(a - b);
        else if (token === "*") evalStack.push(a * b);
        else if (token === "/") evalStack.push(a / b);
      }
    }

    if (evalStack.length !== 1) return null;
    const result = evalStack[0];

    if (!isFinite(result) || isNaN(result)) return null;
    const rounded = Math.round(result);
    if (rounded > 10000000000000 || rounded < -10000000000000) return null;
    return rounded;
  } catch (e) {
    return null;
  }
}

function addItem(parentId, memo, amount, dateStr, accountStr) {
  const safeMemo = (memo || "").trim();
  if (!safeMemo || amount === "" || amount === null) return;
  if (parentId) {
    if (dateStr) lastUsedDates[parentId] = dateStr;
  }

  if (dateStr) {
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    if (dateStr > todayStr) {
      showToast(
        "未来の日付で登録しました",
        '<span class="text-orange-400">⚠️</span>',
        "warning",
      );
    }
  }

  insertRecord(parentId, safeMemo, amount, dateStr, accountStr);

  // フィルター外の日付を追加した場合、自動で「すべての期間」に表示を戻す
  const filterVal = document.getElementById("period-filter")?.value;
  let isOutsideFilter = false;

  if (window.currentActiveMonths) {
    // カスタム期間（1-3月、今年度など）が適用されている場合
    if (dateStr) {
      const match = window.currentActiveMonths.some((m) =>
        dateStr.startsWith(m),
      );
      if (!match) isOutsideFilter = true;
    }
  } else if (filterVal && filterVal !== "all") {
    // 単一月のドロップダウンが適用されている場合
    if (dateStr && !dateStr.startsWith(filterVal)) isOutsideFilter = true;
  }

  // フィルター外だった場合、全体表示にリセット
  if (isOutsideFilter) {
    window.currentActiveMonths = null;
    setActiveQuickPeriodButton(null);
    if (document.getElementById("period-filter")) {
      document.getElementById("period-filter").value = "all";
    }

    // ステータスバーで通知
    showToast(
      "追加した日付がフィルター外のため、「すべての期間」に表示を戻しました",
      '<span class="text-blue-400">👀</span>',
    );
  }

  renderData(parentId);
}

function insertRecord(
  parentId,
  memo,
  amountExpr,
  dateStr = null,
  accountStr = null,
) {
  const parsedAmount = evaluateMath(amountExpr);
  // 金額が入力されたのに数式のパースに失敗した場合（不正な文字列など）は弾く
  if (amountExpr !== null && amountExpr !== "" && parsedAmount === null) {
    alert("金額の入力、または数式が正しくありません。");
    return;
  }

  let query =
    "INSERT INTO records (parent_id, memo, amount, account) VALUES (?, ?, ?, ?)";
  let params = [parentId, memo, parsedAmount, accountStr];

  if (dateStr) {
    // タイムゾーンによるバグを回避するため、入力された日付を文字列のまま保存する
    query =
      "INSERT INTO records (parent_id, memo, amount, account, created_at) VALUES (?, ?, ?, ?, ?)";
    params.push(dateStr + " 00:00:00");
  }

  let stmt;
  try {
    stmt = db.prepare(query);
    stmt.run(params);
  } finally {
    if (stmt) stmt.free();
  }
  setDirty(true);
}

// 【新機能 1】 過去のメモ履歴を抽出して Datalist に登録する
function renderMemoSuggestions() {
  if (!db) return;
  const datalist = document.getElementById("memo-suggestions");
  if (!datalist) return;

  try {
    // 親ブロックではない(parent_id IS NOT NULL)過去のメモを重複排除して直近使った順に取得
    // SQLiteでの安全な書き方(GROUP BY + MAX)を採用
    const res = db.exec(
      "SELECT memo FROM records WHERE parent_id IS NOT NULL AND memo != '' GROUP BY memo ORDER BY MAX(id) DESC",
    );
    datalist.innerHTML = "";
    if (res.length > 0) {
      res[0].values.forEach(([memo]) => {
        const option = document.createElement("option");
        option.value = memo;
        datalist.appendChild(option);
      });
    }
  } catch (e) {
    console.error("Failed to render memo suggestions:", e);
  }
}

// 【新機能 2】 入力されたメモから、過去の科目を自動推論して埋める
function autoSuggestAccount(memoInput) {
  if (!db) return;
  const memo = memoInput.value.trim();
  if (!memo) return;

  const form = memoInput.closest("form");
  const accountInput = form.querySelector(".item-account");

  // すでにユーザーが科目を手入力している場合は、上書きせずに尊重する
  if (accountInput.value.trim() !== "") return;

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
        accountInput.classList.add(
          "!bg-purple-100",
          "!text-purple-700",
          "transition-colors",
        );
        setTimeout(
          () =>
            accountInput.classList.remove("!bg-purple-100", "!text-purple-700"),
          1000,
        );
      }
    }
  } catch (e) {
    console.error("Auto suggest account failed:", e);
  } finally {
    if (stmt) stmt.free();
  }
}

// --- インプレース編集機能 ---
function updateRecord(id, field, newValue, element) {
  if (!db) return;

  // ホワイトリストによるSQLインジェクション対策
  const allowedFields = ["amount", "memo", "account", "created_at"];
  if (!allowedFields.includes(field)) {
    console.error("Invalid field name");
    return;
  }

  let val = newValue.trim();
  if (field === "amount") {
    if (val === "") {
      val = null; // 空文字の場合は未入力(null)として扱う
    } else {
      // 表示時のカンマを除去してから数式評価
      val = evaluateMath(val.replace(/,/g, ""));
      if (val === null) {
        alert("金額の入力、または数式が正しくありません。");
        renderData(); // 元の値に戻すために再レンダリング
        return;
      }
    }
  } else if (field === "created_at") {
    // 全角数字・記号を半角に変換（スマホフリック入力対応）
    val = val.replace(/[０-９／－]/g, (s) =>
      String.fromCharCode(s.charCodeAt(0) - 0xfee0),
    );
    val = val.replace(/[ー−]/g, "-");

    // "12/31" などの簡易形式をパース
    let match = val.match(/^(\d{1,2})[\/\-](\d{1,2})$/);
    if (match) {
      let year = new Date().getFullYear();
      if (element && element.hasAttribute("data-year")) {
        year = parseInt(element.getAttribute("data-year"), 10);
      }
      const m = parseInt(match[1], 10);
      const d = parseInt(match[2], 10);

      const dateObj = new Date(year, m - 1, d);
      if (
        dateObj.getFullYear() !== year ||
        dateObj.getMonth() !== m - 1 ||
        dateObj.getDate() !== d
      ) {
        alert("存在しない日付です。カレンダーを確認してください。");
        renderData();
        return;
      }
      val = `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")} 00:00:00`;
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
          alert("存在しない日付です。カレンダーを確認してください。");
          renderData();
          return;
        }

        val = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")} 00:00:00`;
      } else {
        alert("日付の形式が正しくありません。(例: 12/31 または 2025-12-31)");
        renderData();
        return;
      }
    }

    // 未来の日付チェック
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")} 00:00:00`;
    if (val > todayStr) {
      showToast(
        "未来の日付が入力されました",
        '<span class="text-orange-400">⚠️</span>',
        "warning",
      );
    }
  }

  // 変更があるかチェック (内容が変わっていない場合は何もしない)
  let checkStmt;
  try {
    checkStmt = db.prepare(`SELECT ${field} FROM records WHERE id = ?`);
    checkStmt.bind([id]);
    if (checkStmt.step()) {
      const currentVal = checkStmt.get()[0];
      if (currentVal == val) {
        // 型の違い（"100"と100など）を許容するため == を使用
        // カンマが除去された表示を元に戻す
        if (element && field === "amount") {
          element.innerText = val !== null ? val.toLocaleString("ja-JP") : "";
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
      typeof activeEl.hasAttribute === "function" &&
      activeEl.hasAttribute("data-field") &&
      activeEl.hasAttribute("data-id")
    ) {
      const field = activeEl.getAttribute("data-field");
      const id = activeEl.getAttribute("data-id");
      focusSelector = `[data-id="${id}"][data-field="${field}"]`;
    } else if (activeEl.classList.contains("item-memo")) {
      const form = activeEl.closest("form");
      if (form) focusSelector = `#${form.id} .item-memo`;
    } else if (activeEl.classList.contains("item-amount")) {
      const form = activeEl.closest("form");
      if (form) focusSelector = `#${form.id} .item-amount`;
    } else if (activeEl.classList.contains("item-account")) {
      const form = activeEl.closest("form");
      if (form) focusSelector = `#${form.id} .item-account`;
    } else if (activeEl.classList.contains("item-date")) {
      const form = activeEl.closest("form");
      if (form) focusSelector = `#${form.id} .item-date`;
    }
  }

  // ★ 金額や日付が変更された場合のみ再計算・再描画
  if (field === "amount") {
    // DOM全体を破壊せず、金額表示と合計値のみをソフトに更新する（クリック消失バグ防止）
    if (element) {
      element.innerText = val !== null ? val.toLocaleString("ja-JP") : "";
    }
    updateTotalsOnly();
  } else if (field === "created_at") {
    // ✅ フィルター期間外に変更された場合の神隠し（消失）を防ぐフェイルセーフ
    const filterVal = document.getElementById("period-filter")?.value;
    let isOutsideFilter = false;

    if (window.currentActiveMonths) {
      const match = window.currentActiveMonths.some((m) => val.startsWith(m));
      if (!match) isOutsideFilter = true;
    } else if (filterVal && filterVal !== "all") {
      if (!val.startsWith(filterVal)) isOutsideFilter = true;
    }

    if (isOutsideFilter) {
      window.currentActiveMonths = null;
      setActiveQuickPeriodButton(null);
      if (document.getElementById("period-filter")) {
        document.getElementById("period-filter").value = "all";
      }
      showToast(
        "日付がフィルター外に変更されたため、「すべての期間」を表示します",
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
            if (target.hasAttribute("contenteditable")) {
              const range = document.createRange();
              const sel = window.getSelection();
              range.selectNodeContents(target);
              range.collapse(false);
              sel.removeAllRanges();
              sel.addRange(range);
            }
          }
        } catch (e) {
          console.warn(
            "フォーカスの復元をスキップしました(不正なセレクタ等)",
            e,
          );
        }
      });
    }
  } else {
    // メモや科目の変更は、すでに画面上の文字（innerText / value）が書き換わっているため、
    // DBへの保存(UPDATE)と setDirty(true) だけで十分。DOMの再構築はスキップし、超速タイピングを邪魔しない。
  }
}

// 金額編集時に画面全体を再描画せず、合計金額のみを更新する
function updateTotalsOnly() {
  if (!db) return;

  // 期間フィルターの状態を取得してクエリに反映させる
  const filterVal = document.getElementById("period-filter")?.value || "all";
  let whereClause = "";
  let params = [];

  if (window.currentActiveMonths) {
    const orConditions = window.currentActiveMonths
      .map((m) => {
        params.push(`${m}%`);
        return "created_at LIKE ?";
      })
      .join(" OR ");
    whereClause = ` AND (${orConditions})`;
  } else if (filterVal !== "all") {
    whereClause = ` AND created_at LIKE ?`;
    params.push(`${filterVal}%`);
  }

  let stmtTotal;
  let stmtBlock;
  try {
    // 1. 総合計を更新
    let grandTotal = 0;
    stmtTotal = db.prepare(
      `SELECT SUM(amount) FROM records WHERE parent_id IS NOT NULL${whereClause}`,
    );
    stmtTotal.bind(params);
    if (stmtTotal.step()) {
      grandTotal = stmtTotal.get()[0] || 0;
    }
    animateTotal(Math.round(grandTotal));

    // 2. 各ブロックの合計を更新
    stmtBlock = db.prepare(
      `SELECT SUM(amount) FROM records WHERE parent_id = ?${whereClause}`,
    );
    const blocksRes = db.exec("SELECT id FROM records WHERE parent_id IS NULL");
    if (blocksRes.length > 0) {
      blocksRes[0].values.forEach(([blockId]) => {
        stmtBlock.bind([blockId, ...params]);
        let blockTotal = 0;
        if (stmtBlock.step()) blockTotal = stmtBlock.get()[0] || 0;
        stmtBlock.reset();
        const el = document.getElementById(`block-total-${blockId}`);
        if (el) el.innerText = blockTotal.toLocaleString("ja-JP");
      });
    }
  } catch (e) {
    console.error("Totals update failed:", e);
  } finally {
    if (stmtTotal) stmtTotal.free();
    if (stmtBlock) stmtBlock.free();
  }
}

// 日付の「+1日」「-1日」ボタンの処理
function adjustDate(btn, days) {
  const form = btn.closest("form");
  const dateInput = form.querySelector(".item-date");

  let d;
  const parts = dateInput.value.split("-");
  if (parts.length === 3) {
    d = new Date(
      parseInt(parts[0], 10),
      parseInt(parts[1], 10) - 1,
      parseInt(parts[2], 10),
    );
  } else {
    d = new Date(dateInput.value);
  }

  // Invalid Date の場合は今日を基準にする
  if (isNaN(d.getTime())) {
    d = new Date();
  }

  d.setDate(d.getDate() + days);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  dateInput.value = `${yyyy}-${mm}-${dd}`;

  if (typeof checkFutureDate === "function") checkFutureDate(dateInput);
  setDirty(true);
}

// 未来の日付入力時に警告色にする
function checkFutureDate(input) {
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  if (input.value > todayStr) {
    input.classList.add(
      "text-red-600",
      "font-bold",
      "bg-red-50",
      "rounded",
      "dark:text-red-400",
      "dark:bg-red-900/30",
    );
    input.classList.remove(
      "text-slate-600",
      "bg-transparent",
      "dark:text-slate-300",
    );
  } else {
    input.classList.add(
      "text-slate-600",
      "bg-transparent",
      "dark:text-slate-300",
    );
    input.classList.remove(
      "text-red-600",
      "font-bold",
      "bg-red-50",
      "rounded",
      "dark:text-red-400",
      "dark:bg-red-900/30",
    );
  }
}

// ハッカー的カウントアップ演出
function animateTotal(newTotal) {
  const el = document.getElementById("grand-total-num");
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
    el.textContent = current.toLocaleString("ja-JP");
    currentDisplayedTotal = current;
    if (progress < 1) {
      totalAnimationId = requestAnimationFrame(update);
    } else {
      el.textContent = newTotal.toLocaleString("ja-JP");
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
      bodyEl.style.maxHeight = bodyEl.scrollHeight + "px";
      bodyEl.offsetHeight; // リフローを強制してトランジションを有効化する
      bodyEl.style.maxHeight = "0px";
      bodyEl.style.opacity = "0";
      iconEl.style.transform = "rotate(-90deg)";
    } else {
      bodyEl.style.maxHeight = bodyEl.scrollHeight + 500 + "px";
      bodyEl.style.opacity = "1";
      iconEl.style.transform = "rotate(0deg)";
      setTimeout(() => {
        if (!collapsedBlocks.has(id)) {
          bodyEl.style.maxHeight = "99999px";
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
    document.querySelectorAll(".group\\/block").forEach((el) => {
      const id = parseInt(el.id.replace("block-", ""), 10);
      if (!isNaN(id)) collapsedBlocks.add(id);
    });
  } else {
    // セットを空にして全展開
    collapsedBlocks.clear();
  }

  // ✅ View Transition API を使って、滑らかに一斉開閉させる
  if (document.startViewTransition) {
    document.startViewTransition(() => renderData());
  } else {
    renderData();
  }
}

// --- 期間フィルターの選択肢を自動生成する ---
function updatePeriodDropdown() {
  if (!db) return;
  const select = document.getElementById("period-filter");
  if (!select) return;

  const currentVal = select.value;
  // DB内のすべての日付から「YYYY-MM」を重複なしで抽出
  const res = db.exec(
    "SELECT DISTINCT substr(created_at, 1, 7) FROM records WHERE parent_id IS NOT NULL AND created_at IS NOT NULL ORDER BY substr(created_at, 1, 7) DESC",
  );

  let years = new Set();
  let months = [];
  if (res.length > 0) {
    res[0].values.forEach((row) => {
      if (row[0]) {
        months.push(row[0]);
        years.add(row[0].split("-")[0]);
      }
    });
  }

  let html = `<option value="all">すべての期間</option>`;
  if (years.size > 0) {
    html += `<optgroup label="--- 年度で絞り込み ---">`;
    [...years].forEach(
      (y) =>
        (html += `<option value="${escapeHtml(y)}">${escapeHtml(y)}年</option>`),
    );
    html += `</optgroup><optgroup label="--- 月別で絞り込み ---">`;
    months.forEach((ym) => {
      const [y, m] = ym.split("-");
      html += `<option value="${escapeHtml(ym)}">${escapeHtml(y)}年${parseInt(m, 10)}月</option>`;
    });
    html += `</optgroup>`;
  }

  // 選択肢が更新された場合のみDOMを書き換える（フォーカス消失防止）
  if (select.innerHTML !== html) {
    select.innerHTML = html;
    if (select.querySelector(`option[value="${currentVal}"]`)) {
      select.value = currentVal;
    } else {
      select.value = "all";
    }
  }
}

// --- 期間制御用のヘルパー関数群 ---

// ドロップダウンの手動変更ハンドラ
function handleDropdownChange() {
  window.currentActiveMonths = null;
  setActiveQuickPeriodButton(null);
  if (document.startViewTransition) {
    document.startViewTransition(() => renderData());
  } else {
    renderData();
  }
}

// クイックセレクターのアクティブ状態を更新
function setActiveQuickPeriodButton(btn, keepYear = false) {
  const container = document.getElementById("quick-period-selectors");
  if (!container) return;
  const btns = container.querySelectorAll("button");
  btns.forEach((b) => {
    // 🎯 keepYearがtrueの場合、年度系のボタン(今年/今年度/前年度)の点灯は消さずに保持する
    if (keepYear) {
      const onclickAttr = b.getAttribute("onclick") || "";
      const isYearGroup = onclickAttr.includes("YearFilter");
      if (isYearGroup) return; // 年度系ボタンはリセットをスキップ
    }

    b.classList.remove("ring-2", "ring-primary", "ring-offset-1"); // 古い仕様の枠線をクリア
    b.classList.remove("!bg-primary", "!text-white", "!border-primary"); // 色反転をクリア

    const activeClasses = b.getAttribute("data-active-classes");
    if (activeClasses) {
      b.classList.remove(...activeClasses.split(" ").filter(Boolean));
    }
  });
  if (btn) {
    const activeClasses = btn.getAttribute("data-active-classes");
    if (activeClasses) {
      btn.classList.add(...activeClasses.split(" ").filter(Boolean));
    }
  }
}

// 単一期間（2025-04 など）のセット
function setPeriodFilter(val, btn = null) {
  window.currentActiveMonths = null;
  setActiveQuickPeriodButton(btn);
  const select = document.getElementById("period-filter");
  if (select) {
    select.value = val;
    if (document.startViewTransition) {
      document.startViewTransition(() => renderData());
    } else {
      renderData();
    }
  }
}

// 複数月（[4,5,6] など）のセット
function setMultiMonthFilter(monthArray, btn = null) {
  let baseYear = new Date().getFullYear();
  const select = document.getElementById("period-filter");
  const currentFilter = select ? select.value : "all";

  // 🎯 今年度・前年度がアクティブかどうかを判定する
  const isFiscalYearActive = document
    .getElementById("fiscal-year-btn")
    ?.classList.contains("!bg-purple-600");
  const isPrevFiscalYearActive = document
    .getElementById("prev-fiscal-year-btn")
    ?.classList.contains("!bg-purple-600");
  const startMonth = parseInt(getDbSetting("fiscalMonth", "4"), 10);
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
      return `${y}-${String(m).padStart(2, "0")}`;
    });
  } else {
    // === 暦年ベース（今年、または特定年）のフィルター ===
    if (window.currentActiveMonths && window.currentActiveMonths.length > 0) {
      baseYear = parseInt(window.currentActiveMonths[0].split("-")[0], 10);
    } else if (currentFilter !== "all" && currentFilter.includes("-")) {
      baseYear = parseInt(currentFilter.split("-")[0], 10);
    } else if (currentFilter !== "all" && currentFilter.length === 4) {
      baseYear = parseInt(currentFilter, 10);
    }

    targetMonths = monthArray.map(
      (m) => `${baseYear}-${String(m).padStart(2, "0")}`,
    );
  }

  window.currentActiveMonths = targetMonths;
  if (select) select.value = "all";

  // 🎯 第2引数を true にすることで「年度の紫・緑色」を消さずに「月ボタンの青色」を両立させる
  setActiveQuickPeriodButton(btn, true);

  if (document.startViewTransition) {
    document.startViewTransition(() => renderData());
  } else {
    renderData();
  }
}

// カレンダー年フィルター (1月〜12月: 個人事業主・12月決算向け)
function setCalendarYearFilter(btn = null) {
  const today = new Date();
  const year = today.getFullYear();
  let months = [];
  for (let m = 1; m <= 12; m++)
    months.push(`${year}-${String(m).padStart(2, "0")}`);
  window.currentActiveMonths = months;
  const select = document.getElementById("period-filter");
  if (select) select.value = "all";
  setActiveQuickPeriodButton(btn);
  if (document.startViewTransition) {
    document.startViewTransition(() => renderData());
  } else {
    renderData();
  }
}

// 年度の開始月を更新するUI
function updateFiscalYearButton() {
  const m = parseInt(getDbSetting("fiscalMonth", "4"), 10);
  const gearBtn = document.getElementById("fiscal-month-gear-btn");
  if (gearBtn) {
    gearBtn.title = `開始月を変更 (現在の設定: ${m}月始)`;
  }
}

function changeFiscalMonth() {
  const current = getDbSetting("fiscalMonth", "4");
  const input = prompt("年度の開始月（1〜12）を入力してください:", current);
  if (input !== null) {
    const month = parseInt(input, 10);
    if (month >= 1 && month <= 12) {
      setDbSetting("fiscalMonth", month.toString());
      updateFiscalYearButton();

      const isFiscalYearActive = document
        .getElementById("fiscal-year-btn")
        ?.classList.contains("!bg-purple-600");
      const isPrevFiscalYearActive = document
        .getElementById("prev-fiscal-year-btn")
        ?.classList.contains("!bg-purple-600");

      if (isFiscalYearActive) {
        setFiscalYearFilter(document.getElementById("fiscal-year-btn"));
      } else if (isPrevFiscalYearActive) {
        setPreviousFiscalYearFilter(
          document.getElementById("prev-fiscal-year-btn"),
        );
      } else {
        // その他のフィルター時でも、ドロップダウンや画面の再描画だけは行っておく
        if (document.startViewTransition) {
          document.startViewTransition(() => renderData());
        } else {
          renderData();
        }
      }
    } else {
      alert("1から12の数字を入力してください。");
    }
  }
}

// 前年度フィルター (設定された開始月から12ヶ月、さらに1年前)
function setPreviousFiscalYearFilter(btn = null) {
  const today = new Date();
  const startMonth = parseInt(getDbSetting("fiscalMonth", "4"), 10);
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
    months.push(`${y}-${String(m).padStart(2, "0")}`);
  }

  window.currentActiveMonths = months;
  const select = document.getElementById("period-filter");
  if (select) select.value = "all";
  setActiveQuickPeriodButton(
    btn || document.getElementById("prev-fiscal-year-btn"),
  );
  if (document.startViewTransition) {
    document.startViewTransition(() => renderData());
  } else {
    renderData();
  }
}

// 年度フィルター (設定された開始月から12ヶ月)
function setFiscalYearFilter(btn = null) {
  const today = new Date();
  const startMonth = parseInt(getDbSetting("fiscalMonth", "4"), 10);
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
    months.push(`${y}-${String(m).padStart(2, "0")}`);
  }

  window.currentActiveMonths = months;
  const select = document.getElementById("period-filter");
  if (select) select.value = "all";
  setActiveQuickPeriodButton(btn || document.getElementById("fiscal-year-btn"));
  if (document.startViewTransition) {
    document.startViewTransition(() => renderData());
  } else {
    renderData();
  }
}

// 3. ブロック構造の描画
function renderData(focusBlockId = null) {
  if (!db) return;
  const container = document.getElementById("blocks-container");

  const res = db.exec(
    "SELECT id, parent_id, memo, amount, created_at, account FROM records ORDER BY sort_order ASC, id ASC",
  );

  const records =
    res.length > 0
      ? res[0].values.map(
          ([id, parent_id, memo, rawAmount, created_at, account]) => {
            // SQLiteの型汚染攻撃 (Type Juggling) を防ぐためのサニタイズ
            let safeAmount = null;
            if (rawAmount !== null && rawAmount !== "") {
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
          },
        )
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

  updatePeriodDropdown();
  const periodFilter = document.getElementById("period-filter")?.value || "all";

  // 配列が指定されているかチェック
  const activeMonths =
    window.currentActiveMonths ||
    (periodFilter !== "all" ? [periodFilter] : null);

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

  // 合計金額ラベルの表記更新
  const filterEl = document.getElementById("period-filter");
  const totalLabelEl = document.getElementById("grand-total-label");
  if (totalLabelEl && filterEl) {
    if (window.currentActiveMonths && window.currentActiveMonths.length > 0) {
      const sorted = [...window.currentActiveMonths].sort();
      const formatMonth = (ym) => {
        const [y, m] = ym.split("-");
        return `${y}年${parseInt(m, 10)}月`;
      };
      if (sorted.length === 1) {
        totalLabelEl.textContent = formatMonth(sorted[0]);
      } else {
        totalLabelEl.textContent = `${formatMonth(sorted[0])} 〜 ${formatMonth(sorted[sorted.length - 1])}`;
      }
    } else {
      totalLabelEl.textContent =
        filterEl.value !== "all"
          ? filterEl.options[filterEl.selectedIndex].text
          : "Total Amount";
    }
  }

  // 左側 TOC (目次) の構築
  const tocContainer = document.getElementById("toc-container");
  const tocList = document.getElementById("toc-list");
  if (tocContainer && tocList) {
    const prevScrollTop = tocContainer.scrollTop; // スクロール位置を記憶
    tocList.innerHTML = "";

    filteredTree.forEach((block) => {
      const a = document.createElement("a");
      a.href = `#block-${block.id}`;
      a.className =
        "toc-item block px-2 py-1 hover:text-slate-900 hover:bg-slate-100 rounded truncate transition-colors text-slate-500 cursor-pointer text-sm font-medium";
      a.textContent = block.memo;
      a.title = block.memo;
      a.onclick = (e) => {
        e.preventDefault();
        document
          .getElementById(`block-${block.id}`)
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      };
      tocList.appendChild(a);
    });

    // レンダリング後にスクロール位置を復元
    requestAnimationFrame(() => {
      tocContainer.scrollTop = prevScrollTop;
      // 検索フィルターが入力中なら再適用
      const tocFilter = document.getElementById("toc-filter");
      if (tocFilter && tocFilter.value) {
        applyTocFilter(tocFilter.value);
      }
    });
  }

  // ブロック要素の簡易差分更新 (AutoAnimateのチラつき防止)
  const existingBlocks = Array.from(container.children);
  const existingBlockMap = new Map();
  existingBlocks.forEach((el) => {
    if (el.id.startsWith("block-")) {
      const id = parseInt(el.id.replace("block-", ""), 10);
      existingBlockMap.set(id, el);
    } else if (el.id === "empty-state") {
      el.remove();
    }
  });

  const blockControls = document.getElementById("block-controls");

  if (filteredTree.length === 0) {
    // データがない時はコントロールを隠す
    if (blockControls) {
      blockControls.classList.add("hidden");
      blockControls.classList.remove("flex");
    }

    const isFilterActive = periodFilter !== "all" || window.currentActiveMonths;
    let emptyHtml = "";
    if (isFilterActive) {
      // フィルター適用時のEmpty State
      emptyHtml = `
        <div id="empty-state" class="flex flex-col items-center justify-center py-20 px-6 text-center border border-slate-200 dark:border-dark-border rounded-3xl bg-white dark:bg-dark-surface relative overflow-hidden transition-colors shadow-sm">
           <!-- 背景の網目パターン -->
           <div class="absolute inset-0 pointer-events-none opacity-[0.03] dark:opacity-[0.04]" style="background-image: repeating-linear-gradient(45deg, currentColor 0, currentColor 1px, transparent 1px, transparent 8px), repeating-linear-gradient(-45deg, currentColor 0, currentColor 1px, transparent 1px, transparent 8px);"></div>
           <!-- グラデーション -->
           <div class="absolute inset-0 pointer-events-none opacity-80 bg-gradient-to-b from-transparent to-white dark:to-[#0f172a]"></div>

           <div class="relative z-10 flex flex-col items-center">
              <div class="relative flex items-center justify-center mb-6">
                <div class="absolute w-24 h-24 bg-slate-100 dark:bg-slate-800/50 rounded-full"></div>
                <div class="relative w-16 h-16 bg-slate-200 dark:bg-slate-800 rounded-full flex items-center justify-center backdrop-blur-sm border border-slate-300 dark:border-slate-600">
                  <svg class="w-8 h-8 text-slate-500 dark:text-slate-400"><use href="#icon-search"></use></svg>
                </div>
              </div>

              <h2 class="text-2xl sm:text-3xl font-extrabold text-slate-900 dark:text-white mb-3 tracking-tight">該当する記録がありません</h2>
              <p class="text-sm text-slate-500 dark:text-slate-400 max-w-sm mx-auto leading-relaxed mb-8">
                指定された期間（フィルター）にはデータが存在しません。<br>フィルター条件を変更して再度お試しください。
              </p>

              <button onclick="setPeriodFilter('all', null)" class="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 px-6 py-2.5 rounded-full text-sm font-bold shadow-sm transition-all active:scale-95">
                すべての期間を表示
              </button>
           </div>
        </div>
      `;
    } else {
      // 初期状態のウェルカム画面（GrindPeopleスタイル）

      // ✅ File System Access APIの対応状況を自動判定
      const isFsaSupported = "showSaveFilePicker" in window;
      const browserNoticeHtml = isFsaSupported
        ? `<div class="mt-8 flex flex-col items-center gap-1 text-[11px] text-slate-400 dark:text-slate-500">
             <p class="font-bold flex items-center gap-1">
               <svg class="w-3.5 h-3.5"><use href="#icon-sparkles"></use></svg> 推奨ブラウザ環境 (Chrome / Edge)
             </p>
             <p class="opacity-80">ファイルの直接上書き保存（File System API）が有効です</p>
           </div>`
        : `<div class="mt-8 flex flex-col items-center gap-1.5 text-[11px] text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-900/20 px-4 py-2.5 rounded-xl border border-orange-200 dark:border-orange-800/50">
             <p class="font-bold flex items-center gap-1 text-xs">
               ⚠️ 推奨ブラウザ: Chrome または Edge
             </p>
             <p class="opacity-90 max-w-[260px] leading-relaxed">現在のブラウザは直接上書き保存に非対応のため、保存時に毎回ダウンロードが発生します。</p>
           </div>`;

      emptyHtml = `
        <div id="empty-state" class="flex flex-col items-center justify-center py-20 px-6 text-center border border-slate-200 dark:border-dark-border rounded-3xl bg-white dark:bg-dark-surface relative overflow-hidden transition-colors shadow-sm">
           <!-- 背景の網目パターン -->
           <div class="absolute inset-0 pointer-events-none opacity-[0.03] dark:opacity-[0.04]" style="background-image: repeating-linear-gradient(45deg, currentColor 0, currentColor 1px, transparent 1px, transparent 8px), repeating-linear-gradient(-45deg, currentColor 0, currentColor 1px, transparent 1px, transparent 8px);"></div>
           <!-- グラデーション -->
           <div class="absolute inset-0 pointer-events-none opacity-80 bg-gradient-to-b from-transparent to-white dark:to-[#0f172a]"></div>

           <div class="relative z-10 flex flex-col items-center">
              <!-- アイコングループ -->
              <div class="relative flex items-center justify-center mb-6">
                <div class="absolute w-24 h-24 bg-blue-50 dark:bg-blue-900/20 rounded-full"></div>
                <div class="relative w-16 h-16 bg-blue-100 dark:bg-blue-900/40 rounded-full flex items-center justify-center backdrop-blur-sm border border-blue-200 dark:border-blue-800/50 shadow-inner">
                  <svg class="w-8 h-8 text-blue-600 dark:text-blue-400"><use href="#icon-money"></use></svg>
                </div>
              </div>

              <h2 class="text-2xl sm:text-3xl font-extrabold text-slate-900 dark:text-white mb-3 tracking-tight">Welcome to GrindMoney</h2>
              <p class="text-sm text-slate-500 dark:text-slate-400 max-w-md mx-auto leading-relaxed mb-8">
                .money ファイルをドラッグ＆ドロップするか、<br>上の入力欄から最初のブロックを作成しましょう。
              </p>

              <button onclick="document.getElementById('new-block-memo').focus()" class="bg-slate-900 hover:bg-slate-800 dark:bg-white dark:hover:bg-slate-200 text-white dark:text-slate-900 px-6 py-3 rounded-full text-sm font-bold shadow-md transition-all active:scale-95 flex items-center gap-2">
                <span class="text-lg font-light leading-none mb-0.5">+</span> 新しいブロックを作る
              </button>

              <!-- ブラウザ推奨の通知 -->
              ${browserNoticeHtml}
           </div>
        </div>
      `;
    }

    container.innerHTML = emptyHtml;
    existingBlockMap.forEach((el) => el.remove());

    let mobileTagContainer = document.getElementById("mobile-tag-container");
    if (mobileTagContainer) mobileTagContainer.remove();

    animateTotal(0);
    renderMemoSuggestions();
    return;
  }

  // データがある時はコントロールを表示
  if (blockControls) {
    blockControls.classList.remove("hidden");
    blockControls.classList.add("flex");
  }

  let currentDomIndex = 0;
  let grandTotal = 0;
  let tagTotals = Object.create(null); // タグ集計用 (プロトタイプ汚染防止)

  filteredTree.forEach((block) => {
    block.children.forEach((item) => {
      const safeAmount = parseInt(item.amount || 0, 10);
      grandTotal += safeAmount;

      // メモ欄から「#タグ」を正規表現で抽出して集計（全角ハッシュタグも吸収）
      const tags =
        (item.memo || "").match(/[#＃][^\s　,、。\.・()（）「」]+/g) || [];
      const blockTags =
        (block.memo || "").match(/[#＃][^\s　,、。\.・()（）「」]+/g) || [];
      const rawTags = [...tags, ...blockTags].map((t) => t.replace("＃", "#"));
      const allTags = [...new Set(rawTags)]; // 重複排除と正規化

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

    // 既存のDOMがあれば再利用し、なければ新規作成
    let blockEl = existingBlockMap.get(block.id);
    blockEl = updateOrCreateBlockElement(block, blockEl);
    existingBlockMap.delete(block.id);

    // 要素の順序が異なっていればDOM上の位置を修正する
    if (container.children[currentDomIndex] !== blockEl) {
      container.insertBefore(
        blockEl,
        container.children[currentDomIndex] || null,
      );
    }
    currentDomIndex++;
  });

  // 存在しなくなった古いブロックを削除
  existingBlockMap.forEach((el) => el.remove());

  // 左側 TOC の下部にタグ一覧を生成
  if (tocContainer && Object.keys(tagTotals).length > 0) {
    const tagDivider = document.createElement("div");
    tagDivider.className =
      "mt-8 font-bold text-slate-400 mb-2 px-2 uppercase text-[10px] tracking-widest flex items-center gap-1";
    tagDivider.innerHTML = `<svg class="w-3 h-3"><use href="#icon-folder"></use></svg> PROJECTS`;
    tocContainer.appendChild(tagDivider);

    // タグを金額が大きい順にソートして表示
    Object.entries(tagTotals)
      .sort((a, b) => b[1].amount - a[1].amount)
      .forEach(([tag, data]) => {
        const a = document.createElement("a");
        a.className =
          "group block px-2 py-1.5 hover:bg-slate-100 dark:hover:bg-dark-surface-hover rounded transition-colors cursor-pointer flex justify-between items-center";
        a.innerHTML = `
          <span class="text-sm font-medium text-slate-600 dark:text-slate-300 group-hover:text-primary transition-colors truncate">${escapeHtml(tag)}</span>
          <span class="text-[10px] tabular-nums tracking-tight font-bold text-slate-400 bg-slate-100 dark:bg-dark-bg px-1.5 py-0.5 rounded group-hover:bg-white dark:group-hover:bg-dark-surface-hover transition-colors">¥${data.amount.toLocaleString("ja-JP")}</span>
        `;
        a.onclick = (e) => {
          e.preventDefault();
          showTagModal(tag, data);
        };
        if (tocList) tocList.appendChild(a);
      });
  }

  // スマホ用のタグ表示エリアを（既存のものがあれば削除して）再生成
  const mainContainer = document.getElementById("blocks-container");
  let mobileTagContainer = document.getElementById("mobile-tag-container");
  if (mobileTagContainer) mobileTagContainer.remove();

  if (Object.keys(tagTotals).length > 0) {
    mobileTagContainer = document.createElement("div");
    mobileTagContainer.id = "mobile-tag-container";
    mobileTagContainer.className =
      "xl:hidden mt-12 mb-8 bg-white dark:bg-dark-surface p-6 rounded-xl border border-slate-200 dark:border-dark-border shadow-sm";
    mobileTagContainer.innerHTML = `<h3 class="text-xs font-bold text-slate-400 mb-4 tracking-widest flex items-center gap-1"><svg class="w-4 h-4"><use href="#icon-folder"></use></svg> PROJECTS (TAGS)</h3>`;

    const grid = document.createElement("div");
    grid.className = "grid grid-cols-2 gap-3";

    Object.entries(tagTotals)
      .sort((a, b) => b[1].amount - a[1].amount)
      .forEach(([tag, data]) => {
        const btn = document.createElement("button");
        btn.className =
          "text-left p-3 rounded-lg bg-slate-50 dark:bg-dark-bg hover:bg-slate-100 dark:hover:bg-dark-surface-hover border border-slate-100 dark:border-dark-border transition-colors cursor-pointer flex flex-col gap-1";
        btn.innerHTML = `<span class="text-sm font-bold text-slate-700 truncate">${escapeHtml(tag)}</span><span class="text-xs tabular-nums tracking-tight text-slate-500">¥${data.amount.toLocaleString("ja-JP")}</span>`;
        btn.onclick = () => showTagModal(tag, data);
        grid.appendChild(btn);
      });

    mobileTagContainer.appendChild(grid);
    mainContainer.appendChild(mobileTagContainer);
  }

  // 数字のアニメーション更新
  animateTotal(Math.round(grandTotal));

  renderMemoSuggestions();

  if (focusBlockId) {
    const targetInput = document.querySelector(
      `#block-form-${focusBlockId} .item-memo`,
    );
    if (targetInput) {
      targetInput.focus({ preventScroll: false });
    }
  }

  // --- TOC（目次）の自動ハイライト (Scrollspy) ---
  if (window.tocObserver) window.tocObserver.disconnect();

  window.tocObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          document.querySelectorAll(".toc-item").forEach((el) => {
            el.classList.remove("text-primary", "bg-primary-50", "font-bold");
            el.classList.add("text-slate-500", "font-medium");
          });
          const activeToc = document.querySelector(
            `.toc-item[href="#${entry.target.id}"]`,
          );
          if (activeToc) {
            activeToc.classList.remove("text-slate-500", "font-medium");
            activeToc.classList.add(
              "text-primary",
              "bg-primary-50",
              "font-bold",
            );
            const tocContainer = document.getElementById("toc-container");
            if (tocContainer && !tocContainer.matches(":hover")) {
              // scrollIntoViewはページ全体のスクロールを阻害してカクつきを生むため、コンテナ内の相対位置で安全にスクロールさせる
              const scrollPos =
                activeToc.offsetTop -
                tocContainer.clientHeight / 2 +
                activeToc.clientHeight / 2;
              tocContainer.scrollTo({
                top: scrollPos,
                behavior: "smooth",
              });
            }
          }
        }
      });
    },
    { rootMargin: "-20% 0px -60% 0px" },
  );

  // ブロック要素 (.group/block) のみを安全に監視対象にする
  document.querySelectorAll(".group\\/block").forEach((block) => {
    window.tocObserver.observe(block);
  });
}

function updateOrCreateBlockElement(block, existingEl = null) {
  const blockEl = existingEl || document.createElement("div");
  if (!existingEl) {
    blockEl.id = `block-${block.id}`; // TOCアンカー用
    blockEl.className = "group/block relative scroll-mt-36 sm:scroll-mt-48";
  }

  const blockTotal = block.children.reduce(
    (sum, item) => sum + parseInt(item.amount || 0, 10),
    0,
  );

  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const todayStr = `${yyyy}-${mm}-${dd}`;
  let defaultDate = lastUsedDates[block.id] || todayStr;

  // 年度を計算
  const startMonth = parseInt(getDbSetting("fiscalMonth", "4"), 10);
  let currentFiscalYear = yyyy;
  if (today.getMonth() + 1 < startMonth) {
    currentFiscalYear--;
  }
  // 🎯 フィルター期間外によるリセット（アクティブ消失）を防ぐためのスマート補正
  if (window.currentActiveMonths && window.currentActiveMonths.length > 0) {
    const isInside = window.currentActiveMonths.some((m) =>
      defaultDate.startsWith(m),
    );
    if (!isInside) {
      // フィルター内の最新月（最後の月）の月末日をデフォルトにする
      const sortedMonths = [...window.currentActiveMonths].sort();
      const targetMonth = sortedMonths[sortedMonths.length - 1]; // 例: "2026-03"
      if (targetMonth === `${yyyy}-${mm}`) {
        defaultDate = todayStr; // 今月が含まれているなら今日
      } else {
        const [tYear, tMonth] = targetMonth.split("-");
        const lastDay = new Date(
          parseInt(tYear, 10),
          parseInt(tMonth, 10),
          0,
        ).getDate();
        defaultDate = `${targetMonth}-${String(lastDay).padStart(2, "0")}`; // 例: "2026-03-31"
      }
    }
  }

  let itemsHtml = "";
  block.children.forEach((item) => {
    let dateDisp = "";
    let badgeHtml = "";
    let yyyy = today.getFullYear();
    if (item.created_at) {
      // 文字列から直接日付をパースして表示（タイムゾーン安全）
      const dStr = item.created_at.split(" ")[0]; // "YYYY-MM-DD"
      const parts = dStr.split("-");
      if (parts.length === 3) {
        yyyy = escapeHtml(parts[0]);
        const imm = escapeHtml(parts[1]);
        const idd = escapeHtml(parts[2]);

        // 年度判定バッジの生成
        const itemYear = parseInt(yyyy, 10);
        const itemMonth = parseInt(imm, 10);
        let itemFiscalYear = itemYear;
        if (itemMonth < startMonth) itemFiscalYear--;

        const diff = currentFiscalYear - itemFiscalYear;
        if (diff === 1) {
          badgeHtml = `<span class="text-[9px] font-bold px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 mr-1.5 shrink-0 select-none dark:bg-purple-900/30 dark:text-purple-300" title="前年度の記録です">前期</span>`;
        } else if (diff >= 2) {
          badgeHtml = `<span class="text-[9px] font-bold px-1.5 py-0.5 rounded bg-slate-200 text-slate-600 mr-1.5 shrink-0 select-none dark:bg-slate-700 dark:text-slate-300" title="前々期以前の記録です">過年度</span>`;
        }

        let dateClasses =
          "text-xs font-mono mr-2 sm:mr-3 border px-1.5 py-0.5 rounded outline-none focus:ring-2 cursor-text transition-colors";
        let dateTitle = "クリックして日付を編集";
        if (dStr > todayStr) {
          dateClasses +=
            " text-red-600 bg-red-50 border-red-200 focus:ring-red-300 hover:bg-red-100 font-bold dark:text-red-400 dark:bg-red-900/30 dark:border-red-800 dark:hover:bg-red-900/50";
          dateTitle = "未来の日付です（クリックして編集）";
        } else {
          dateClasses +=
            " text-slate-500 bg-slate-100 border-slate-200 focus:ring-blue-200 hover:bg-slate-200 dark:text-slate-400 dark:bg-dark-bg dark:border-dark-border dark:hover:bg-dark-surface-hover";
        }

        dateDisp = `${badgeHtml}<span data-id="${item.id}" data-field="created_at" data-year="${yyyy}" contenteditable="true" oninput="setDirty(true)" onfocus="window.getSelection().selectAllChildren(this)" onpaste="handlePlainTextPaste(event)" onkeydown="if(event.key==='Enter' && !event.isComposing){event.preventDefault();this.blur();}" onblur="updateRecord(${item.id}, 'created_at', this.innerText, this)" class="${dateClasses}" title="${dateTitle}">${imm}/${idd}</span>`;
      }
    }

    const accStr = item.account || "";
    let accountDisp = `<input type="text" data-id="${item.id}" data-field="account" list="account-suggestions" value="${escapeHtml(accStr)}" placeholder="科目" onfocus="this.select()" oninput="setDirty(true)" onkeydown="if(event.key==='Enter' && !event.isComposing){event.preventDefault();this.blur();}" onblur="updateRecord(${item.id}, 'account', this.value, this)" class="text-xs text-blue-600 bg-blue-50 border border-blue-200 px-1.5 py-0.5 rounded mr-2 outline-none focus:ring-2 focus:ring-blue-400 focus:bg-blue-100 cursor-text transition-colors hover:bg-blue-100 w-[60px] sm:w-[72px] shrink-0 text-center placeholder-blue-300">`;

    itemsHtml += `
      <div class="flex justify-between items-center px-4 sm:px-8 py-3.5 border-b border-slate-50 dark:border-dark-border/30 group/item hover:bg-slate-50/80 dark:hover:bg-dark-surface-hover transition-colors">
        <div class="flex items-center flex-1 min-w-0">
          ${dateDisp}
          ${accountDisp}
          <span data-id="${item.id}" data-field="memo" contenteditable="true" oninput="setDirty(true)" onpaste="handlePlainTextPaste(event)" onkeydown="if(event.key==='Enter' && !event.isComposing){event.preventDefault();this.blur();}" onblur="updateRecord(${item.id}, 'memo', this.innerText, this)" class="text-slate-700 dark:text-slate-200 font-medium truncate outline-none focus:bg-blue-50 dark:focus:bg-dark-surface-hover focus:ring-2 focus:ring-blue-200 px-1 rounded cursor-text transition-colors empty:inline-block empty:min-w-12 empty:bg-slate-100 dark:empty:bg-dark-bg empty:before:content-['✎_未入力'] empty:before:text-slate-400 empty:before:text-xs empty:before:font-normal empty:before:pointer-events-none empty:focus:before:opacity-50">${escapeHtml(item.memo)}</span>
        </div>
        <div class="flex items-center space-x-2 sm:space-x-4 ml-2 sm:ml-auto shrink-0">
          <span data-id="${item.id}" data-field="amount" contenteditable="true" oninput="setDirty(true)" onfocus="window.getSelection().selectAllChildren(this)" onpaste="handlePlainTextPaste(event)" onkeydown="if(event.key==='Enter' && !event.isComposing){event.preventDefault();this.blur();}" onblur="updateRecord(${item.id}, 'amount', this.innerText, this)" class="font-medium tabular-nums tracking-tight text-slate-900 dark:text-white outline-none focus:bg-blue-50 dark:focus:bg-dark-surface-hover focus:ring-2 focus:ring-blue-200 px-1 rounded cursor-text transition-colors empty:inline-block empty:min-w-8 empty:bg-slate-100 dark:empty:bg-dark-bg empty:before:content-['0'] empty:before:text-slate-400 empty:before:text-xs empty:before:font-sans empty:before:pointer-events-none empty:focus:before:opacity-50">${item.amount !== null && item.amount !== "" && item.amount !== undefined ? item.amount.toLocaleString("ja-JP") : ""}</span><span class="text-slate-400 text-xs font-sans">円</span>
          <div class="flex items-center space-x-1 md:opacity-0 md:group-hover/item:opacity-100 focus-within:opacity-100 transition-opacity">
            <button onclick="duplicateRecord(${item.id})" aria-label="複製" class="text-slate-300 hover:text-primary focus:outline-none focus:ring-2 focus:ring-primary/30 rounded p-1 transition-colors" title="複製">
              <svg class="w-4 h-4"><use href="#icon-copy"></use></svg>
            </button>
            <button onclick="deleteRecord(${item.id})" aria-label="削除" class="text-slate-300 hover:text-red-500 focus:outline-none focus:ring-2 focus:ring-red-200 rounded transition-colors text-xl leading-none px-1 py-0.5 -mt-0.5" title="削除">&times;</button>
          </div>
        </div>
      </div>
    `;
  });

  const isCollapsed = collapsedBlocks.has(block.id);
  const maxH = isCollapsed ? "0px" : "99999px";
  const op = isCollapsed ? "0" : "1";
  const iconRotation = isCollapsed ? "rotate(-90deg)" : "rotate(0deg)";

  // ブロック全体が前期・過年度の場合、タイトル横にもバッジを出す
  let blockBadgeHtml = "";
  if (block.children.length > 0) {
    let diffs = block.children.map((item) => {
      if (!item.created_at) return 0;
      const parts = item.created_at.split(" ")[0].split("-");
      if (parts.length !== 3) return 0;
      const itemYear = parseInt(parts[0], 10);
      const itemMonth = parseInt(parts[1], 10);
      let itemFiscalYear = itemYear;
      if (itemMonth < startMonth) itemFiscalYear--;
      return currentFiscalYear - itemFiscalYear;
    });
    const validDiffs = diffs.filter((d) => !isNaN(d));
    if (validDiffs.length > 0) {
      const minDiff = Math.min(...validDiffs);
      if (minDiff === 1) {
        blockBadgeHtml = `<span class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 ml-2 shrink-0 select-none dark:bg-purple-900/30 dark:text-purple-300" title="このブロックは前年度のデータです">前期</span>`;
      } else if (minDiff >= 2) {
        blockBadgeHtml = `<span class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-200 text-slate-600 ml-2 shrink-0 select-none dark:bg-slate-700 dark:text-slate-300" title="このブロックは前々期以前のデータです">過年度</span>`;
      }
    }
  }

  let dateInputClass =
    "item-date border-0 focus:ring-0 p-0 text-xs w-[110px] text-center outline-none cursor-pointer transition-colors";
  if (defaultDate > todayStr) {
    dateInputClass +=
      " text-red-600 font-bold bg-red-50 rounded dark:text-red-400 dark:bg-red-900/30";
  } else {
    dateInputClass += " text-slate-600 bg-transparent dark:text-slate-300";
  }

  blockEl.innerHTML = `
    <button onclick="event.stopPropagation(); saveTemplate(${block.id})" class="absolute -top-3 -left-3 opacity-100 md:opacity-0 group-hover/block:opacity-100 bg-white dark:bg-dark-surface border border-slate-200 dark:border-dark-border text-slate-400 hover:text-primary hover:border-primary/50 hover:shadow-[0_0_15px_rgba(15,98,254,0.3)] hover:scale-110 p-2 rounded-xl transition-all duration-300 cursor-pointer flex items-center justify-center z-10" title="このブロックをテンプレートとして保存">
      <svg class="w-5 h-5"><use href="#icon-squares-plus"></use></svg>
    </button>
    <div class="bg-white dark:bg-dark-surface rounded-xl shadow-sm border border-slate-200 dark:border-dark-border overflow-hidden transition-all hover:border-slate-300 dark:hover:border-dark-border-hover hover:shadow-md">
    <div onclick="toggleBlock(${block.id})" class="bg-slate-50/50 dark:bg-dark-surface px-8 py-5 border-b border-slate-100 dark:border-dark-border flex justify-between items-center transition-colors cursor-pointer select-none group/header hover:bg-slate-100 dark:hover:bg-dark-surface-hover">
      <div class="flex items-center gap-3 overflow-hidden">
        <svg id="block-icon-${block.id}" class="w-5 h-5 text-slate-400 transition-transform duration-200" style="transform: ${iconRotation};"><use href="#icon-chevron-down"></use></svg>
        <h2 data-id="${block.id}" data-field="memo" contenteditable="true" oninput="setDirty(true)" onpaste="handlePlainTextPaste(event)" onclick="event.stopPropagation()" onkeydown="if(event.key==='Enter' && !event.isComposing){event.preventDefault();this.blur();}" onblur="updateRecord(${block.id}, 'memo', this.innerText, this)" class="text-xl font-extrabold text-slate-900 dark:text-white tracking-tight outline-none focus:bg-white dark:focus:bg-dark-surface-hover focus:ring-2 focus:ring-primary/30 px-1 rounded cursor-text truncate transition-colors empty:inline-block empty:min-w-20 empty:bg-slate-100 dark:empty:bg-dark-bg empty:before:content-['✎_タイトル未入力'] empty:before:text-slate-400 empty:before:text-sm empty:before:font-normal empty:before:pointer-events-none empty:focus:before:opacity-50">${escapeHtml(block.memo)}</h2>
        ${blockBadgeHtml}
      </div>
      <div class="flex items-center shrink-0">
        <div class="font-bold tabular-nums tracking-tight text-slate-900 dark:text-white text-lg"><span id="block-total-${block.id}">${blockTotal.toLocaleString("ja-JP")}</span> <span class="text-slate-400 text-sm font-sans">円</span></div>
        <div class="flex items-center pl-4 border-l border-slate-200/50 dark:border-dark-border/50 ml-4 shrink-0 h-8">
          <button onclick="event.stopPropagation(); sortBlockByDate(${block.id})" aria-label="日付順に並べ替え" class="w-8 h-8 flex items-center justify-center rounded text-slate-300 dark:text-slate-500 hover:bg-slate-100 dark:hover:bg-dark-surface-hover hover:text-slate-600 dark:hover:text-slate-300 md:opacity-0 md:group-hover/block:opacity-100 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-slate-200 transition-all cursor-pointer mr-1" title="日付の古い順に並べ替える">
            <svg class="w-5 h-5"><use href="#icon-sort"></use></svg>
          </button>
          <button onclick="event.stopPropagation(); deleteRecord(${block.id})" aria-label="ブロックを削除" class="w-8 h-8 flex items-center justify-center rounded text-slate-300 dark:text-slate-500 hover:bg-red-50 dark:hover:bg-red-500/10 hover:text-red-500 md:opacity-0 md:group-hover/block:opacity-100 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-red-200 transition-all cursor-pointer" title="ブロックを丸ごと削除">
            <svg class="w-5 h-5"><use href="#icon-trash"></use></svg>
          </button>
        </div>
      </div>
    </div>
    <div id="block-body-${block.id}" class="transition-all duration-300 ease-in-out overflow-hidden" style="max-height: ${maxH}; opacity: ${op};">
      <div class="">${itemsHtml}</div>
      <div class="px-8 py-4 bg-white dark:bg-dark-surface transition-colors">
      <form id="block-form-${block.id}" class="flex flex-wrap sm:flex-nowrap items-center gap-2 sm:gap-3 px-3 py-2 -mx-3 rounded-md transition-all focus-within:bg-slate-50 dark:focus-within:bg-dark-surface-hover focus-within:ring-1 focus-within:ring-slate-200 dark:focus-within:ring-dark-border" onsubmit="event.preventDefault(); addItem(
        ${block.id},
        this.querySelector('.item-memo').value,
        this.querySelector('.item-amount').value,
        this.querySelector('.item-date').value,
        this.querySelector('.item-account').value
      );">
        <span class="text-primary text-xl leading-none font-light hidden sm:inline">+</span>

        <div class="flex items-center gap-2 sm:gap-3 w-full sm:w-auto">
          <button type="submit" aria-label="明細を追加" class="text-primary bg-primary/10 hover:bg-primary/20 rounded-full w-8 h-8 flex items-center justify-center text-xl leading-none font-light sm:hidden transition-colors outline-none focus:ring-2 focus:ring-primary/50 shrink-0">+</button>
          <div class="flex items-center bg-slate-50 dark:bg-dark-bg rounded-md px-1 py-1 border border-slate-200 dark:border-dark-border transition-colors">
            <button type="button" onclick="adjustDate(this, -1)" aria-label="1日戻す" class="text-slate-400 hover:text-slate-800 w-8 h-8 flex items-center justify-center font-bold cursor-pointer outline-none transition-colors touch-manipulation" title="-1日">-</button>
            <input type="date" class="${dateInputClass}" value="${defaultDate}" oninput="setDirty(true); checkFutureDate(this)">
            <button type="button" onclick="adjustDate(this, 1)" aria-label="1日進める" class="text-slate-400 hover:text-slate-800 w-8 h-8 flex items-center justify-center font-bold cursor-pointer outline-none transition-colors touch-manipulation" title="+1日">+</button>
          </div>
          <input type="text" placeholder="科目" value="" list="account-suggestions" oninput="setDirty(true)" onfocus="this.select()" onkeydown="if(event.key==='Enter'){ if(event.isComposing){ event.preventDefault(); return; } event.preventDefault();this.closest('form').querySelector('.item-memo').focus();}" class="item-account bg-transparent border-0 focus:ring-0 p-0 text-slate-600 dark:text-slate-300 placeholder-slate-400 w-20 shrink-0 text-sm outline-none text-center" style="min-width: 60px;">
        </div>

        <div class="flex items-center gap-2 sm:gap-3 w-full sm:w-auto sm:flex-1 pl-6 sm:pl-0 mt-2 sm:mt-0">
          <input type="text" placeholder="明細を追加..." list="memo-suggestions" oninput="setDirty(true)" onblur="autoSuggestAccount(this)" onfocus="setTimeout(() => this.closest('form').scrollIntoView({ behavior: 'smooth', block: 'center' }), 300);" onkeydown="if(event.key==='Enter'){ if(event.isComposing){ event.preventDefault(); return; } event.preventDefault();this.closest('form').querySelector('.item-amount').focus();}" class="item-memo bg-transparent border-0 focus:ring-0 p-0 text-slate-900 dark:text-white placeholder-slate-400 flex-1 text-sm font-medium outline-none min-w-[100px]">
          <input type="text" placeholder="金額(数式OK)" class="item-amount bg-transparent border-0 focus:ring-0 p-0 text-right tabular-nums tracking-tight text-slate-900 dark:text-white placeholder-slate-400 w-24 sm:w-32 shrink-0 text-sm outline-none" style="min-width: 104px;" oninput="setDirty(true)" onfocus="setTimeout(() => this.closest('form').scrollIntoView({ behavior: 'smooth', block: 'center' }), 300);" onkeydown="if(event.key==='Enter' && event.isComposing){ event.preventDefault(); event.stopPropagation(); } else if(event.key==='Tab' && !event.shiftKey){ event.preventDefault(); this.closest('form').dispatchEvent(new Event('submit', {cancelable: true, bubbles: true})); }" title="数式計算（+ - * /）が使えます">
        </div>
        <button type="submit" class="hidden">追加</button>
      </form>
      </div>
    </div>
  `;
  return blockEl;
}

// --- テンプレート（1Shot生成）機能 ---
function saveTemplate(blockId) {
  if (!db) return;

  // ブロックのタイトルを取得
  let blockMemo = "名称未設定";
  let blockStmt;
  try {
    blockStmt = db.prepare("SELECT memo FROM records WHERE id = ?");
    blockStmt.bind([blockId]);
    if (blockStmt.step()) {
      blockMemo = blockStmt.get()[0] || "名称未設定";
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
      "SELECT memo, account, amount FROM records WHERE parent_id = ? ORDER BY sort_order ASC, id ASC",
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

  let tplName = prompt(
    "このブロックをテンプレートとして保存します。\n呼び出し用の名前を入力してください:",
    blockMemo + " (雛形)",
  );
  if (!tplName) return;

  let stmt;
  try {
    stmt = db.prepare("INSERT INTO templates (name, data) VALUES (?, ?)");
    stmt.run([tplName, JSON.stringify(items)]);
  } finally {
    if (stmt) stmt.free();
  }
  setDirty(true);
  alert(
    `✅ テンプレート「${tplName}」を保存しました。\nコマンドパレット(Cmd+K)からいつでも一発で呼び出せます。`,
  );
}

function insertTemplate(templateId) {
  if (!db) return;

  let tplName = "";
  let rawData = "[]";
  let stmt;
  try {
    stmt = db.prepare("SELECT name, data FROM templates WHERE id = ?");
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
    tplData = JSON.parse(rawData || "[]");
  } catch (e) {
    alert(
      "テンプレートデータの読み込みに失敗しました。データが破損している可能性があります。",
    );
    return;
  }

  // 万が一パース結果がオブジェクト等で配列でない場合のクラッシュ(TypeError)を防止
  if (!Array.isArray(tplData)) {
    alert("テンプレートデータが破損しています（配列ではありません）。");
    return;
  }

  // 新しい親ブロックを作成
  db.run("INSERT INTO records (memo, amount) VALUES (?, ?)", [tplName, null]);
  const parentRes = db.exec("SELECT last_insert_rowid()");
  const parentId = parentRes[0].values[0][0];

  // 今日の日付を取得
  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")} 00:00:00`;

  // 子要素を展開して一気にINSERT
  let insertStmt = null;
  try {
    insertStmt = db.prepare(
      "INSERT INTO records (parent_id, memo, amount, account, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (let item of tplData) {
      // テンプレート保存時の金額をそのまま展開する（固定費などで便利にするため）
      const safeAmount =
        item.amount === "" || item.amount === undefined ? null : item.amount;
      insertStmt.run([parentId, item.memo, safeAmount, item.account, dateStr]);
    }
  } finally {
    if (insertStmt) insertStmt.free();
  }

  // フィルター外の日付を追加した場合、自動で「すべての期間」に表示を戻すフェイルセーフ
  const filterVal = document.getElementById("period-filter")?.value;
  let isOutsideFilter = false;

  if (window.currentActiveMonths) {
    const match = window.currentActiveMonths.some((m) => dateStr.startsWith(m));
    if (!match) isOutsideFilter = true;
  } else if (filterVal && filterVal !== "all") {
    if (!dateStr.startsWith(filterVal)) isOutsideFilter = true;
  }

  if (isOutsideFilter) {
    window.currentActiveMonths = null;
    setActiveQuickPeriodButton(null);
    if (document.getElementById("period-filter")) {
      document.getElementById("period-filter").value = "all";
    }
    showToast(
      "追加した日付がフィルター外のため、「すべての期間」に表示を戻しました",
      '<span class="text-blue-400">👀</span>',
    );
  }

  setDirty(true);
  renderData(parentId);
}

// 3.5 データの削除（DELETE文の実行）
function deleteRecord(id) {
  if (!confirm("この記録を削除しますか？")) return;
  let stmt;
  try {
    stmt = db.prepare("DELETE FROM records WHERE id = ? OR parent_id = ?");
    stmt.run([id, id]);
  } finally {
    if (stmt) stmt.free();
  }

  // ゾンビステートのクリーンアップ
  collapsedBlocks.delete(id);
  delete lastUsedDates[id];

  setDirty(true);
  renderData();
}

// 手動でブロック内の明細を日付順に並べ替える
function sortBlockByDate(blockId) {
  if (!db) return;
  if (
    !confirm(
      "このブロック内の明細を「日付が古い順」に並べ替えますか？\n（同じ日付の場合は入力した順になります）",
    )
  )
    return;

  let stmt;
  let items = [];
  try {
    stmt = db.prepare("SELECT id, created_at FROM records WHERE parent_id = ?");
    stmt.bind([blockId]);
    while (stmt.step()) {
      const [id, created_at] = stmt.get();
      items.push({ id, created_at: created_at || "" });
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
    updateStmt = db.prepare("UPDATE records SET sort_order = ? WHERE id = ?");
    items.forEach((item, index) => {
      updateStmt.run([index, item.id]);
    });
    setDirty(true);
    renderData();
    showToast("日付順に並べ替えました", "🧹");
  } catch (e) {
    console.error("並べ替えに失敗しました", e);
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
      "SELECT parent_id, memo, amount, account, created_at, sort_order FROM records WHERE id = ?",
    );
    stmt.bind([id]);
    if (stmt.step()) {
      const [parent_id, memo, amount, account, created_at, sort_order] =
        stmt.get();

      insertStmt = db.prepare(
        "INSERT INTO records (parent_id, memo, amount, account, created_at, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
      );
      insertStmt.run([
        parent_id,
        memo,
        amount,
        account,
        created_at,
        sort_order,
      ]);

      // 新しく挿入されたレコードのIDを取得
      const res = db.exec("SELECT last_insert_rowid()");
      const newId = res[0].values[0][0];

      setDirty(true);
      renderData(parent_id);

      showToast("明細を複製しました", '<span class="text-green-400">📋</span>');

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
    console.error("Duplicate failed:", e);
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

  // 🎯 God-Rank: 現在フォーカス中の要素を特定・記憶する
  let activeSelector = null;
  const activeEl = document.activeElement;
  if (
    activeEl &&
    typeof activeEl.blur === "function" &&
    activeEl.tagName !== "BODY" &&
    activeEl.id !== "cmd-input"
  ) {
    if (
      typeof activeEl.hasAttribute === "function" &&
      activeEl.hasAttribute("data-id") &&
      activeEl.hasAttribute("data-field")
    ) {
      activeSelector = `[data-id="${activeEl.getAttribute("data-id")}"][data-field="${activeEl.getAttribute("data-field")}"]`;
    } else if (activeEl.classList.contains("item-memo")) {
      const form = activeEl.closest("form");
      if (form) activeSelector = `#${form.id} .item-memo`;
    } else if (activeEl.classList.contains("item-amount")) {
      const form = activeEl.closest("form");
      if (form) activeSelector = `#${form.id} .item-amount`;
    } else if (activeEl.classList.contains("item-account")) {
      const form = activeEl.closest("form");
      if (form) activeSelector = `#${form.id} .item-account`;
    } else if (activeEl.classList.contains("item-date")) {
      const form = activeEl.closest("form");
      if (form) activeSelector = `#${form.id} .item-date`;
    } else if (activeEl.id) {
      activeSelector = `#${activeEl.id}`;
    } else if (activeEl.className && typeof activeEl.className === "string") {
      const firstClass = activeEl.className.trim().split(" ")[0];
      if (firstClass) {
        activeSelector = `.${CSS.escape(firstClass)}`;
      }
    }
    activeEl.blur(); // 一旦フォーカスを外してDBに値を確定(UPDATE)させる
  }

  try {
    // ★ 抽出前にDBをデフラグし、ファイルサイズを最小化する
    db.run("VACUUM");

    let data = db.export();
    const currentPassword = document.getElementById("file-password").value;

    // 【セキュリティ修正 1】: パスワードを空にして暗号化を解除しようとした場合の警告
    if (lastSavedPassword !== "" && currentPassword === "") {
      if (
        !confirm(
          "⚠️ 警告 ⚠️\nパスワードが空になっています。\nこのまま保存すると、ファイルの暗号化が解除され「平文」で保存されます。\n\n本当に暗号化を解除して保存しますか？",
        )
      ) {
        document.getElementById("file-password").value = lastSavedPassword; // パスワードを復元して中断
        isSaving = false;
        return;
      }
    }

    // 【セキュリティ修正 2】: 新規パスワード設定時、または変更時の「確認ダイアログ」
    if (currentPassword !== "" && currentPassword !== lastSavedPassword) {
      const confirmPw = await requestPasswordPrompt(
        "🔒 新しいパスワードを設定（または変更）します。\n確認のため、同じパスワードをもう一度入力してください:",
      );
      if (confirmPw === null) {
        isSaving = false;
        return;
      } // キャンセル
      if (confirmPw !== currentPassword) {
        alert("❌ パスワードが一致しません。保存を中止しました。");
        isSaving = false;
        return;
      }
    }

    if (currentPassword) {
      data = await encryptData(data, currentPassword);
    }

    // 保存成功時の視覚的なタクタイル・フィードバックを共通化
    const showSaveSuccessFeedback = () => {
      const saveBtn = document.getElementById("btn-save");
      if (saveBtn) {
        const iconSvg = saveBtn.querySelector("svg");
        if (iconSvg && !iconSvg.hasAttribute("data-animating")) {
          iconSvg.setAttribute("data-animating", "true");
          // 万が一の重複を防ぐためハードコードで復元元を指定
          const originalUse = `<use href="#icon-save"></use>`;
          iconSvg.innerHTML = `<use href="#icon-sparkles"></use>`;
          iconSvg.classList.add("text-green-500", "scale-125");
          saveBtn.classList.add("ring-2", "ring-green-500/20", "bg-green-50");

          setTimeout(() => {
            iconSvg.innerHTML = originalUse;
            iconSvg.classList.remove("text-green-500", "scale-125");
            saveBtn.classList.remove(
              "ring-2",
              "ring-green-500/20",
              "bg-green-50",
            );
            iconSvg.removeAttribute("data-animating");
          }, 1500);
        }
      }
    };

    if (isSaveAs || !fileHandle || fileHandle.isDummy) {
      if ("showSaveFilePicker" in window) {
        try {
          fileHandle = await window.showSaveFilePicker({
            types: [
              {
                description: "GrindMoney Database",
                accept: { "application/x-sqlite3": [".money"] },
              },
            ],
          });
        } catch (err) {
          console.log("Save cancelled.", err);
          return;
        }
      } else {
        // API非対応ブラウザ向けのフォールバック保存
        const blob = new Blob([data], { type: "application/x-sqlite3" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download =
          fileHandle && fileHandle.name ? fileHandle.name : "database.money";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        setDirty(false);
        showToast(
          `データを "${escapeHtml(a.download)}" としてダウンロードしました`,
          '<span class="text-green-400">💾</span>',
        );
        showSaveSuccessFeedback();
        lastSavedPassword = currentPassword;
        return;
      }
    }

    // --- File System権限の「サイレント没収」からのリカバリ ---
    if (fileHandle && !fileHandle.isDummy) {
      try {
        const permission = await fileHandle.queryPermission({
          mode: "readwrite",
        });
        if (permission !== "granted") {
          const request = await fileHandle.requestPermission({
            mode: "readwrite",
          });
          if (request !== "granted") {
            throw new Error("書き込み権限が拒否されました");
          }
        }
      } catch (e) {
        alert(
          "ファイルの書き込み権限が取得できませんでした。時間経過によりブラウザが権限を取り消した可能性があります。\n\n「複製して保存する (Save As)」をお試しください。",
        );
        return; // 権限がなければクラッシュを防ぐため中断
      }
    }

    const writable = await fileHandle.createWritable();
    await writable.write(data);
    await writable.close();
    setDirty(false);

    showToast(
      `データを "${escapeHtml(fileHandle.name)}" に保存しました`,
      '<span class="text-green-400">💾</span>',
    );
    showSaveSuccessFeedback();
    lastSavedPassword = currentPassword;
  } catch (err) {
    console.error("Save failed:", err);
  } finally {
    isSaving = false;

    // 🎯 God-Rank: 保存が終わったら、超高速でフォーカスを元の位置に戻す
    if (activeSelector) {
      requestAnimationFrame(() => {
        try {
          const el = document.querySelector(activeSelector);
          if (el) {
            el.focus({ preventScroll: true });
            // contenteditable要素なら、カーソルを一番最後に移動させる魔法
            if (el.hasAttribute("contenteditable")) {
              const range = document.createRange();
              const sel = window.getSelection();
              range.selectNodeContents(el);
              range.collapse(false);
              sel.removeAllRanges();
              sel.addRange(range);
            }
          }
        } catch (e) {
          console.warn(
            "フォーカスの復元をスキップしました(不正なセレクタ等)",
            e,
          );
        }
      });
    }
  }
}

// 5. 【核心部】 ファイル読み込みの共通処理
async function processFileHandle(handle, isDummy = false) {
  try {
    const file = await handle.getFile();

    // 巨大ファイルによるOOMクラッシュを防止
    if (file.size > 50 * 1024 * 1024) {
      alert(
        "ファイルサイズが大きすぎます（50MB上限）。不正なファイルの可能性があります。",
      );
      return;
    }

    const arrayBuffer = await file.arrayBuffer();
    let Uints = new Uint8Array(arrayBuffer);

    const magic = Uints.slice(0, 8);
    const magicStr = new TextDecoder().decode(magic);
    const isEncrypted = magicStr === "GRINDENC" || magicStr === "GRINDEN2";

    if (isEncrypted) {
      let password = document.getElementById("file-password").value;
      let success = false;
      while (!success) {
        try {
          Uints = await decryptData(Uints, password);
          success = true;
          if (password) {
            document.getElementById("file-password").value = password;
            lastSavedPassword = password;
          }
        } catch (err) {
          password = await requestPasswordPrompt(
            "ファイルは暗号化されています。解除パスワードを入力してください:",
          );
          if (password === null) return; // キャンセルして処理を中断
        }
      }
    }

    let newDb;
    try {
      newDb = new SQL.Database(Uints);
    } catch (e) {
      throw new Error("Invalid SQLite database file.");
    }

    if (db) {
      db.close();
    }
    db = newDb;
    migrateDatabase();

    loadSettingsFromDb(); // ファイル固有の設定をUIに反映

    // 🎯 ファイル切り替え時のグローバル状態完全リセット（データ汚染防止）
    lastUsedDates = {};
    collapsedBlocks.clear();
    window.currentActiveMonths = null;
    currentDisplayedTotal = 0;

    const filterEl = document.getElementById("period-filter");
    if (filterEl) filterEl.value = "all";
    setActiveQuickPeriodButton(null);

    // UI更新の前にハンドルをセットして正しいファイル名を反映させる
    fileHandle = handle;
    setDirty(false);

    showToast(
      `ファイル "${escapeHtml(file.name)}" を読み込みました`,
      '<span class="text-blue-400">📂</span>',
    );

    // 【パフォーマンス対策】ファイル読み込み時も同様にデフォルト期間を最適化
    const countRes = db.exec("SELECT COUNT(*) FROM records");
    const recordCount = countRes.length > 0 ? countRes[0].values[0][0] : 0;
    if (recordCount > 50) {
      setFiscalYearFilter();
    } else {
      renderData();
    }
  } catch (err) {
    console.log("Open cancelled or failed.", err);
    alert("ファイルの読み込みに失敗しました。");
  }
}

// 5.1 「開く」ボタンから File System Access API を使った読み込み
async function loadGrindFile() {
  if (isDirty) {
    if (
      !confirm(
        "未保存のデータがあります。変更を破棄して別のファイルを開きますか？",
      )
    )
      return;
  }

  if ("showOpenFilePicker" in window) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [
          {
            description: "GrindMoney Database",
            accept: {
              "application/x-sqlite3": [".money", ".grind", ".sqlite"],
            },
          },
        ],
        multiple: false,
      });
      await processFileHandle(handle);
    } catch (err) {
      console.log("Open picker cancelled.", err);
    }
  } else {
    // Safari / Firefox 等のフォールバック (input type="file" を使う)
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".money,.grind,.sqlite";
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
  const modal = document.getElementById("export-modal");

  // 現在の抽出対象期間をモーダルに表示する
  const infoEl = document.getElementById("export-period-info");
  if (infoEl) {
    const filterEl = document.getElementById("period-filter");
    let periodText = "すべての期間";

    if (window.currentActiveMonths && window.currentActiveMonths.length > 0) {
      const sorted = [...window.currentActiveMonths].sort();
      const formatMonth = (ym) => {
        const [y, m] = ym.split("-");
        return `${y}年${parseInt(m, 10)}月`;
      };
      periodText = `${formatMonth(sorted[0])} 〜 ${formatMonth(sorted[sorted.length - 1])}`;
    } else if (filterEl && filterEl.value !== "all") {
      periodText = filterEl.options[filterEl.selectedIndex].text;
    }
    infoEl.innerHTML = `💡 現在表示中の <b>「${periodText}」</b> が出力されます。`;
  }

  modal.classList.remove("hidden");
  modal.classList.add("flex");
  document.body.style.overflow = "hidden";
}

function closeExportModal() {
  const modal = document.getElementById("export-modal");
  modal.classList.add("hidden");
  modal.classList.remove("flex");
  document.body.style.overflow = "";
}

function executeExport() {
  const format = document.getElementById("export-format").value;
  closeExportModal();
  exportCSV(format);
}

// 6. CSVエクスポート
function exportCSV(format = "yayoi") {
  if (!db) return;

  const filterVal = document.getElementById("period-filter")?.value || "all";
  let whereClause = "";
  let params = [];

  if (window.currentActiveMonths) {
    const orConditions = window.currentActiveMonths
      .map((m) => {
        params.push(`${m}%`);
        return "c.created_at LIKE ?";
      })
      .join(" OR ");
    whereClause = ` AND (${orConditions})`;
  } else if (filterVal !== "all") {
    whereClause = ` AND c.created_at LIKE ?`;
    params.push(`${filterVal.replace(/[^0-9-]/g, "")}%`);
  }

  let query = `SELECT c.id, COALESCE(p.memo, '') || ' - ' || COALESCE(c.memo, '') AS memo, c.amount, c.created_at, c.account FROM records c JOIN records p ON c.parent_id = p.id WHERE c.parent_id IS NOT NULL${whereClause} ORDER BY c.id ASC`;

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
    alert("エクスポートするデータがありません。");
    return;
  }

  // サニタイズ用のヘルパー関数 (CSV Injection / DDE 対策)
  function sanitizeCsvCell(value) {
    let str = value ? value.toString() : "";
    // メモ欄などの改行をスペースに置換し、CSVフォーマットの崩れを防ぐ
    str = str.replace(/\r?\n/g, " ");
    // 先頭が危険な文字で始まる場合はシングルクォートを付与して数式解釈を無効化
    if (/^[=+\-@\t\r]/.test(str)) {
      str = "'" + str;
    }
    return `"${str.replace(/"/g, '""')}"`;
  }

  let csvRows = [];
  if (format === "freee") {
    // freeeはヘッダー行が必要
    csvRows.push(
      "収支区分,管理番号,発生日,支払期日,取引先,勘定科目,税区分,金額,税計算区分,税額,備考,品目,部門,メモタグ,決済期日,決済口座,決済金額",
    );
  } else if (format === "mf") {
    csvRows.push(
      '"取引No","取引日","借方勘定科目","借方補助科目","借方部門","借方税区分","借方金額","借方税額","貸方勘定科目","貸方補助科目","貸方部門","貸方税区分","貸方金額","貸方税額","摘要","仕訳メモ","タグ"',
    );
  } else if (format === "generic") {
    csvRows.push('"ID","日付","勘定科目","摘要","金額"');
  }

  values.forEach((row) => {
    // row[0]: id, row[1]: memo, row[2]: amount, row[3]: created_at
    const memo = row[1] ? row[1].toString() : "";
    const amount = row[2] || 0;
    const account = row[4] ? row[4].toString() : "雑費";
    const escapedMemo = sanitizeCsvCell(memo);
    const escapedAccount = sanitizeCsvCell(account);

    let dateFreeway = "000000";
    let dateSlash = "";
    let dateHyphen = "";

    if (row[3]) {
      // 保存時と同じく文字列から直接パースする
      const dStr = row[3].split(" ")[0];
      const parts = dStr.split("-");
      if (parts.length === 3) {
        const yyyy = parseInt(parts[0], 10);
        const mm = parts[1];
        const dd = parts[2];

        const numMonth = parseInt(mm, 10);
        const numDay = parseInt(dd, 10);
        let eraYear;

        // 2019年5月1日以降が令和
        if (yyyy > 2019 || (yyyy === 2019 && numMonth >= 5)) {
          eraYear = yyyy - 2018;
        }
        // 1989年1月8日以降が平成
        else if (
          yyyy > 1989 ||
          (yyyy === 1989 && (numMonth > 1 || numDay >= 8))
        ) {
          eraYear = yyyy - 1988;
        }
        // それ以前は簡易的に昭和とする
        else {
          eraYear = yyyy - 1925;
        }

        const yy = String(eraYear).padStart(2, "0");

        dateFreeway = yy + mm + dd;
        dateSlash = `${yyyy}/${mm}/${dd}`;
        dateHyphen = `${yyyy}-${mm}-${dd}`;
      }
    }

    let cols = [];
    if (format === "freeway") {
      cols = Array(16).fill("0");
      cols[3] = dateFreeway;
      cols[4] = ""; // フリーウェイは科目名だけでも基本取り込める場合が多い
      cols[5] = escapedAccount;
      cols[7] = "1100";
      cols[8] = '"現金"';
      cols[10] = amount.toString();
      cols[11] = escapedMemo;
      cols[12] = "21";
      cols[13] = "10";
    } else if (format === "yayoi") {
      cols = Array(25).fill("");
      cols[0] = "2000"; // 識別フラグ
      cols[2] = "0"; // 決算
      cols[3] = dateSlash;
      cols[4] = escapedAccount;
      cols[7] = '"課税対応仕入"';
      cols[8] = amount.toString();
      cols[10] = '"現金"';
      cols[13] = '"対象外"';
      cols[14] = amount.toString();
      cols[16] = escapedMemo;
      cols[19] = "0"; // タイプ (0=仕訳)
    } else if (format === "freee") {
      cols = Array(17).fill("");
      cols[0] = '"支出"';
      cols[1] = `"${row[0]}"`; // 管理番号 (GrindMoneyの内部ID)
      cols[2] = `"${dateHyphen}"`;
      cols[5] = escapedAccount;
      cols[6] = '"課税仕入"';
      cols[7] = amount.toString();
      cols[8] = '"税込"';
      cols[10] = escapedMemo;
      cols[14] = `"${dateHyphen}"`;
      cols[15] = '"現金"';
      cols[16] = amount.toString();
    } else if (format === "mf") {
      cols = Array(17).fill('""');
      cols[0] = `"${row[0]}"`; // 取引No (GrindMoneyの内部ID)
      cols[1] = `"${dateSlash}"`; // 取引日
      cols[2] = escapedAccount; // 借方勘定科目
      cols[5] = '"対象外"'; // 借方税区分
      cols[6] = `"${amount}"`; // 借方金額
      cols[8] = '"現金"'; // 貸方勘定科目
      cols[11] = '"対象外"'; // 貸方税区分
      cols[12] = `"${amount}"`; // 貸方金額
      cols[14] = escapedMemo; // 摘要
    } else if (format === "generic") {
      cols = [
        `"${row[0]}"`,
        `"${dateSlash}"`,
        escapedAccount,
        escapedMemo,
        `"${amount}"`,
      ];
    }

    csvRows.push(cols.join(","));
  });

  const csvContent = csvRows.join("\n") + "\n";
  const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
  const blob = new Blob([bom, csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const today = new Date();
  const dateSuffix = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;

  const a = document.createElement("a");
  a.href = url;
  a.download = `${format}_${dateSuffix}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// 7. CSVインポート
function importCSV(event) {
  const file = event.target.files[0];
  if (!file) return;

  // 5MB (5 * 1024 * 1024 bytes) を超える場合は警告してクラッシュを防ぐ
  if (file.size > 5242880) {
    alert(
      "ファイルサイズが大きすぎます（5MB上限）。ブラウザがクラッシュするのを防ぐため読み込みを中止しました。",
    );
    event.target.value = "";
    return;
  }

  const reader = new FileReader();
  reader.onload = function (e) {
    pendingCSVBuffer = e.target.result; // ArrayBufferを保存
    showCSVModal();
    event.target.value = "";
  };
  reader.onerror = function () {
    alert(
      "ファイルの読み込みに失敗しました。ファイルが破損しているか、メモリが不足しています。",
    );
    event.target.value = "";
  };
  reader.readAsArrayBuffer(file); // ArrayBufferとして読み込む
}

// CSVマッピングモーダルを表示
function showCSVModal() {
  const modal = document.getElementById("csv-mapping-modal");
  modal.classList.remove("hidden");
  modal.classList.add("flex");
  document.body.style.overflow = "hidden";
  updateCSVPreview(); // プレビューとマッピングを初期描画
}

// CSVプレビューとマッピングを更新する (文字コード変更時にも呼ばれる)
function updateCSVPreview() {
  if (!pendingCSVBuffer) return;

  const encoding = document.getElementById("csv-encoding").value;
  const previewBody = document.getElementById("csv-preview-body");

  try {
    const decoder = new TextDecoder(encoding, { fatal: true });
    const text = decoder.decode(pendingCSVBuffer);

    pendingCSVData = []; // グローバル変数を更新
    let currentLine = [];
    let currentCellChars = [];
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const nextChar = text[i + 1];

      // BOMのスキップ
      if (i === 0 && char.charCodeAt(0) === 0xfeff) continue;

      if (char === '"' && nextChar === '"') {
        currentCellChars.push('"');
        i++; // エスケープされたクオートをスキップ
      } else if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === "," && !inQuotes) {
        currentLine.push(currentCellChars.join(""));
        currentCellChars = [];
      } else if ((char === "\n" || char === "\r") && !inQuotes) {
        if (char === "\r" && nextChar === "\n") i++; // \r\n の対応
        currentLine.push(currentCellChars.join(""));
        pendingCSVData.push(currentLine);
        currentLine = [];
        currentCellChars = [];
      } else {
        currentCellChars.push(char);
      }
    }
    // 最後の行をプッシュ
    if (currentLine.length > 0 || currentCellChars.length > 0) {
      currentLine.push(currentCellChars.join(""));
      pendingCSVData.push(currentLine);
    }
    // 最終行の空行を無視
    if (
      pendingCSVData.length > 0 &&
      pendingCSVData[pendingCSVData.length - 1].length === 1 &&
      pendingCSVData[pendingCSVData.length - 1][0].trim() === ""
    ) {
      pendingCSVData.pop();
    }
  } catch (e) {
    pendingCSVData = []; // エラー時はデータをクリア
    document.getElementById("map-date").innerHTML =
      `<option value="-1">-- 選択しない --</option>`;
    if (document.getElementById("map-account"))
      document.getElementById("map-account").innerHTML =
        `<option value="-1">-- 選択しない --</option>`;
    document.getElementById("map-memo").innerHTML =
      `<option value="-1">-- 選択しない --</option>`;
    document.getElementById("map-amount").innerHTML =
      `<option value="-1">-- 選択しない --</option>`;
    const previewHead = document.getElementById("csv-preview-head");
    if (previewHead) previewHead.innerHTML = "";
    previewBody.innerHTML = `<tr><td colspan="99" class="p-4 text-center text-red-500">文字コード「${encoding}」でのデコードに失敗しました。ファイルが破損しているか、文字コードの指定が間違っています。</td></tr>`;
    return;
  }

  // --- UI更新 ---
  const mapDate = document.getElementById("map-date");
  const mapAccount = document.getElementById("map-account");
  const mapMemo = document.getElementById("map-memo");
  const mapAmount = document.getElementById("map-amount");

  const maxCols = Math.min(
    50,
    pendingCSVData.reduce((max, row) => Math.max(max, row.length), 0),
  );
  const firstRow = pendingCSVData.length > 0 ? pendingCSVData[0] : [];

  let optionsHtml = `<option value="-1">-- 選択しない --</option>`;
  for (let i = 0; i < maxCols; i++) {
    const sample =
      firstRow[i] !== undefined ? firstRow[i].substring(0, 15) : "";
    optionsHtml += `<option value="${i}">列 ${i + 1} (${sample})</option>`;
  }

  const oldVals = {
    date: mapDate.value,
    account: mapAccount ? mapAccount.value : "-1",
    memo: mapMemo.value,
    amount: mapAmount.value,
  };
  mapDate.innerHTML = optionsHtml;
  if (mapAccount) mapAccount.innerHTML = optionsHtml;
  mapMemo.innerHTML = optionsHtml;
  mapAmount.innerHTML = optionsHtml;
  mapDate.value = oldVals.date;
  if (mapAccount) mapAccount.value = oldVals.account;
  mapMemo.value = oldVals.memo;
  mapAmount.value = oldVals.amount;

  if (mapDate.selectedIndex < 1 && maxCols >= 1) mapDate.value = "0";
  if (mapAccount && mapAccount.selectedIndex < 1 && maxCols >= 4)
    mapAccount.value = "3"; // 4列以上あれば適当に
  if (mapMemo.selectedIndex < 1 && maxCols >= 2) mapMemo.value = "1";
  if (mapAmount.selectedIndex < 1 && maxCols >= 3) mapAmount.value = "2";

  renderCSVPreview();
}

function renderCSVPreview() {
  const previewHead = document.getElementById("csv-preview-head");
  const previewBody = document.getElementById("csv-preview-body");
  if (!previewHead || !previewBody || pendingCSVData.length === 0) return;

  const mapDate = parseInt(document.getElementById("map-date").value, 10);
  const mapAccount = document.getElementById("map-account")
    ? parseInt(document.getElementById("map-account").value, 10)
    : -1;
  const mapMemo = parseInt(document.getElementById("map-memo").value, 10);
  const mapAmount = parseInt(document.getElementById("map-amount").value, 10);

  const maxCols = Math.min(
    50,
    pendingCSVData.reduce((max, row) => Math.max(max, row.length), 0),
  );

  // ヘッダーの構築
  let thHtml = `<th class="px-3 py-2 w-8 text-center border-r border-gray-200">行</th>`;
  for (let i = 0; i < maxCols; i++) {
    let label = "";
    let badgeClass = "bg-slate-200 text-slate-500";
    if (i === mapDate) {
      label = "日付";
      badgeClass = "bg-blue-100 text-blue-700";
    } else if (i === mapAccount) {
      label = "科目";
      badgeClass = "bg-purple-100 text-purple-700";
    } else if (i === mapMemo) {
      label = "メモ";
      badgeClass = "bg-green-100 text-green-700";
    } else if (i === mapAmount) {
      label = "金額";
      badgeClass = "bg-orange-100 text-orange-700";
    }

    if (label) {
      thHtml += `<th class="px-3 py-2"><span class="px-2 py-0.5 rounded text-[10px] font-bold ${badgeClass}">${label}</span></th>`;
    } else {
      thHtml += `<th class="px-3 py-2"><span class="px-2 py-0.5 rounded text-[10px] font-medium ${badgeClass}">列 ${i + 1}</span></th>`;
    }
  }
  previewHead.innerHTML = `<tr>${thHtml}</tr>`;

  // プレビューの構築 (安全のためHTMLエスケープを行う)
  previewBody.innerHTML = "";
  const skipRowsInput = document.getElementById("csv-skip-rows");
  const skipRows = skipRowsInput
    ? Math.max(0, parseInt(skipRowsInput.value, 10) || 0)
    : 0;
  const previewRows = pendingCSVData.slice(skipRows, skipRows + 4); // スキップ行を考慮して最初の4行をプレビュー
  previewRows.forEach((row, rowIndex) => {
    const tr = document.createElement("tr");
    tr.className = rowIndex === 0 ? "bg-slate-50" : "bg-white";
    let tdHtml = `<td class="px-3 py-2 font-bold text-slate-400 border-r border-slate-200 w-8 text-center">${skipRows + rowIndex + 1}</td>`;
    for (let i = 0; i < maxCols; i++) {
      const val = row[i] !== undefined ? row[i] : "";
      // 長すぎる文字列は省略して表示し、title属性で全文を確認できるようにする
      const displayVal = val.length > 20 ? val.substring(0, 20) + "..." : val;

      // マッピングされている列はハイライト
      let highlightClass = "";
      if (
        i === mapDate ||
        i === mapAccount ||
        i === mapMemo ||
        i === mapAmount
      ) {
        highlightClass = "text-slate-900 font-medium bg-slate-50/50";
      }

      tdHtml += `<td class="px-3 py-2 truncate max-w-[150px] ${highlightClass}" title="${escapeHtml(val)}">${escapeHtml(displayVal)}</td>`;
    }
    tr.innerHTML = tdHtml;
    previewBody.appendChild(tr);
  });
}

function closeCSVModal() {
  const modal = document.getElementById("csv-mapping-modal");
  modal.classList.add("hidden");
  modal.classList.remove("flex");
  document.body.style.overflow = "";
  pendingCSVData = [];
  pendingCSVBuffer = null;
}

function executeCSVImport() {
  const mapDate = parseInt(document.getElementById("map-date").value, 10);
  const mapAccount = parseInt(document.getElementById("map-account").value, 10);
  const mapMemo = parseInt(document.getElementById("map-memo").value, 10);
  const mapAmount = parseInt(document.getElementById("map-amount").value, 10);
  const skipRows =
    parseInt(document.getElementById("csv-skip-rows").value, 10) || 0;

  if (mapMemo === -1 || mapAmount === -1) {
    alert("「メモ」と「金額」の列は必須です。");
    return;
  }

  // モーダルを閉じると pendingCSVData がクリアされてしまうため、退避しておく
  const dataToImport = [...pendingCSVData];

  closeCSVModal();

  let successCount = 0;
  let suggestStmt = null;
  let insertStmt = null;

  db.run("BEGIN TRANSACTION;");
  try {
    db.run("INSERT INTO records (memo, amount) VALUES (?, ?)", [
      "CSVインポート",
      null,
    ]);
    const parentRes = db.exec("SELECT last_insert_rowid()");
    const parentId = parentRes[0].values[0][0];

    const startIndex = Math.max(0, skipRows);

    const MAX_IMPORT_ROWS = 3000;
    const rowsToProcess = dataToImport.length - startIndex;
    if (rowsToProcess > MAX_IMPORT_ROWS) {
      alert(
        `⚠️ データが多すぎます（${rowsToProcess}行）。\nブラウザのフリーズを防ぐため、最初の${MAX_IMPORT_ROWS}行のみをインポートします。\n残りのデータはCSVを分割してインポートしてください。`,
      );
    }
    const endIndex = Math.min(
      dataToImport.length,
      startIndex + MAX_IMPORT_ROWS,
    );

    try {
      suggestStmt = db.prepare(
        "SELECT account FROM records WHERE parent_id IS NOT NULL AND memo = ? AND account IS NOT NULL AND account != '' ORDER BY id DESC LIMIT 1",
      );
    } catch (e) {
      console.warn("科目サジェストSQLの準備に失敗しました", e);
    }

    try {
      insertStmt = db.prepare(
        "INSERT INTO records (parent_id, memo, amount, created_at, account) VALUES (?, ?, ?, ?, ?)",
      );
    } catch (e) {
      console.warn("インポート用SQLの準備に失敗しました", e);
    }

    for (let i = startIndex; i < endIndex; i++) {
      const cols = dataToImport[i];
      if (cols.length === 0 || cols.every((c) => !c.trim())) continue;

      const dateStr =
        mapDate !== -1 && cols[mapDate] !== undefined
          ? cols[mapDate].trim()
          : "";
      const accountStr =
        mapAccount !== -1 && cols[mapAccount] !== undefined
          ? cols[mapAccount].trim()
          : "";
      const memo =
        mapMemo !== -1 && cols[mapMemo] !== undefined
          ? cols[mapMemo].trim()
          : "";
      // "¥1,500" のようなカンマや記号付き金額もパースできるように数字とマイナス以外を除去
      // 日本の銀行CSVでよく使われる「△」をマイナスとして処理する
      const rawAmount =
        mapAmount !== -1 && cols[mapAmount] !== undefined
          ? cols[mapAmount]
          : "";

      // まず全角数字・全角マイナス等を半角に変換
      let normalizedAmount = rawAmount
        .replace(/[０-９]/g, (s) =>
          String.fromCharCode(s.charCodeAt(0) - 0xfee0),
        )
        .replace(/[ー−△]/g, "-");

      // 会計特有の (1,500) というマイナス表記を -1500 に変換する
      const trimmedAmount = normalizedAmount.trim();
      if (/^\([\d,.]+\)$/.test(trimmedAmount)) {
        normalizedAmount = "-" + trimmedAmount.replace(/[()]/g, "");
      }

      // その後、半角数字・ピリオド・マイナス以外を除去
      const amountStr = normalizedAmount.replace(/[^\d.-]/g, "");
      let amount = Math.round(parseFloat(amountStr));
      if (amount > 10000000000000 || amount < -10000000000000) {
        amount = NaN; // 上限超過は弾く
      }

      // 摘要(メモ)が空の行でも、金額が存在すればインポートする
      if (!isNaN(amount)) {
        let parsedDate = new Date(dateStr);
        // YYYY-MM-DD形式等のタイムゾーン問題を回避する
        if (dateStr && /^\d{4}-\d{1,2}-\d{1,2}$/.test(dateStr.trim())) {
          const parts = dateStr.trim().split("-");
          parsedDate = new Date(
            parseInt(parts[0], 10),
            parseInt(parts[1], 10) - 1,
            parseInt(parts[2], 10),
          );
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

        let finalDateStr = "";
        if (dateStr && !isNaN(parsedDate.getTime())) {
          // タイムゾーンによる日付のズレを防ぐため、ローカル時間のまま手動で文字列化
          const yyyy = parsedDate.getFullYear();
          const mm = String(parsedDate.getMonth() + 1).padStart(2, "0");
          const dd = String(parsedDate.getDate()).padStart(2, "0");
          finalDateStr = `${yyyy}-${mm}-${dd} 00:00:00`;
        } else {
          const today = new Date();
          finalDateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")} 00:00:00`;
        }

        if (insertStmt) {
          try {
            insertStmt.run([
              parentId,
              memo,
              amount,
              finalDateStr,
              finalAccountStr,
            ]);
            successCount++;
          } catch (e) {
            console.warn(e);
          }
        }
      }
    }

    if (successCount === 0) {
      db.run("DELETE FROM records WHERE id = ?", [parentId]);
    }

    db.run("COMMIT;");
    setDirty(true);

    // インポートしたブロックは初期状態で折りたたんでおく（見やすさへの配慮）
    collapsedBlocks.add(parentId);

    // インポートしたデータが見えなくなるのを防ぐため、フィルターを解除
    if (document.getElementById("period-filter")) {
      document.getElementById("period-filter").value = "all";
    }
    window.currentActiveMonths = null;
    setActiveQuickPeriodButton(null);

    // ✅ ブラウザの操作をブロックするアラートを廃止し、トースト通知に変更
    showToast(
      `${successCount} 件のデータをインポートしました`,
      '<span class="text-green-400">✨</span>',
    );
  } catch (err) {
    db.run("ROLLBACK;");
    alert("インポート中にエラーが発生しました。");
    console.error(err);
  } finally {
    if (suggestStmt) suggestStmt.free();
    if (insertStmt) insertStmt.free();
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
      showToast("AI用プロンプトをコピーしました", "📋");
    })
    .catch((err) => {
      console.error("コピーに失敗しました", err);
    });
}

// 8.5 データ一覧を Markdown 形式でコピーする機能
function copyAsMarkdown() {
  if (!db) return;
  // 全データを日付の降順で取得
  const res = db.exec(
    "SELECT created_at, account, memo, amount FROM records WHERE parent_id IS NOT NULL ORDER BY created_at DESC",
  );
  if (res.length === 0) {
    alert("コピーするデータがありません。");
    return;
  }

  let markdown = "## 出力データ (Markdown)\n\n";
  res[0].values.forEach((row) => {
    const date = row[0] ? row[0].split(" ")[0] : "日付なし";
    const account = row[1] || "未分類";
    const memo = row[2] || "名称未設定";

    markdown += `- **${date}** [${account}] ${memo}\n`;
  });

  navigator.clipboard
    .writeText(markdown)
    .then(() => {
      showToast("データを Markdown でコピーしました", "📋");
    })
    .catch((err) => console.error("コピーに失敗しました", err));
}

// 9. PWAインストールプロンプトの制御
let deferredPrompt;
window.addEventListener("beforeinstallprompt", (e) => {
  // ブラウザ標準の目立たないインストール通知をキャンセル
  e.preventDefault();
  // イベントを保持しておく
  deferredPrompt = e;

  // カスタムのインストールボタンを表示する
  const installBtn = document.getElementById("install-button");
  if (installBtn) {
    installBtn.classList.remove("hidden");
    // 多重登録を防ぐため、addEventListenerではなく onclick を使用
    installBtn.onclick = async () => {
      installBtn.classList.add("hidden");
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      console.log(`インストール結果: ${outcome}`);
      deferredPrompt = null;
    };
  }
});

window.addEventListener("appinstalled", () => {
  const installBtn = document.getElementById("install-button");
  if (installBtn) installBtn.classList.add("hidden");
  console.log("GrindMoneyがインストールされました");
});

// --- コマンドパレット制御 ---
let isCommandPaletteOpen = false;
let selectedCommandIndex = 0;
let prePaletteActiveElement = null; // 🎯 God-Rank用: パレットを開く直前のフォーカス要素
const commandsList = [
  {
    id: "save",
    icon: '<svg class="w-5 h-5"><use href="#icon-save"></use></svg>',
    title: "データを保存する (Save)",
    shortcut: isMac ? "⌘S" : "Ctrl+S",
    action: () => saveGrindFile(),
  },
  {
    id: "open",
    icon: '<svg class="w-5 h-5"><use href="#icon-folder"></use></svg>',
    title: "ファイルを開く (Open)",
    shortcut: isMac ? "⌘O" : "Ctrl+O",
    action: () => loadGrindFile(),
  },
  {
    id: "saveas",
    icon: '<svg class="w-5 h-5"><use href="#icon-copy"></use></svg>',
    title: "複製して保存する (Save As)",
    shortcut: isMac ? "⇧⌘S" : "Ctrl+Shift+S",
    action: () => saveGrindFile(true),
  },
  {
    id: "new",
    icon: '<svg class="w-5 h-5"><use href="#icon-sparkles"></use></svg>',
    title: "新しいブロックを作成する (New)",
    shortcut: isMac ? "⌥N" : "Alt+N",
    action: () => document.getElementById("new-block-memo").focus(),
  },
  {
    id: "import",
    icon: '<svg class="w-5 h-5"><use href="#icon-import"></use></svg>',
    title: "CSVインポート (Import CSV)",
    action: () => document.getElementById("csv-input").click(),
  },
  {
    id: "export",
    icon: '<svg class="w-5 h-5"><use href="#icon-export"></use></svg>',
    title: "CSVエクスポート (Export CSV)",
    action: showExportModal,
  },
  {
    id: "editdict",
    icon: '<svg class="w-5 h-5"><use href="#icon-pencil"></use></svg>',
    title: "カスタム科目辞書を編集",
    action: () => showAccountDictEditor(),
  },
  {
    id: "ai",
    icon: '<svg class="w-5 h-5"><use href="#icon-bot"></use></svg>',
    title: "AI用プロンプトをコピー (AI)",
    action: copyAIPrompt,
  },
  {
    id: "markdown",
    icon: '<svg class="w-5 h-5"><use href="#icon-copy"></use></svg>',
    title: "Markdownとしてコピー (GrindSite用)",
    action: copyAsMarkdown,
  },
  {
    id: "expandall",
    icon: '<svg class="w-5 h-5"><use href="#icon-chevron-down"></use></svg>',
    title: "すべてのブロックを展開する",
    action: () => toggleAllBlocks(false),
  },
  {
    id: "collapseall",
    icon: '<svg class="w-5 h-5" style="transform: rotate(-90deg)"><use href="#icon-chevron-down"></use></svg>',
    title: "すべてのブロックを折りたたむ",
    action: () => toggleAllBlocks(true),
  },
];

function toggleCommandPalette() {
  const palette = document.getElementById("cmd-palette");
  const input = document.getElementById("cmd-input");

  if (!isCommandPaletteOpen) {
    // 🎯 開く瞬間に、どこにフォーカスしていたかを記憶
    prePaletteActiveElement = document.activeElement;
  }

  isCommandPaletteOpen = !isCommandPaletteOpen;
  if (isCommandPaletteOpen) {
    palette.classList.remove("hidden");
    palette.classList.add("flex");
    document.body.style.overflow = "hidden";
    input.value = "";
    selectedCommandIndex = 0;
    renderCommandList();

    if (window.innerWidth > 768) {
      setTimeout(() => input.focus(), 50);
    } else {
      input.blur(); // スマホの場合はソフトウェアキーボードを出さず、リスト表示を優先
    }
  } else {
    palette.classList.add("hidden");
    palette.classList.remove("flex");
    document.body.style.overflow = "";
  }
}

function getDynamicCommands() {
  let dynamicCommands = [...commandsList];
  if (db) {
    try {
      const res = db.exec("SELECT id, name FROM templates ORDER BY id DESC");
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
            action: () => {
              if (confirm(`テンプレート「${row[1]}」を削除しますか？`)) {
                db.run("DELETE FROM templates WHERE id = ?", [row[0]]);
                setDirty(true);
                // パレットを閉じずにリストだけを再描画して更新を反映
                renderCommandList(document.getElementById("cmd-input").value);
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
          id: "calculator",
          icon: '<svg class="w-5 h-5 text-green-500"><use href="#icon-sparkles"></use></svg>',
          title: `= ${calcResult.toLocaleString("ja-JP")} <span class="text-xs text-slate-400 ml-2">(Enterで適用またはコピー)</span>`,
          action: () => {
            const resultStr = calcResult.toString();
            navigator.clipboard.writeText(resultStr);

            // 🎯 God-Rank: パレットを開く直前が入力欄だった場合、直接代入する
            if (prePaletteActiveElement) {
              if (prePaletteActiveElement.hasAttribute("contenteditable")) {
                prePaletteActiveElement.innerText = resultStr;
                prePaletteActiveElement.focus();

                const range = document.createRange();
                const sel = window.getSelection();
                range.selectNodeContents(prePaletteActiveElement);
                range.collapse(false);
                sel.removeAllRanges();
                sel.addRange(range);

                updateRecord(
                  prePaletteActiveElement.getAttribute("data-id"),
                  prePaletteActiveElement.getAttribute("data-field"),
                  resultStr,
                  prePaletteActiveElement,
                );
                showToast(
                  `${resultStr} を直接入力しました`,
                  '<span class="text-green-400">✨</span>',
                );
                return;
              } else if (
                prePaletteActiveElement.tagName === "INPUT" ||
                prePaletteActiveElement.tagName === "TEXTAREA"
              ) {
                prePaletteActiveElement.value = resultStr;
                prePaletteActiveElement.focus();
                setDirty(true);
                prePaletteActiveElement.dispatchEvent(
                  new Event("input", { bubbles: true }),
                );
                showToast(
                  `${resultStr} を直接入力しました`,
                  '<span class="text-green-400">✨</span>',
                );
                return;
              }
            }

            showToast(
              `${calcResult.toLocaleString("ja-JP")} をコピーしました`,
              '<span class="text-green-400">📋</span>',
            );
          },
        });
      }
    } catch (e) {
      console.error("Calculator command failed:", e);
    }
  }
  return filtered;
}

function renderCommandList(query = "") {
  const list = document.getElementById("cmd-list");
  list.innerHTML = "";

  const filtered = getFilteredCommands(query);

  if (selectedCommandIndex >= filtered.length) selectedCommandIndex = 0;

  filtered.forEach((cmd, i) => {
    const div = document.createElement("div");
    const isSelected = i === selectedCommandIndex;
    div.className = `px-4 py-3 my-1 flex justify-between items-center rounded-md cursor-pointer transition-colors ${isSelected ? "bg-primary-50 dark:bg-primary/10 text-primary" : "text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-dark-surface-hover hover:text-slate-900 dark:hover:text-white"}`;

    let innerHtml = `<div class="flex items-center gap-3"><span class="text-xl">${cmd.icon}</span><span class="font-medium tracking-wide">${cmd.title}</span></div>`;
    if (cmd.shortcut) {
      // コマンドが選択されている時はバッジの色も少し強調する
      innerHtml += `<kbd class="font-mono text-[10px] bg-white border border-slate-200 px-1.5 py-0.5 rounded shadow-sm ${isSelected ? "text-primary border-primary/20" : "text-slate-400"}">${cmd.shortcut}</kbd>`;
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
      setTimeout(() => div.scrollIntoView({ block: "nearest" }), 0);
    }
  });
}

document.addEventListener("keydown", (e) => {
  const key = e.key?.toLowerCase();
  if (!key) return; // キー情報が取得できない特殊なイベントは無視

  if ((e.metaKey || e.ctrlKey) && key === "k") {
    e.preventDefault();
    toggleCommandPalette();
    return;
  }

  // 新規ブロック作成 (Option+N / Alt+N)
  if (
    e.altKey &&
    !e.metaKey &&
    !e.ctrlKey &&
    (key === "n" || key === "ｎ" || e.code === "KeyN")
  ) {
    e.preventDefault();
    document.getElementById("new-block-memo").focus();
    return;
  }

  // 上書き保存 (Cmd+S / Ctrl+S) & 複製保存 (Cmd+Shift+S / Ctrl+Shift+S)
  if (
    (e.metaKey || e.ctrlKey) &&
    (key === "s" || key === "ｓ" || e.code === "KeyS")
  ) {
    e.preventDefault();
    if (e.shiftKey) {
      saveGrindFile(true); // Save As
    } else {
      saveGrindFile(); // Save
    }
    return;
  }

  // ファイルを開く (Cmd+O / Ctrl+O)
  if (
    (e.metaKey || e.ctrlKey) &&
    (key === "o" || key === "ｏ" || e.code === "KeyO")
  ) {
    e.preventDefault();
    loadGrindFile();
    return;
  }

  if (e.key === "Escape") {
    // モーダルやパレットが開いていれば閉じる
    if (isCommandPaletteOpen) {
      toggleCommandPalette();
      return;
    }
    if (
      !document.getElementById("csv-mapping-modal").classList.contains("hidden")
    ) {
      closeCSVModal();
      return;
    }
    if (!document.getElementById("export-modal").classList.contains("hidden")) {
      closeExportModal();
      return;
    }
    if (!document.getElementById("tag-modal").classList.contains("hidden")) {
      closeTagModal();
      return;
    }
    if (
      !document
        .getElementById("account-dict-editor-modal")
        .classList.contains("hidden")
    ) {
      closeAccountDictEditor();
      return;
    }
  }

  if (isCommandPaletteOpen) {
    const input = document.getElementById("cmd-input");

    const filtered = getFilteredCommands(input.value);

    // ✅ 結果が0件の時の NaN クラッシュを防止
    if (
      filtered.length === 0 &&
      (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter")
    ) {
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedCommandIndex = (selectedCommandIndex + 1) % filtered.length;
      renderCommandList(input.value);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedCommandIndex =
        (selectedCommandIndex - 1 + filtered.length) % filtered.length;
      renderCommandList(input.value);
    } else if (
      e.key === "Enter" &&
      !e.isComposing &&
      filtered[selectedCommandIndex]
    ) {
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
  const tocItems = document.querySelectorAll("#toc-list a.toc-item");

  tocItems.forEach((item) => {
    const text = item.textContent.toLowerCase();
    if (text.includes(q)) {
      item.style.display = "block";
    } else {
      item.style.display = "none";
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  const tocFilter = document.getElementById("toc-filter");
  if (tocFilter) {
    tocFilter.addEventListener("input", (e) => {
      applyTocFilter(e.target.value);
    });
  }
});

// --- マルチタブ起動によるデータ競合の防止 ---
const bc = new BroadcastChannel("grindmoney_app_channel");
let hasAlerted = false;

bc.onmessage = (e) => {
  if (e.data === "ping") {
    bc.postMessage("pong"); // すでに開いているタブが応答する
  } else if (e.data === "pong") {
    // 自分が後から開いたタブだった場合
    if (!hasAlerted) {
      hasAlerted = true;
      alert(
        "⚠️ GrindMoneyは既に別のタブまたはウィンドウで開かれています。\n\nデータ競合（バックアップの巻き戻り）を防ぐため、このタブでの編集は行わないでください。",
      );
      document.body.style.opacity = "0.5";
      document.body.style.pointerEvents = "none";
    }
  }
};
bc.postMessage("ping");

document.getElementById("cmd-input")?.addEventListener("input", (e) => {
  selectedCommandIndex = 0;
  renderCommandList(e.target.value);
});

// --- パスワード表示トグル ---
function togglePasswordVisibility() {
  const pwInput = document.getElementById("file-password");
  const iconOpen = document.getElementById("icon-eye-open");
  const iconClosed = document.getElementById("icon-eye-closed");
  if (pwInput.type === "password") {
    pwInput.type = "text";
    iconOpen.classList.remove("hidden");
    iconClosed.classList.add("hidden");
  } else {
    pwInput.type = "password";
    iconOpen.classList.add("hidden");
    iconClosed.classList.remove("hidden");
  }
}

// --- 科目サジェスト (オートコンプリート) 機能 ---
const baseAccountingDict = [
  "売上高",
  "現金",
  "普通預金",
  "当座預金",
  "売掛金",
  "買掛金",
  "未払金",
  "預り金",
  "前払金",
  "前受金",
  "立替金",
  "仮払金",
  "仮受金",
  "事業主貸",
  "事業主借",
  "元入金",
  "役員借入金",
  "役員貸付金",
  "租税公課",
  "荷造運賃",
  "水道光熱費",
  "旅費交通費",
  "通信費",
  "広告宣伝費",
  "接待交際費",
  "損害保険料",
  "修繕費",
  "消耗品費",
  "減価償却費",
  "福利厚生費",
  "給料手当",
  "専従者給与",
  "外注工賃",
  "利子割引料",
  "地代家賃",
  "貸倒金",
  "雑費",
  "支払手数料",
  "会議費",
  "新聞図書費",
  "車両費",
  "諸会費",
  "リース料",
];

const accountDictionaries = {
  custom: [], // ユーザー定義の辞書
  none: [],
  yayoi: baseAccountingDict,
  freee: baseAccountingDict,
  mf: [
    "売上高",
    "現金",
    "普通預金",
    "当座預金",
    "売掛金",
    "買掛金",
    "未払金",
    "預り金",
    "前払前渡金",
    "前受金",
    "立替金",
    "仮払金",
    "仮受金",
    "事業主貸",
    "事業主借",
    "元入金",
    "役員借入金",
    "役員貸付金",
    "租税公課",
    "荷造運賃",
    "水道光熱費",
    "旅費交通費",
    "通信費",
    "広告宣伝費",
    "接待交際費",
    "損害保険料",
    "修繕費",
    "消耗品費",
    "減価償却費",
    "福利厚生費",
    "給料手当",
    "専従者給与",
    "外注工賃",
    "利子割引料",
    "地代家賃",
    "貸倒金",
    "雑費",
    "支払手数料",
    "会議費",
    "新聞図書費",
    "車両費",
    "諸会費",
    "リース料",
  ],
  freeway: baseAccountingDict,
};

function changeAccountDict() {
  const select = document.getElementById("dict-select");
  const dictKey = select.value;
  setDbSetting("accountDict", dictKey);
  renderAccountSuggestions(dictKey);
}

function renderAccountSuggestions(dictKey) {
  const datalist = document.getElementById("account-suggestions");
  if (!datalist) return;
  datalist.innerHTML = "";

  const dict = accountDictionaries[dictKey] || [];
  const fragment = document.createDocumentFragment();
  dict.forEach((account) => {
    const option = document.createElement("option");
    option.value = account;
    fragment.appendChild(option);
  });
  datalist.appendChild(fragment);
}

function loadCustomDict() {
  const savedDict = getDbSetting("customAccountDict");
  if (savedDict) {
    try {
      const parsed = JSON.parse(savedDict);
      if (Array.isArray(parsed)) {
        // 古い形式(文字列の配列)から新しい形式(オブジェクトの配列)へマイグレーション
        if (parsed.length > 0 && typeof parsed[0] === "string") {
          customAccountDict = parsed.map((name) => ({ name, hidden: false }));
        } else {
          customAccountDict = parsed;
        }
      } else {
        throw new Error("Invalid format"); // catchブロックに飛ばしてデフォルト値をセットさせる
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
  accountDictionaries.custom = customAccountDict
    .filter((i) => !i.hidden)
    .map((i) => i.name);
}

function saveCustomDict() {
  setDbSetting("customAccountDict", JSON.stringify(customAccountDict));
  accountDictionaries.custom = customAccountDict
    .filter((i) => !i.hidden)
    .map((i) => i.name);
  // 現在の選択がカスタムなら、datalistを即時更新
  if (document.getElementById("dict-select").value === "custom") {
    renderAccountSuggestions("custom");
  }
  return true;
}

// --- カスタム科目辞書エディタ ---
let draggedItemIndex = null;

function showAccountDictEditor() {
  const modal = document.getElementById("account-dict-editor-modal");
  modal.classList.remove("hidden");
  modal.classList.add("flex");
  document.body.style.overflow = "hidden";
  renderCustomDictEditor();

  document.getElementById("add-custom-dict-form").onsubmit = (e) => {
    e.preventDefault();
    const input = document.getElementById("new-custom-account");
    const newAccountName = input.value.trim();
    if (newAccountName) {
      const existing = customAccountDict.find(
        (item) => item.name === newAccountName,
      );
      if (existing) {
        existing.hidden = false; // 存在していれば再表示
      } else {
        customAccountDict.push({ name: newAccountName, hidden: false });
      }
      renderCustomDictEditor();
    }
    input.value = "";
    input.focus();
  };
}

function closeAccountDictEditor() {
  const modal = document.getElementById("account-dict-editor-modal");
  modal.classList.add("hidden");
  modal.classList.remove("flex");
  document.body.style.overflow = "";
  // 変更を保存せずに閉じた場合は、元の状態に戻す
  loadCustomDict();
}

function saveCustomDictAndClose() {
  if (!saveCustomDict()) return; // 失敗時は閉じない

  const modal = document.getElementById("account-dict-editor-modal");
  modal.classList.add("hidden");
  modal.classList.remove("flex");
  document.body.style.overflow = "";
}

function renderCustomDictEditor() {
  const list = document.getElementById("custom-dict-list");
  list.innerHTML = "";
  customAccountDict.forEach((item, index) => {
    const li = document.createElement("li");
    li.dataset.index = index;
    li.draggable = true;
    li.className = `flex items-center justify-between p-3 bg-slate-50 border border-slate-200 rounded-md cursor-grab active:cursor-grabbing active:bg-slate-100 transition-opacity ${item.hidden ? "opacity-50" : "opacity-100"}`;

    const icon = item.hidden ? "icon-eye-slash" : "icon-eye";
    const title = item.hidden ? "表示する" : "非表示にする";
    const textClass = item.hidden
      ? "text-slate-400 line-through"
      : "text-slate-700";

    li.innerHTML = `
      <div class="flex items-center gap-3 min-w-0 flex-1">
        <!-- PC用のドラッグハンドル -->
        <svg class="hidden sm:block w-5 h-5 text-slate-400 shrink-0"><use href="#icon-drag"></use></svg>
        <span class="font-medium ${textClass} truncate">${escapeHtml(item.name)}</span>
      </div>
      <div class="flex items-center gap-1 shrink-0">
        <!-- スマホ用の上下移動ボタン -->
        <div class="flex flex-col sm:hidden mr-2">
          <button type="button" onclick="event.stopPropagation(); moveCustomDictItem(${index}, -1)" class="text-slate-400 hover:text-slate-700 px-1 py-0.5 leading-none ${index === 0 ? "opacity-30 cursor-not-allowed" : ""}" ${index === 0 ? "disabled" : ""}>▲</button>
          <button type="button" onclick="event.stopPropagation(); moveCustomDictItem(${index}, 1)" class="text-slate-400 hover:text-slate-700 px-1 py-0.5 leading-none ${index === customAccountDict.length - 1 ? "opacity-30 cursor-not-allowed" : ""}" ${index === customAccountDict.length - 1 ? "disabled" : ""}>▼</button>
        </div>
        <!-- 表示/非表示トグル -->
        <button onclick="toggleCustomAccountHidden(${index})" class="text-slate-400 hover:text-slate-600 transition-colors shrink-0" title="${title}">
          <svg class="w-5 h-5"><use href="#${icon}"></use></svg>
        </button>
        <!-- 削除ボタン -->
        <button onclick="deleteCustomDictItem(${index})" class="text-slate-300 hover:text-red-500 transition-colors shrink-0 ml-1" title="完全に削除する">
          <svg class="w-5 h-5"><use href="#icon-trash"></use></svg>
        </button>
      </div>
    `;
    // Drag and Drop イベント
    li.addEventListener("dragstart", (e) => {
      draggedItemIndex = index;
      // Firefoxでドラッグ＆ドロップを有効化するための必須コード
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", index);
      }
      setTimeout(() => e.target.classList.add("opacity-30"), 0);
    });
    li.addEventListener("dragover", (e) => e.preventDefault());
    li.addEventListener("drop", (e) => {
      e.preventDefault();
      if (typeof draggedItemIndex !== "number" || draggedItemIndex === null)
        return;

      let droppedOnIndex = index;
      if (draggedItemIndex === droppedOnIndex) return;

      const [reorderedItem] = customAccountDict.splice(draggedItemIndex, 1);
      customAccountDict.splice(droppedOnIndex, 0, reorderedItem);
      draggedItemIndex = null;
      renderCustomDictEditor();
    });
    li.addEventListener("dragend", (e) => {
      e.target.classList.remove("opacity-30");
      draggedItemIndex = null;
    });
    list.appendChild(li);
  });
}

// スマホタップ用のカスタム科目並び替え関数
function moveCustomDictItem(index, direction) {
  if (index + direction < 0 || index + direction >= customAccountDict.length)
    return;
  const item = customAccountDict.splice(index, 1)[0];
  customAccountDict.splice(index + direction, 0, item);
  renderCustomDictEditor();
}

function deleteCustomDictItem(index) {
  if (
    confirm(
      `「${customAccountDict[index].name}」を辞書から完全に削除しますか？`,
    )
  ) {
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
  const modal = document.getElementById("tag-modal");
  document.getElementById("tag-modal-title").textContent = tag;
  document.getElementById("tag-modal-total").textContent =
    "¥" + data.amount.toLocaleString("ja-JP");

  const tbody = document.getElementById("tag-modal-body");
  tbody.innerHTML = "";

  // 日付の降順にソートして明細を表示
  const sortedItems = data.items.sort((a, b) =>
    (b.date || "").localeCompare(a.date || ""),
  );

  sortedItems.forEach((item) => {
    let dateDisp = "日付なし";
    if (item.date) {
      const parts = item.date.split(" ")[0].split("-");
      if (parts.length === 3)
        dateDisp = `${escapeHtml(parts[1])}/${escapeHtml(parts[2])}`;
    }

    tbody.innerHTML += `
      <tr class="hover:bg-slate-50 transition-colors border-b border-slate-50 last:border-0">
        <td class="py-4 px-6 w-20 text-xs text-slate-400 font-mono">${dateDisp}</td>
        <td class="py-4 px-4 text-slate-700 font-medium">${escapeHtml(item.memo)}</td>
        <td class="py-4 px-6 text-right tabular-nums tracking-tight font-bold text-slate-600">¥${item.amount.toLocaleString("ja-JP")}</td>
      </tr>
    `;
  });

  modal.classList.remove("hidden");
  modal.classList.add("flex");
  document.body.style.overflow = "hidden";
}

function closeTagModal() {
  const modal = document.getElementById("tag-modal");
  modal.classList.add("hidden");
  modal.classList.remove("flex");
  document.body.style.overflow = "";
}

if (!window.isSecureContext) {
  alert(
    "⚠️ セキュリティ警告 ⚠️\n\n現在のアクセス環境 (HTTP) では、ブラウザのセキュリティ制限によりファイルの読み書きや暗号化機能がブロックされます。\n\nGrindMoneyを正常に動作させるには、必ず「HTTPS」環境にアップロードするか、「localhost」で実行してください。",
  );
  showToast(
    "エラー: HTTPS環境またはlocalhostでの実行が必要です",
    '<span class="text-red-400">⚠️</span>',
    "warning",
  );
} else {
  // アプリ起動時にSQLiteをロード
  initSQLite();
}

// --- ファイル固有の設定を読み込んでUIに反映する ---
function loadSettingsFromDb() {
  loadCustomDict();
  const savedDict = getDbSetting("accountDict", "custom");
  const dictSelect = document.getElementById("dict-select");
  if (dictSelect) dictSelect.value = savedDict;
  renderAccountSuggestions(savedDict);
  updateFiscalYearButton();

  // 💡 ダークモード状態の復元
  const dbTheme = getDbSetting("theme");
  if (dbTheme) {
    if (dbTheme === "dark") {
      document.documentElement.classList.add("dark");
      localStorage.setItem("theme", "dark");
    } else {
      document.documentElement.classList.remove("dark");
      localStorage.setItem("theme", "light");
    }
  }
}

// ページ離脱時の警告（データ未保存防止）
window.addEventListener("beforeunload", (e) => {
  if (isDirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// --- ドラッグ＆ドロップによるファイル読み込み ---
const dropOverlay = document.getElementById("drop-overlay");
let dragCounter = 0;

// 安全にファイルドラッグかどうかを判定する関数（Safariのエラー回避用）
function hasFiles(e) {
  if (!e.dataTransfer || !e.dataTransfer.types) return false;
  for (let i = 0; i < e.dataTransfer.types.length; i++) {
    if (e.dataTransfer.types[i] === "Files") return true;
  }
  return false;
}

// 1. デフォルト挙動をキャンセル (documentに対して行うことでSafariでの誤発火を防ぐ)
document.addEventListener("dragover", (e) => {
  if (hasFiles(e)) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }
});
document.addEventListener("drop", (e) => {
  if (hasFiles(e)) {
    e.preventDefault();
  }
});

// 2. ファイルがウィンドウに入ってきたときの処理 (カウンタ方式)
document.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (dragCounter === 0) {
    dropOverlay.classList.remove("hidden");
    dropOverlay.classList.add("flex");
  }
  dragCounter++;
});

// 3. ファイルがウィンドウから出ていったときの処理 (カウンタ方式)
document.addEventListener("dragleave", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0; // 念のためリセット
    dropOverlay.classList.add("hidden");
    dropOverlay.classList.remove("flex");
  }
});

// 4. ドロップされたときの処理
document.addEventListener("drop", async (e) => {
  if (!hasFiles(e)) return;

  // カウンタとオーバーレイをリセット
  dragCounter = 0;
  dropOverlay.classList.add("hidden");
  dropOverlay.classList.remove("flex");

  let file = null;
  let handle = null;

  if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
    for (let i = 0; i < e.dataTransfer.items.length; i++) {
      const item = e.dataTransfer.items[i];
      if (item.kind === "file") {
        file = item.getAsFile();
        if (item.getAsFileSystemHandle) {
          try {
            handle = await item.getAsFileSystemHandle();
          } catch (err) {
            console.warn(
              "ファイルハンドルの取得に失敗しました。フォールバックします:",
              err,
            );
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

  // 拡張子に応じて処理を分岐
  if (
    file.name.endsWith(".money") ||
    file.name.endsWith(".grind") ||
    file.name.endsWith(".sqlite")
  ) {
    if (isDirty) {
      if (
        !confirm(
          "未保存のデータがあります。変更を破棄して別のファイルを開きますか？",
        )
      )
        return;
    }
    if (handle && handle.kind === "file") {
      await processFileHandle(handle);
    } else {
      const dummyHandle = {
        getFile: async () => file,
        name: file.name,
        isDummy: true,
      };
      await processFileHandle(dummyHandle, true);
    }
  } else if (file.name.endsWith(".csv")) {
    // 隠された <input type="file"> を利用して、既存のインポートフローに流す
    const csvInput = document.getElementById("csv-input");
    if (csvInput) {
      // FileListを作成してinputにセット
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      csvInput.files = dataTransfer.files;
      // onchangeイベントを手動で発火させる
      csvInput.dispatchEvent(new Event("change", { bubbles: true }));
    }
  } else {
    alert(
      "サポートされていないファイルです。.money、.grind または .csv 形式のファイルをドロップしてください。",
    );
  }
});

// OSを判定してショートカットキーのUI表示を最適化
const shortcutEl = document.getElementById("cmd-shortcut-key");
if (shortcutEl) {
  shortcutEl.textContent = isMac ? "⌘K" : "Ctrl+K";
}

const btnSaveTooltip = document.getElementById("btn-save");
if (btnSaveTooltip) btnSaveTooltip.title = `保存 (${isMac ? "⌘S" : "Ctrl+S"})`;

const btnOpenTooltip = document.querySelector(
  'button[onclick="loadGrindFile()"]',
);
if (btnOpenTooltip) btnOpenTooltip.title = `開く (${isMac ? "⌘O" : "Ctrl+O"})`;

// --- 最後の砦：タブ閉じ/バックグラウンド移行時の強制バックアップ ---
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && isDirty && db) {
    try {
      // 【追加】パスワードが設定されている場合は、平文でのバックアップを絶対に禁止する
      const currentPassword = document.getElementById("file-password").value;
      if (currentPassword) {
        console.warn(
          "暗号化が有効なため、情報漏洩を防ぐ目的で平文の緊急バックアップを破棄しました。",
        );
        return;
      }

      // 簡易的なサイズチェック（SQLiteのページ数などで推定）
      const pageSizeRes = db.exec("PRAGMA page_size");
      const pageCountRes = db.exec("PRAGMA page_count");
      if (pageSizeRes.length && pageCountRes.length) {
        const sizeBytes =
          pageSizeRes[0].values[0][0] * pageCountRes[0].values[0][0];
        if (sizeBytes > 5 * 1024 * 1024) {
          console.warn(
            "DBが大きすぎるため、終了時のバックアップをスキップします",
          );
          return;
        }
      }

      const data = db.export();

      // 【セキュリティ修正 3】: タブ終了時の Race Condition キル対策
      // 非同期の暗号化（encryptData）を待つとブラウザにプロセスを殺されてデータが消失するため、
      // 終了時の緊急退避に限っては、サンドボックスで保護されたIndexedDBへ「同期的」に即座に叩き込む。
      const tx = indexedDB.open(DB_NAME, 1);
      tx.onsuccess = (e) => {
        const idb = e.target.result;
        const store = idb
          .transaction(STORE_NAME, "readwrite")
          .objectStore(STORE_NAME);
        store.put(data, "latest_draft");
      };
      tx.onerror = (e) => {
        console.warn("終了時の緊急バックアップがブラウザに拒否されました");
      };
    } catch (e) {
      console.error("Emergency save error", e);
    }
  }
});
