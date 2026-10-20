# GrindMoney AI Rules

> Product type: PWA. Shared rules: [`../AGENTS.md`](../AGENTS.md) §1, §2, §4, §6 and the PWA rules in §7. This file adds GrindMoney rules and wins where the two differ.

## 1. Stack

- Vanilla JavaScript, no frontend framework.
- Wasm SQLite (`sql.js`): the database lives in memory. Manage memory explicitly (`stmt.free()`, `db.close()` before re-instantiating) to prevent leaks.
- Tailwind CSS 4 from npm devDependencies (`@tailwindcss/cli`, `tailwindcss`); `./build.sh` runs `npx tailwindcss`. npm is a development tool only; nothing from `node_modules` ships.

## 2. Data and files

- Files: SQLite databases opened as `.money` or `.grind` (`manifest.json` file handlers).
- SQL: ALWAYS use parameterized queries (`db.prepare("... WHERE id = ?")`). Never interpolate variables into SQL strings.
- `sql.js` does not auto-persist. Every INSERT, UPDATE or DELETE must call `setDirty(true)` so the user is warned before closing the tab.

## 3. UI (SaaS-like flat design)

- Light theme only (the `dark` variant is disabled in `input.css`).
- Clean, professional, modern flat design.
- Color palette: Tailwind's default palette only; no custom colors such as `primary`.
  - Main text and headings: deep navy (`text-blue-950`).
  - Buttons, accents and focus rings: solid blue (`blue-600` / `bg-blue-600` / `focus:ring-blue-600`).
  - Toasts and system notifications: deep slate (`bg-slate-900`).
  - Backgrounds: subtle slate (`bg-slate-50`, `bg-slate-100`), with refined grid patterns for empty states.
- Use smooth CSS animations or View Transitions where they help; never shift the layout.
- UI language: Japanese (`<html lang="ja">`). UI strings are inline in `index.html` and `main.js`.

## 4. Known gaps against shared §7

- `sw.js` revalidates cached files in the background and calls `skipWaiting()` on install.
- The Tailwind version is a `^` range in `package.json`, not pinned.
- Japanese comments in `main.js`, `index.html`, `input.css`, `sw.js` and `.gitignore`.
