// Switching the extension must log the user out: Keycloak SSO cookies on auth.* removed,
// the apps' oidc.* tokens cleared and every *.landonline.govt.nz tab reloaded.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup, setEnabled, sleep } = require('./helpers');

const ISSUER = 'https://auth.dev.landonline.govt.nz/realms/landonline';

test('forced re-login on toggle', async (t) => {
    const pageLoads = {};
    const env = await setup((req, res, url) => {
        if (url.pathname.startsWith('/realms/landonline/login')) {
            // Mimic the cookies Keycloak sets after a login
            const attrs = 'Path=/realms/landonline/; Secure; SameSite=None';
            res.setHeader('set-cookie', [
                `KEYCLOAK_IDENTITY=id; ${attrs}; HttpOnly`, `KEYCLOAK_SESSION=sess; ${attrs}`,
                `AUTH_SESSION_ID=a1; ${attrs}; HttpOnly`, `KC_RESTART=r; ${attrs}; HttpOnly`,
                `KEYCLOAK_TRUSTED_DEVICE=td; ${attrs}; HttpOnly`, `KEYCLOAK_REMEMBER_ME=user; ${attrs}`,
            ]);
            return res.end('logged in');
        }
        if (url.pathname === '/page') {
            pageLoads[req.headers.host] = (pageLoads[req.headers.host] || 0) + 1;
            res.setHeader('set-cookie', 'APP_COOKIE=keep; Path=/; Secure');
            res.setHeader('content-type', 'text/html');
            return res.end('<h1>app</h1>');
        }
        return false;
    });
    const { context, extensionPage: ext } = env;
    t.after(env.cleanup);

    const cookieNames = async (domain) =>
        (await ext.evaluate((d) => chrome.cookies.getAll({ domain: d }), domain)).map((c) => c.name).sort();

    const appTab = await context.newPage();
    await appTab.goto('https://app.landonline.govt.nz/page');
    const searchTab = await context.newPage();
    await searchTab.goto('https://search.landonline.govt.nz/page');
    const tabs = [[appTab, 'survey-capture-client'], [searchTab, 'search-spa']];

    // "Log in": Keycloak cookies on auth.*, OIDC tokens in each app tab
    async function login() {
        const kc = await context.newPage();
        await kc.goto(`${ISSUER}/login-actions/authenticate`);
        await kc.close();
        for (const [page, clientId] of tabs) {
            await page.evaluate(([issuer, client]) => {
                sessionStorage.setItem(`oidc.user:${issuer}:${client}`, JSON.stringify({ access_token: 'x', id_token: 'y' }));
                sessionStorage.setItem('searchState', 'keep-me');
                localStorage.setItem('LolUserSessionState', JSON.stringify({ isAuthenticated: true }));
            }, [ISSUER, clientId]);
        }
    }
    await login();
    assert.equal((await cookieNames('auth.dev.landonline.govt.nz')).length, 6);

    for (const isEnabled of [true, false]) {
        await t.test(`switch ${isEnabled ? 'ON' : 'OFF'}`, async () => {
            const loadsBefore = { ...pageLoads };
            await setEnabled(ext, isEnabled);
            await sleep(500);

            assert.deepEqual(await cookieNames('auth.dev.landonline.govt.nz'), ['KEYCLOAK_REMEMBER_ME', 'KEYCLOAK_TRUSTED_DEVICE'],
                'Keycloak SSO cookies removed; trusted device and remember-me kept');
            assert.deepEqual(await cookieNames('app.landonline.govt.nz'), ['APP_COOKIE'], 'app cookies untouched');

            for (const [page] of tabs) {
                const host = new URL(page.url()).host;
                assert.equal(pageLoads[host] - loadsBefore[host], 1, `${host} reloaded once`);
                assert.deepEqual(await page.evaluate(() => ({
                    oidc: Object.keys(sessionStorage).filter((k) => k.startsWith('oidc.')),
                    searchState: sessionStorage.getItem('searchState'),
                    lolState: Boolean(localStorage.getItem('LolUserSessionState')),
                })), { oidc: [], searchState: 'keep-me', lolState: true }, `${host} tokens cleared, other storage kept`);
            }
        });
        await login();
    }

    await t.test('unrelated storage change does not log out', async () => {
        const loadsBefore = { ...pageLoads };
        await ext.evaluate(() => chrome.storage.session.set({ somethingElse: 1 }));
        await sleep(1500);
        assert.equal(pageLoads['app.landonline.govt.nz'] - loadsBefore['app.landonline.govt.nz'], 0);
        assert.equal((await cookieNames('auth.dev.landonline.govt.nz')).length, 6);
    });
});
