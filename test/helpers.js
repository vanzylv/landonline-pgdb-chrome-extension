// Shared test harness: a local HTTPS server that stands in for *.landonline.govt.nz and
// *.linz.govt.nz, and a Chromium with the unpacked extension loaded.
//
// Every hostname is mapped to the local server with --host-resolver-rules, so pages,
// API calls and Keycloak cookies behave as if they were on the real domains.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const EXTENSION_DIR = path.resolve(__dirname, '..');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Throwaway self-signed certificate, generated per run so no key is committed.
function makeCertificate(dir) {
    const key = path.join(dir, 'key.pem');
    const cert = path.join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
        '-days', '1', '-subj', '/CN=landonline-test'], { stdio: 'ignore' });
    return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

// handler(req, res, url) handles a request; return false to fall through to the default 'ok'.
// Every request is recorded in server.requests with the Landonline-DB header it carried.
async function startServer(handler, tmpDir) {
    const requests = [];
    const server = https.createServer(makeCertificate(tmpDir), (req, res) => {
        const url = new URL(req.url, `https://${req.headers.host}`);
        requests.push({ host: req.headers.host, path: url.pathname, header: req.headers['landonline-db'] || null });
        if (handler && handler(req, res, url) !== false) return;
        res.end('ok');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    server.requests = requests;
    server.port = server.address().port;
    return server;
}

// A page that exposes window.api() / window.xhr() for making API calls.
function appPage(res) {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><h1>app</h1><script>
        window.api = () => fetch('/api').then((r) => r.text());
        window.xhr = () => new Promise((resolve) => {
            const x = new XMLHttpRequest(); x.open('GET', '/api/xhr'); x.onload = resolve; x.send();
        });
    </script>`);
}

// Launch Chromium with the extension. Set CHROME_PATH to use a specific binary,
// otherwise Playwright's Chromium is used (npm run test:install-browser).
async function launch(server, tmpDir) {
    const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(tmpDir, 'profile-')), {
        executablePath: process.env.CHROME_PATH || undefined,
        headless: true,
        ignoreHTTPSErrors: true,
        args: [
            `--disable-extensions-except=${EXTENSION_DIR}`,
            `--load-extension=${EXTENSION_DIR}`,
            `--host-resolver-rules=MAP * 127.0.0.1:${server.port}, EXCLUDE localhost`,
            '--ignore-certificate-errors',
        ],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;

    // An extension page with access to chrome.* APIs, used to drive and inspect the extension.
    const extensionPage = await context.newPage();
    await extensionPage.goto(`chrome-extension://${extensionId}/manifest.json`);

    return { context, extensionId, extensionPage };
}

// Set up server + browser for a test file; returns everything plus a cleanup function.
async function setup(handler) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'landonline-db-test-'));
    const server = await startServer(handler, tmpDir);
    const browser = await launch(server, tmpDir);
    const cleanup = async () => {
        await browser.context.close();
        server.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    };
    return { server, ...browser, cleanup };
}

// Switch the extension the same way the popup does, then wait for the background to react
// (header rule, re-login reload of open tabs).
async function setEnabled(extensionPage, isEnabled) {
    await extensionPage.evaluate((value) => chrome.storage.session.set({ isEnabled: value }), isEnabled);
    await sleep(1500);
}

// Flip the extension's enable toggle on chrome://extensions. Disabling and re-enabling
// starts a new extension session, like a browser restart or an update.
async function toggleExtension(context) {
    const page = await context.newPage();
    await page.goto('chrome://extensions');
    await sleep(800);
    await page.evaluate(() => document.querySelector('extensions-manager').shadowRoot
        .querySelector('extensions-item-list').shadowRoot
        .querySelector('extensions-item').shadowRoot
        .querySelector('#enableToggle').click());
    await sleep(1500);
    await page.close();
}

// A fresh extension page; needed after disable/enable, which closes the old one.
async function openExtensionPage(context, extensionId) {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/manifest.json`);
    return page;
}

module.exports = { EXTENSION_DIR, sleep, setup, appPage, setEnabled, toggleExtension, openExtensionPage };
