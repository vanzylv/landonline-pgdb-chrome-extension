// content.js - draws the indicator from what the background actually observed on
// this tab's API requests. It never decides on its own that the header is being sent.
(function() {
    // Early exit if not on a valid web page
    if (!window.location.protocol.match(/^https?:/)) {
        console.log('[Landonline-DB] Skipping non-HTTP(S) page:', window.location.href);
        return;
    }

    // Skip if a live copy of this script is already running in the page.
    // A copy left over from a disabled/reloaded extension reports itself dead,
    // so a fresh injection takes over from it.
    if (window.__landonlineDbAlive && window.__landonlineDbAlive()) {
        return 'skipped';
    }
    const isAlive = () => !!chrome.runtime?.id;
    window.__landonlineDbAlive = isAlive;

    const POLL_MS = 1000;
    // Per-site banner positions, { [hostname]: { left, top } }. Shared with the popup's reset.
    const POSITIONS_KEY = 'bannerPositions';
    const host = window.location.hostname;

    // The indicator is a small pill: a grip to drag it by, and a label. Only the grip
    // takes the mouse; clicks anywhere else on the pill go through to the page.
    const createIndicator = () => {
        let indicator = document.getElementById('landonline-db-indicator');
        if (!indicator) {
            indicator = document.createElement('div');
            indicator.id = 'landonline-db-indicator';
            indicator.style.display = 'none'; // Start hidden
            document.body.appendChild(indicator);
        }
        // An indicator left by an older version has no grip/label; rebuild its contents
        if (!indicator.querySelector('.ldb-label')) {
            indicator.textContent = '';
            const grip = document.createElement('span');
            grip.className = 'ldb-grip';
            grip.textContent = '⋮⋮';
            grip.title = 'Drag to move';
            const label = document.createElement('span');
            label.className = 'ldb-label';
            indicator.append(grip, label);
        }
        return indicator;
    };

    let indicator = createIndicator();
    let lastStatus = null;
    let position = null; // { left, top } in px, or null for the default top-centre

    // Text and class for each status from background.js tabStatus(); null = hidden.
    // Kept short so the pill covers as little of the page as possible; the popup has
    // the details (request counts, failing URL).
    const describe = (status) => {
        switch (status?.status) {
            case 'verified':
                return ['verified', `Connected to Postgres (${status.ok})`];
            case 'pending':
                return ['pending', 'Postgres header ON – waiting for first API request'];
            case 'missing':
                return ['missing', 'NOT on Postgres – reload'];
            case 'unexpected':
                return ['missing', 'Header sent while OFF – reload'];
            default:
                // 'off', no answer, or unknown: show nothing rather than guess
                return null;
        }
    };

    // Keep the pill fully inside the window, so it can never be lost off-screen
    const clamp = (pos) => {
        const maxLeft = Math.max(0, window.innerWidth - indicator.offsetWidth);
        const maxTop = Math.max(0, window.innerHeight - indicator.offsetHeight);
        return {
            left: Math.round(Math.min(Math.max(0, pos.left), maxLeft)),
            top: Math.round(Math.min(Math.max(0, pos.top), maxTop)),
        };
    };

    const applyPosition = () => {
        indicator.classList.toggle('moved', Boolean(position));
        if (!position) {
            indicator.style.left = '';
            indicator.style.top = '';
            return;
        }
        const { left, top } = clamp(position);
        if (indicator.style.left !== `${left}px`) indicator.style.left = `${left}px`;
        if (indicator.style.top !== `${top}px`) indicator.style.top = `${top}px`;
    };

    const render = (status) => {
        lastStatus = status;
        const view = describe(status);
        const display = view ? 'flex' : 'none';
        const className = view ? view[0] : '';
        const text = view ? view[1] : '';
        const label = indicator.querySelector('.ldb-label');
        // Only touch the DOM on change, so the page's own observers aren't woken every poll
        let changed = false;
        if (label.textContent !== text) { label.textContent = text; changed = true; }
        if (indicator.dataset.state !== className) {
            indicator.classList.remove('verified', 'pending', 'missing');
            if (className) indicator.classList.add(className);
            indicator.dataset.state = className;
            changed = true;
        }
        if (indicator.style.display !== display) { indicator.style.display = display; changed = true; }
        // A different label changes the width; keep a moved pill inside the window
        if (changed && position) applyPosition();
    };

    // --- Moving the pill -------------------------------------------------------

    const loadPosition = async () => {
        try {
            const { [POSITIONS_KEY]: positions = {} } = await chrome.storage.local.get(POSITIONS_KEY);
            position = positions[host] || null;
        } catch (error) {
            position = null;
        }
        applyPosition();
    };

    const savePosition = async () => {
        try {
            const { [POSITIONS_KEY]: positions = {} } = await chrome.storage.local.get(POSITIONS_KEY);
            positions[host] = position;
            await chrome.storage.local.set({ [POSITIONS_KEY]: positions });
        } catch (error) {
            console.info('[Landonline-DB] Could not save banner position:', error);
        }
    };

    let drag = null;
    const onPointerDown = (event) => {
        if (!event.target.closest('#landonline-db-indicator .ldb-grip')) return;
        event.preventDefault();
        const rect = indicator.getBoundingClientRect();
        drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top, pointerId: event.pointerId };
        event.target.setPointerCapture(event.pointerId);
        indicator.classList.add('dragging');
    };
    const onPointerMove = (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        position = clamp({ left: event.clientX - drag.dx, top: event.clientY - drag.dy });
        applyPosition();
    };
    const onPointerUp = (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        drag = null;
        indicator.classList.remove('dragging');
        savePosition();
    };
    // Listen on the document (capture), so a recreated indicator keeps working
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointermove', onPointerMove, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('pointercancel', onPointerUp, true);
    window.addEventListener('resize', () => { if (position) applyPosition(); });

    // Position changed elsewhere: another tab on this site, or "Reset banner position"
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes[POSITIONS_KEY] && !drag) {
            position = (changes[POSITIONS_KEY].newValue || {})[host] || null;
            applyPosition();
        }
    });

    // --- Polling ---------------------------------------------------------------

    const poll = async () => {
        if (!isAlive()) {
            // Extension disabled, reloaded or removed: it can no longer vouch for anything
            clearInterval(pollTimer);
            observer.disconnect();
            indicator.remove();
            console.log('[Landonline-DB] Extension unloaded, indicator removed');
            return;
        }
        try {
            render(await chrome.runtime.sendMessage({ type: 'status' }));
        } catch (error) {
            render(null);
        }
    };

    // MutationObserver to handle dynamic page changes
    const observer = new MutationObserver(() => {
        // Recreate indicator if it was removed
        if (!document.getElementById('landonline-db-indicator')) {
            indicator = createIndicator();
            render(lastStatus);
            applyPosition();
        }
    });

    // Start observing the document body for changes
    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    const pollTimer = setInterval(poll, POLL_MS);
    loadPosition().then(poll);

    console.log('[Landonline-DB] Content script initialized');
    return 'initialized';
})();
