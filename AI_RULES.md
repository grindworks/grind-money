# GrindMoney AI Rules

> Product type: PWA. Shared rules: [`../AGENTS.md`](../AGENTS.md) §1, §2, §4, §6 and the PWA rules in §7. This file adds GrindMoney rules and wins where the two differ.

## 1. Stack

- Vanilla JavaScript, no frontend framework.
- Wasm SQLite (`sql.js`): the database lives in memory. Manage memory explicitly (`stmt.free()`, `db.close()` before re-instantiating) to prevent leaks.
- Tailwind CSS v4.3.1 from npm devDependencies (`@tailwindcss/cli`, `tailwindcss`, pinned); `./build.sh` runs `npx tailwindcss`. npm is a development tool only; nothing from `node_modules` ships.

## 2. Data and files

- Files: SQLite databases opened as `.money` or `.grind` (`manifest.json` file handlers).
- SQL: ALWAYS use parameterized queries (`db.prepare("... WHERE id = ?")`). Never interpolate variables into SQL strings.
- `sql.js` does not auto-persist. Every INSERT, UPDATE or DELETE must call `setDirty(true)` so the user is warned before closing the tab.

## 3. UI

- Look, top bar, shortcuts, toasts, dialogs, wording and languages follow shared §7 UI. Do not restate them here; add only what differs.
- Product-specific top-bar controls: the account dictionary selector, placed before the file password field.
- UI language: Japanese only, for Japanese users. Strings stay inline in `index.html` and `main.js`; money has no `lang/` folder or `i18n.js`, and no language choice.

## 4. Known gaps against shared §7

- `build.sh` runs `npx tailwindcss` (pinned to 4.3.1 in `package.json`) instead of a pinned standalone binary.
- Japanese comments in `main.js`, `index.html`, `input.css` and `.gitignore`.
- `showToast` takes an options object (`{ duration, rawHtml }`) instead of `type`.
- `appPrompt` ignores `title` (the text prompt always says 入力), and the text and password dialogs use `rounded-xl` where the shared rule says `rounded-2xl`.
- Japanese `console.*` messages in `main.js` (about 13 lines). Japanese text in thrown `Error` messages is UI text and stays until it moves to `lang/`.
- `sw.js` has an `offline.html` fallback; keep it in the precache, and keep its text bilingual.
