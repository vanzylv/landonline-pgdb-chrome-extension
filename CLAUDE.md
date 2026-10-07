# CLAUDE.md

Chrome MV3 extension used by testers to switch Landonline between the **Informix** and **Postgres** backends. When ON it adds `Landonline-DB: postgres` (and `landonline: postgres`) to requests to `*.landonline.govt.nz` / `*.linz.govt.nz`; the ALB routes on that header. User docs: `README.md`.

## The rule that matters

**The indicator and icon must never claim the header is being sent when it isn't.** Testers trust the green banner to know which backend they're testing. So the in-page indicator shows what was *observed* on the tab's API requests, never the stored on/off intent. Don't reintroduce logic that derives the banner from `isEnabled`, or that adds/removes the header rule based on the active tab's URL (that caused the original "green banner, no header" bug).

Scope:
- Only API requests (XHR/fetch, `xmlhttprequest`) count for verification.
- If the header is on the API request, we're done: ALB routing and downstream services are not the extension's concern.
- WebSockets are not used; ignore them.

## How it fits together

- `chrome.storage.session.isEnabled` is the single source of truth. Only the popup writes it.
- **Session-scoped on purpose.** The state and the header rule are cleared by Chrome on browser restart and on extension update, reload or re-enable, so every session starts OFF (Informix). That matches the grey manifest icon Chrome shows at launch.
  - Don't move them back to `storage.local` / dynamic rules: the icon would show OFF while a persisted rule still sends the header.
- `background.js`, on `storage.onChanged`:
  1. Adds or removes DNR **session** rule id 1 (`requestDomains`, all resource types), sets or clears `storage.local.postgresSession`, and updates the icon.
  2. Resets verification.
  3. `forceRelogin()`:
     - deletes Keycloak SSO cookies on `auth.*` under `/realms/` (keeps `KEYCLOAK_TRUSTED_DEVICE` / `KEYCLOAK_REMEMBER_ME`);
     - clears `oidc.*` from sessionStorage in each `*.landonline.govt.nz` tab, then reloads it.
- Verification: `webRequest.onSendHeaders` (sees headers *after* DNR) counts per-tab `ok` / `wrong` API requests.
  - Stored in `storage.session`.
  - Reset on `main_frame` navigation and on toggle.
  - Events timestamped before the last toggle are ignored.
- `content.js` polls `{type: 'status'}` every second and renders the result:
  - `pending` → amber; `verified` → green; `missing` / `unexpected` → red (sticky until navigation); `off` → hidden.
  - Writes to the DOM only on change.
  - Removes itself when `chrome.runtime.id` is gone (extension disabled or reloaded).
  - `window.__landonlineDbAlive` stops duplicate copies.
- `startSession()` runs on every service worker start, but only acts once per session (guarded by `storage.session.sessionStarted`):
  - removes any persistent dynamic rule 1 and `storage.local.isEnabled` left by earlier versions;
  - if the previous session was on Postgres (`postgresSession`, or a legacy `isEnabled`), runs `forceRelogin()`.

  An empty `runtime.onStartup` listener makes Chrome start the worker with the browser, so this happens at launch.
- The background injects `content.js` into open tabs on every service worker start, because re-enable doesn't fire `onInstalled`.
- `popup/` shows the current backend, the active tab's status and the logout warning, then flips `isEnabled`.

## Login facts (from landonline-auth and the front-end repos)

- **Keycloak:** Informix and Postgres each have their own Keycloak (`keycloak-<env>` / `keycloak-pg-<env>`) behind the same `auth.<env>.landonline.govt.nz`, routed by the same header.
  - Realm `landonline` (`test` in lab).
  - On dev both instances serve the same signing keys, so a session from one backend silently works on the other. That's why switching forces a re-login.
- **Front ends:** all use `@linz/lol-auth-js` (oidc-client-ts).
  - Tokens live in per-tab sessionStorage `oidc.user:<issuer>:<clientId>`.
  - With no token, `LOLUserContextProviderV2` auto-redirects to login.
- **Don't clear `LolUserSessionState`** (localStorage). Other tabs poll it and would fire a Keycloak signout mid-switch.

## Testing

```sh
npm install
npm run test:install-browser   # Playwright's Chromium, once
npm test                       # ~35s, all suites in parallel
CHROME_PATH=/path/to/chrome npm test   # use a specific Chromium build
```

- `test/helpers.js`:
  - starts a local HTTPS server on a random port with a throwaway cert;
  - maps every hostname to it with `--host-resolver-rules`;
  - launches Chromium with the unpacked extension.
- `test/*.test.js` use `node:test`. Each file runs its steps in order against one browser.
- Drive and inspect the extension from a `chrome-extension://<id>/manifest.json` page (it has `chrome.*` APIs). Switch with `chrome.storage.session.set({ isEnabled })`, which is what the popup does.
- Simulate "header not sent" by removing session rule 1 (`updateSessionRules`) behind the extension's back.
- A new session is simulated by disabling and re-enabling the extension (`toggleExtension`). A real browser restart can't be tested: an extension loaded with `--load-extension` is reinstalled on every launch.

Browser gotchas:
- **Branded Google Chrome** (137+) ignores `--load-extension`. Use Playwright's Chromium / Chrome for Testing.
- **Headless can't click the toolbar icon or show a real popup.** The popup tests open `popup.html` as a tab, which covers its logic but not its sizing.
- **Reload button on `chrome://extensions`:** reloading a command-line-loaded extension disables it in that browser. Use disable/enable, or restart the browser.
- **Popup width under XWayland:** Chrome for Testing sizes every extension popup 87px wide. Run with `--ozone-platform=wayland` to check popup sizing.
- **Toolbar icon repaint:** Chrome sometimes doesn't repaint the icon after `setIcon` until it's hovered. The state is fine; don't "fix" it with delayed `setIcon` (tried, no effect).

## Conventions

- Bump `version` in `manifest.json` for each release.
- Conventional commit messages (`feat:`, `fix:`, `chore:`).
- Update `README.md` when behaviour changes. Screenshots in `docs/images/` are supplied by the user; only add generated ones (like the `overview-*.png` slides) when asked.
- Add or adjust tests in `test/` with any behaviour change, and run `npm test` before committing.
