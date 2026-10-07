// Every new extension session (browser restart, update, disable/enable) starts OFF.
// If the previous session was on Postgres, it logs out like a switch does.
// Disable/enable stands in for a browser restart, which the harness can't do: an
// extension loaded with --load-extension is reinstalled on every launch.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup, setEnabled, sleep, toggleExtension, openExtensionPage } = require('./helpers');

const ISSUER = 'https://auth.dev.landonline.govt.nz/realms/landonline';

test('new session starts OFF', async (t) => {
    const pageLoads = {};
    const env = await setup((req, res, url) => {
        if (url.pathname.startsWith('/realms/landonline/login')) {
            const attrs = 'Path=/realms/landonline/; Secure; SameSite=None';
            res.setHeader('set-cookie', [`KEYCLOAK_IDENTITY=id; ${attrs}; HttpOnly`, `KEYCLOAK_TRUSTED_DEVICE=td; ${attrs}; HttpOnly`]);
            return res.end('logged in');
        }
        if (url.pathname === '/page') {
            pageLoads[req.headers.host] = (pageLoads[req.headers.host] || 0) + 1;
            res.setHeader('content-type', 'text/html');
            return res.end('<h1>app</h1><script>window.api = () => fetch("/api")</script>');
        }
        return false;
    });
    const { server, context, extensionId } = env;
    t.after(env.cleanup);
    let ext = env.extensionPage;

    const tab = await context.newPage();
    await tab.goto('https://app.landonline.govt.nz/page');

    async function login() {
        const kc = await context.newPage();
        await kc.goto(`${ISSUER}/login-actions/authenticate`);
        await kc.close();
        await tab.evaluate((issuer) => sessionStorage.setItem(`oidc.user:${issuer}:search-spa`, '{}'), ISSUER);
    }

    // Restart the extension session and return a fresh extension page
    async function newSession() {
        await toggleExtension(context);
        await toggleExtension(context);
        await sleep(1000);
        ext = await openExtensionPage(context, extensionId);
        await tab.bringToFront();
    }

    const state = () => ext.evaluate(async () => ({
        isEnabled: (await chrome.storage.session.get('isEnabled')).isEnabled || false,
        sessionRules: (await chrome.declarativeNetRequest.getSessionRules()).map((r) => r.id),
        dynamicRules: (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.id),
        title: await chrome.action.getTitle({}),
        local: await chrome.storage.local.get(null),
    }));
    const kcCookies = async () => (await ext.evaluate(() => chrome.cookies.getAll({ domain: 'auth.dev.landonline.govt.nz' }))).map((c) => c.name).sort();
    const oidcKeys = () => tab.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith('oidc.')));
    const lastApiHeader = () => server.requests.filter((r) => r.path === '/api').at(-1).header;

    await t.test('switching ON remembers a Postgres session', async () => {
        await setEnabled(ext, true);
        assert.deepEqual(await state(), {
            isEnabled: true, sessionRules: [1], dynamicRules: [], title: 'Landonline-DB Header: ON', local: { postgresSession: true },
        });
    });

    await t.test('service worker restart within the session keeps it ON, no logout', async () => {
        await login();
        const loadsBefore = pageLoads['app.landonline.govt.nz'];
        const cdp = await context.newCDPSession(tab);
        await cdp.send('ServiceWorker.enable');
        await cdp.send('ServiceWorker.stopAllWorkers');
        await sleep(1500);
        await tab.evaluate(() => api());
        await sleep(300);
        assert.equal((await state()).isEnabled, true);
        assert.equal(lastApiHeader(), 'postgres');
        assert.equal(pageLoads['app.landonline.govt.nz'], loadsBefore, 'tab not reloaded');
        assert.deepEqual(await kcCookies(), ['KEYCLOAK_IDENTITY', 'KEYCLOAK_TRUSTED_DEVICE']);
    });

    await t.test('new session after Postgres: OFF, no header, logged out', async () => {
        const loadsBefore = pageLoads['app.landonline.govt.nz'];
        await newSession();
        assert.deepEqual(await state(), {
            isEnabled: false, sessionRules: [], dynamicRules: [], title: 'Landonline-DB Header: OFF', local: {},
        });
        assert.ok(pageLoads['app.landonline.govt.nz'] > loadsBefore, 'tab reloaded');
        assert.deepEqual(await oidcKeys(), [], 'tokens cleared');
        assert.deepEqual(await kcCookies(), ['KEYCLOAK_TRUSTED_DEVICE'], 'Keycloak SSO cookie removed');
        await tab.evaluate(() => api());
        await sleep(300);
        assert.equal(lastApiHeader(), null);
    });

    await t.test('new session after Informix: OFF, no logout', async () => {
        await login();
        const loadsBefore = pageLoads['app.landonline.govt.nz'];
        await newSession();
        assert.equal((await state()).isEnabled, false);
        assert.equal(pageLoads['app.landonline.govt.nz'], loadsBefore, 'tab not reloaded');
        assert.deepEqual(await kcCookies(), ['KEYCLOAK_IDENTITY', 'KEYCLOAK_TRUSTED_DEVICE']);
    });

    await t.test('upgrade from an earlier version: persistent rule and state removed, logged out', async () => {
        // What versions before session scoping left behind when ON
        await ext.evaluate(async () => {
            await chrome.storage.local.set({ isEnabled: true });
            await chrome.declarativeNetRequest.updateDynamicRules({
                addRules: [{
                    id: 1, priority: 1,
                    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Landonline-DB', operation: 'set', value: 'postgres' }] },
                    condition: { requestDomains: ['landonline.govt.nz'], resourceTypes: ['xmlhttprequest'] },
                }],
            });
        });
        await login();
        await newSession();
        const s = await state();
        assert.deepEqual([s.isEnabled, s.dynamicRules, s.sessionRules, s.local], [false, [], [], {}]);
        assert.deepEqual(await kcCookies(), ['KEYCLOAK_TRUSTED_DEVICE'], 'logged out');
        await tab.evaluate(() => api());
        await sleep(300);
        assert.equal(lastApiHeader(), null);
    });
});
