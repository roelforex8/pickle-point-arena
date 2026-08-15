import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserHandoffDismissedKey,
  copyTextWithFallback,
  createAndroidBrowserIntent,
  detectFacebookInAppBrowser,
  dismissBrowserHandoff,
  getSafeCurrentHttpsUrl,
  openExternalBrowser,
  shouldShowBrowserHandoff,
} from './browserHandoff.js';

const userAgents = {
  iphoneFacebook: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 [FBAN/FBIOS;FBAV/510.0]',
  iphoneMessenger: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 [FBAN/MessengerForiOS;FBAV/510.0]',
  androidFacebook: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 [FB_IAB/FB4A;FBAV/510.0]',
  androidMessenger: 'Mozilla/5.0 (Linux; Android 14) [FBAN/EMA;FBAV/500.0]',
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1',
  androidChrome: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/138.0 Mobile Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36 SamsungBrowser/27.0',
  edge: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36 EdgA/130.0',
  firefox: 'Mozilla/5.0 (Android 14; Mobile; rv:128.0) Gecko/128.0 Firefox/128.0',
  desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138.0 Safari/537.36',
};

test('iPhone and Android Facebook/Messenger markers are detected and platform-classified', () => {
  assert.deepEqual(detectFacebookInAppBrowser(userAgents.iphoneFacebook), { isFacebookInAppBrowser: true, platform: 'ios' });
  assert.deepEqual(detectFacebookInAppBrowser(userAgents.iphoneMessenger), { isFacebookInAppBrowser: true, platform: 'ios' });
  assert.deepEqual(detectFacebookInAppBrowser(userAgents.androidFacebook), { isFacebookInAppBrowser: true, platform: 'android' });
  assert.deepEqual(detectFacebookInAppBrowser(userAgents.androidMessenger), { isFacebookInAppBrowser: true, platform: 'android' });
});

test('Safari, Chrome, Samsung Internet, Edge, Firefox, and ordinary desktop browsers are not detected', () => {
  for (const userAgent of [userAgents.iphoneSafari, userAgents.androidChrome, userAgents.samsung, userAgents.edge, userAgents.firefox, userAgents.desktop]) {
    assert.equal(detectFacebookInAppBrowser(userAgent).isFacebookInAppBrowser, false, userAgent);
  }
});

test('missing, empty, long, mixed-case, and malformed User-Agent values are handled safely', () => {
  for (const userAgent of [undefined, null, '', 'not a browser', {}, 42]) {
    assert.equal(detectFacebookInAppBrowser(userAgent).isFacebookInAppBrowser, false);
  }
  assert.equal(detectFacebookInAppBrowser(`${'x'.repeat(100000)}fBaV/1`).isFacebookInAppBrowser, true);
  assert.equal(detectFacebookInAppBrowser('mozilla android [fb_iab/fb4a]').platform, 'android');
});

test('dismissal is session-only, idempotent, and repeated checks stay dismissed', () => {
  const values = new Map();
  const sessionStorage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  assert.equal(shouldShowBrowserHandoff({ userAgent: userAgents.iphoneMessenger, sessionStorage }), true);
  dismissBrowserHandoff(sessionStorage);
  dismissBrowserHandoff(sessionStorage);
  assert.equal(values.get(browserHandoffDismissedKey), '1');
  assert.equal(shouldShowBrowserHandoff({ userAgent: userAgents.iphoneMessenger, sessionStorage }), false);
  assert.equal(shouldShowBrowserHandoff({ userAgent: userAgents.iphoneSafari, sessionStorage: null }), false);
});

test('safe HTTPS URLs preserve path, query, hash, and their combination exactly', () => {
  for (const url of [
    'https://picklepointarena.com/book?source=facebook',
    'https://picklepointarena.com/book#receipt',
    'https://picklepointarena.com/book?source=facebook&campaign=summer#receipt',
  ]) assert.equal(getSafeCurrentHttpsUrl(url), url);
});

test('unsafe schemes, credentials, malformed URLs, and private query fields are rejected', () => {
  for (const url of [
    'http://picklepointarena.com/',
    'javascript:alert(1)',
    'https://user:pass@picklepointarena.com/',
    'not a url',
    'https://picklepointarena.com/?customer_email=a%40b.com',
    'https://picklepointarena.com/?tracking_number=PPA-123',
    'https://picklepointarena.com/?access_token=secret',
    'https://picklepointarena.com/?receipt_path=private/file.png',
  ]) assert.equal(getSafeCurrentHttpsUrl(url), null, url);
});

test('Clipboard API copies only the supplied safe URL', async () => {
  let copied = '';
  const url = getSafeCurrentHttpsUrl('https://picklepointarena.com/book?source=facebook#receipt');
  assert.equal(await copyTextWithFallback(url, { clipboard: { writeText: async (value) => { copied = value; } } }), true);
  assert.equal(copied, url);
  assert.doesNotMatch(copied, /name=|email=|phone=|mobile=|tracking=|receipt=|token=|key=/i);
});

test('blocked Clipboard API uses the sanitized textarea fallback and removes it', async () => {
  const events = [];
  const textarea = { value: '', style: {}, setAttribute: (...args) => events.push(['attribute', ...args]), select: () => events.push(['select']), remove: () => events.push(['remove']) };
  const document = { body: { appendChild: (node) => events.push(['append', node.value]) }, createElement: () => textarea, execCommand: (command) => { events.push(['command', command]); return true; } };
  const copied = await copyTextWithFallback('https://picklepointarena.com/', { clipboard: { writeText: async () => { throw new Error('blocked'); } }, document });
  assert.equal(copied, true);
  assert.deepEqual(events.at(-1), ['remove']);
  assert.ok(events.some((event) => event[0] === 'command' && event[1] === 'copy'));
});

test('clipboard failure is safe when both APIs are unavailable or throw', async () => {
  assert.equal(await copyTextWithFallback('https://picklepointarena.com/', {}), false);
  const textarea = { value: '', style: {}, setAttribute() {}, select() {}, remove() {} };
  const document = { body: { appendChild() {} }, createElement: () => textarea, execCommand: () => { throw new Error('blocked'); } };
  assert.equal(await copyTextWithFallback('https://picklepointarena.com/', { document }), false);
});

test('Android intent is generic, tap-driven by caller, and contains a normal exact HTTPS fallback', () => {
  const assignments = [];
  const timers = [];
  const url = 'https://picklepointarena.com/booking?source=facebook';
  const result = openExternalBrowser({ url, platform: 'android', location: { assign: (value) => assignments.push(value) }, document: { hidden: false }, setTimer: (callback) => timers.push(callback) });
  assert.equal(result.method, 'android-intent');
  assert.doesNotMatch(assignments[0], /package=com\.android\.chrome/);
  assert.match(assignments[0], new RegExp(`browser_fallback_url=${encodeURIComponent(url)}`));
  assert.equal(assignments.length, 1);
  timers[0]();
  assert.deepEqual(assignments.slice(1), [url]);
});

test('Android URLs with hashes use normal HTTPS so the hash is preserved', () => {
  const opened = [];
  const url = 'https://picklepointarena.com/booking?source=facebook#receipt';
  assert.equal(createAndroidBrowserIntent(url), null);
  const result = openExternalBrowser({ url, platform: 'android', openWindow: (...args) => opened.push(args) });
  assert.equal(result.method, 'https');
  assert.equal(opened[0][0], url);
});

test('iPhone and iPad never attempt automatic external navigation', () => {
  let openCalls = 0;
  let assignCalls = 0;
  const url = 'https://picklepointarena.com/booking?source=facebook';
  const result = openExternalBrowser({
    url,
    platform: 'ios',
    location: { assign: () => { assignCalls += 1; } },
    openWindow: () => { openCalls += 1; },
  });
  assert.deepEqual(result, { attempted: false, method: null, fallbackUrl: url });
  assert.equal(openCalls, 0);
  assert.equal(assignCalls, 0);
});

test('intent failure falls back to HTTPS and complete external-open failure is reported', () => {
  const opened = [];
  const fallback = openExternalBrowser({
    url: 'https://picklepointarena.com/', platform: 'android',
    location: { assign: () => { throw new Error('no intent handler'); } },
    openWindow: (...args) => opened.push(args),
  });
  assert.equal(fallback.method, 'https');
  assert.equal(opened[0][0], 'https://picklepointarena.com/');
  const failed = openExternalBrowser({ url: 'https://picklepointarena.com/', platform: 'other', openWindow: () => { throw new Error('blocked'); } });
  assert.deepEqual(failed, { attempted: false, method: null, fallbackUrl: 'https://picklepointarena.com/' });
});
