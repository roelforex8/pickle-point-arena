import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const appSource = await readFile(new URL('./App.jsx', import.meta.url), 'utf8');
const stylesSource = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
const promptSource = await readFile(new URL('./InAppBrowserHandoff.jsx', import.meta.url), 'utf8');
const pickerSource = await readFile(new URL('./ReceiptFilePicker.jsx', import.meta.url), 'utf8');
const bpiQr = await readFile(new URL('../public/bpi-qr.png', import.meta.url));

test('User-Agent detection is presentation-only and public prompt rendering is conditional', () => {
  assert.match(appSource, /shouldShowBrowserHandoff/);
  assert.match(appSource, /showBrowserHandoff && <BrowserHandoffPrompt/);
  assert.doesNotMatch(appSource, /Authorization[^\n]+userAgent|userAgent[^\n]+Authorization/);
  assert.doesNotMatch(promptSource, /fetch\(|supabase|Authorization|pricing|availability/);
});

test('dialog has an accessible name, description, modal semantics, focus trap, and Escape close', () => {
  assert.match(promptSource, /role="dialog" aria-modal="true" aria-labelledby="browser-handoff-title" aria-describedby="browser-handoff-description"/);
  assert.match(promptSource, /event\.key === 'Escape'/);
  assert.match(promptSource, /event\.key !== 'Tab'/);
  assert.match(promptSource, /first\.focus\(\)|last\.focus\(\)/);
});

test('iPhone uses copy-only Safari guidance while Android retains the customer-triggered external action', () => {
  assert.match(promptSource, /platform === 'ios'[\s\S]+onClick=\{copyForSafari\}>Copy link for Safari/);
  assert.match(promptSource, /: <button type="button" className="primary" onClick=\{open\}>Open in browser/);
  assert.match(promptSource, /onClick=\{\(\) => copy\(\)\}>Copy link/);
  assert.match(promptSource, /Continue in Messenger/);
  const effectSource = promptSource.slice(promptSource.indexOf('useEffect(() =>'), promptSource.indexOf('const open = () =>'));
  assert.doesNotMatch(effectSource, /openExternalBrowser|location\.assign|window\.open/);
});

test('iOS copy confirmation and failure provide accurate manual Safari instructions', () => {
  assert.match(promptSource, /Link copied\. Open Safari, tap the address bar, paste the link, then tap Go\./);
  assert.match(promptSource, /Copy was unavailable\. Copy this page address manually, then open Safari, paste it into the address bar, and tap Go\./);
  assert.match(promptSource, /You can also tap the ••• menu in Messenger and choose Open in browser, if available\./);
  assert.doesNotMatch(promptSource, /force Safari|x-safari|safari-http/i);
});

test('booking-continuity guidance does not promise restoration', () => {
  assert.match(promptSource, /payment step cannot be restored from this link/);
  assert.match(promptSource, /Track my booking/);
});

test('picker remains enabled, accepts the established formats, and supports remove and same-file reselection', () => {
  assert.match(pickerSource, /type="file"/);
  assert.doesNotMatch(pickerSource, /disabled=/);
  assert.match(pickerSource, /accept=\{receiptFileAccept\}/);
  assert.match(pickerSource, /event\.currentTarget\.value = ''/);
  assert.match(pickerSource, /Remove selected file/);
  assert.match(pickerSource, /inputRef\.current\.value = ''/);
});

test('both customer upload paths retain validation and expose removal without changing upload submission', () => {
  assert.equal((appSource.match(/<ReceiptFilePicker/g) || []).length, 2);
  assert.equal((appSource.match(/validateReceiptFile\(file\)/g) || []).length >= 2, true);
  assert.match(appSource, /if \(!paymentReady \|\| bookingSubmitting\) return;/);
  assert.match(appSource, /disabled=\{!paymentReady \|\| bookingSubmitting\}/);
  assert.match(appSource, /disabled=\{proofSubmitting \|\| !receiptFile\}/);
});

test('BPI renders conditionally and shares the existing pending receipt workflow', () => {
  assert.match(appSource, /<strong>GCash<\/strong><small>Available now<\/small>[\s\S]+<strong>Maya<\/strong><small>Coming soon<\/small>[\s\S]+<strong>Metrobank<\/strong><small>Coming soon<\/small>[\s\S]+<strong>BPI<\/strong><small>Available now<\/small>/);
  assert.match(appSource, /<strong>BPI<\/strong><small>Available now<\/small>/);
  assert.match(appSource, /<button type="button" disabled><strong>Maya/);
  assert.match(appSource, /<button type="button" disabled><strong>Metrobank/);
  assert.match(appSource, /selectedPaymentMethod === 'bpi'/);
  assert.match(appSource, /src="\/bpi-qr\.png"/);
  assert.match(appSource, /src="\/gcash-qr-hd\.png"/);
  assert.match(appSource, /Scan the BPI QR code to pay/);
  assert.match(appSource, /paymentMethod: selectedPaymentMethod/);
  assert.match(stylesSource, /\.payment-tabs \{[^}]*grid-template-columns: repeat\(4, 1fr\)/);
  assert.ok(bpiQr.length > 0);
  assert.doesNotMatch(appSource, /setCheckoutStage\(['"](?:confirmed|verified|paid)['"]\)/);
});

test('payment preparation occurs only inside explicit submit handlers', () => {
  const calls = [...appSource.matchAll(/uploadPaymentProof\(/g)].map((match) => match.index);
  assert.equal(calls.length, 3);
  assert.ok(appSource.indexOf('const submitPaymentProof = async') < calls[1]);
  assert.ok(appSource.indexOf('const continuePayment = async') < calls[2]);
  assert.doesNotMatch(pickerSource, /fetch\(|\/api\/payments|supabase/);
});

test('isolated worktree excludes Priority #3 UI changes', () => {
  assert.doesNotMatch(appSource, /bookingProtection|acquireSubmissionGuard|customerSlotTotal|bookingConflictMessage/);
});
