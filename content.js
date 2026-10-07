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

    // Create the visual indicator element
    const createIndicator = () => {
        const existingIndicator = document.getElementById('landonline-db-indicator');
        if (existingIndicator) {
            return existingIndicator;
        }

        const indicator = document.createElement('div');
        indicator.id = 'landonline-db-indicator';
        indicator.style.display = 'none'; // Start hidden
        document.body.appendChild(indicator);
        return indicator;
    };

    let indicator = createIndicator();
    let lastStatus = null;

    const plural = (n) => `${n} API request${n === 1 ? '' : 's'}`;

    // Text and class for each status from background.js tabStatus(); null = hidden
    const describe = (status) => {
        switch (status?.status) {
            case 'verified':
                return ['verified', `Connected to Postgres – header verified on ${plural(status.ok)}`];
            case 'pending':
                return ['pending', 'Postgres header ON – waiting for first API request'];
            case 'missing':
                return ['missing', `NOT on Postgres – header missing on ${plural(status.wrong)} (last: ${status.url})`];
            case 'unexpected':
                return ['missing', `Header OFF but still sent on ${plural(status.wrong)} (last: ${status.url})`];
            default:
                // 'off', no answer, or unknown: show nothing rather than guess
                return null;
        }
    };

    const render = (status) => {
        lastStatus = status;
        const view = describe(status);
        const display = view ? 'block' : 'none';
        const className = view ? view[0] : '';
        const text = view ? view[1] : '';
        // Only touch the DOM on change, so the page's own observers aren't woken every poll
        if (indicator.textContent !== text) indicator.textContent = text;
        if (indicator.className !== className) indicator.className = className;
        if (indicator.style.display !== display) indicator.style.display = display;
    };

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
        }
    });

    // Start observing the document body for changes
    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    const pollTimer = setInterval(poll, POLL_MS);
    poll();

    console.log('[Landonline-DB] Content script initialized');
    return 'initialized';
})();
