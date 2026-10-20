# GrindMoney AI Rules

> Product type: PWA. Shared rules: [`../AGENTS.md`](../AGENTS.md) §1, §2, §4, §6 and the PWA rules in §7. This file adds GrindMoney rules and wins where the two differ.

## 1. Stack

- Vanilla JavaScript, no frontend framework.
- Wasm SQLite (`sql.js`): the database lives in memory. Manage memory explicitly (`stmt.free()`, `db.close()` before re-instantiating) to prevent leaks.
- Tailwind CSS v4.3.1. `./build.sh` downloads the standalone binary for the current OS on first run and checks its pinned SHA-256. The binary is git-ignored. npm is a development tool only (Prettier); nothing from `node_modules` ships.

## 2. Data and files

- Files: SQLite databases opened as `.money` or `.grind` (`manifest.json` file handlers).
- SQL: ALWAYS use parameterized queries (`db.prepare("... WHERE id = ?")`). Never interpolate variables into SQL strings.
- `sql.js` does not auto-persist. Every INSERT, UPDATE or DELETE must call `setDirty(true)` so the user is warned before closing the tab.

## 3. UI

- Look, top bar, shortcuts, toasts, dialogs, wording and languages follow shared §7 UI. Do not restate them here; add only what differs.
- Product-specific top-bar controls: the account dictionary selector, placed before the file password field.
- UI language: Japanese only, for Japanese users. Strings stay inline in `index.html` and `main.js`; money has no `lang/` folder or `i18n.js`, and no language choice.

## 4. Known gaps against shared §7

- Japanese comments in `main.js` and `index.html` stay: the shared rule does not require rewriting existing comments.
- `sw.js` has an `offline.html` fallback; keep it in the precache, and keep its text bilingual.
