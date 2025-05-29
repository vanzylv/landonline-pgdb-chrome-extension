document.addEventListener('DOMContentLoaded', () => {
    const toggleSwitch = document.getElementById('toggle-switch');
    const statusText = document.getElementById('status-text');

    // Load current state
    chrome.storage.local.get('isEnabled', (data) => {
        const isEnabled = data.isEnabled || false;
        toggleSwitch.checked = isEnabled;
        statusText.textContent = isEnabled ? 'ON' : 'OFF';
        statusText.style.color = isEnabled ? '#4CAF50' : '#f44336';
    });

    // Handle toggle
    toggleSwitch.addEventListener('change', () => {
        const isEnabled = toggleSwitch.checked;
        chrome.storage.local.set({ isEnabled });
        statusText.textContent = isEnabled ? 'ON' : 'OFF';
        statusText.style.color = isEnabled ? '#4CAF50' : '#f44336';

        // Send message to background script
        chrome.runtime.sendMessage({ action: 'toggle', isEnabled });
    });
});