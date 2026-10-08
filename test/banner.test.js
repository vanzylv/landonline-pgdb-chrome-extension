// The in-page banner: short text, never blocks clicks, can be dragged by its grip, remembers
// its position per site, stays inside the window, and can be reset from the popup.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup, setEnabled, sleep } = require('./helpers');

// A page with a button right where the banner sits by default (top centre)
function pageWithTopButton(res) {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><body style="margin:0">
        <button id="top" style="position:fixed;top:0;left:50%;transform:translateX(-50%);width:300px;height:40px">Top button</button>
        <script>
            window.clicks = 0;
            document.getElementById('top').addEventListener('click', () => window.clicks++);
            window.api = () => fetch('/api');
        </script>`);
}

// Layout position and size, plus the visual centre for checking the default
// centred position (which uses a translateX transform).
const box = (page) => page.evaluate(() => {
    const el = document.getElementById('landonline-db-indicator');
    const r = el.getBoundingClientRect();
    return {
        moved: el.classList.contains('moved'),
        left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight,
        centre: Math.round(r.left + r.width / 2),
    };
});
const gripCentre = (page) => page.evaluate(() => {
    const r = document.querySelector('#landonline-db-indicator .ldb-grip').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});

async function dragGrip(page, dx, dy) {
    const start = await gripCentre(page);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + dx / 2, start.y + dy / 2, { steps: 5 });
    await page.mouse.move(start.x + dx, start.y + dy, { steps: 5 });
    await page.mouse.up();
    await sleep(300);
}

test('banner', async (t) => {
    const env = await setup((req, res, url) => url.pathname === '/page' ? pageWithTopButton(res) : false);
    const { context, extensionId, extensionPage: ext } = env;
    t.after(env.cleanup);

    const tab = await context.newPage();
    await tab.setViewportSize({ width: 1200, height: 800 });
    await tab.goto('https://plan.landonline.govt.nz/page');
    await setEnabled(ext, true);
    await tab.evaluate(() => api());
    await sleep(1300);

    await t.test('short text, at the top centre by default', async () => {
        const b = await box(tab);
        assert.ok(b.width < 260, `width ${b.width}`); // 1.2.0 was ~470px
        assert.equal(b.moved, false);
        assert.equal(b.top, 5);
        assert.ok(Math.abs(b.centre - 600) <= 1, `centre ${b.centre}`);
    });

    await t.test('clicks on the banner go through to the page', async () => {
        const b = await box(tab);
        // Click on the label part of the banner, which sits over the button
        await tab.mouse.click(b.centre + b.width / 2 - 20, b.top + b.height / 2);
        assert.equal(await tab.evaluate(() => window.clicks), 1);
    });

    await t.test('dragging the grip moves it, and does not click the page', async () => {
        await dragGrip(tab, -400, 300);
        const b = await box(tab);
        assert.equal(b.moved, true);
        assert.ok(Math.abs(b.top - 305) <= 3, `top ${b.top}`); // starts at 5px
        assert.ok(b.left < 300, `left ${b.left}`);
        assert.equal(await tab.evaluate(() => window.clicks), 1);
    });

    await t.test('position is remembered after reload and in other tabs of the same site', async () => {
        const before = await box(tab);
        await tab.reload();
        await tab.evaluate(() => api()); // back to green, same width as before
        await sleep(1300);
        assert.deepEqual(await box(tab), before);

        const other = await context.newPage();
        await other.setViewportSize({ width: 1200, height: 800 });
        await other.goto('https://plan.landonline.govt.nz/page');
        await other.evaluate(() => api());
        await sleep(1300);
        assert.deepEqual(await box(other), before);
        await other.close();
    });

    await t.test('other sites keep the default position', async () => {
        const other = await context.newPage();
        await other.setViewportSize({ width: 1200, height: 800 });
        await other.goto('https://search.landonline.govt.nz/page');
        await other.evaluate(() => api());
        await sleep(1300);
        const b = await box(other);
        assert.equal(b.moved, false);
        assert.equal(b.top, 5);
        await other.close();
    });

    await t.test('cannot be dragged out of the window', async () => {
        await tab.bringToFront();
        await dragGrip(tab, -2000, 2000);
        const b = await box(tab);
        assert.equal(b.left, 0);
        assert.equal(b.top + b.height, 800);
    });

    await t.test('stays inside when the window shrinks', async () => {
        await dragGrip(tab, 1100, -100);
        await tab.setViewportSize({ width: 600, height: 400 });
        await sleep(300);
        const b = await box(tab);
        assert.ok(b.left + b.width <= 600, `right edge ${b.left + b.width}`);
        assert.ok(b.top + b.height <= 400, `bottom edge ${b.top + b.height}`);
        await tab.setViewportSize({ width: 1200, height: 800 });
    });

    await t.test('popup "Reset banner position" puts it back at the top centre', async () => {
        const popup = await context.newPage();
        await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
        await sleep(400);
        // Opened as a tab the popup can't see the Landonline tab, so call its reset
        // check for the site directly
        await popup.evaluate(() => showResetPosition('plan.landonline.govt.nz'));
        assert.equal(await popup.isVisible('#reset-position'), true);
        await popup.click('#reset-position');
        await sleep(500);
        await popup.close();

        await tab.bringToFront();
        await sleep(300);
        const b = await box(tab);
        assert.equal(b.moved, false);
        assert.equal(b.top, 5);
        assert.ok(Math.abs(b.centre - 600) <= 1, `centre ${b.centre}`);
    });

    await t.test('no reset link when the banner has not been moved', async () => {
        const popup = await context.newPage();
        await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
        await sleep(400);
        await popup.evaluate(() => showResetPosition('plan.landonline.govt.nz'));
        assert.equal(await popup.isVisible('#reset-position'), false);
        await popup.close();
    });
});
