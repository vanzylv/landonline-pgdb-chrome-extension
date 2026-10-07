const RULE_ID = 1;
const HEADER = 'landonline-db';
const HEADER_VALUE = 'postgres';
const LANDONLINE_URLS = ['https://*.landonline.govt.nz/*', 'https://*.linz.govt.nz/*'];
// Tabs logged out and reloaded on toggle: the Landonline apps and auth.*, not linz.govt.nz sites
const LOGIN_URLS = ['https://*.landonline.govt.nz/*'];

// Rule definition for declarativeNetRequest.
// requestDomains also matches subdomains and ignores the port.
const rule = {
    id: RULE_ID,
    priority: 1,
    action: {
        type: 'modifyHeaders',
        requestHeaders: [
            { header: 'Landonline-DB', operation: 'set', value: HEADER_VALUE },
            { header: 'landonline', operation: 'set', value: HEADER_VALUE }
        ]
    },
    condition: {
        requestDomains: ['landonline.govt.nz', 'linz.govt.nz'],
        resourceTypes: [
            'main_frame', 'sub_frame', 'xmlhttprequest', 'script',
            'stylesheet', 'image', 'font', 'media', 'ping', 'other'
        ]
    }
};

// chrome.storage.session 'isEnabled' is what the user asked for. The header rule and
// toolbar icon follow it. The in-page indicator does NOT trust it: it shows what was
// actually observed on the tab's API requests (see "Verification" below).
//
// Both the state and the header rule are session-scoped: Chrome clears them when the
// browser restarts and when the extension is updated, reloaded or re-enabled. So every
// new session starts OFF (Informix), matching the grey icon Chrome shows at launch.
async function getIsEnabled() {
    const { isEnabled } = await chrome.storage.session.get('isEnabled');
    return isEnabled || false;
}

async function applyState(isEnabled) {
    try {
        await chrome.declarativeNetRequest.updateSessionRules(
            isEnabled ? { addRules: [rule], removeRuleIds: [RULE_ID] } : { removeRuleIds: [RULE_ID] }
        );
    } catch (error) {
        console.warn('Error updating header injection rule:', error);
    }
    // Remembered across sessions so the next session knows to log out of Postgres
    if (isEnabled) {
        await chrome.storage.local.set({ postgresSession: true });
    } else {
        await chrome.storage.local.remove('postgresSession');
    }
    updateIcon(isEnabled);
}

function updateIcon(isEnabled) {
    chrome.action.setIcon({
        path: {
            "16": isEnabled ? 'icons/db16.png' : 'icons/dboff16.png',
            "32": isEnabled ? 'icons/db32.png' : 'icons/dboff32.png',
            "48": isEnabled ? 'icons/db48.png' : 'icons/dboff48.png',
            "128": isEnabled ? 'icons/db128.png' : 'icons/dboff128.png'
        }
    });
    chrome.action.setTitle({
        title: isEnabled ? 'Landonline-DB Header: ON' : 'Landonline-DB Header: OFF'
    });
}

// Toggling happens in the popup (popup/popup.js), which warns that open Landonline
// tabs will be logged out, and then flips isEnabled in storage.

chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === 'session' && changes.isEnabled) {
        const isEnabled = changes.isEnabled.newValue || false;
        await applyState(isEnabled);
        await resetVerification(isEnabled);
        await forceRelogin();
    }
});

// ---------------------------------------------------------------------------
// Forced re-login: Informix and Postgres each have their own Keycloak behind the
// same auth.* hostname, routed by the same header. After a toggle the user must
// log in again so their session comes from the backend they now point at.
//
// 1. Delete Keycloak's SSO cookies on auth.*, otherwise Keycloak signs the user
//    straight back in. KEYCLOAK_TRUSTED_DEVICE is kept so MFA isn't asked again.
// 2. Remove the apps' OIDC tokens (per-tab sessionStorage, @linz/lol-auth-js) and
//    reload, so each app redirects to the Keycloak login.
// ---------------------------------------------------------------------------

const KEYCLOAK_HOST = /^auth[\w-]*\.(.+\.)?landonline\.govt\.nz$/;
const KEYCLOAK_SSO_COOKIE = /^(KEYCLOAK_IDENTITY|KEYCLOAK_SESSION|AUTH_SESSION_ID|KC_RESTART|KC_AUTH_SESSION_HASH)/;

async function clearKeycloakSession() {
    const cookies = await chrome.cookies.getAll({ domain: 'landonline.govt.nz' });
    for (const cookie of cookies) {
        const host = cookie.domain.replace(/^\./, '');
        if (KEYCLOAK_HOST.test(host) && cookie.path.startsWith('/realms/') && KEYCLOAK_SSO_COOKIE.test(cookie.name)) {
            try {
                await chrome.cookies.remove({ url: `https://${host}${cookie.path}`, name: cookie.name, storeId: cookie.storeId });
            } catch (error) {
                console.warn(`Failed to remove cookie ${cookie.name} on ${host}:`, error);
            }
        }
    }
}

async function forceRelogin() {
    await clearKeycloakSession();
    const tabs = await chrome.tabs.query({ url: LOGIN_URLS });
    for (const tab of tabs) {
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => {
                    for (const key of Object.keys(sessionStorage)) {
                        if (key.startsWith('oidc.')) sessionStorage.removeItem(key);
                    }
                }
            });
        } catch (error) {
            // e.g. a restored tab that hasn't loaded yet; reload it anyway
            console.info(`Failed to clear tokens in tab ${tab.id}:`, error);
        }
        try {
            await chrome.tabs.reload(tab.id);
        } catch (error) {
            console.info(`Failed to reload tab ${tab.id}:`, error);
        }
    }
}

// ---------------------------------------------------------------------------
// Verification: watch the API requests each tab actually sends and record
// whether they carried the header. webRequest sees headers after the
// declarativeNetRequest rule has been applied, i.e. what really goes out.
//
// Per tab: { ok, wrong, lastWrongUrl }
//   ON:  ok = sent with header,    wrong = sent without it
//   OFF: ok = sent without header, wrong = sent with it
// Kept in storage.session so it survives service worker restarts.
// ---------------------------------------------------------------------------

let verification = { since: 0, expectHeader: false, tabs: {} };
const loaded = Promise.all([
    chrome.storage.session.get('verification'),
    getIsEnabled()
]).then(([{ verification: saved }, isEnabled]) => {
    verification = saved || { since: Date.now(), expectHeader: isEnabled, tabs: {} };
});

let saveTimer;
function saveVerification() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => chrome.storage.session.set({ verification }), 200);
}

async function resetVerification(expectHeader) {
    await loaded;
    verification = { since: Date.now(), expectHeader, tabs: {} };
    saveVerification();
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
        updateBadge(tab.id);
    }
}

function tabStatus(tabId) {
    const t = verification.tabs[tabId];
    if (t && t.wrong > 0) {
        return { status: verification.expectHeader ? 'missing' : 'unexpected', ok: t.ok, wrong: t.wrong, url: t.lastWrongUrl };
    }
    if (!verification.expectHeader) {
        return { status: 'off', ok: t ? t.ok : 0, wrong: 0 };
    }
    return t && t.ok > 0 ? { status: 'verified', ok: t.ok, wrong: 0 } : { status: 'pending', ok: 0, wrong: 0 };
}

function updateBadge(tabId) {
    const { status } = tabStatus(tabId);
    const badge = {
        verified: { text: '✓', color: '#2e7d32' },
        missing: { text: '!', color: '#c62828' },
        unexpected: { text: '!', color: '#c62828' },
    }[status] || { text: '', color: '#000000' };
    chrome.action.setBadgeText({ tabId, text: badge.text }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color }).catch(() => {});
}

chrome.webRequest.onSendHeaders.addListener(async (details) => {
    await loaded;
    if (details.tabId < 0 || details.timeStamp < verification.since) {
        return; // not from a tab, or sent before the last toggle
    }
    if (details.type === 'main_frame') {
        delete verification.tabs[details.tabId]; // new page, start over
    } else {
        const sent = (details.requestHeaders || [])
            .some(h => h.name.toLowerCase() === HEADER && h.value === HEADER_VALUE);
        const t = verification.tabs[details.tabId] ||= { ok: 0, wrong: 0, lastWrongUrl: null };
        if (sent === verification.expectHeader) {
            t.ok++;
        } else {
            t.wrong++;
            t.lastWrongUrl = details.url;
        }
    }
    saveVerification();
    updateBadge(details.tabId);
}, { urls: LANDONLINE_URLS, types: ['main_frame', 'xmlhttprequest'] }, ['requestHeaders', 'extraHeaders']);

chrome.tabs.onRemoved.addListener(async (tabId) => {
    await loaded;
    delete verification.tabs[tabId];
    saveVerification();
});

// The content script polls this to draw the indicator; if the extension is gone the
// poll fails and the content script removes the indicator. The popup passes tabId.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const tabId = sender.tab ? sender.tab.id : message?.tabId;
    if (message?.type === 'status' && tabId !== undefined) {
        loaded.then(() => sendResponse(tabStatus(tabId)));
        return true;
    }
});

// After install, update, reload or re-enable, content scripts in already-open tabs
// belong to the previous extension instance and can no longer reach it.
// Inject into open tabs; content.js skips itself where a live copy is already running.
async function injectIntoOpenTabs() {
    const tabs = await chrome.tabs.query({ url: LANDONLINE_URLS });
    for (const tab of tabs) {
        try {
            const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
            if (result?.result === 'initialized') {
                await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['active-indicator.css'] });
            }
        } catch (error) {
            console.info(`Failed to inject content script into tab ${tab.id}:`, error);
        }
    }
}

// ---------------------------------------------------------------------------
// New session (browser start, extension install/update/reload/re-enable): the state
// is back to OFF. If the previous session was on Postgres, the browser still holds a
// Postgres-backend login (Keycloak cookies, restored tabs' tokens), so log out.
// storage.session 'sessionStarted' tells a new session apart from the service worker
// merely waking up again within the same session.
// ---------------------------------------------------------------------------

async function startSession() {
    const { sessionStarted } = await chrome.storage.session.get('sessionStarted');
    if (sessionStarted) {
        return;
    }
    await chrome.storage.session.set({ sessionStarted: true });

    // Earlier versions kept the header as a persistent dynamic rule and the state in
    // storage.local. Remove both, or the header would stay on for good after the update.
    const { postgresSession, isEnabled: legacyIsEnabled } = await chrome.storage.local.get(['postgresSession', 'isEnabled']);
    try {
        await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [RULE_ID] });
    } catch (error) {
        console.warn('Error removing legacy header rule:', error);
    }
    await chrome.storage.local.remove(['postgresSession', 'isEnabled']);

    if (postgresSession || legacyIsEnabled) {
        await forceRelogin();
    }
}

// Registering onStartup makes Chrome start the service worker when the browser opens,
// so the session start (and any logout) happens straight away, not on the first request.
chrome.runtime.onStartup.addListener(() => {});

// Whenever the service worker starts: handle a new session, re-sync rule and icon from
// storage, and make sure every open Landonline tab has a live indicator.
startSession()
    .then(getIsEnabled)
    .then(applyState)
    .then(injectIntoOpenTabs);
