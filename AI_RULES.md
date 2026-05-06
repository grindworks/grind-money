# GrindMoney AI Rules

## 1. Environment & Architecture

- **Serverless & Offline-First (PWA):** No Backend (No PHP, No Node.js). The application MUST run entirely in the browser using HTML, Vanilla JavaScript, and Tailwind CSS.
- **Wasm SQLite (`sql.js`):** Database operations are performed in-memory via WebAssembly. Always remember to manage memory properly (e.g., `stmt.free()`, `db.close()` before re-instantiating) to prevent memory leaks.
- **Local File Management:** Read/Write operations are strictly handled via the **File System Access API**. Never suggest uploading files to a server.
- **Strong Security:** Data saving must pass through Web Crypto API (`AES-256-GCM`) when a password is provided.
- **Absolute Portability (CRITICAL):**
  - **Zero Build Tools:** Do NOT suggest adding `npm`, `Webpack`, `Vite`, or ES Modules that require a build step. The system MUST work instantly by just opening `index.html` in a modern browser.
  - **No External Dependencies for Assets:** Do NOT suggest external CDNs for images or icons. Everything needed for the UI must be inline to guarantee offline functionality.

## 2. Coding Standards & Data Handling

- **Vanilla JavaScript (Modern ES6+):** Use strict typing conceptually, modern features (arrow functions, template literals, destructuring, Optional Chaining).
- **SQL Security & Safety:**
  - ALWAYS use parameterized queries (`db.prepare("... WHERE id = ?")`). Never interpolate variables directly into SQL strings.
  - SQLite in `sql.js` does not auto-persist. Any operation that modifies data (INSERT, UPDATE, DELETE) MUST set a flag (e.g., `isDirty = true`) to warn the user before they close the tab.
- **Error Handling (FAIL-SAFE):**
  - Assume files selected by the user might be corrupted or manipulated. Always wrap decryption and JSON/CSV parsing in robust `try...catch` blocks.
  - Fail gracefully with user-friendly `alert` or toast notifications, allowing the user to retry without reloading the app.

## 3. Frontend (S-Rank UI & Hacker Aesthetic)

- **Tailwind CSS:** Use Tailwind utility classes for all styling. Avoid custom CSS in `<style>` blocks unless absolutely necessary.
- **Icons (Inline SVG Sprites):** Load icons strictly via inline SVG `<use href="#icon-name"></use>`. **NEVER** use external files like `sprite.svg` or icon fonts, as they break when the PWA is offline.
- **Micro-Interactions & UX:**
  - Enhance the "Grind (fast input)" experience. Ensure form submissions do not cause page reloads (`event.preventDefault()`).
  - Maintain focus on input fields programmatically after actions.
  - Ensure UI transitions do not cause layout shifts (CLS). Use `@formkit/auto-animate` for smooth DOM insertions/deletions.
- **Minimalist Hacker Vibe:** Keep the UI clean. Hide complex actions in the Command Palette (`Cmd+K`).

## 4. AI Directives

- **Deep Contextual Analysis:** Do not act like a naive static analysis tool. Analyze actual data flow in the browser memory before suggesting "optimizations."
- **Respect Design Philosophy:** Maintain the "Serverless & Subscription-free" nature of the tool. If a feature requires heavy processing, rely on the user's local machine or "BYO-AI (Bring Your Own AI)" via prompt generation, rather than suggesting API integrations that require API keys in the code.
- **Language:** Output chat explanations in **Japanese**. Code comments should match the existing project style (Japanese is acceptable for explaining UI logic in this specific standalone tool).
