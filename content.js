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
        indicator.textContent = 'Connected to Postgres';
        indicator.style.display = 'none'; // Start hidden
        document.body.appendChild(indicator);
        return indicator;
    };

    // Initialize the indicator
    let indicator = createIndicator();

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

    // Follow the same stored state the background uses for the header rule
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.isEnabled) {
            handleStateUpdate(changes.isEnabled.newValue || false);
        }
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
            indicator = createIndicator();
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