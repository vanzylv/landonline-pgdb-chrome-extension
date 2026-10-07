// The toolbar popup: current backend, logout warning, Cancel and Switch, and that only
// *.landonline.govt.nz tabs are reloaded on switch.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup, sleep } = require('./helpers');

test('toggle popup', async (t) => {
    const loads = {};
    const env = await setup((req, res, url) => {
        if (url.pathname !== '/page') return false;
        loads[req.headers.host] = (loads[req.headers.host] || 0) + 1;
        res.setHeader('content-type', 'text/html');
        return res.end('<h1>page</h1>');
    });
    const { context, extensionId } = env;
    t.after(env.cleanup);

    // The popup opened as a normal tab; good enough for its logic, not its sizing.
    const openPopup = async () => {
        const page = await context.newPage();
        await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
        await sleep(400);
        return page;
    };
    const read = (popup) => popup.evaluate(() => ({
        current: document.getElementById('current').textContent,
        button: document.getElementById('switch').textContent,
        warning: document.getElementById('warning').hidden ? null : document.getElementById('warning').textContent,
    }));
    const stored = (page) => page.evaluate(() => chrome.storage.session.get('isEnabled').then((d) => d.isEnabled || false));

    await t.test('no Landonline tabs open: no warning', async () => {
        const popup = await openPopup();
        assert.deepEqual(await read(popup), { current: 'Informix (header OFF)', button: 'Switch to Postgres', warning: null });
        await popup.close();
    });

    const app = await context.newPage();
    await app.goto('https://app.landonline.govt.nz/page');
    const auth = await context.newPage();
    await auth.goto('https://auth.dev.landonline.govt.nz/page');
    const linz = await context.newPage();
    await linz.goto('https://www.linz.govt.nz/page');

    await t.test('counts Landonline tabs only', async () => {
        const popup = await openPopup();
        assert.deepEqual(await read(popup), {
            current: 'Informix (header OFF)', button: 'Switch to Postgres',
            warning: 'Switching logs you out of 2 open Landonline tabs. Unsaved work is lost.',
        });
        await popup.close();
    });

    await t.test('Cancel changes nothing', async () => {
        const popup = await openPopup();
        const before = { ...loads };
        await popup.click('#cancel').catch(() => {});
        await sleep(1000);
        const check = await openPopup();
        assert.equal(await stored(check), false);
        assert.deepEqual(loads, before);
        await check.close();
    });

    await t.test('Switch: ON, Landonline tabs reloaded, linz.govt.nz tab left alone', async () => {
        const popup = await openPopup();
        const before = { ...loads };
        await popup.click('#switch').catch(() => {}); // the popup closes itself
        await sleep(2000);
        const check = await openPopup();
        assert.equal(await stored(check), true);
        assert.deepEqual((await check.evaluate(() => chrome.declarativeNetRequest.getSessionRules())).map((r) => r.id), [1]);
        assert.equal(loads['app.landonline.govt.nz'] - before['app.landonline.govt.nz'], 1);
        assert.equal(loads['auth.dev.landonline.govt.nz'] - before['auth.dev.landonline.govt.nz'], 1);
        assert.equal(loads['www.linz.govt.nz'] - before['www.linz.govt.nz'], 0);
        await check.close();
    });

    await t.test('then offers to switch back', async () => {
        const popup = await openPopup();
        assert.deepEqual(await read(popup), {
            current: 'Postgres (header ON)', button: 'Switch to Informix',
            warning: 'Switching logs you out of 2 open Landonline tabs. Unsaved work is lost.',
        });
        await popup.close();
    });

    await t.test('singular wording for one tab', async () => {
        await auth.close();
        const popup = await openPopup();
        assert.equal((await read(popup)).warning, 'Switching logs you out of 1 open Landonline tab. Unsaved work is lost.');
        await popup.close();
    });
});
