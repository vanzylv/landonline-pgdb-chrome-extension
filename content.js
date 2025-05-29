// content.js - Complete implementation
(function() {
    // Early exit if not on a valid web page
    if (!window.location.protocol.match(/^https?:/)) {
        console.log('[Landonline-DB] Skipping non-HTTP(S) page:', window.location.href);
        return;
    }

    // Create the visual indicator element
    const createIndicator = () => {
        const existingIndicator = document.getElementById('landonline-db-indicator');
        if (existingIndicator) {
            return existingIndicator;
        }

        const indicator = document.createElement('div');
        indicator.id = 'landonline-db-indicator';
        indicator.textContent = 'You are now connecting to postgres';
        indicator.style.display = 'none'; // Start hidden
        document.body.appendChild(indicator);
        return indicator;
    };

    // Initialize the indicator
    const indicator = createIndicator();

    // Handle state updates from background
    const handleStateUpdate = (isEnabled) => {
        console.log(`[Landonline-DB] Setting indicator to ${isEnabled ? 'ON' : 'OFF'}`);
        indicator.style.display = isEnabled ? 'block' : 'none';

        // Optional: Add visual feedback when state changes
        if (isEnabled) {
            indicator.classList.add('active');
            indicator.classList.remove('inactive');
        } else {
            indicator.classList.add('inactive');
            indicator.classList.remove('active');
        }
    };

    // Message listener for state changes
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.hasOwnProperty('isEnabled')) {
            handleStateUpdate(message.isEnabled);
            sendResponse({ success: true });
        }
        return true; // Keep message channel open for sendResponse
    });

    // Get initial state
    chrome.storage.local.get('isEnabled', (data) => {
        const isEnabled = data.isEnabled || false;
        handleStateUpdate(isEnabled);
    });

    // MutationObserver to handle dynamic page changes
    const observer = new MutationObserver((mutations) => {
        // Recreate indicator if it was removed
        if (!document.getElementById('landonline-db-indicator')) {
            const newIndicator = createIndicator();
            chrome.storage.local.get('isEnabled', (data) => {
                handleStateUpdate(data.isEnabled || false);
            });
        }
    });

    // Start observing the document body for changes
    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    console.log('[Landonline-DB] Content script initialized');
})();