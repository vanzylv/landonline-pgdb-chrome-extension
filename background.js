const RULE_ID = 1;
const CONTENT_SCRIPT_MATCHES = ['https://*.landonline.govt.nz/*', 'https://*.linz.govt.nz/*'];

// Rule definition for declarativeNetRequest.
// requestDomains also matches subdomains and ignores the port.
const rule = {
    id: RULE_ID,
    priority: 1,
    action: {
        type: 'modifyHeaders',
        requestHeaders: [
            { header: 'Landonline-DB', operation: 'set', value: 'postgres' },
            { header: 'landonline', operation: 'set', value: 'postgres' }
        ]
    },
    condition: {
        requestDomains: ['landonline.govt.nz', 'linz.govt.nz'],
        resourceTypes: [
            'main_frame', 'sub_frame', 'xmlhttprequest', 'websocket', 'script',
            'stylesheet', 'image', 'font', 'media', 'ping', 'other'
        ]
    }
};

// chrome.storage.local 'isEnabled' is the single source of truth. The header rule,
// the toolbar icon and the in-page indicator are all derived from it, so they
// cannot drift apart.
async function getIsEnabled() {
    const { isEnabled } = await chrome.storage.local.get('isEnabled');
    return isEnabled || false;
}

async function applyState(isEnabled) {
    try {
        await chrome.declarativeNetRequest.updateDynamicRules(
            isEnabled ? { addRules: [rule], removeRuleIds: [RULE_ID] } : { removeRuleIds: [RULE_ID] }
        );
    } catch (error) {
        console.warn('Error updating header injection rule:', error);
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

// Toggle when icon is clicked. Read from storage rather than memory, because the
// service worker may have just been woken by this click.
chrome.action.onClicked.addListener(async () => {
    await chrome.storage.local.set({ isEnabled: !(await getIsEnabled()) });
});

// Any change to the stored state (icon click, devtools) updates the rule.
// Content scripts listen to the same change to update the indicator.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.isEnabled) {
        applyState(changes.isEnabled.newValue || false);
    }
});

// After install, update, reload or re-enable, content scripts in already-open tabs
// belong to the previous extension instance and stop receiving state changes.
// Inject into open tabs; content.js skips itself where a live copy is already running.
async function injectIntoOpenTabs() {
    const tabs = await chrome.tabs.query({ url: CONTENT_SCRIPT_MATCHES });
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

// Whenever the service worker starts: re-sync rule and icon from storage, and make
// sure every open Landonline tab has a live indicator.
getIsEnabled().then(applyState);
injectIntoOpenTabs();
