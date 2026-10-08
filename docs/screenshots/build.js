// Regenerates the README / Chrome Web Store screenshots from the real extension UI:
//   docs/images/banner-{pending,verified,missing}.png   banners as testers see them
//   docs/images/overview-*.png                          README overview slides
//   dist/store-screenshots/*.png                        Web Store listing (max 5)
//
// Usage: npm run screenshots   (CHROME_PATH works as for the tests)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const { setup, appPage, setEnabled, sleep } = require('../../test/helpers');

const ROOT = path.resolve(__dirname, '../..');
const IMAGES = path.join(ROOT, 'docs/images');
const STORE = path.join(ROOT, 'dist/store-screenshots');

// Slide name -> README overview image; the store gets the first five in this order
const SLIDES = ['verified', 'switch', 'states', 'move', 'restart', 'missing'];
const STORE_NAMES = {
    verified: '1-verified-banner', switch: '2-switch-popup', states: '3-banner-states',
    move: '4-move-banner', restart: '5-back-to-informix',
};

async function captureParts(dir) {
    const env = await setup((req, res, url) => url.pathname === '/page' ? appPage(res) : false);
    const { context, extensionId, extensionPage: ext } = env;
    try {
        const tab = await context.newPage();
        await tab.setViewportSize({ width: 1000, height: 200 });
        await tab.goto('https://app.landonline.govt.nz/page');
        await setEnabled(ext, true);

        const banner = async (name) => {
            await sleep(1300); // next poll of the content script
            await tab.locator('#landonline-db-indicator').screenshot({ path: path.join(dir, `${name}.png`), animations: 'disabled' });
        };
        await banner('banner-pending');
        for (let i = 0; i < 14; i++) await tab.evaluate(() => api()); // same count as the popup shot
        await banner('banner-verified');
        await ext.evaluate(() => chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1] }));
        await tab.evaluate(() => api());
        await banner('banner-missing');

        // The popup, opened as a tab. Its "This tab" line can't see a Landonline tab that
        // way, so it's filled with the text the popup shows for a verified tab.
        const popup = async (name, isEnabled) => {
            await setEnabled(ext, isEnabled);
            const page = await context.newPage();
            await page.setViewportSize({ width: 300, height: 400 });
            await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
            await sleep(500);
            await page.evaluate((on) => {
                if (on) {
                    const status = document.getElementById('tab-status');
                    status.className = 'tab-status verified';
                    status.textContent = 'This tab: header verified on 14 API requests';
                    status.hidden = false;
                }
                const warning = document.getElementById('warning');
                warning.textContent = 'Switching logs you out of 2 open Landonline tabs. Unsaved work is lost.';
                warning.hidden = false;
            }, isEnabled);
            await page.locator('main').screenshot({ path: path.join(dir, `${name}.png`) });
            await page.close();
        };
        await popup('popup-on', true);
        await popup('popup-off', false);
    } finally {
        await env.cleanup();
    }
}

async function renderSlides(partsDir) {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
        const slidesUrl = pathToFileURL(path.join(__dirname, 'slides.html')).href;
        const partsUrl = pathToFileURL(partsDir).href;
        for (const slide of SLIDES) {
            await page.goto(`${slidesUrl}?slide=${slide}&parts=${encodeURIComponent(partsUrl)}`);
            await page.waitForLoadState('load');
            await sleep(200);
            const file = path.join(IMAGES, `overview-${slide}.png`);
            await page.screenshot({ path: file }); // opaque RGB PNG, as the store requires
            if (STORE_NAMES[slide]) fs.copyFileSync(file, path.join(STORE, `${STORE_NAMES[slide]}.png`));
            console.log(`overview-${slide}.png${STORE_NAMES[slide] ? `  + store ${STORE_NAMES[slide]}.png` : ''}`);
        }
    } finally {
        await browser.close();
    }
}

(async () => {
    const partsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'landonline-db-shots-'));
    fs.rmSync(STORE, { recursive: true, force: true });
    fs.mkdirSync(STORE, { recursive: true });
    try {
        await captureParts(partsDir);
        for (const name of ['banner-pending', 'banner-verified', 'banner-missing']) {
            fs.copyFileSync(path.join(partsDir, `${name}.png`), path.join(IMAGES, `${name}.png`));
            console.log(`${name}.png`);
        }
        await renderSlides(partsDir);
    } finally {
        fs.rmSync(partsDir, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
