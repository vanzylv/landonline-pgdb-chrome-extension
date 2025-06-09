const RULE_ID = 1;
let isEnabled = false;

// Rule definition for declarativeNetRequest
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
        urlFilter: 'https://*.govt.nz/*',
        resourceTypes: ['main_frame', 'xmlhttprequest']
    }
};

// Utility: Check if a URL matches the required pattern
function matchesLandonlineUrl(url) {
    return /^https:\/\/.*\.(landonline|linz)\.govt\.nz\//.test(url);
}

// Utility: Handle tab updates (activated, updated, or created)
async function handleTabUpdate(tabId, url) {
    if (matchesLandonlineUrl(url)) {
        const { isEnabled } = await chrome.storage.local.get('isEnabled');
        if (isEnabled) {
            await enableHeaderInjection();
            await sendMessageToTab(tabId, { isEnabled });
        } else {
            await disableHeaderInjection();
            await sendMessageToTab(tabId, { isEnabled: false });
        }
    } else {
        await disableHeaderInjection();
        chrome.action.setTitle({ title: 'Landonline-DB Header: OFF' });
    }
}

async function sendMessageToTab(tabId, message) {
    try {
        // Check if the tab exists
        const tab = await chrome.tabs.get(tabId);
        if (!tab) {
            console.warn(`Tab with ID ${tabId} does not exist.`);
            return;
        }

        // Send the message to the tab
        await chrome.tabs.sendMessage(tabId, message);
    } catch (error) {
        console.log('Attempting to inject content script...');
        try {
            chrome.scripting.executeScript({
                target: { tabId },
                files: ['content.js']
            });
            await chrome.tabs.sendMessage(tabId, message);
        } catch (injectError) {
            console.warn(`Failed to inject content script or send message to tab ${tabId}:`, injectError);
        }
    }
}

// Event: Tab activated
chrome.tabs.onActivated.addListener(async (activeInfo) => {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab && tab.url) {
        await handleTabUpdate(tab.id, tab.url);
    }
});

// Event: Tab updated
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.url) {
        await handleTabUpdate(tabId, changeInfo.url);
    }
});

// Event: Tab created
chrome.tabs.onCreated.addListener(async (tab) => {
    if (tab && tab.url) {
        await handleTabUpdate(tab.id, tab.url);
    }
});

// Load saved state
chrome.storage.local.get('isEnabled', async (data) => {
    isEnabled = data.isEnabled || false;
    updateIcon();
    if (isEnabled) {
        await enableHeaderInjection();
    }
});

// Toggle when icon is clicked
chrome.action.onClicked.addListener(async (tab) => {
    isEnabled = !isEnabled;
    chrome.storage.local.set({ isEnabled });
    updateIcon();

    if (isEnabled) {
        await enableHeaderInjection();
    } else {
        await disableHeaderInjection();

        // Notify all tabs to update the indicator
        const tabs = await chrome.tabs.query({});
        for (const t of tabs) {
            try {
                await chrome.tabs.sendMessage(t.id, { isEnabled: false });
            } catch (error) {
                console.info(`Failed to send message to tab ${t.id}:`, error);
            }
        }
    }

    if (tab && tab.id) {
        await sendMessageToTab(tab.id, { isEnabled });
    }
});

// Utility: Enable header injection
async function enableHeaderInjection() {
    try {
        await chrome.declarativeNetRequest.updateDynamicRules({
            addRules: [rule],
            removeRuleIds: [RULE_ID]
        });
    } catch (error) {
        console.warn('Error enabling header injection:', error);
    }
}

async function disableHeaderInjection() {
    try {
        await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: [RULE_ID]
        });
    } catch (error) {
        console.warn('Error disabling header injection:', error);
    }
}

function updateIcon() {
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