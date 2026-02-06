/**
 * Google Photos Clipboard Fix - Content Script v2.0
 *
 * Key fixes:
 * - Pre-fetches image blob on click (instant clipboard write on Cmd+C)
 * - Context menu copies routed through offscreen document (no focus issues)
 * - Grabs pixels from already-loaded on-page images (no CORS issues)
 *
 * Filter console by "GPCF" to see all logs.
 */

(() => {
  const P = '[GPCF]';
  const log = (...a) => console.log(P, ...a);
  const warn = (...a) => console.warn(P, ...a);
  const err = (...a) => console.error(P, ...a);

  log('Content script v2.0 loaded on', window.location.href);

  // --- Cache ---
  let cachedBlob = null;
  let cachedUrl = null;
  let targetImgElement = null; // Store actual DOM element reference

  // ============================================================
  // Find the image element the user is interacting with
  // ============================================================

  function findImageElement(element) {
    let el = element;
    for (let i = 0; i < 15 && el; i++) {
      if (el.tagName === 'IMG' && el.src &&
          (el.src.includes('googleusercontent.com') || el.src.includes('ggpht.com'))) {
        return el;
      }
      el = el.parentElement;
    }

    // Fallback: largest visible Google-hosted image on page
    let best = null, bestArea = 0;
    document.querySelectorAll('img[src*="googleusercontent.com"], img[src*="ggpht.com"]').forEach(img => {
      const r = img.getBoundingClientRect();
      const a = r.width * r.height;
      if (a > bestArea && r.width > 100) { bestArea = a; best = img; }
    });
    return best;
  }

  function getUrlFromElement(imgEl) {
    if (!imgEl?.src) return null;
    return upgradeUrl(imgEl.src);
  }

  function upgradeUrl(url) {
    if (url.includes('=w')) return url.replace(/=w\d+.*$/, '=w2048-h2048-no');
    if (url.includes('=s')) return url.replace(/=s\d+.*$/, '=s2048-no');
    return url.includes('=') ? url : url + '=w2048-h2048-no';
  }

  // ============================================================
  // Image fetching - multiple strategies
  // ============================================================

  /**
   * Method A: Grab pixels directly from on-page <img> element.
   * This is the MOST RELIABLE because the browser already loaded it
   * with proper auth cookies — no CORS issues.
   */
  function grabFromElement(imgEl) {
    return new Promise((resolve, reject) => {
      if (!imgEl || !imgEl.complete || imgEl.naturalWidth === 0) {
        return reject(new Error('Image element not ready'));
      }
      log('Method A: grabbing from on-page <img>', imgEl.naturalWidth, 'x', imgEl.naturalHeight);
      try {
        const c = document.createElement('canvas');
        c.width = imgEl.naturalWidth;
        c.height = imgEl.naturalHeight;
        c.getContext('2d').drawImage(imgEl, 0, 0);
        c.toBlob(b => {
          if (b) { log('  ✓ Method A success:', b.size, 'bytes'); resolve(b); }
          else reject(new Error('toBlob null'));
        }, 'image/png');
      } catch (e) {
        err('  Method A canvas tainted:', e.message);
        reject(e);
      }
    });
  }

  /**
   * Method B: Fetch via background service worker (bypasses CORS).
   */
  function fetchViaBackground(url) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'fetchImage', url }, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!resp) return reject(new Error('No response from background'));
        if (resp.success) {
          log('  Method B: got dataUrl from background, converting...');
          fetch(resp.dataUrl).then(r => r.blob()).then(blob => {
            log('  ✓ Method B success:', blob.size, 'bytes');
            resolve(blob);
          }).catch(reject);
        } else {
          reject(new Error(resp.error));
        }
      });
    });
  }

  /**
   * Method C: Load via new Image with crossOrigin (least likely to work).
   */
  function fetchViaDomCanvas(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          c.getContext('2d').drawImage(img, 0, 0);
          c.toBlob(b => {
            if (b) { log('  ✓ Method C success:', b.size, 'bytes'); resolve(b); }
            else reject(new Error('toBlob null'));
          }, 'image/png');
        } catch (e) { reject(e); }
      };
      img.onerror = () => reject(new Error('Image load failed'));
      img.src = url;
    });
  }

  /**
   * Try all methods in order: A (on-page element) → B (background) → C (DOM canvas)
   */
  async function fetchImageBlob(imgEl, url) {
    log('--- Fetch pipeline ---');

    // Method A: grab from existing element (most reliable)
    if (imgEl) {
      try { return await grabFromElement(imgEl); } catch (e) { warn('Method A failed:', e.message); }
    }

    // Method B: background worker
    if (url) {
      try { return await fetchViaBackground(url); } catch (e) { warn('Method B failed:', e.message); }
    }

    // Method C: DOM canvas with crossOrigin
    if (url) {
      try { return await fetchViaDomCanvas(url); } catch (e) { warn('Method C failed:', e.message); }
    }

    throw new Error('All fetch methods failed');
  }

  /**
   * Ensure blob is PNG.
   */
  async function ensurePng(blob) {
    if (blob.type === 'image/png') return blob;
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext('2d').drawImage(bmp, 0, 0);
    return await c.convertToBlob({ type: 'image/png' });
  }

  // ============================================================
  // Pre-fetch on click
  // ============================================================

  async function prefetch(imgEl, url) {
    if (!imgEl && !url) return;
    if (url === cachedUrl && cachedBlob) return;

    cachedBlob = null;
    cachedUrl = url;
    targetImgElement = imgEl;
    log('Pre-fetching...', url?.substring(0, 100));

    try {
      const blob = await fetchImageBlob(imgEl, url);
      const png = await ensurePng(blob);
      if (cachedUrl === url) {
        cachedBlob = png;
        log('✓ Pre-fetch cached:', png.size, 'bytes');
      }
    } catch (e) {
      err('Pre-fetch failed:', e.message);
    }
  }

  // ============================================================
  // Clipboard write with focus handling
  // ============================================================

  async function writeToClipboard(blob) {
    log('Writing to clipboard:', blob.size, 'bytes, focused:', document.hasFocus());

    // If document isn't focused, try to focus it first
    if (!document.hasFocus()) {
      log('  Document not focused, calling window.focus()...');
      window.focus();
      // Wait a tick for focus to take effect
      await new Promise(r => setTimeout(r, 100));
      log('  After focus attempt, focused:', document.hasFocus());
    }

    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      log('✓ CLIPBOARD WRITE SUCCESS');
      return { ok: true };
    } catch (e) {
      err('✗ CLIPBOARD WRITE FAILED:', e.name, e.message);
      return { ok: false, error: `${e.name}: ${e.message}` };
    }
  }

  /**
   * Promise-based clipboard write (Chrome 97+).
   * Passes a Promise to ClipboardItem so the browser keeps the gesture window open.
   */
  async function writeWithPromise(imgEl, url) {
    log('Trying Promise-based clipboard write...');
    try {
      const item = new ClipboardItem({
        'image/png': (async () => {
          const blob = await fetchImageBlob(imgEl, url);
          return await ensurePng(blob);
        })()
      });
      await navigator.clipboard.write([item]);
      log('✓ CLIPBOARD WRITE (Promise) SUCCESS');
      return { ok: true };
    } catch (e) {
      err('✗ CLIPBOARD WRITE (Promise) FAILED:', e.name, e.message);
      return { ok: false, error: `${e.name}: ${e.message}` };
    }
  }

  // ============================================================
  // Toast
  // ============================================================

  function showToast(msg, isError = false) {
    const old = document.getElementById('gpcf-toast');
    if (old) old.remove();
    const t = document.createElement('div');
    t.id = 'gpcf-toast';
    t.textContent = msg;
    Object.assign(t.style, {
      position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)',
      background: isError ? '#d93025' : '#1a73e8', color: '#fff',
      padding: '10px 24px', borderRadius: '8px', fontSize: '14px',
      fontFamily: 'Google Sans, Roboto, Arial, sans-serif',
      zIndex: '999999', boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
      transition: 'opacity 0.3s ease', opacity: '1',
    });
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 400); }, 3000);
  }

  // ============================================================
  // Event listeners
  // ============================================================

  // Pre-fetch on any interaction with an image
  function onInteract(e) {
    const imgEl = findImageElement(e.target);
    if (imgEl) {
      const url = getUrlFromElement(imgEl);
      prefetch(imgEl, url);
    }
  }

  document.addEventListener('mousedown', onInteract, true);
  document.addEventListener('click', onInteract, true);
  document.addEventListener('contextmenu', onInteract, true);

  // Pre-fetch when navigating to a new photo
  let lastPath = location.pathname;
  new MutationObserver(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      setTimeout(() => {
        const imgEl = findImageElement(document.body);
        if (imgEl) prefetch(imgEl, getUrlFromElement(imgEl));
      }, 800);
    }
  }).observe(document.body, { childList: true, subtree: true });

  // --- Cmd+C handler ---
  document.addEventListener('keydown', async (e) => {
    if (!((e.ctrlKey || e.metaKey) && e.key === 'c')) return;
    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    log('');
    log('======= Cmd+C =======');

    // Try cached blob first (instant, within user gesture)
    if (cachedBlob) {
      log('Using cached blob');
      const result = await writeToClipboard(cachedBlob);
      showToast(result.ok ? '✓ Image copied!' : `✗ ${result.error}`, !result.ok);
      return;
    }

    // Try Promise-based write
    const imgEl = targetImgElement || findImageElement(document.activeElement);
    const url = cachedUrl || getUrlFromElement(imgEl);

    if (!url && !imgEl) {
      showToast('✗ No image found — click a photo first', true);
      return;
    }

    showToast('⏳ Fetching image…');
    const result = await writeWithPromise(imgEl, url);
    showToast(result.ok ? '✓ Image copied!' : `✗ ${result.error}`, !result.ok);
  }, true);

  // --- Context menu handler ---
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action !== 'copyImageFromContextMenu') return;

    log('');
    log('======= Context Menu Copy =======');
    log('Document focused:', document.hasFocus());

    (async () => {
      // Wait for document to regain focus after context menu closes.
      // Poll every 50ms instead of a fixed delay — this is reliable
      // regardless of how long the context menu takes to dismiss.
      if (!document.hasFocus()) {
        log('  Waiting for focus...');
        const focused = await new Promise((resolve) => {
          const start = Date.now();
          const check = setInterval(() => {
            if (document.hasFocus()) {
              clearInterval(check);
              resolve(true);
            } else if (Date.now() - start > 2000) {
              clearInterval(check);
              resolve(false);
            }
          }, 50);
        });
        log('  Focus wait result:', focused, 'hasFocus:', document.hasFocus());
        if (!focused) {
          showToast('✗ Page lost focus — try refreshing the page and retry', true);
          sendResponse({ ok: false });
          return;
        }
      }

      try {
        let blob = cachedBlob;
        if (!blob) {
          log('No cached blob, fetching...');
          const imgEl = targetImgElement || findImageElement(document.body);
          const url = cachedUrl || getUrlFromElement(imgEl) || message.srcUrl;
          blob = await fetchImageBlob(imgEl, url);
          blob = await ensurePng(blob);
        }

        const result = await writeToClipboard(blob);
        showToast(result.ok ? '✓ Image copied!' : `✗ ${result.error}`, !result.ok);
        sendResponse({ ok: result.ok });
      } catch (ex) {
        err('Context menu copy failed:', ex);
        showToast(`✗ ${ex.message}`, true);
        sendResponse({ ok: false });
      }
    })();

    return true;
  });

  log('✓ Extension ready');
  log('  1. Click/view a photo (pre-fetches the image)');
  log('  2. Cmd+C or right-click → "Copy image for pasting"');
  log('  Filter console by "GPCF" to see logs');
})();
