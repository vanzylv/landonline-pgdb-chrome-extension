let isEnabled = false;
const RULE_ID = 1;

// Rule definition for declarativeNetRequest
const rule = {
    id: RULE_ID,
    priority: 1,
    action: {
        type: 'modifyHeaders',
        requestHeaders: [
            {header: 'Landonline-DB', operation: 'set', value: 'postgres'}, //xhr
            {header: 'landonline', operation: 'set', value: 'postgres'} //s3
        ]
    },
    condition: {
        urlFilter: '*',
        resourceTypes: ['main_frame', 'xmlhttprequest']
    }
};

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
    chrome.storage.local.set({isEnabled});
    updateIcon();

    if (isEnabled) {
        await enableHeaderInjection();
    } else {
        await disableHeaderInjection();
    }

    // Improved message sending with proper error handling
    try {
        await sendMessageToActiveTab({isEnabled});
    } catch (error) {
        console.error('Failed to send message:', error);
    }
});

function isValidUrl(url) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}

async function sendMessageToActiveTab(message) {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});

    if (!tab || !tab.id || !isValidUrl(tab.url)) {
        console.log('Skipping non-web page:', tab?.url);
        return;
    }

    try {
        await chrome.tabs.sendMessage(tab.id, message);
    } catch (error) {
        console.log('Attempting to inject content script...');
        try {
            await chrome.scripting.executeScript({
                target: {tabId: tab.id},
                files: ['content.js']
            });
            await chrome.tabs.sendMessage(tab.id, message);
        } catch (injectError) {
            console.error('Failed to inject content script:', injectError);
        }
    }
}

async function enableHeaderInjection() {
    try {
        await chrome.declarativeNetRequest.updateDynamicRules({
            addRules: [rule],
            removeRuleIds: [RULE_ID]
        });
    } catch (error) {
        console.error('Error enabling header injection:', error);
    }
}

async function disableHeaderInjection() {
    try {
        await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: [RULE_ID]
        });
    } catch (error) {
        console.error('Error disabling header injection:', error);
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