// Popup opened from the toolbar icon. Shows the current backend and, before switching,
// warns that open Landonline tabs will be logged out (see forceRelogin in background.js).
const LOGIN_URLS = ['https://*.landonline.govt.nz/*'];
const LANDONLINE_URL = /^https:\/\/([^/]+\.)?(landonline|linz)\.govt\.nz(:\d+)?\//;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const POSITIONS_KEY = 'bannerPositions'; // per-site banner positions, saved by content.js

// The details behind the in-page indicator (content.js), which keeps its text short
function describeTabStatus(status) {
    switch (status?.status) {
        case 'verified':
            return ['verified', `This tab: header verified on ${plural(status.ok, 'API request')}`];
        case 'pending':
            return ['pending', 'This tab: waiting for first API request'];
        case 'missing':
            return ['missing', `This tab: header missing on ${plural(status.wrong, 'API request')} (last: ${status.url})`];
        case 'unexpected':
            return ['missing', `This tab: header still sent on ${plural(status.wrong, 'API request')} (last: ${status.url})`];
        default:
            return null;
    }
}

async function init() {
    const { isEnabled = false } = await chrome.storage.session.get('isEnabled');
    document.getElementById('current').textContent = isEnabled ? 'Postgres (header ON)' : 'Informix (header OFF)';

    const switchButton = document.getElementById('switch');
    switchButton.textContent = isEnabled ? 'Switch to Informix' : 'Switch to Postgres';

    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab && LANDONLINE_URL.test(activeTab.url || '')) {
        try {
            const view = describeTabStatus(await chrome.runtime.sendMessage({ type: 'status', tabId: activeTab.id }));
            if (view) {
                const tabStatus = document.getElementById('tab-status');
                tabStatus.className = `tab-status ${view[0]}`;
                tabStatus.textContent = view[1];
                tabStatus.hidden = false;
            }
        } catch (error) {
            console.info('No tab status:', error);
        }
        await showResetPosition(new URL(activeTab.url).hostname);
    }

    const loginTabs = await chrome.tabs.query({ url: LOGIN_URLS });
    if (loginTabs.length > 0) {
        const warning = document.getElementById('warning');
        warning.textContent = `Switching logs you out of ${plural(loginTabs.length, 'open Landonline tab')}. Unsaved work is lost.`;
        warning.hidden = false;
    }

    switchButton.addEventListener('click', async () => {
        switchButton.disabled = true;
        // background.js reacts to the change: header rule, icon, verification, re-login
        await chrome.storage.session.set({ isEnabled: !isEnabled });
        window.close();
    });
    switchButton.focus();
}

// Offer to put the banner back at the top centre, if it has been moved on this site
async function showResetPosition(host) {
    const { [POSITIONS_KEY]: positions = {} } = await chrome.storage.local.get(POSITIONS_KEY);
    if (!positions[host]) return;
    const row = document.getElementById('reset-row');
    const button = document.getElementById('reset-position');
    row.hidden = false;
    button.addEventListener('click', async () => {
        const { [POSITIONS_KEY]: current = {} } = await chrome.storage.local.get(POSITIONS_KEY);
        delete current[host];
        await chrome.storage.local.set({ [POSITIONS_KEY]: current });
        row.textContent = 'Banner moved back to the top.';
    });
}

document.getElementById('cancel').addEventListener('click', () => window.close());
init();
