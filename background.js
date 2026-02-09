chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'download') {
    const blob = new Blob([message.markdown], { type: 'text/plain;charset=utf-8' });
    const reader = new FileReader();
    reader.onloadend = () => {
      chrome.downloads.download({
        url: reader.result,
        filename: message.filename,
        saveAs: false
      }, (downloadId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, downloadId });
        }
      });
    };
    reader.readAsDataURL(blob);
    return true; // keep message channel open for async response
  }
});
