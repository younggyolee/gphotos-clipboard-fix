/**
 * Google Photos Clipboard Fix - Background Service Worker
 * 
 * Fetches images on behalf of content script (bypasses CORS).
 * Filter by "GPCF BG" in the Service Worker console.
 */

const P = '[GPCF BG]';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'gphotos-copy-image',
    title: 'Copy image for pasting',
    contexts: ['image', 'page'],
    documentUrlPatterns: ['https://photos.google.com/*']
  });
  console.log(P, 'Installed, context menu created');
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'gphotos-copy-image' && tab?.id) {
    chrome.tabs.sendMessage(tab.id, {
      action: 'copyImageFromContextMenu',
      srcUrl: info.srcUrl || null
    });
  }
});

// Fetch image and return as data URL
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action !== 'fetchImage' || !msg.url) return;

  const url = msg.url;
  console.log(P, 'Fetch request:', url.substring(0, 120));

  (async () => {
    try {
      let resp;
      try {
        resp = await fetch(url, { credentials: 'include' });
      } catch (e1) {
        console.warn(P, 'Fetch with credentials failed, trying without:', e1.message);
        resp = await fetch(url);
      }

      console.log(P, 'Status:', resp.status, 'Type:', resp.headers.get('content-type'));

      if (!resp.ok) {
        if (resp.status === 403) {
          console.warn(P, '403 - trying URL variant...');
          const altUrl = url.replace(/-no-gm/, '-no');
          const resp2 = await fetch(altUrl, { credentials: 'include' });
          if (resp2.ok) resp = resp2;
          else throw new Error('HTTP 403 on both URL variants');
        } else {
          throw new Error(`HTTP ${resp.status}`);
        }
      }

      const blob = await resp.blob();
      console.log(P, 'Blob:', blob.size, 'bytes,', blob.type);

      const reader = new FileReader();
      reader.onloadend = () => {
        console.log(P, '✓ DataURL ready, length:', reader.result?.length);
        sendResponse({ success: true, dataUrl: reader.result });
      };
      reader.onerror = () => sendResponse({ success: false, error: 'FileReader error' });
      reader.readAsDataURL(blob);
    } catch (e) {
      console.error(P, '✗ Fetch failed:', e.message);
      sendResponse({ success: false, error: e.message });
    }
  })();

  return true;
});
