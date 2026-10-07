// The in-page indicator must only be green when the tab's API requests were actually
// seen with the Landonline-DB header. Steps run in order and share one browser.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sleep, setup, appPage, setEnabled, toggleExtension, openExtensionPage } = require('./helpers');

// Wait for the content script's next poll, then read the indicator.
async function indicator(page) {
    await sleep(1300);
    return page.evaluate(() => {
        const all = document.querySelectorAll('#landonline-db-indicator');
        const el = all[0];
        if (!el) return { shown: false, count: 0 };
        const shown = getComputedStyle(el).display !== 'none';
        return { shown, cls: el.className, text: shown ? el.textContent : '', bg: getComputedStyle(el).backgroundColor, count: all.length };
    });
}

// Simulate a bug: change the header rule without changing the stored state.
const removeRule = (ext) => ext.evaluate(() => chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1] }));
const addRule = (ext) => ext.evaluate(() => chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [1],
    addRules: [{
        id: 1, priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Landonline-DB', operation: 'set', value: 'postgres' }] },
        condition: { requestDomains: ['landonline.govt.nz'], resourceTypes: ['xmlhttprequest'] },
    }],
}));

const badge = (ext, page) => ext.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    return chrome.action.getBadgeText({ tabId: tab.id });
}, page.url());

test('verified indicator', async (t) => {
    const env = await setup((req, res, url) => url.pathname === '/page' ? appPage(res) : false);
    const { server, context, extensionId, extensionPage: ext } = env;
    t.after(env.cleanup);
    const tab = await context.newPage();
    const lastApiHeader = () => server.requests.filter((r) => r.path.startsWith('/api')).at(-1).header;

    await t.test('OFF: no indicator', async () => {
        await tab.goto('https://app.landonline.govt.nz/page');
        await tab.evaluate(() => api());
        assert.equal((await indicator(tab)).shown, false);
    });

    await t.test('ON before any API call: amber pending, never green', async () => {
        await setEnabled(ext, true);
        const ind = await indicator(tab);
        assert.equal(ind.cls, 'pending');
        assert.ok(!ind.text.startsWith('Connected'), ind.text);
    });

    await t.test('ON after API calls with header: green verified', async () => {
        await tab.evaluate(() => Promise.all([api(), xhr()]));
        const ind = await indicator(tab);
        assert.equal(ind.cls, 'verified');
        assert.match(ind.text, /verified on 2 API requests/);
        assert.equal(await badge(ext, tab), '✓');
        assert.equal(lastApiHeader(), 'postgres');
    });

    await t.test('ON but rule removed behind its back: red, not green', async () => {
        await removeRule(ext);
        await tab.evaluate(() => api());
        const ind = await indicator(tab);
        assert.equal(lastApiHeader(), null, 'server should have received no header');
        assert.equal(ind.cls, 'missing');
        assert.match(ind.text, /^NOT on Postgres.*\/api/);
        assert.equal(ind.bg, 'rgb(198, 40, 40)');
        assert.equal(await badge(ext, tab), '!');
    });

    await t.test('red is sticky: a later good request does not turn it green', async () => {
        await addRule(ext);
        await tab.evaluate(() => api());
        assert.equal((await indicator(tab)).cls, 'missing');
    });

    await t.test('navigation resets to pending, then verified', async () => {
        await tab.reload();
        assert.equal((await indicator(tab)).cls, 'pending');
        await tab.evaluate(() => api());
        assert.equal((await indicator(tab)).cls, 'verified');
    });

    await t.test('service worker restart keeps the verified state', async () => {
        const cdp = await context.newCDPSession(tab);
        await cdp.send('ServiceWorker.enable');
        await cdp.send('ServiceWorker.stopAllWorkers');
        await sleep(1500);
        const ind = await indicator(tab);
        assert.equal(ind.cls, 'verified');
        assert.match(ind.text, /1 API request/);
    });

    await t.test('OFF: hidden, badge cleared', async () => {
        await setEnabled(ext, false);
        await tab.evaluate(() => api());
        assert.equal((await indicator(tab)).shown, false);
        assert.equal(await badge(ext, tab), '');
    });

    await t.test('OFF but header still sent: red', async () => {
        await addRule(ext);
        await tab.evaluate(() => api());
        const ind = await indicator(tab);
        assert.equal(ind.cls, 'missing');
        assert.match(ind.text, /^Header OFF but still sent/);
        await removeRule(ext);
    });

    await t.test('page removes the indicator: recreated with the same state', async () => {
        await setEnabled(ext, true);
        await tab.evaluate(() => api());
        await indicator(tab);
        await tab.evaluate(() => document.getElementById('landonline-db-indicator').remove());
        const ind = await indicator(tab);
        assert.equal(ind.cls, 'verified');
        assert.equal(ind.count, 1);
    });

    await t.test('stable state does not touch the page DOM', async () => {
        const mutations = await tab.evaluate(() => new Promise((resolve) => {
            let n = 0;
            const observer = new MutationObserver((list) => { n += list.length; });
            observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
            setTimeout(() => { observer.disconnect(); resolve(n); }, 3500);
        }));
        assert.equal(mutations, 0);
    });

    await t.test('extension disabled: indicator removed', async () => {
        await toggleExtension(context);
        await tab.bringToFront();
        assert.equal((await indicator(tab)).count, 0);
    });

    await t.test('extension re-enabled: back OFF, fresh content script works again', async () => {
        await toggleExtension(context);
        await tab.bringToFront();
        await sleep(1000); // re-enable logs out of the Postgres session and reloads the tab
        await tab.evaluate(() => api());
        assert.equal((await indicator(tab)).shown, false);
        assert.equal(lastApiHeader(), null, 'new session must start without the header');

        const freshExt = await openExtensionPage(context, extensionId);
        await setEnabled(freshExt, true);
        assert.equal((await indicator(tab)).cls, 'pending');
        await tab.evaluate(() => api());
        assert.equal((await indicator(tab)).cls, 'verified');
    });
});
