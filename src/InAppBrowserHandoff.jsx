import { useEffect, useRef, useState } from 'react';
import {
  copyTextWithFallback,
  dismissBrowserHandoff,
  getSafeCurrentHttpsUrl,
  openExternalBrowser,
  restoreBrowserHandoff,
} from './browserHandoff';

export function PlatformBrowserInstructions({ platform }) {
  if (platform === 'ios') return <p>You can also tap the ••• menu in Messenger and choose Open in browser, if available.</p>;
  if (platform === 'android') return <p>Tap Open in browser, or use the ••• menu and choose Open in Chrome or Open in external browser.</p>;
  return <p>Use the Facebook or Messenger menu and choose Open in browser.</p>;
}

function useBookingLinkCopy() {
  const [message, setMessage] = useState('');
  const copy = async ({ successMessage, failureMessage } = {}) => {
    const url = getSafeCurrentHttpsUrl(window.location);
    const copied = await copyTextWithFallback(url, { clipboard: navigator.clipboard, document });
    setMessage(copied
      ? (successMessage || 'Booking link copied. You can paste it into Safari or Chrome.')
      : (failureMessage || 'Copy was unavailable. Use the ••• menu and choose Open in browser, if available.'));
    return copied;
  };
  return { copy, message, setMessage };
}

export function BrowserHandoffPrompt({ platform, onDismiss }) {
  const panelRef = useRef(null);
  const previousFocusRef = useRef(null);
  const { copy, message, setMessage } = useBookingLinkCopy();

  useEffect(() => {
    previousFocusRef.current = document.activeElement;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const panel = panelRef.current;
    const focusable = () => [...(panel?.querySelectorAll('button') || [])].filter((element) => !element.disabled);
    focusable()[0]?.focus();
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onDismiss();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = priorOverflow;
      document.removeEventListener('keydown', onKeyDown);
      previousFocusRef.current?.focus?.();
    };
  }, [onDismiss]);

  const open = () => {
    const url = getSafeCurrentHttpsUrl(window.location);
    dismissBrowserHandoff(window.sessionStorage);
    const result = openExternalBrowser({
      url,
      platform,
      location: window.location,
      document,
      openWindow: window.open.bind(window),
      setTimer: window.setTimeout.bind(window),
    });
    if (result.attempted) onDismiss();
    else {
      restoreBrowserHandoff(window.sessionStorage);
      setMessage('This browser could not open the link automatically. Use the ••• menu and choose Open in browser.');
    }
  };

  const copyForSafari = () => copy({
    successMessage: 'Link copied. Open Safari, tap the address bar, paste the link, then tap Go.',
    failureMessage: 'Copy was unavailable. Copy this page address manually, then open Safari, paste it into the address bar, and tap Go. You can also use the ••• menu in Messenger and choose Open in browser, if available.',
  });

  const continueHere = () => {
    dismissBrowserHandoff(window.sessionStorage);
    onDismiss();
  };

  return <div className="browser-handoff-backdrop" role="presentation">
    <section className="browser-handoff-dialog" ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="browser-handoff-title" aria-describedby="browser-handoff-description">
      <span className="browser-handoff-kicker">PICKLE POINT ARENA</span>
      <h2 id="browser-handoff-title">For easier receipt uploading</h2>
      <p id="browser-handoff-description">{platform === 'ios'
        ? 'You’re viewing the booking portal inside Facebook or Messenger. Copy this safe link and paste it into Safari so you can select your payment receipt without problems.'
        : 'You’re viewing the booking portal inside Facebook or Messenger. Open it in your browser so you can select your payment receipt without problems.'}</p>
      <div className="browser-handoff-instructions"><PlatformBrowserInstructions platform={platform} /></div>
      <div className="browser-handoff-actions">
        {platform === 'ios'
          ? <button type="button" className="primary" onClick={copyForSafari}>Copy link for Safari</button>
          : <button type="button" className="primary" onClick={open}>Open in browser</button>}
        <button type="button" className="secondary" onClick={() => copy()}>Copy link</button>
        <button type="button" className="browser-handoff-continue" onClick={continueHere}>Continue in Messenger</button>
      </div>
      {message && <p className="browser-handoff-status" role="status">{message}</p>}
    </section>
  </div>;
}

export function ReceiptBrowserReminder({ platform }) {
  const { copy, message } = useBookingLinkCopy();
  return <aside className="receipt-browser-reminder" aria-label="Help opening the booking portal outside Messenger">
    <strong>Can’t select your receipt?</strong>
    <p>Save it to Photos or Files, then open this page in Safari or Chrome.</p>
    <p>Your payment step cannot be restored from this link. Open the main portal externally, choose <b>Track my booking</b>, and use your existing email address or tracking number.</p>
    <PlatformBrowserInstructions platform={platform} />
    <button type="button" onClick={() => copy()}>Copy link</button>
    {message && <span role="status">{message}</span>}
  </aside>;
}
