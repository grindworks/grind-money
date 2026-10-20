# GrindMoney AI Rules

> Product type: PWA. Shared rules: [`../AGENTS.md`](../AGENTS.md) §1, §2, §4, §6 and the PWA rules in §7. This file adds GrindMoney rules and wins where the two differ.

## 1. Stack

- Vanilla JavaScript, no frontend framework.
- Wasm SQLite (`sql.js`): the database lives in memory. Manage memory explicitly (`stmt.free()`, `db.close()` before re-instantiating) to prevent leaks.
- Tailwind CSS v4.3.1 from npm devDependencies (`@tailwindcss/cli`, `tailwindcss`); `./build.sh` runs `npx tailwindcss`. npm is a development tool only; nothing from `node_modules` ships.

## 2. Data and files

- Files: SQLite databases opened as `.money` or `.grind` (`manifest.json` file handlers).
- SQL: ALWAYS use parameterized queries (`db.prepare("... WHERE id = ?")`). Never interpolate variables into SQL strings.
- `sql.js` does not auto-persist. Every INSERT, UPDATE or DELETE must call `setDirty(true)` so the user is warned before closing the tab.

## 3. UI

- Look, top bar, shortcuts, toasts, dialogs, wording and languages follow shared §7 UI. Do not restate them here; add only what differs.
- Product-specific top-bar controls: the account dictionary selector, placed before the file password field.

## 4. Known gaps against shared §7

- UI language is Japanese only and the strings are inline in `index.html` and `main.js`. Move them to `lang/ja.js` and `lang/en.js` with the shared `i18n.js`, then add the language choice.
- `main.js` calls the browser's `alert()`, `confirm()` and `prompt()` about 50 times; money has no `appAlert()`, `appConfirm()` and `appPrompt()` yet. Do not add new native dialogs; port grind-qrcoder's three functions when touching a dialog.
- Colors use `blue-600` (56 places) instead of the `primary` token. Because `primary` equals `blue-600`, migrate by replacing the classes without changing the look.
- Fonts: `--font-sans` differs from the shared stack.
- The Tailwind version is a `^` range in `package.json`, not pinned, and `build.sh` runs `npx tailwindcss` instead of the pinned binary.
- The top bar has no file-name badge with the unsaved marker; add it.
- Japanese comments in `main.js`, `index.html`, `input.css`, `sw.js` and `.gitignore`.
- Japanese `console.*` messages in `main.js` (about 13 lines). Japanese text in thrown `Error` messages is UI text and stays until it moves to `lang/`.
- `sw.js` has an `offline.html` fallback; keep it in the precache, and keep its text bilingual.
