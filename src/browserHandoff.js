export const browserHandoffDismissedKey = 'ppa-browser-handoff-dismissed';

const facebookMarkers = /(?:FBAN|FBAV|FB_IAB|MessengerForiOS)/i;
const privateQueryName = /(?:^|[_-])(?:name|email|phone|mobile|tracking|receipt|token|key|secret|auth)(?:$|[_-])/i;

export function detectFacebookInAppBrowser(userAgent = '') {
  const value = String(userAgent ?? '');
  const isFacebookInAppBrowser = facebookMarkers.test(value);
  const isAndroid = /Android/i.test(value);
  const isIOS = /iPhone|iPad|iPod/i.test(value);
  return {
    isFacebookInAppBrowser,
    platform: isAndroid ? 'android' : (isIOS ? 'ios' : 'other'),
  };
}

export function getSafeCurrentHttpsUrl(locationLike) {
  try {
    const url = new URL(locationLike?.href || String(locationLike || ''));
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if ([...url.searchParams.keys()].some((name) => privateQueryName.test(name))) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function shouldShowBrowserHandoff({ userAgent = '', sessionStorage } = {}) {
  if (!detectFacebookInAppBrowser(userAgent).isFacebookInAppBrowser) return false;
  try {
    return sessionStorage?.getItem(browserHandoffDismissedKey) !== '1';
  } catch {
    return true;
  }
}

export function dismissBrowserHandoff(sessionStorage) {
  try {
    sessionStorage?.setItem(browserHandoffDismissedKey, '1');
  } catch {
    // Guidance remains dismissible even when storage is unavailable.
  }
}

export function restoreBrowserHandoff(sessionStorage) {
  try {
    sessionStorage?.removeItem(browserHandoffDismissedKey);
  } catch {
    // An unavailable store must not prevent the customer from continuing.
  }
}

export async function copyTextWithFallback(text, { clipboard, document: documentLike } = {}) {
  if (!text) return false;
  try {
    if (clipboard?.writeText) {
      await clipboard.writeText(text);
      return true;
    }
  } catch {
    // Continue to the legacy, user-initiated copy fallback.
  }
  if (!documentLike?.body || typeof documentLike.execCommand !== 'function') return false;
  const textarea = documentLike.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  documentLike.body.appendChild(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = Boolean(documentLike.execCommand('copy'));
  } catch {
    copied = false;
  } finally {
    textarea.remove();
  }
  return copied;
}

export function createAndroidBrowserIntent(httpsUrl) {
  const safeUrl = getSafeCurrentHttpsUrl(httpsUrl);
  if (!safeUrl) return null;
  const url = new URL(safeUrl);
  // Android intent URI syntax reserves the fragment for #Intent metadata.
  // Use ordinary HTTPS when a real page fragment must be retained.
  if (url.hash) return null;
  const target = `${url.host}${url.pathname}${url.search}`;
  return `intent://${target}#Intent;scheme=https;action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;S.browser_fallback_url=${encodeURIComponent(safeUrl)};end`;
}

export function openExternalBrowser({ url, platform, location: locationLike, document: documentLike, openWindow, setTimer = setTimeout }) {
  const safeUrl = getSafeCurrentHttpsUrl(url);
  if (!safeUrl) return { attempted: false, method: null, fallbackUrl: null };

  // iOS Facebook and Messenger do not expose a reliable, documented way for a
  // webpage to launch Safari. The UI uses a copy-only flow on these platforms;
  // keep this guard so future callers cannot accidentally attempt navigation.
  if (platform === 'ios') return { attempted: false, method: null, fallbackUrl: safeUrl };

  if (platform === 'android') {
    const intentUrl = createAndroidBrowserIntent(safeUrl);
    if (intentUrl) {
      try {
        locationLike?.assign?.(intentUrl);
        setTimer(() => {
          if (!documentLike?.hidden) {
            try { locationLike?.assign?.(safeUrl); } catch { /* Keep the current page available. */ }
          }
        }, 900);
        return { attempted: true, method: 'android-intent', fallbackUrl: safeUrl };
      } catch {
        // Fall through to the normal HTTPS attempt.
      }
    }
  }

  try {
    if (typeof openWindow !== 'function') return { attempted: false, method: null, fallbackUrl: safeUrl };
    openWindow(safeUrl, '_blank', 'noopener,noreferrer');
    return { attempted: true, method: 'https', fallbackUrl: safeUrl };
  } catch {
    return { attempted: false, method: null, fallbackUrl: safeUrl };
  }
}
