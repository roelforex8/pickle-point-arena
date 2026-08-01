import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from './supabase';

const courtNames = ['Court 1', 'Court 2', 'Court 3', 'Court 4', 'Court 5', 'Court 6'];
const courtGalleryPhotos = [
  {
    src: '/arena-covered-courts-v1.png?v=20260801',
    alt: 'Covered indoor pickleball courts beneath the steel-truss roof at Pickle Point Arena',
    label: 'INDOOR COURTS',
    title: 'Covered courts',
  },
  {
    src: '/arena-overview-vertical-v1.png?v=20260801',
    alt: 'Vertical architectural overview of Pickle Point Arena showing Courts 1 through 6, Court 5 rotated at the right, the player seating area, and the branded arena wall',
    label: 'ARENA OVERVIEW',
    fit: 'contain',
    title: 'Courts 1–6 overview',
  },
  {
    src: '/court-action-wide-v1.png?v=20260801',
    alt: 'Three players enjoying a pickleball game on Court 3 in front of the Pickle Point Arena service window and branded wall',
    label: 'COURT 3 · ACTION VIEW',
    title: 'Play at Court 3',
  },
  {
    src: '/court-four-amenities-v1.png?v=20260801',
    alt: 'Court 4 beside the Pickle Point Arena service counter, branded wall, refrigerator, tables, and planted player lounge',
    label: 'COURT 4 · AMENITIES',
    title: 'Court 4 & player lounge',
  },
  {
    src: '/arena-overview-wide-v1.png?v=20260801',
    alt: 'Wide architectural overview of Pickle Point Arena showing the complete six-court arrangement and player amenities',
    label: 'ARENA OVERVIEW',
    title: 'Complete arena',
  },
  {
    src: '/court-gallery-01.png',
    alt: 'Wide view of the covered pickleball courts at Pickle Point Arena',
    label: 'COURT PHOTO',
    title: 'The Arena',
  },
  {
    src: '/court-gallery-02.png',
    alt: 'Pickleball court view inside Pickle Point Arena',
    label: 'COURT PHOTO',
    title: 'Court view',
  },
  {
    src: '/court-floor-plan-enhanced-v10.png?v=20260801',
    alt: 'Enhanced top-down floor plan of Pickle Point Arena preserving the complete twelve-court layout, court numbering, entrances, aisles, and service area',
    label: 'ARENA FLOOR PLAN',
    title: 'Complete court layout',
  },
];
const heroCourtPhotos = courtGalleryPhotos;
const hours = Array.from({ length: 20 }, (_, index) => (6 + index) % 24);

const statusDetails = {
  past: { label: 'Past time — not booked', short: 'Not booked' },
  available: { label: 'Available', short: 'Available' },
  selected: { label: 'Selected', short: 'Selected' },
  pending: { label: 'Payment submitted — pending verification', short: 'Pending' },
  awaiting: { label: 'Awaiting payment', short: 'Awaiting' },
  booked: { label: 'Confirmed booking', short: 'Booked' },
  blocked: { label: 'Blocked by venue', short: 'Blocked' },
};

const bookingLegendStatuses = ['available', 'pending', 'booked', 'blocked'];

const demoStatuses = {};

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function manilaTodayKey() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function slotKey(date, hour, courtIndex) {
  return `${dateKey(date)}|${hour}|${courtIndex}`;
}

function displayHour(hour) {
  const normalized = hour % 24;
  const suffix = normalized >= 12 ? 'PM' : 'AM';
  const value = normalized % 12 || 12;
  return `${value}:00 ${suffix}`;
}

function timeRange(hour) {
  return `${displayHour(hour)} – ${displayHour((hour + 1) % 24)}`;
}

function startOfWeek(date) {
  const copy = new Date(`${date}T12:00:00`);
  const offset = copy.getDay() === 0 ? -6 : 1 - copy.getDay();
  copy.setDate(copy.getDate() + offset);
  return copy;
}

function monthCalendarDays(monthDate) {
  const first = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1, 12);
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - first.getDay());
  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(gridStart);
    day.setDate(gridStart.getDate() + index);
    return day;
  });
}

function manilaDayWindow(date) {
  const start = new Date(`${date}T00:00:00+08:00`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

function manilaSlotIso(date, hour) {
  const dayOffset = hour < 6 ? 1 : 0;
  const base = new Date(`${date}T00:00:00+08:00`);
  base.setUTCDate(base.getUTCDate() + dayOffset);
  base.setUTCHours(base.getUTCHours() + hour);
  return base.toISOString();
}

function relativeTime(timestamp) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000));
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hoursAgo = Math.floor(minutes / 60);
  if (hoursAgo < 24) return `${hoursAgo} hour${hoursAgo === 1 ? '' : 's'} ago`;
  const days = Math.floor(hoursAgo / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function activityTimestamp(timestamp) {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

function receiptScheduleSummary(slots = []) {
  return [...slots]
    .sort((first, second) => new Date(first.slot_start).getTime() - new Date(second.slot_start).getTime() || Number(first.court_id) - Number(second.court_id))
    .map((slot) => {
      const start = new Date(slot.slot_start);
      const end = new Date(slot.slot_end);
      const date = start.toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric' });
      const startTime = start.toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' });
      const endTime = end.toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' });
      return `Court ${slot.court_id} · ${date}, ${startTime}–${endTime}`;
    })
    .join(' • ');
}

function validStaffPassword(password) {
  const letterCount = (password.match(/[A-Za-z]/g) || []).length;
  return letterCount >= 5 && /[A-Z]/.test(password) && /[0-9]/.test(password) && /[^A-Za-z0-9]/.test(password);
}

const passwordRequirements = 'Use at least 5 letters, including 1 capital letter, plus 1 number and 1 special character.';

async function uploadPaymentProof({ lookupMethod, lookupValue, referenceNumber, file }) {
  const prepareResponse = await fetch('/api/payments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lookupMethod, lookupValue, mimeType: file.type }),
  });
  const prepared = await prepareResponse.json();
  if (!prepareResponse.ok) throw new Error(prepared.error || 'The receipt upload could not be prepared.');

  const { error: uploadError } = await supabase.storage.from('payment-receipts').uploadToSignedUrl(prepared.path, prepared.token, file, { contentType: file.type });
  if (uploadError) throw uploadError;

  const finalizeResponse = await fetch('/api/payments', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lookupMethod, lookupValue, referenceNumber, receiptPath: prepared.path }),
  });
  const finalized = await finalizeResponse.json();
  if (!finalizeResponse.ok) throw new Error(finalized.error || 'The payment proof could not be submitted.');
  return finalized.booking;
}

function App() {
  const [view, setView] = useState('home');
  const [selectedDate, setSelectedDate] = useState(manilaTodayKey());
  const [selectedSlots, setSelectedSlots] = useState(new Set());
  const [blockedSlots, setBlockedSlots] = useState(new Set());
  const [period, setPeriod] = useState('Weekly');
  const [heroPhotoIndex, setHeroPhotoIndex] = useState(0);
  const [trackingHandoff, setTrackingHandoff] = useState(null);
  const heroPointerStartX = useRef(null);
  const todayForAvailability = new Date();
  const unavailableTonight = new Set(['booked', 'pending', 'awaiting', 'blocked']);
  const courtsOpenTonight = courtNames.filter((_, courtIndex) => {
    const status = blockedSlots.has(slotKey(todayForAvailability, 18, courtIndex)) ? 'blocked' : (demoStatuses[`18-${courtIndex}`] || 'available');
    return !unavailableTonight.has(status);
  }).length;

  useEffect(() => {
    const timer = window.setInterval(() => setHeroPhotoIndex((current) => (current + 1) % heroCourtPhotos.length), 5000);
    return () => window.clearInterval(timer);
  }, []);

  if (window.location.pathname === '/admin' || window.location.pathname.startsWith('/admin/')) {
    return <AdminPortal />;
  }

  const navigate = (next) => {
    if (next !== 'tracking') setTrackingHandoff(null);
    setView(next);
    window.setTimeout(() => document.getElementById('experience')?.scrollIntoView({ behavior: 'smooth' }), 30);
  };

  const changeHeroPhoto = (direction = 1) => {
    setHeroPhotoIndex((current) => (current + direction + heroCourtPhotos.length) % heroCourtPhotos.length);
  };

  const finishHeroPhotoGesture = (event) => {
    if (heroPointerStartX.current === null) return;
    const distance = event.clientX - heroPointerStartX.current;
    heroPointerStartX.current = null;
    if (Math.abs(distance) >= 35) changeHeroPhoto(distance < 0 ? 1 : -1);
    else changeHeroPhoto(1);
  };

  return (
    <main>
      <header className="topbar">
        <button className="brand brand-image" onClick={() => setView('home')} aria-label="Pickle Point Arena home">
          <img src="/header-logo-colored.png" alt="Pickle Point Arena" />
        </button>
        <nav aria-label="Main navigation">
          <button onClick={() => navigate('booking')}>Book</button>
          <button onClick={() => navigate('courts')}>Our Courts</button>
          <button onClick={() => navigate('location')}>Location</button>
          <button onClick={() => navigate('tracking')}>Track Booking</button>
        </nav>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">BUKIDNON&apos;S NEXT PLAYGROUND</span>
          <h1>Your court,<br /><em>your moment.</em></h1>
          <p>Welcome to Pickle Point Arena!<br />Home of six (6) Indoor Pickleball Courts in Valencia City Bukidnon. Designed for every dink, drive, and drop shot. Where passion meets play&mdash;rain or shine. 🏓</p>
          <div className="hero-actions">
            <button className="primary" onClick={() => navigate('booking')}>Book a court <span>↗</span></button>
            <button
              className="secondary"
              onClick={() => window.open('https://reclub.co/clubs/@pickle-point-arena', '_blank', 'noopener,noreferrer')}
            >
              Join Open Play <span>↗</span>
            </button>
            <button className="secondary" onClick={() => navigate('tracking')}>Track my booking</button>
          </div>
          <div className="hero-facts">
            <div><strong>6</strong><span>Courts</span></div>
            <div><strong>6AM–2AM</strong><span>Open daily</span></div>
            <div><strong>₱300</strong><span>Starting rate</span></div>
          </div>
        </div>

        <div className="hero-visual" aria-label="Pickleball court illustration">
          <div className="court-card">
            <div
              className={`court-photo court-photo-interactive${heroCourtPhotos[heroPhotoIndex].fit === 'contain' || heroCourtPhotos[heroPhotoIndex].src.includes('floor-plan') ? ' court-photo-contain' : ''}`}
              role="button"
              tabIndex="0"
              aria-label="Court photo gallery. Click, tap, or swipe to show another photo."
              aria-live="polite"
              onPointerDown={(event) => {
                heroPointerStartX.current = event.clientX;
                event.currentTarget.setPointerCapture?.(event.pointerId);
              }}
              onPointerUp={finishHeroPhotoGesture}
              onPointerCancel={() => { heroPointerStartX.current = null; }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowLeft') changeHeroPhoto(-1);
                if (event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  changeHeroPhoto(1);
                }
              }}
            >
              <img
                src={heroCourtPhotos[heroPhotoIndex].src}
                alt={`${heroCourtPhotos[heroPhotoIndex].alt}. Image ${heroPhotoIndex + 1} of ${heroCourtPhotos.length}`}
                draggable="false"
              />
            </div>
          </div>
          <a className="hero-icon-link facebook-link" href="https://www.facebook.com/profile.php?id=61591695621672&sk=photos" target="_blank" rel="noreferrer" aria-label="Open Pickle Point Arena on Facebook"><span>f</span></a>
          <div className="availability-pill"><span /> {courtsOpenTonight} {courtsOpenTonight === 1 ? 'court' : 'courts'} open tonight</div>
          <a className="hero-icon-link location-link" href="https://www.google.com/maps/search/?api=1&query=Guinoyuran%20Rd%2C%20Valencia%20City%2C%20Bukidnon%2C%20Philippines" target="_blank" rel="noreferrer" aria-label="Open Pickle Point Arena location in Google Maps"><span className="location-pin-icon"><i /></span></a>
          <div className="rate-pill"><small>EVENING RATE</small><strong>₱350/hr</strong></div>
        </div>
      </section>

      <section className="trust-strip">
        <span>REAL-TIME AVAILABILITY</span><i />
        <span>15-MINUTE PAYMENT HOLD</span><i />
        <span>NO ACCOUNT REQUIRED</span><i />
        <span>BOOK MULTIPLE COURTS</span>
      </section>

      <section id="experience" className="experience">
        {view === 'home' && <HomePreview onStart={() => setView('booking')} />}
        {view === 'booking' && (
          <BookingCalendar
            selectedDate={selectedDate}
            setSelectedDate={setSelectedDate}
            selectedSlots={selectedSlots}
            setSelectedSlots={setSelectedSlots}
            blockedSlots={blockedSlots}
            onTrackBooking={(booking) => {
              setTrackingHandoff(booking);
              setView('tracking');
              window.setTimeout(() => document.getElementById('experience')?.scrollIntoView({ behavior: 'smooth' }), 30);
            }}
          />
        )}
        {view === 'courts' && <CourtsPreview onBook={() => setView('booking')} />}
        {view === 'location' && <LocationPreview />}
        {view === 'tracking' && <TrackingPreview initialBooking={trackingHandoff} />}
      </section>

      <section className="closing-cta">
        <span className="eyebrow">PICKLE POINT ARENA</span>
        <h2>Less waiting.<br />More playing.</h2>
        <p>Book any of six courts in less than a minute.</p>
        <button className="primary light" onClick={() => navigate('booking')}>Find your court <span>→</span></button>
      </section>

      <footer>
        <div className="footer-brand"><div className="footer-logo-lockup"><img src="/footer-logo-black.png" alt="Pickle Point Arena Valencia Bukidnon" /></div></div>
        <div><strong>Hours</strong><span>Monday–Sunday</span><span>6:00 AM–2:00 AM</span></div>
        <div><strong>Rates</strong><span>₱300 · 6AM - 4PM</span><span>₱350 · 4PM - 2AM</span></div>
        <div><strong>Quick links</strong><button onClick={() => navigate('booking')}>Book a court</button><button onClick={() => navigate('tracking')}>Track booking</button></div>
        <div><strong>Contact</strong><a href="mailto:picklepointarenabukidnon@gmail.com">picklepointarenabukidnon@gmail.com</a><a href="https://www.facebook.com/profile.php?id=61591695621672&sk=photos" target="_blank" rel="noreferrer">Facebook page ↗</a><a href="https://www.google.com/maps/search/?api=1&query=Guinoyuran%20Rd%2C%20Valencia%20City%2C%20Bukidnon%2C%20Philippines" target="_blank" rel="noreferrer">Guinoyuran Rd, Valencia City ↗</a></div>
      </footer>
    </main>
  );
}

function HomePreview({ onStart }) {
  return (
    <div className="feature-intro">
      <div><span className="eyebrow dark">BUKIDNON&apos;S NEXT PLAYGROUND</span><h2>Easy online booking,<br /><em>and play from sunrise until late.</em><br />Choose a schedule and step onto the court.</h2></div>
      <p>Six premium courts, easy online booking, and play from sunrise until late. Choose a schedule and step onto the court.</p>
      <button className="text-link" onClick={onStart}>See the booking experience →</button>
      <div className="feature-grid">
        <article><span>01</span><h3>Pick a schedule</h3><p>Compare all six courts by hour and select multiple courts in one transaction.</p></article>
        <article><span>02</span><h3>Pay your way</h3><p>Select GCash, Maya, or Metrobank and scan or download the correct QR.</p></article>
        <article><span>03</span><h3>Track every step</h3><p>Use your tracking number and email to upload proof and check confirmation.</p></article>
      </div>
    </div>
  );
}

function BookingCalendar({ selectedDate, setSelectedDate, selectedSlots, setSelectedSlots, onTrackBooking }) {
  const today = manilaTodayKey();
  const [nowTick, setNowTick] = useState(Date.now());
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [checkoutStage, setCheckoutStage] = useState('details');
  const [customerName, setCustomerName] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [paymentReference, setPaymentReference] = useState('');
  const [proofFile, setProofFile] = useState(null);
  const [trackingNumber, setTrackingNumber] = useState('');
  const [selectionMessage, setSelectionMessage] = useState('');
  const [availability, setAvailability] = useState(new Map());
  const [availabilityLoading, setAvailabilityLoading] = useState(true);
  const [bookingRecord, setBookingRecord] = useState(null);
  const [bookingSubmitting, setBookingSubmitting] = useState(false);
  const [recentSubmissions, setRecentSubmissions] = useState([]);
  const bookingRecordRef = useRef(null);
  const weekStart = useMemo(() => startOfWeek(selectedDate), [selectedDate]);
  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, index) => {
    const day = new Date(weekStart);
    day.setDate(weekStart.getDate() + index);
    return day;
  }), [weekStart]);
  const activeDate = new Date(`${selectedDate}T12:00:00`);

  useEffect(() => {
    const timer = window.setInterval(() => setNowTick(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);

  const isPastHour = (hour) => new Date(manilaSlotIso(selectedDate, hour)).getTime() <= nowTick;
  const visibleBookingHours = hours.filter((hour) => !isPastHour(hour));

  const refreshAvailability = useCallback(async () => {
    setAvailabilityLoading(true);
    const from = manilaSlotIso(selectedDate, 6);
    const to = manilaSlotIso(selectedDate, 2);
    const response = await fetch(`/api/availability?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    const result = await response.json();
    if (!response.ok) {
      setSelectionMessage(result.error || 'Live availability could not be loaded. Please refresh the page.');
      setAvailabilityLoading(false);
      return null;
    }
    const nextAvailability = new Map((result.slots || []).map((slot) => [`${slot.courtId}|${new Date(slot.slotStart).toISOString()}`, slot.status]));
    (result.blocks || []).forEach((block) => {
      hours.forEach((hour) => {
        const start = new Date(manilaSlotIso(selectedDate, hour)).getTime();
        const end = start + 3600000;
        if (new Date(block.startsAt).getTime() < end && new Date(block.endsAt).getTime() > start) nextAvailability.set(`${block.courtId}|${new Date(start).toISOString()}`, 'blocked');
      });
    });
    setAvailability(nextAvailability);
    if (!bookingRecordRef.current) {
      setSelectedSlots((current) => new Set([...current].filter((key) => {
        if (!key.startsWith(`${selectedDate}|`)) return true;
        const [, hour, courtIndex] = key.split('|');
        return !nextAvailability.has(`${Number(courtIndex) + 1}|${new Date(manilaSlotIso(selectedDate, Number(hour))).toISOString()}`);
      })));
    }
    setAvailabilityLoading(false);
    return nextAvailability;
  }, [selectedDate]);

  useEffect(() => { refreshAvailability(); }, [refreshAvailability]);

  useEffect(() => {
    let refreshTimer;
    const refreshBookingAndAvailability = () => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(async () => {
        await refreshAvailability();
        if (!trackingNumber) return;
        const response = await fetch('/api/lookup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'tracking', value: trackingNumber }) });
        const result = await response.json();
        if (response.ok && result.booking) {
          if (result.booking.status === 'expired') {
            bookingRecordRef.current = null;
            setSelectedSlots((current) => new Set([...current].filter((key) => !key.startsWith(`${selectedDate}|`))));
            setCheckoutOpen(false);
            setSelectionMessage('The 15-minute payment hold expired. The slots are available to select again.');
          } else bookingRecordRef.current = result.booking;
          setBookingRecord(result.booking);
        }
      }, 75);
    };
    const channel = supabase
      .channel(`client-calendar-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'booking_slots' }, refreshBookingAndAvailability)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, refreshBookingAndAvailability)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'blocked_slots' }, refreshBookingAndAvailability)
      .subscribe((status) => { if (status === 'SUBSCRIBED') refreshBookingAndAvailability(); });
    const refreshWhenVisible = () => { if (document.visibilityState === 'visible') refreshBookingAndAvailability(); };
    window.addEventListener('focus', refreshBookingAndAvailability);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    const reconciliationTimer = window.setInterval(refreshBookingAndAvailability, 5000);
    return () => {
      window.clearTimeout(refreshTimer);
      window.clearInterval(reconciliationTimer);
      window.removeEventListener('focus', refreshBookingAndAvailability);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      supabase.removeChannel(channel);
    };
  }, [refreshAvailability, trackingNumber]);

  const chooseDate = (nextDate) => {
    setSelectedDate(nextDate < today ? today : nextDate);
    setSelectedSlots(new Set());
    bookingRecordRef.current = null;
    setBookingRecord(null);
    setCheckoutOpen(false);
  };

  const getStatus = (hour, courtIndex) => {
    if (isPastHour(hour)) return 'past';
    const key = slotKey(activeDate, hour, courtIndex);
    const liveStatus = availability.get(`${courtIndex + 1}|${new Date(manilaSlotIso(selectedDate, hour)).toISOString()}`);
    if (selectedSlots.has(key)) {
      if (bookingRecord?.status === 'payment_submitted') return 'pending';
      if (bookingRecord?.status === 'confirmed') return 'booked';
      if (bookingRecord?.status === 'awaiting_payment') return 'awaiting';
      if (checkoutStage === 'submitted' && trackingNumber) return 'pending';
      if (checkoutStage === 'payment' && trackingNumber) return 'awaiting';
      if (['awaiting', 'pending', 'booked', 'blocked'].includes(liveStatus)) return liveStatus;
      return 'selected';
    }
    return liveStatus || 'available';
  };

  const toggleSlot = (hour, courtIndex) => {
    if (bookingRecordRef.current || bookingRecord || trackingNumber) {
      setSelectionMessage('This reservation is already in progress. Finish it before starting another booking.');
      return;
    }
    const status = getStatus(hour, courtIndex);
    if (!['available', 'selected'].includes(status)) return;
    const key = slotKey(activeDate, hour, courtIndex);
    setSelectedSlots((current) => {
      const next = new Set(current);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
    setSelectionMessage('');
  };

  const selectedForDate = [...selectedSlots].filter((key) => key.startsWith(`${selectedDate}|`) && !isPastHour(Number(key.split('|')[1])));
  const selectedSchedule = selectedForDate
    .map((key) => {
      const [, hourValue, courtValue] = key.split('|');
      const hour = Number(hourValue);
      const courtIndex = Number(courtValue);
      return { key, hour, courtIndex, order: (hours.indexOf(hour) * courtNames.length) + courtIndex };
    })
    .sort((first, second) => first.order - second.order);
  const rental = selectedForDate.reduce((sum, key) => {
    const hour = Number(key.split('|')[1]);
    return sum + (hour < 16 ? 300 : 350);
  }, 0);
  const total = rental + (selectedForDate.length ? 10 : 0);
  const customerReady = customerName.trim().length > 1 && /^\S+@\S+\.\S+$/.test(customerEmail);
  const paymentReady = paymentReference.trim().length > 2 && proofFile;

  const startCheckout = async () => {
    if (!selectedForDate.length) {
      setSelectionMessage('Select at least one white court slot above before continuing.');
      return;
    }
    const latestAvailability = await refreshAvailability();
    if (!latestAvailability) return;
    const conflicts = selectedForDate.filter((key) => {
      const [, hour, courtIndex] = key.split('|');
      return latestAvailability.has(`${Number(courtIndex) + 1}|${new Date(manilaSlotIso(selectedDate, Number(hour))).toISOString()}`);
    });
    if (conflicts.length) {
      setSelectionMessage(`${conflicts.length} selected court-hour${conflicts.length === 1 ? ' is' : 's are'} no longer available. The calendar was refreshed—please review your remaining selection.`);
      return;
    }
    setCheckoutStage('details');
    setCheckoutOpen(true);
    window.setTimeout(() => document.querySelector('.checkout-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 30);
  };

  const createReservation = async () => {
    if (!customerReady || bookingSubmitting) return;
    setBookingSubmitting(true);
    setSelectionMessage('');
    const slots = selectedForDate.map((key) => {
      const [, hour, courtIndex] = key.split('|');
      return { courtId: Number(courtIndex) + 1, slotStart: manilaSlotIso(selectedDate, Number(hour)) };
    });
    const response = await fetch('/api/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customerName, customerEmail, slots }) });
    const result = await response.json();
    if (!response.ok) {
      setSelectionMessage(result.error || 'The reservation could not be created.');
      setCheckoutOpen(false);
      await refreshAvailability();
    } else {
      setTrackingNumber(result.trackingNumber);
      const reservedBooking = { ...result, status: 'awaiting_payment' };
      bookingRecordRef.current = reservedBooking;
      setBookingRecord(reservedBooking);
      setCheckoutStage('payment');
      await refreshAvailability();
    }
    setBookingSubmitting(false);
  };

  const submitPaymentProof = async () => {
    if (!paymentReady || bookingSubmitting) return;
    setBookingSubmitting(true);
    setSelectionMessage('');
    try {
      const booking = await uploadPaymentProof({ lookupMethod: 'tracking', lookupValue: trackingNumber, referenceNumber: paymentReference, file: proofFile });
      const completedTracking = booking.trackingNumber || trackingNumber;
      const submittedAt = booking.payment?.submittedAt || new Date().toISOString();
      setRecentSubmissions((current) => [{ trackingNumber: completedTracking, submittedAt, totalAmount: booking.totalAmount || total, customerName, courtHours: selectedForDate.length }, ...current].slice(0, 5));
      bookingRecordRef.current = null;
      setBookingRecord(null);
      setSelectedSlots(new Set());
      setTrackingNumber('');
      setPaymentReference('');
      setProofFile(null);
      setCustomerName('');
      setCheckoutStage('details');
      setCheckoutOpen(false);
      await refreshAvailability();
      onTrackBooking?.({ ...booking, trackingNumber: completedTracking });
    } catch (error) {
      setSelectionMessage(error.message);
    }
    setBookingSubmitting(false);
  };

  return (
    <div className="portal-shell calendar-portal">
      <div className="portal-heading">
        <div><span className="eyebrow dark">LIVE COURT AVAILABILITY</span><h2>Choose your game time.</h2><p>Open daily from 6:00 AM to 2:00 AM. Select consecutive hours or multiple courts.</p></div>
      </div>

      <div className="calendar-toolbar">
        <div className="calendar-date-controls"><button className="refresh-button" aria-label="Refresh availability" onClick={refreshAvailability} disabled={availabilityLoading}>{availabilityLoading ? '…' : '↻'}</button><label className="date-picker">Select date<input type="date" min={today} value={selectedDate} onChange={(event) => chooseDate(event.target.value)} /></label></div>
        <a className="find-booking open-play-link" href="https://reclub.co/clubs/@pickle-point-arena" target="_blank" rel="noopener noreferrer">Join Open Play <span>↗</span></a>
        <div className="rate-guide"><span><b>₱300</b> 6AM - 4PM</span><span><b>₱350</b> 4PM - 2AM</span></div>
      </div>

      {recentSubmissions.length > 0 && <div className="submission-history">{recentSubmissions.map((submission, index) => <aside className="submission-receipt" role={index === 0 ? 'status' : undefined} key={`${submission.trackingNumber}-${submission.submittedAt}`}><span className="result-icon">✓</span><div><small>PAYMENT PROOF SUBMITTED · PENDING REVIEW</small><strong>{submission.trackingNumber}</strong><p>{submission.customerName} · {submission.courtHours} court-hour{submission.courtHours === 1 ? '' : 's'} · ₱{Number(submission.totalAmount).toLocaleString()}</p><time dateTime={submission.submittedAt}>{activityTimestamp(submission.submittedAt)} Philippine time</time>{index === 0 && <em>The previous selection was cleared. Select another white slot to create a new booking with a different tracking number.</em>}</div><div><button type="button" onClick={() => navigator.clipboard?.writeText(submission.trackingNumber)}>Copy tracking</button><button type="button" onClick={() => setRecentSubmissions((current) => current.filter((item) => item.trackingNumber !== submission.trackingNumber))}>Dismiss</button></div></aside>)}</div>}

      <div className="week-strip" aria-label="Select booking date">
        {weekDays.map((day) => {
          const active = dateKey(day) === selectedDate;
          const past = dateKey(day) < today;
          return <button key={dateKey(day)} className={active ? 'active' : ''} disabled={past} aria-label={past ? `${day.toLocaleDateString()} is unavailable because it has passed` : `Book ${day.toLocaleDateString()}`} onClick={() => chooseDate(dateKey(day))}><small>{day.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase()}</small><strong>{day.getDate()}</strong>{past && <em>Passed</em>}</button>;
        })}
      </div>

      <div className="status-legend" aria-label="Booking status legend">
        {bookingLegendStatuses.map((status) => <span className={status} key={status}>{statusDetails[status].short}</span>)}
      </div>

      <div className="schedule-wrap">
        <table className="schedule-table">
          <thead><tr><th>TIME</th>{courtNames.map((court) => <th key={court}>{court}</th>)}</tr></thead>
          <tbody>
            {visibleBookingHours.map((hour) => <tr key={hour}><th>{timeRange(hour)}</th>{courtNames.map((court, courtIndex) => {
              const status = getStatus(hour, courtIndex);
              const disabled = !['available', 'selected'].includes(status);
              return <td key={court}><button className={`slot ${status}`} disabled={disabled} onClick={() => toggleSlot(hour, courtIndex)} aria-label={`${court}, ${timeRange(hour)}, ${statusDetails[status].label}`}><span>{statusDetails[status].short}</span></button></td>;
            })}</tr>)}
          </tbody>
        </table>
      </div>

      <div className="booking-dock">
        <div><small>YOUR SELECTION</small><strong>{selectedForDate.length} {selectedForDate.length === 1 ? 'court-hour' : 'court-hours'}</strong><span>{selectedForDate.length ? 'Multiple courts and consecutive times are allowed.' : 'Tap any white slot to begin.'}</span></div>
        <div className="dock-total"><small>BOOKING FEE INCLUDED</small><strong>₱{total.toLocaleString()}</strong></div>
        <button className="primary" onClick={startCheckout}>Continue to customer details <span>→</span></button>
      </div>
      {selectionMessage && <p className="selection-message" role="alert">{selectionMessage}</p>}
      <p className="booking-policy">Selected slots are held for 15 minutes after reservation. Full payment is required. All confirmed bookings are non-refundable and cannot be cancelled.</p>

      {checkoutOpen && selectedForDate.length > 0 && <section className="checkout-panel">
        <div className="checkout-heading"><div><span className="eyebrow dark">LIVE BOOKING</span><h3>{checkoutStage === 'details' ? 'Customer details.' : checkoutStage === 'payment' ? 'Pay and submit proof.' : 'Payment submitted.'}</h3><p>Your reservation, payment reference, and receipt are securely stored for Owner/Admin review.</p></div><button onClick={() => setCheckoutOpen(false)} aria-label="Close checkout">×</button></div>

        {checkoutStage === 'details' && <>
          <div className="checkout-grid">
            <div className="customer-form"><span className="step-number">01</span><h4>Customer details</h4><label>Full name<input value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="Customer full name" autoComplete="name" /></label><label>Email address<input type="email" value={customerEmail} onChange={(event) => setCustomerEmail(event.target.value)} placeholder="customer@email.com" autoComplete="email" /></label><p>Booking updates and the tracking number will be sent to this email.</p></div>
            <div className="order-review"><span className="step-number">BOOKING SUMMARY</span><h4>{selectedForDate.length} {selectedForDate.length === 1 ? 'court-hour' : 'court-hours'} selected</h4><p>{new Date(`${selectedDate}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</p><div className="checkout-total"><span>Court rental</span><b>₱{rental.toLocaleString()}</b><span>Booking fee</span><b>₱10</b><small>Total payment</small><strong>₱{total.toLocaleString()}</strong></div></div>
          </div>
          <div className="checkout-footer"><p>Continuing creates a real 15-minute reservation hold for these court slots.</p><button className="primary" disabled={!customerReady || bookingSubmitting} onClick={createReservation}>{bookingSubmitting ? 'Reserving slots…' : 'Reserve and continue to payment'} <span>→</span></button></div>
        </>}

        {checkoutStage === 'payment' && <>
          <div className="payment-confirmation-banner" role="status">
            <small>PLEASE VERIFY BEFORE PAYING</small>
            <div className="payment-confirmation-total"><span>Exact amount to pay</span><strong>₱{(bookingRecord?.totalAmount || total).toLocaleString()}</strong></div>
            <div className="payment-confirmation-schedule">
              <span>Booking schedule</span>
              <strong>{new Date(`${selectedDate}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</strong>
              <ul>{selectedSchedule.map((slot) => <li key={slot.key}>{courtNames[slot.courtIndex]} · {timeRange(slot.hour)}</li>)}</ul>
            </div>
          </div>
          <div className="payment-stage">
            <div className="payment-choice"><span className="step-number">02</span><h4>Payment method</h4><div className="payment-tabs"><button className="active"><strong>GCash</strong><small>Available now</small></button><button disabled><strong>Maya</strong><small>Coming soon</small></button><button disabled><strong>Metrobank</strong><small>Coming soon</small></button></div><div className="qr-payment"><div className="qr-frame"><img src="/gcash-qr-hd.png" alt="High-resolution GCash QR code for Pickle Point Arena payment" /></div><div><span className="gcash-label">GCASH PAYMENT</span><h4>Scan and pay ₱{total.toLocaleString()}</h4><p>Enter the exact amount shown. Transfer fees may apply.</p><a href="/gcash-qr-hd.png" download="Pickle-Point-Arena-GCash-QR.png">↓ Download GCash QR</a></div></div></div>
            <div className="proof-form"><span className="step-number">03</span><h4>Submit payment proof</h4><label>Reference number<input value={paymentReference} onChange={(event) => setPaymentReference(event.target.value)} placeholder="Enter GCash reference number" /></label><label className="file-upload">Receipt or screenshot<input type="file" accept="image/png,image/jpeg,application/pdf" onChange={(event) => setProofFile(event.target.files?.[0] || null)} /><span>{proofFile?.name || 'Choose an image or PDF'}</span></label><p>The receipt is stored privately and can only be opened by an authorized Owner or Admin.</p><div className="payment-summary"><span>Customer</span><strong>{customerName}</strong><span>Tracking</span><strong>{trackingNumber}</strong><span>Amount</span><strong>₱{(bookingRecord?.totalAmount || total).toLocaleString()}</strong></div></div>
          </div>
          <div className="checkout-footer"><span className="hold-notice">Reserved until {bookingRecord?.holdExpiresAt ? new Date(bookingRecord.holdExpiresAt).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' }) : '—'}</span><button className="primary" disabled={!paymentReady || bookingSubmitting} onClick={submitPaymentProof}>{bookingSubmitting ? 'Uploading securely…' : 'Submit payment proof'} <span>→</span></button></div>
        </>}

        {checkoutStage === 'submitted' && <div className="status-result pending-result"><span className="result-icon">✓</span><span className="step-number">PAYMENT SUBMITTED — PENDING VERIFICATION</span><h4>Your payment proof is with the venue.</h4><p>The Owner or Admin can now open the receipt and confirm or reject this booking from the private portal. Use Track Booking to check for updates.</p><div className="tracking-number"><small>TRACKING NUMBER</small><strong>{trackingNumber}</strong><button onClick={() => navigator.clipboard?.writeText(trackingNumber)}>Copy</button></div><div className="confirmed-details"><span>Amount submitted<strong>₱{(bookingRecord?.totalAmount || total).toLocaleString()}</strong></span><span>Payment method<strong>GCash</strong></span><span>Status<strong>Pending verification</strong></span></div></div>}
      </section>}
    </div>
  );
}

function CourtsPreview({ onBook }) {
  const [galleryIndex, setGalleryIndex] = useState(0);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const galleryImages = courtGalleryPhotos;

  useEffect(() => {
    if (!galleryOpen) return undefined;
    const handleGalleryKeyDown = (event) => {
      if (event.key === 'Escape') setGalleryOpen(false);
      if (event.key === 'ArrowLeft') setGalleryIndex((current) => (current - 1 + galleryImages.length) % galleryImages.length);
      if (event.key === 'ArrowRight') setGalleryIndex((current) => (current + 1) % galleryImages.length);
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleGalleryKeyDown);
    const interval = window.setInterval(() => {
      setGalleryIndex((current) => (current + 1) % galleryImages.length);
    }, 3000);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('keydown', handleGalleryKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [galleryOpen, galleryImages.length]);

  const openGallery = (index) => {
    setGalleryIndex(index);
    setGalleryOpen(true);
  };

  const closeGallery = () => setGalleryOpen(false);
  const nextGalleryImage = () => setGalleryIndex((current) => (current + 1) % galleryImages.length);
  const previousGalleryImage = () => setGalleryIndex((current) => (current - 1 + galleryImages.length) % galleryImages.length);

  return (
    <div className="content-page">
      <div className="content-heading"><span className="eyebrow dark">OUR COURTS</span><h2>Six courts.<br />One home for play.</h2><p>A spacious covered venue designed for comfortable play from early morning until late at night.</p></div>
      <div className="court-gallery">
        {galleryImages.map((image, index) => {
          const galleryClass = index === 0
            ? 'venue-photo gallery-item floor-plan-feature'
            : index === 1
              ? 'venue-photo gallery-item venue-photo-small'
              : 'venue-photo gallery-item venue-photo-third';

          return (
            <figure
              key={image.src}
              className={galleryClass}
              role="button"
              tabIndex="0"
              onClick={() => openGallery(index)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  openGallery(index);
                }
              }}
            >
              <img
                src={image.src}
                alt={image.alt}
                loading={index === 0 ? 'eager' : 'lazy'}
                fetchPriority={index === 0 ? 'high' : 'auto'}
              />
              <figcaption><span>{image.label}</span><strong>{image.title}</strong></figcaption>
            </figure>
          );
        })}
        <article className="court-list-card"><span>PLAY YOUR WAY</span><h3>Courts 01–06</h3><p>Reserve one court, consecutive hours, or multiple courts in a single transaction.</p><div>{courtNames.map((court) => <small key={court}>{court}</small>)}</div></article>
      </div>

      {galleryOpen && (
        <div className="gallery-modal" role="dialog" aria-modal="true" aria-label="Court image viewer" onClick={closeGallery}>
          <div className="gallery-modal-content" onClick={(event) => event.stopPropagation()}>
            <button type="button" className="gallery-modal-close" onClick={closeGallery} aria-label="Close image viewer">×</button>
            <button type="button" className="gallery-modal-control prev" onClick={previousGalleryImage} aria-label="Previous image">‹</button>
            <img src={galleryImages[galleryIndex].src} alt={`${galleryImages[galleryIndex].alt}. Image ${galleryIndex + 1} of ${galleryImages.length}`} onClick={nextGalleryImage} />
            <button type="button" className="gallery-modal-control next" onClick={nextGalleryImage} aria-label="Next image">›</button>
            <div className="gallery-modal-counter">{galleryIndex + 1} / {galleryImages.length}</div>
          </div>
        </div>
      )}

      <button className="primary" onClick={onBook}>Check court availability <span>→</span></button>
    </div>
  );
}

function LocationPreview() {
  return (
    <div className="location-page">
      <div className="map-embed">
        <iframe
          title="Pickle Point Arena location on Google Maps"
          src="https://www.google.com/maps?q=Guinoyuran%20Rd%2C%20Valencia%20City%2C%20Bukidnon%2C%20Philippines&output=embed"
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
          allowFullScreen
        />
        <a href="https://www.google.com/maps/search/?api=1&query=Guinoyuran%20Rd%2C%20Valencia%20City%2C%20Bukidnon%2C%20Philippines" target="_blank" rel="noreferrer">Open in Google Maps ↗</a>
      </div>
      <div className="location-copy"><span className="eyebrow dark">VISIT THE ARENA</span><h2>Find your way<br />to the court.</h2><p>Visit Pickle Point Arena in Valencia City or contact the venue directly for assistance.</p><div className="location-detail"><small>VENUE ADDRESS</small><strong>Guinoyuran Rd, Valencia City, Bukidnon, Philippines</strong></div><div className="location-detail"><small>EMAIL</small><a href="mailto:picklepointarenabukidnon@gmail.com">picklepointarenabukidnon@gmail.com</a></div><div className="location-detail"><small>FACEBOOK</small><a href="https://www.facebook.com/profile.php?id=61591695621672&sk=photos" target="_blank" rel="noreferrer">Visit the Pickle Point Arena Facebook page ↗</a></div><div className="location-detail"><small>OPERATING HOURS</small><strong>Monday–Sunday · 6:00 AM–2:00 AM</strong></div><a className="primary" href="https://www.google.com/maps/search/?api=1&query=Guinoyuran%20Rd%2C%20Valencia%20City%2C%20Bukidnon%2C%20Philippines" target="_blank" rel="noreferrer">Get directions <span>↗</span></a></div>
    </div>
  );
}

function TrackingPreview({ initialBooking = null }) {
  const [lookupMethod, setLookupMethod] = useState(initialBooking ? 'tracking' : 'email');
  const [lookupValue, setLookupValue] = useState(initialBooking?.trackingNumber || '');
  const [lookupMessage, setLookupMessage] = useState('');
  const [lookupLoading, setLookupLoading] = useState(false);
  const [booking, setBooking] = useState(initialBooking);
  const [referenceNumber, setReferenceNumber] = useState('');
  const [receiptFile, setReceiptFile] = useState(null);
  const [proofSubmitting, setProofSubmitting] = useState(false);

  useEffect(() => {
    if (!initialBooking) return;
    setLookupMethod('tracking');
    setLookupValue(initialBooking.trackingNumber || '');
    setBooking(initialBooking);
    setLookupMessage('Payment proof submitted successfully. Save this tracking number for booking updates.');
  }, [initialBooking]);

  const findBooking = async (event) => {
    event.preventDefault();
    if (!lookupValue.trim()) return;
    setLookupLoading(true);
    setLookupMessage('');
    setBooking(null);
    const response = await fetch('/api/lookup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: lookupMethod, value: lookupValue }) });
    const result = await response.json();
    if (response.ok) setBooking(result.booking);
    else setLookupMessage(result.error || 'The booking could not be found.');
    setLookupLoading(false);
  };

  const continuePayment = async () => {
    if (!receiptFile || referenceNumber.trim().length < 3) return;
    setProofSubmitting(true);
    setLookupMessage('');
    try {
      const updated = await uploadPaymentProof({ lookupMethod, lookupValue, referenceNumber, file: receiptFile });
      setBooking(updated);
      setLookupMessage('Payment proof submitted successfully.');
    } catch (error) {
      setLookupMessage(error.message);
    }
    setProofSubmitting(false);
  };

  const changeMethod = (method) => {
    setLookupMethod(method);
    setLookupValue('');
    setBooking(null);
    setLookupMessage('');
  };

  const statusCopy = {
    awaiting_payment: 'Awaiting payment',
    payment_submitted: 'Payment submitted — pending verification',
    confirmed: 'Booking confirmed',
    expired: 'Reservation expired',
    rejected: 'Payment rejected',
    cancelled: 'Booking cancelled by venue',
  };

  return (
    <div className="tracking-card">
      <div className="tracking-copy">
        <span className="eyebrow dark">SECURE BOOKING LOOKUP</span>
        <h2>Continue your payment anytime.</h2>
        <p>Return within the 15-minute hold, upload your receipt, and see exactly where the booking stands.</p>
        <div className="status-flow"><span className="done">Reserved</span><i /><span className="current">Awaiting payment</span><i /><span>Verification</span><i /><span>Confirmed</span></div>
      </div>
      <form className="lookup-form" onSubmit={findBooking}>
        <span className="summary-tag">TRACK MY BOOKING</span>
        <div className="lookup-switch" role="tablist" aria-label="Choose how to find your booking">
          <button type="button" role="tab" aria-selected={lookupMethod === 'email'} className={lookupMethod === 'email' ? 'active' : ''} onClick={() => changeMethod('email')}>Email address</button>
          <button type="button" role="tab" aria-selected={lookupMethod === 'tracking'} className={lookupMethod === 'tracking' ? 'active' : ''} onClick={() => changeMethod('tracking')}>Tracking number</button>
        </div>
        {lookupMethod === 'email' ? <label>Booking email<input type="email" value={lookupValue} onChange={(event) => setLookupValue(event.target.value)} placeholder="you@email.com" autoComplete="email" required /></label> : <label>Tracking number<input value={lookupValue} onChange={(event) => setLookupValue(event.target.value)} placeholder="PPA-XXXXXXXXXXXX" autoComplete="off" required /></label>}
        <button className="primary full" disabled={lookupLoading}>{lookupLoading ? 'Checking…' : 'Check booking status'} <span>→</span></button>
        {lookupMessage && <p className="tracking-message" role="status">{lookupMessage}</p>}
        {booking && <div className="tracking-result">
          <small>{booking.trackingNumber}</small>
          <h3>{statusCopy[booking.status] || booking.status}</h3>
          <p>{booking.customerName} · {booking.maskedEmail}</p>
          <div className="tracking-result-details"><span>Total<strong>₱{booking.totalAmount.toLocaleString()}</strong></span><span>Court-hours<strong>{booking.slots.length}</strong></span></div>
          <p className="tracking-timestamps"><span>Booking created: <strong>{activityTimestamp(booking.createdAt)}</strong></span>{booking.payment?.submittedAt && <span>Proof submitted: <strong>{activityTimestamp(booking.payment.submittedAt)}</strong></span>}</p>
          {booking.status === 'awaiting_payment' && <div className="continue-payment">
            <p>Upload payment before {new Date(booking.holdExpiresAt).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })} to keep the reservation.</p>
            <img src="/gcash-qr-hd.png" alt="GCash QR code" />
            <label>GCash reference number<input value={referenceNumber} onChange={(event) => setReferenceNumber(event.target.value)} placeholder="Reference number" /></label>
            <label className="file-upload">Receipt or screenshot<input type="file" accept="image/png,image/jpeg,application/pdf" onChange={(event) => setReceiptFile(event.target.files?.[0] || null)} /><span>{receiptFile?.name || 'Choose an image or PDF'}</span></label>
            <button type="button" className="primary full" disabled={proofSubmitting || !receiptFile || referenceNumber.trim().length < 3} onClick={continuePayment}>{proofSubmitting ? 'Uploading…' : 'Submit payment proof'}</button>
          </div>}
        </div>}
      </form>
    </div>
  );
}

function AdminPortal() {
  const [staffRole, setStaffRole] = useState(null);
  const [staffSession, setStaffSession] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loginSubmitting, setLoginSubmitting] = useState(false);
  const [selectedDate, setSelectedDate] = useState(dateKey(new Date()));
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginMessage, setLoginMessage] = useState('');
  const [forgotSubmitting, setForgotSubmitting] = useState(false);
  const [passwordRecovery, setPasswordRecovery] = useState(false);
  const [recoveryPassword, setRecoveryPassword] = useState('');
  const [recoveryPasswordConfirm, setRecoveryPasswordConfirm] = useState('');
  const [recoveryMessage, setRecoveryMessage] = useState('');
  const [recoverySubmitting, setRecoverySubmitting] = useState(false);

  useEffect(() => {
    let active = true;

    const resolveStaffRole = async (session) => {
      if (!active) return;
      if (!session?.user) {
        setStaffRole(null);
        setStaffSession(null);
        setAuthLoading(false);
        return;
      }

      const { data: profile, error } = await supabase
        .from('profiles')
        .select('role, active')
        .eq('id', session.user.id)
        .single();

      if (!active) return;
      if (error || !profile?.active || !['owner', 'admin'].includes(profile.role)) {
        setStaffRole(null);
        setLoginMessage('This account is not authorized for the venue portal.');
        setAuthLoading(false);
        await supabase.auth.signOut();
        return;
      }

      setStaffRole(profile.role);
      setStaffSession(session);
      setLoginMessage('');
      setAuthLoading(false);
    };

    supabase.auth.getSession().then(({ data }) => resolveStaffRole(data.session));
    const { data: authListener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') setPasswordRecovery(true);
      window.setTimeout(() => resolveStaffRole(session), 0);
    });

    return () => {
      active = false;
      authListener.subscription.unsubscribe();
    };
  }, []);

  const signIn = async (event) => {
    event.preventDefault();
    if (!loginEmail.trim() || !loginPassword) return;
    setLoginSubmitting(true);
    setLoginMessage('');
    const { error } = await supabase.auth.signInWithPassword({
      email: loginEmail.trim().toLowerCase(),
      password: loginPassword,
    });
    if (error) setLoginMessage('The email or password is incorrect. Please try again.');
    setLoginSubmitting(false);
  };

  const requestPasswordReset = async () => {
    const email = loginEmail.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return setLoginMessage('Enter the Owner account email first.');
    setForgotSubmitting(true);
    setLoginMessage('');
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/admin` });
    if (error) setLoginMessage(error.message || 'The password reset email could not be sent.');
    else setLoginMessage('If this email belongs to an account, a secure password-reset link has been sent. Check the inbox and spam folder.');
    setForgotSubmitting(false);
  };

  const completePasswordRecovery = async (event) => {
    event.preventDefault();
    setRecoveryMessage('');
    if (!validStaffPassword(recoveryPassword)) return setRecoveryMessage(passwordRequirements);
    if (recoveryPassword !== recoveryPasswordConfirm) return setRecoveryMessage('The new passwords do not match.');
    setRecoverySubmitting(true);
    const recoveryEmail = staffSession?.user?.email || loginEmail;
    const { error } = await supabase.auth.updateUser({ password: recoveryPassword });
    if (error) {
      setRecoveryMessage(error.message || 'The password could not be updated. Request a new reset link and try again.');
      setRecoverySubmitting(false);
      return;
    }
    window.history.replaceState({}, '', '/admin');
    setPasswordRecovery(false);
    setRecoveryPassword('');
    setRecoveryPasswordConfirm('');
    await supabase.auth.signOut();
    setStaffRole(null);
    setStaffSession(null);
    setLoginEmail(recoveryEmail || '');
    setLoginPassword('');
    setLoginMessage('Password reset successfully. Sign in with your new password.');
    setRecoverySubmitting(false);
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    setStaffRole(null);
    setStaffSession(null);
    setLoginPassword('');
  };

  if (authLoading) {
    return <main className="admin-login-page auth-loading"><div><span className="auth-spinner" /><strong>Securing the venue portal…</strong></div></main>;
  }

  if (passwordRecovery && staffRole && staffSession) {
    return <main className="admin-login-page password-reset-page"><header className="admin-login-header"><a href="/" className="brand brand-image" aria-label="Return to Pickle Point Arena public site"><img src="/header-logo-colored.png" alt="Pickle Point Arena" /></a><span>Secure account recovery</span></header><section className="password-reset-layout"><form className="admin-login-card password-reset-card" onSubmit={completePasswordRecovery}><span className="summary-tag">PASSWORD RECOVERY</span><h2>Choose a new password.</h2><p>The reset link was verified for {staffSession.user.email}. Enter a new password for this account.</p><label>New password<input type="password" value={recoveryPassword} onChange={(event) => setRecoveryPassword(event.target.value)} autoComplete="new-password" minLength="7" required /></label><label>Confirm new password<input type="password" value={recoveryPasswordConfirm} onChange={(event) => setRecoveryPasswordConfirm(event.target.value)} autoComplete="new-password" minLength="7" required /></label><small className="password-rules">{passwordRequirements}</small><button className="primary full" type="submit" disabled={recoverySubmitting}>{recoverySubmitting ? 'Updating securely…' : 'Reset password'} <span>→</span></button>{recoveryMessage && <p className="login-message">{recoveryMessage}</p>}</form></section></main>;
  }

  if (!staffRole) {
    return <main className="admin-login-page">
      <header className="admin-login-header"><a href="/" className="brand brand-image" aria-label="Return to Pickle Point Arena public site"><img src="/header-logo-colored.png" alt="Pickle Point Arena" /></a><a href="/">← Public booking site</a></header>
      <section className="admin-login-layout">
        <div className="admin-login-copy"><span className="eyebrow">PRIVATE VENUE PORTAL</span><h1>Run the arena.<br /><em>Stay in control.</em></h1><p>One secure portal for the Owner and all authorized Administrators. Access is determined by each account&apos;s role.</p><div className="role-explainer"><article><span>OWNER</span><strong>Complete business control</strong><p>Financial reports, administrator accounts, bookings, payments, and court availability.</p></article><article><span>ADMIN</span><strong>Daily operations</strong><p>Bookings, payment verification, customer notifications, and court blocking—without financial reports.</p></article></div></div>
        <form className="admin-login-card" onSubmit={signIn}><span className="summary-tag">OWNER / ADMIN SIGN IN</span><h2>Welcome back.</h2><p>Use the email and password assigned by the Owner.</p><label>Email address<input type="email" value={loginEmail} onChange={(event) => setLoginEmail(event.target.value)} placeholder="you@email.com" autoComplete="username" required /></label><label>Password<input type="password" value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} placeholder="Enter your password" autoComplete="current-password" required /></label><div className="login-options"><span>Secure Supabase authentication</span><button type="button" onClick={requestPasswordReset} disabled={forgotSubmitting}>{forgotSubmitting ? 'Sending…' : 'Forgot password?'}</button></div><button className="primary full" type="submit" disabled={loginSubmitting || forgotSubmitting}>{loginSubmitting ? 'Signing in…' : 'Sign in securely'} <span>→</span></button>{loginMessage && <p className="login-message">{loginMessage}</p>}<small className="login-disclaimer">Only active Owner and Administrator accounts can access this portal.</small></form>
      </section>
    </main>;
  }

  return <main className="admin-portal-page"><header className="admin-portal-header"><a href="/" className="brand brand-image" aria-label="Pickle Point Arena public site"><img src="/header-logo-colored.png" alt="Pickle Point Arena" /></a><div><span className={`active-role ${staffRole}`}>{staffRole === 'owner' ? 'Owner' : 'Administrator'}</span><button onClick={signOut}>Sign out</button><a href="/">Public site ↗</a></div></header><section className="admin-dashboard-wrap"><OwnerPreview role={staffRole} session={staffSession} selectedDate={selectedDate} setSelectedDate={setSelectedDate} /></section></main>;
}

function OperationsCalendar({ selectedDate, setSelectedDate, refreshKey, role, session, onChanged }) {
  const [slotRows, setSlotRows] = useState([]);
  const [blockRows, setBlockRows] = useState([]);
  const [nowTick, setNowTick] = useState(Date.now());
  const [selectedBooking, setSelectedBooking] = useState(null);
  const [calendarMessage, setCalendarMessage] = useState('Loading live schedule…');
  const [cancelTarget, setCancelTarget] = useState(null);
  const [cancelPin, setCancelPin] = useState('');
  const [cancelMessage, setCancelMessage] = useState('');
  const [cancelSubmitting, setCancelSubmitting] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(true);
  const [availabilitySelections, setAvailabilitySelections] = useState(() => new Map());
  const [availabilityReason, setAvailabilityReason] = useState('Maintenance');
  const [availabilitySubmitting, setAvailabilitySubmitting] = useState(false);
  const loadRequestRef = useRef(0);
  const weekStart = useMemo(() => startOfWeek(selectedDate), [selectedDate]);
  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, index) => { const day = new Date(weekStart); day.setDate(weekStart.getDate() + index); return day; }), [weekStart]);

  const loadSchedule = useCallback(async ({ showLoading = false } = {}) => {
    const requestId = ++loadRequestRef.current;
    if (showLoading) setCalendarMessage('Loading live schedule…');
    const rangeStart = manilaSlotIso(selectedDate, 6);
    const rangeEnd = manilaSlotIso(selectedDate, 2);
    if (!session?.access_token) return;
    const response = await fetch(`/api/staff-schedule?from=${encodeURIComponent(rangeStart)}&to=${encodeURIComponent(rangeEnd)}`, { headers: { Authorization: `Bearer ${session.access_token}` } });
    const result = await response.json();
    if (requestId !== loadRequestRef.current) return;
    if (!response.ok) {
      setCalendarMessage('The live schedule could not be loaded. Retrying automatically…');
      return;
    }
    setSlotRows(result.slots || []);
    setBlockRows(result.blocks || []);
    setCalendarMessage('Schedule is current.');
  }, [selectedDate, session?.access_token]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowTick(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    loadSchedule({ showLoading: true });
  }, [loadSchedule, refreshKey]);

  useEffect(() => {
    let refreshTimer;
    const queueReload = () => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => loadSchedule(), 75);
    };
    const channel = supabase
      .channel(`staff-calendar-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'booking_slots' }, queueReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, queueReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'blocked_slots' }, queueReload)
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          // Close the query/subscription race so no booking can be missed while connecting.
          queueReload();
        }
      });

    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') queueReload();
    };
    window.addEventListener('focus', queueReload);
    window.addEventListener('online', queueReload);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    const reconciliationTimer = window.setInterval(queueReload, 5000);

    return () => {
      window.clearTimeout(refreshTimer);
      window.clearInterval(reconciliationTimer);
      window.removeEventListener('focus', queueReload);
      window.removeEventListener('online', queueReload);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      supabase.removeChannel(channel);
    };
  }, [loadSchedule]);

  const getSlotData = (hour, courtIndex) => {
    const start = new Date(manilaSlotIso(selectedDate, hour)).getTime();
    const end = start + 60 * 60 * 1000;
    const block = blockRows.find((row) => row.court_id === courtIndex + 1 && new Date(row.starts_at).getTime() < end && new Date(row.ends_at).getTime() > start);
    const row = slotRows.find((item) => item.court_id === courtIndex + 1 && Math.abs(new Date(item.slot_start).getTime() - start) < 1000);
    const mapped = { held: 'awaiting', payment_submitted: 'pending', confirmed: 'booked' };
    if (start <= nowTick) {
      if (row && mapped[row.status]) return { status: mapped[row.status], row, historical: true };
      if (block) return { status: 'blocked', block, historical: true };
      return { status: 'past', block, row, historical: true };
    }
    if (block) return { status: 'blocked', block };
    return { status: mapped[row?.status] || 'available', row };
  };

  const inspectSlot = (hour, courtIndex) => setSelectedBooking({ hour, courtIndex, ...getSlotData(hour, courtIndex) });

  const toggleAvailabilityCell = (hour, courtIndex, status) => {
    const courtId = courtIndex + 1;
    const key = `${selectedDate}|${hour}|${courtId}`;
    setAvailabilitySelections((current) => {
      const next = new Map(current);
      if (next.has(key)) next.delete(key);
      else next.set(key, { date: selectedDate, hour, courtId, status });
      return next;
    });
    setSelectedBooking(null);
  };

  const changeAvailability = async (action) => {
    const applicable = [...availabilitySelections.values()].filter((item) => action === 'block' ? item.status === 'available' : item.status === 'blocked');
    if (!applicable.length) return setCalendarMessage(`Select at least one ${action === 'block' ? 'available' : 'blocked'} court-hour.`);
    setAvailabilitySubmitting(true);
    setCalendarMessage(`${action === 'block' ? 'Blocking' : 'Unblocking'} selected court-hours…`);
    const response = await fetch('/api/staff-blocks', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` }, body: JSON.stringify({ action, reason: availabilityReason, selections: applicable }) });
    const result = await response.json();
    if (response.ok) {
      setCalendarMessage(`${result.changed || 0} court-hour${result.changed === 1 ? '' : 's'} ${action === 'block' ? 'blocked' : 'unblocked'} successfully.${result.skipped ? ` ${result.skipped} unchanged.` : ''}`);
      setAvailabilitySelections(new Map());
      await loadSchedule();
      onChanged?.();
    } else setCalendarMessage(result.error || 'Court availability could not be updated.');
    setAvailabilitySubmitting(false);
  };

  const cancelConfirmedBooking = async () => {
    if (!cancelTarget?.bookingId || !/^\d{4}$/.test(cancelPin)) return setCancelMessage('Enter the Owner’s four-digit cancellation PIN.');
    setCancelSubmitting(true);
    setCancelMessage('');
    const response = await fetch('/api/owner-pin', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` }, body: JSON.stringify({ bookingId: cancelTarget.bookingId, pin: cancelPin }) });
    const result = await response.json();
    if (response.ok) {
      setCancelTarget(null);
      setCancelPin('');
      setSelectedBooking(null);
      await loadSchedule();
      onChanged?.();
    } else setCancelMessage(result.error || 'The booking could not be cancelled.');
    setCancelSubmitting(false);
  };

  const selectedAvailable = [...availabilitySelections.values()].filter((item) => item.status === 'available').length;
  const selectedBlocked = [...availabilitySelections.values()].filter((item) => item.status === 'blocked').length;

  return <section className={`operations-calendar ${scheduleOpen ? 'expanded' : 'collapsed'}`}>
    <button className="operations-heading operations-toggle" type="button" aria-expanded={scheduleOpen} onClick={() => { setScheduleOpen((open) => !open); setSelectedBooking(null); }}><div><small>INTERNAL SCHEDULE</small><h3>Bookings & court status</h3><p>View bookings or select court-hours to block and unblock.</p></div><b>{scheduleOpen ? '−' : '+'}</b></button>
    {scheduleOpen && <div className="operations-calendar-content"><label className="operations-date-picker">Date<input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} /></label><div className="week-strip operations-week">{weekDays.map((day) => <button key={dateKey(day)} className={dateKey(day) === selectedDate ? 'active' : ''} onClick={() => setSelectedDate(dateKey(day))}><small>{day.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase()}</small><strong>{day.getDate()}</strong></button>)}</div>
    <div className="schedule-wrap operations-schedule"><table className="schedule-table"><thead><tr><th>TIME</th>{courtNames.map((court) => <th key={court}>{court}</th>)}</tr></thead><tbody>{hours.map((hour) => <tr key={hour}><th>{timeRange(hour)}</th>{courtNames.map((court, courtIndex) => { const { status } = getSlotData(hour, courtIndex); const isPast = status === 'past'; const availabilityKey = `${selectedDate}|${hour}|${courtIndex + 1}`; const chosen = availabilitySelections.has(availabilityKey); return <td key={court}><button className={`slot ${status} ${chosen ? 'staff-selected' : ''}`} disabled={isPast} onClick={() => { if (isPast) return; if (status === 'available' || status === 'blocked') toggleAvailabilityCell(hour, courtIndex, status); else inspectSlot(hour, courtIndex); }} aria-pressed={chosen} aria-label={`${court}, ${timeRange(hour)}, ${statusDetails[status].label}`}><span>{chosen ? 'SELECTED' : statusDetails[status].short}</span></button></td>; })}</tr>)}</tbody></table></div>
    {availabilitySelections.size > 0 && <div className="availability-batch"><div><small>BATCH AVAILABILITY</small><strong>{availabilitySelections.size} court-hour{availabilitySelections.size === 1 ? '' : 's'} selected across one or more days</strong><span>{selectedAvailable} available · {selectedBlocked} blocked</span></div><label>Blocking reason<select value={availabilityReason} onChange={(event) => setAvailabilityReason(event.target.value)}><option>Maintenance</option><option>Private event</option><option>Weather</option><option>Venue closure</option></select></label><button type="button" className="block-selected" disabled={availabilitySubmitting || !selectedAvailable} onClick={() => changeAvailability('block')}>Block selected</button><button type="button" className="unblock-selected" disabled={availabilitySubmitting || !selectedBlocked} onClick={() => changeAvailability('unblock')}>Unblock selected</button><button type="button" className="clear-selected" disabled={availabilitySubmitting} onClick={() => setAvailabilitySelections(new Map())}>Clear</button></div>}
    {selectedBooking && <div className="booking-inspector"><span className={`inspector-status ${selectedBooking.status}`}>{statusDetails[selectedBooking.status].short}</span><div><small>SELECTED SLOT</small><strong>{courtNames[selectedBooking.courtIndex]} · {timeRange(selectedBooking.hour)}</strong><p>{selectedBooking.status === 'past' ? (selectedBooking.row ? `${selectedBooking.row?.bookings?.tracking_number || 'Historical booking'} · ${selectedBooking.row?.bookings?.customer_name || 'Customer'}` : 'This hour has already passed and is no longer bookable.') : selectedBooking.status === 'available' ? 'This slot is open for customer booking.' : selectedBooking.status === 'blocked' ? `Blocked by venue: ${selectedBooking.block?.reason || 'Unavailable'}.` : `${selectedBooking.row?.bookings?.tracking_number || 'Booking'} · ${selectedBooking.row?.bookings?.customer_name || 'Customer'}`}</p></div>{role === 'owner' && selectedBooking.status === 'booked' && <button className="cancel-booking-button" type="button" onClick={() => setCancelTarget({ bookingId: selectedBooking.row?.booking_id, tracking: selectedBooking.row?.bookings?.tracking_number })}>Cancel booking</button>}<button className="close-inspector" onClick={() => setSelectedBooking(null)}>×</button></div>}
    <p className="operations-note">{calendarMessage} · reconciles every 5 seconds.</p></div>}
    {cancelTarget && <div className="cancel-booking-modal" role="dialog" aria-modal="true" aria-label="Cancel confirmed booking"><div><button className="modal-close" type="button" onClick={() => setCancelTarget(null)}>×</button><small>OWNER CANCELLATION</small><h3>Cancel {cancelTarget.tracking || 'this booking'}?</h3><p>This releases every court slot in the confirmed booking. Enter your four-digit Owner PIN to continue.</p><label>Cancellation PIN<input type="password" inputMode="numeric" maxLength="4" value={cancelPin} onChange={(event) => setCancelPin(event.target.value.replace(/\D/g, '').slice(0, 4))} autoFocus /></label>{cancelMessage && <p className="cancel-error">{cancelMessage}</p>}<button className="confirm-cancellation" type="button" onClick={cancelConfirmedBooking} disabled={cancelSubmitting}>{cancelSubmitting ? 'Cancelling…' : 'Cancel confirmed booking'}</button></div></div>}
  </section>;
}

function PaymentReview({ session, refreshKey, onChanged, activityPanel }) {
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [workingId, setWorkingId] = useState('');
  const [receiptPreview, setReceiptPreview] = useState(null);
  const [reviewNow, setReviewNow] = useState(Date.now());

  const loadBookings = useCallback(async () => {
    if (!session?.access_token) return;
    setLoading(true);
    const response = await fetch('/api/staff-bookings', { headers: { Authorization: `Bearer ${session.access_token}` } });
    const result = await response.json();
    if (response.ok) setBookings(result.bookings || []);
    else setMessage(result.error || 'Bookings could not be loaded.');
    setLoading(false);
  }, [session?.access_token]);

  useEffect(() => { loadBookings(); }, [loadBookings, refreshKey]);
  useEffect(() => {
    const timer = window.setInterval(() => setReviewNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!session?.access_token) return undefined;
    let refreshTimer;
    const queueReload = () => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(loadBookings, 75);
    };
    const channel = supabase
      .channel(`staff-payment-review-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, queueReload)
      .subscribe((status) => { if (status === 'SUBSCRIBED') queueReload(); });
    const refreshWhenVisible = () => { if (document.visibilityState === 'visible') queueReload(); };
    window.addEventListener('focus', queueReload);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    const reconciliationTimer = window.setInterval(queueReload, 20000);
    return () => {
      window.clearTimeout(refreshTimer);
      window.clearInterval(reconciliationTimer);
      window.removeEventListener('focus', queueReload);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      supabase.removeChannel(channel);
    };
  }, [loadBookings, session?.access_token]);

  const review = async (bookingId, action) => {
    setWorkingId(bookingId);
    setMessage('');
    const response = await fetch('/api/staff-bookings', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ bookingId, action }) });
    const result = await response.json();
    if (response.ok) {
      setMessage(action === 'undo' ? 'The decision was undone and returned to payment review.' : action === 'confirm' ? 'Payment verified and booking confirmed.' : 'Payment rejected and court slots released.');
      await loadBookings();
      onChanged();
    } else setMessage(result.error || 'The booking could not be updated.');
    setWorkingId('');
  };

  const pending = bookings.filter((booking) => booking.status === 'payment_submitted');
  const recentActivities = bookings.filter((booking) => {
    if (!['confirmed', 'rejected'].includes(booking.status)) return false;
    const payment = Array.isArray(booking.payments) ? booking.payments[0] : booking.payments;
    const reviewedAt = new Date(payment?.reviewed_at || 0).getTime();
    return reviewedAt && reviewNow - reviewedAt <= 7 * 24 * 60 * 60 * 1000;
  }).slice(0, 20);

  return <>
    <section className="payment-review-card">
      <div className="review-heading"><div><small>PAYMENT VERIFICATION</small><h3>Receipts awaiting review</h3><p>Open the private proof, match its reference number and amount, then confirm or reject.</p></div><button onClick={loadBookings} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button></div>
      {message && <p className="review-message">{message}</p>}
      {!loading && pending.length === 0 ? <p className="review-empty">No payment proofs are waiting for verification.</p> : <div className="review-list">{pending.map((booking) => {
        const payment = Array.isArray(booking.payments) ? booking.payments[0] : booking.payments;
        const receiptExpired = !payment?.receipt_path && payment?.submitted_at && Date.now() - new Date(payment.submitted_at).getTime() >= 12 * 60 * 60 * 1000;
        return <article key={booking.id}><div><small>{booking.tracking_number}</small><strong>{booking.customer_name}</strong><span>{booking.customer_email}</span><time dateTime={payment?.submitted_at}>Submitted {activityTimestamp(payment?.submitted_at)}</time></div><div><small>AMOUNT</small><strong>₱{Number(booking.total_amount).toLocaleString()}</strong><span>Ref: {payment?.reference_number || '—'}</span></div><div><small>SCHEDULE</small><strong>{booking.booking_slots?.length || 0} court-hour{booking.booking_slots?.length === 1 ? '' : 's'}</strong><span>{booking.booking_slots?.[0] ? new Date(booking.booking_slots[0].slot_start).toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', hour: 'numeric' }) : '—'}</span></div><div className="review-actions">{booking.receiptUrl && <button type="button" onClick={() => setReceiptPreview({ url: booking.receiptUrl, isPdf: payment?.receipt_path?.toLowerCase().endsWith('.pdf'), tracking: booking.tracking_number, amount: Number(booking.total_amount), schedule: receiptScheduleSummary(booking.booking_slots) })}>Open receipt</button>}{receiptExpired && <span className="receipt-expired">Receipt deleted after 12 hours</span>}<button className="reject" disabled={workingId === booking.id} onClick={() => review(booking.id, 'reject')}>Reject</button><button className="confirm" disabled={workingId === booking.id} onClick={() => review(booking.id, 'confirm')}>{workingId === booking.id ? 'Saving…' : 'Confirm'}</button></div></article>;
      })}</div>}
    </section>
    <div className="dashboard-priority-row">
      {activityPanel}
      <section className="recent-activity-card"><div className="recent-activity-heading"><small>RECENT ACTIVITY · LAST 7 DAYS</small><h3>Payment decisions</h3><p>Undo is available for 30 minutes after each decision, whether used or not.</p></div><div className="decision-history recent-decision-list">{recentActivities.length === 0 ? <p className="recent-activity-empty">No payment decisions in the last seven days.</p> : recentActivities.map((booking) => {
        const payment = Array.isArray(booking.payments) ? booking.payments[0] : booking.payments;
        const reviewedAt = new Date(payment?.reviewed_at || 0).getTime();
        const undoExpired = !reviewedAt || reviewNow - reviewedAt >= 30 * 60 * 1000;
        const undoLimitReached = Number(booking.review_undo_count || 0) >= 2;
        const remainingMinutes = Math.max(0, Math.ceil((reviewedAt + 30 * 60 * 1000 - reviewNow) / 60000));
        return <article key={booking.id}><span className={`decision-status ${booking.status}`}>{booking.status === 'confirmed' ? 'Confirmed' : 'Rejected'}</span><div><strong>{booking.tracking_number} · {booking.customer_name}</strong><small>{activityTimestamp(payment?.reviewed_at)} · {relativeTime(payment?.reviewed_at)}{!undoExpired ? ` · ${remainingMinutes}m remaining` : ''}</small></div>{!undoExpired && !undoLimitReached && <button className="undo-decision" type="button" disabled={workingId === booking.id} onClick={() => review(booking.id, 'undo')}>Undo</button>}</article>;
      })}</div></section>
    </div>
    {receiptPreview && <div className="receipt-modal" role="dialog" aria-modal="true" aria-label={`Receipt for ${receiptPreview.tracking}`} onClick={() => setReceiptPreview(null)}><div onClick={(event) => event.stopPropagation()}><header><div><small>PAYMENT RECEIPT</small><strong>{receiptPreview.tracking}</strong></div><div className="receipt-check-summary"><small>EXPECTED PAYMENT</small><strong>₱{Number(receiptPreview.amount || 0).toLocaleString()}</strong><span>{receiptPreview.schedule || 'Schedule unavailable'}</span></div><button type="button" onClick={() => setReceiptPreview(null)} aria-label="Close receipt">×</button></header>{receiptPreview.isPdf ? <iframe src={receiptPreview.url} title={`Receipt ${receiptPreview.tracking}`} /> : <img src={receiptPreview.url} alt={`Payment receipt for ${receiptPreview.tracking}`} />}</div></div>}
  </>;
}

function OwnerSalesReport({ session, refreshKey }) {
  const [report, setReport] = useState(null);
  const [period, setPeriod] = useState('day');
  const [rangeStart, setRangeStart] = useState(manilaTodayKey());
  const [rangeEnd, setRangeEnd] = useState(manilaTodayKey());
  const [appliedRange, setAppliedRange] = useState({ from: manilaTodayKey(), to: manilaTodayKey() });
  const [salesRangeAnchor, setSalesRangeAnchor] = useState(null);
  const [salesHoverDate, setSalesHoverDate] = useState(null);
  const [salesCalendarMonth, setSalesCalendarMonth] = useState(() => new Date(`${manilaTodayKey()}T12:00:00`));
  const [salesCalendarOpen, setSalesCalendarOpen] = useState(false);
  const [selectedSalesCourts, setSelectedSalesCourts] = useState(() => new Set([1, 2, 3, 4, 5, 6]));
  const [message, setMessage] = useState('Loading confirmed sales…');

  const loadReport = useCallback(async () => {
    if (!session?.access_token) return;
    const rangeQuery = period === 'range' ? `&from=${encodeURIComponent(appliedRange.from)}&to=${encodeURIComponent(appliedRange.to)}` : '';
    const response = await fetch(`/api/reports?period=${period}${rangeQuery}`, { headers: { Authorization: `Bearer ${session.access_token}` } });
    const result = await response.json();
    if (response.ok) {
      setReport(result);
      setMessage('Confirmed payments only · live owner report.');
    } else setMessage(result.error || 'The sales report could not be loaded.');
  }, [period, appliedRange, session?.access_token]);

  useEffect(() => { loadReport(); }, [loadReport, refreshKey]);
  useEffect(() => {
    if (!session?.access_token) return undefined;
    let refreshTimer;
    const queueReload = () => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(loadReport, 75);
    };
    const channel = supabase
      .channel(`owner-sales-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, queueReload)
      .subscribe((status) => { if (status === 'SUBSCRIBED') queueReload(); });
    const reconciliationTimer = window.setInterval(queueReload, 5000);
    return () => {
      window.clearTimeout(refreshTimer);
      window.clearInterval(reconciliationTimer);
      supabase.removeChannel(channel);
    };
  }, [loadReport, session?.access_token]);

  const applyDateRange = (event) => {
    event.preventDefault();
    if (!rangeStart || !rangeEnd) return setMessage('Choose both a start date and an end date.');
    if (rangeEnd < rangeStart) return setMessage('The end date must be on or after the start date.');
    const rangeLength = Math.round((new Date(`${rangeEnd}T12:00:00Z`) - new Date(`${rangeStart}T12:00:00Z`)) / 86400000) + 1;
    if (rangeLength > 366) return setMessage('Choose a range of 366 days or fewer.');
    setMessage('Loading selected date range…');
    setAppliedRange({ from: rangeStart, to: rangeEnd });
    setPeriod('range');
  };

  const salesCalendarDays = useMemo(() => monthCalendarDays(salesCalendarMonth), [salesCalendarMonth]);
  const salesPreviewRange = useMemo(() => {
    if (!salesRangeAnchor || !salesHoverDate) return { start: rangeStart, end: rangeEnd };
    return salesHoverDate < salesRangeAnchor
      ? { start: salesHoverDate, end: salesRangeAnchor }
      : { start: salesRangeAnchor, end: salesHoverDate };
  }, [salesRangeAnchor, salesHoverDate, rangeStart, rangeEnd]);

  const chooseSalesRangeDate = (date) => {
    if (!salesRangeAnchor) {
      setRangeStart(date);
      setRangeEnd(date);
      setSalesRangeAnchor(date);
      setSalesHoverDate(date);
      return;
    }
    const from = date < salesRangeAnchor ? date : salesRangeAnchor;
    const to = date < salesRangeAnchor ? salesRangeAnchor : date;
    setRangeStart(from);
    setRangeEnd(to);
    setSalesRangeAnchor(null);
    setSalesHoverDate(null);
    setAppliedRange({ from, to });
    setPeriod('range');
    setMessage('Loading selected date range…');
  };

  const changeSalesCalendarMonth = (offset) => setSalesCalendarMonth((current) => new Date(current.getFullYear(), current.getMonth() + offset, 1, 12));

  const toggleSalesCourt = (courtId) => setSelectedSalesCourts((current) => {
    const next = new Set(current);
    if (next.has(courtId)) next.delete(courtId); else next.add(courtId);
    return next;
  });

  const toggleAllSalesCourts = () => setSelectedSalesCourts((current) => current.size === 6 ? new Set() : new Set([1, 2, 3, 4, 5, 6]));

  const periodName = period === 'day' ? 'day' : period === 'week' ? 'week' : period === 'month' ? 'month' : 'date range';
  const historyLabel = period === 'day' ? 'LAST 7 DAYS' : period === 'week' ? 'LAST 8 WEEKS' : period === 'month' ? 'LAST 12 MONTHS' : `${report?.rangeDays || 0} SELECTED DAY${report?.rangeDays === 1 ? '' : 'S'}`;
  const currentLabel = period === 'range' ? 'SELECTED RANGE' : `THIS ${periodName.toUpperCase()}`;
  const previousLabel = period === 'range' ? 'PRECEDING RANGE' : `PREVIOUS ${periodName.toUpperCase()}`;
  const comparisonLabel = period === 'range' ? 'preceding range of the same length' : `previous ${periodName}`;
  const selectedRangeButtonLabel = period === 'range'
    ? `${new Date(`${appliedRange.from}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${new Date(`${appliedRange.to}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
    : 'Select dates';
  const maximum = Math.max(1, ...(report?.series || []).map((item) => item.revenue));
  const change = Number(report?.changeAmount || 0);
  const changePercent = Number(report?.changePercent || 0);
  const selectedCourtRows = (report?.courtSales || []).filter((court) => selectedSalesCourts.has(court.courtId));
  const selectedCourtRevenue = selectedCourtRows.reduce((sum, court) => sum + Number(court.currentRevenue || 0), 0);
  const selectedCourtHours = selectedCourtRows.reduce((sum, court) => sum + Number(court.currentCourtHours || 0), 0);
  return <section className="owner-sales-report">
    <div className="sales-report-heading"><div><small>OWNER FINANCIAL REPORT</small><h3>Confirmed sales comparison</h3><p>{message}</p></div><div className="sales-heading-actions"><div className="period-toggle" aria-label="Revenue comparison period">{['day', 'week', 'month'].map((value) => <button type="button" className={period === value ? 'active' : ''} onClick={() => setPeriod(value)} key={value}>{value[0].toUpperCase() + value.slice(1)}</button>)}</div><button type="button" onClick={loadReport}>Refresh report</button></div></div>
    <div className="metric-grid">
      <article><small>{currentLabel}</small><strong>₱{Number(report?.currentRevenue || 0).toLocaleString()}</strong><span>{report?.currentBookings || 0} confirmed booking{report?.currentBookings === 1 ? '' : 's'}</span></article>
      <article><small>{previousLabel}</small><strong>₱{Number(report?.previousRevenue || 0).toLocaleString()}</strong><span>{report?.previousBookings || 0} confirmed booking{report?.previousBookings === 1 ? '' : 's'}</span></article>
      <article><small>CHANGE VS PREVIOUS</small><strong className={change >= 0 ? 'up' : 'attention'}>{change >= 0 ? '+' : '−'}₱{Math.abs(change).toLocaleString()}</strong><span>{changePercent >= 0 ? '+' : ''}{changePercent}% compared with the {comparisonLabel}</span></article>
      <article><small>ALL-TIME CONFIRMED SALES</small><strong>₱{Number(report?.totalRevenue || 0).toLocaleString()}</strong><span>{report?.confirmedBookings || 0} bookings · {report?.courtHours || 0} court-hours</span></article>
    </div>
    <section className={`court-sales-report ${salesCalendarOpen ? 'calendar-open' : ''}`}>
      <div className="court-sales-heading"><div><small>SALES BY COURT · {currentLabel}</small><h3>Every court&apos;s confirmed sales</h3><p>Choose one day or an inclusive start-to-end range to combine sales across several dates.</p></div><button className="court-sales-calendar-toggle" type="button" aria-expanded={salesCalendarOpen} onClick={() => { setSalesCalendarOpen((open) => !open); setSalesRangeAnchor(null); setSalesHoverDate(null); }}><span aria-hidden="true">▣</span><strong>{selectedRangeButtonLabel}</strong><small>{salesCalendarOpen ? 'Close calendar' : period === 'range' ? `₱${selectedCourtRevenue.toLocaleString()} selected total · Change dates` : 'Choose sales range'}</small></button></div>
      {salesCalendarOpen && <form className="court-sales-range" onSubmit={applyDateRange}><div className="sales-range-calendar range-calendar" onMouseLeave={() => { if (salesRangeAnchor) setSalesHoverDate(salesRangeAnchor); }}><div className="range-calendar-heading"><button type="button" onClick={() => changeSalesCalendarMonth(-1)} aria-label="Previous month">‹</button><strong>{salesCalendarMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</strong><button type="button" onClick={() => changeSalesCalendarMonth(1)} aria-label="Next month">›</button></div><div className="range-weekdays">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day) => <span key={day}>{day}</span>)}</div><div className="range-days">{salesCalendarDays.map((day) => { const key = dateKey(day); const outsideMonth = day.getMonth() !== salesCalendarMonth.getMonth(); const inRange = key >= salesPreviewRange.start && key <= salesPreviewRange.end; const endpoint = key === salesPreviewRange.start || key === salesPreviewRange.end; return <button type="button" key={key} className={`${outsideMonth ? 'outside' : ''} ${inRange ? 'in-range' : ''} ${endpoint ? 'endpoint' : ''}`} onMouseEnter={() => { if (salesRangeAnchor) setSalesHoverDate(key); }} onClick={() => chooseSalesRangeDate(key)} aria-label={`${salesRangeAnchor ? 'End' : 'Start'} sales range on ${day.toLocaleDateString()}`}>{day.getDate()}</button>; })}</div></div><div className="sales-range-controls"><div className="sales-range-intro"><strong>{salesRangeAnchor ? 'Now choose an end date' : 'Select sales dates'}</strong><span>Click once for the start and again for the end. Both dates are included.</span></div><div className="sales-range-inputs"><label>Start date<input type="date" value={rangeStart} max={rangeEnd || undefined} onChange={(event) => setRangeStart(event.target.value)} required /></label><span className="range-arrow" aria-hidden="true">→</span><label>End date<input type="date" value={rangeEnd} min={rangeStart || undefined} onChange={(event) => setRangeEnd(event.target.value)} required /></label></div><div className="sales-range-summary"><small>{salesRangeAnchor ? 'SELECT AN END DATE' : 'SELECTED DATE RANGE'}</small><strong>{new Date(`${salesPreviewRange.start}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} — {new Date(`${salesPreviewRange.end}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</strong></div><button type="submit" disabled={Boolean(salesRangeAnchor)}>Calculate range total</button></div></form>}
      <div className="court-sales-results">
        <div className="court-sales-grid-toolbar"><label className="court-master-selector"><input type="checkbox" checked={selectedSalesCourts.size === 6} onChange={toggleAllSalesCourts} /><span aria-hidden="true" /><strong>{selectedSalesCourts.size === 6 ? 'Deselect all' : 'Select all courts'}</strong></label><div><strong>{selectedSalesCourts.size} court{selectedSalesCourts.size === 1 ? '' : 's'} selected</strong><span>₱{selectedCourtRevenue.toLocaleString()} · {selectedCourtHours} paid court-hour{selectedCourtHours === 1 ? '' : 's'}</span></div></div>
        <div className="court-sales-grid">{(report?.courtSales || []).map((court) => { const selected = selectedSalesCourts.has(court.courtId); return <article className={selected ? 'court-selected' : 'court-deselected'} key={court.courtId}><div><label className="court-sales-selector"><input type="checkbox" checked={selected} onChange={() => toggleSalesCourt(court.courtId)} /><span aria-hidden="true" /><small>COURT {court.courtId}</small></label><strong>₱{Number(court.currentRevenue || 0).toLocaleString()}</strong></div><span>{court.currentCourtHours || 0} paid court-hour{court.currentCourtHours === 1 ? '' : 's'}</span><div className="court-sales-compare"><span>Previous: ₱{Number(court.previousRevenue || 0).toLocaleString()}</span><b className={court.changePercent >= 0 ? 'up' : 'down'}>{court.changePercent >= 0 ? '+' : ''}{court.changePercent || 0}%</b></div></article>; })}</div>
      </div>
    </section>
    <article className="chart-card sales-chart"><div className="card-title"><div><small>{historyLabel}</small><h3>{period === 'range' ? 'Daily confirmed revenue' : `${periodName[0].toUpperCase() + periodName.slice(1)}ly confirmed revenue`}</h3></div><span className="chart-badge">OWNER ONLY</span></div><div className="chart-area" style={{ gridTemplateColumns: `repeat(${report?.series?.length || 7}, minmax(52px, 1fr))` }}>{(report?.series || []).map((item) => <div className="bar-wrap" key={item.key}><span>₱{item.revenue.toLocaleString()}</span><div className={`bar ${item.revenue === maximum && item.revenue > 0 ? 'peak' : ''}`} style={{ height: `${Math.max(4, (item.revenue / maximum) * 100)}%` }} /><small>{item.label}</small></div>)}</div></article>
  </section>;
}

function OwnerPreview({ role = 'owner', session, selectedDate, setSelectedDate }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [blockStartDate, setBlockStartDate] = useState(selectedDate);
  const [blockEndDate, setBlockEndDate] = useState(selectedDate);
  const [blockDays, setBlockDays] = useState(() => new Set([0, 1, 2, 3, 4, 5, 6]));
  const [blockCells, setBlockCells] = useState(() => new Set(['17|1', '18|1']));
  const [blockReason, setBlockReason] = useState('Maintenance');
  const [blockMessage, setBlockMessage] = useState('');
  const [blockSubmitting, setBlockSubmitting] = useState(false);
  const [blockPanelOpen, setBlockPanelOpen] = useState(false);
  const [blockRangeAnchor, setBlockRangeAnchor] = useState(null);
  const [blockHoverDate, setBlockHoverDate] = useState(null);
  const [blockCalendarMonth, setBlockCalendarMonth] = useState(() => new Date(`${selectedDate}T12:00:00`));
  const [admins, setAdmins] = useState([]);
  const [adminName, setAdminName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminMessage, setAdminMessage] = useState('');
  const [adminSubmitting, setAdminSubmitting] = useState(false);
  const [ownerAccountOpen, setOwnerAccountOpen] = useState(false);
  const [adminManagerOpen, setAdminManagerOpen] = useState(false);
  const [expandedAdminId, setExpandedAdminId] = useState('');
  const [sessionAdminPasswords, setSessionAdminPasswords] = useState({});
  const [adminPinTarget, setAdminPinTarget] = useState(null);
  const [adminAccessPin, setAdminAccessPin] = useState('');
  const [adminAccessMessage, setAdminAccessMessage] = useState('');
  const [adminAccessSubmitting, setAdminAccessSubmitting] = useState(false);
  const [adminNewPassword, setAdminNewPassword] = useState('');
  const [adminPasswordOwnerPin, setAdminPasswordOwnerPin] = useState('');
  const [adminPasswordChangeMessage, setAdminPasswordChangeMessage] = useState('');
  const [adminPasswordChangeSubmitting, setAdminPasswordChangeSubmitting] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordMessage, setPasswordMessage] = useState('');
  const [passwordSubmitting, setPasswordSubmitting] = useState(false);
  const [cancellationPin, setCancellationPin] = useState('');
  const [confirmCancellationPin, setConfirmCancellationPin] = useState('');
  const [pinConfigured, setPinConfigured] = useState(false);
  const [pinMessage, setPinMessage] = useState('');
  const [pinSubmitting, setPinSubmitting] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const activityCleanupRef = useRef(0);

  const authorizedFetch = async (url, options = {}) => fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}`, ...(options.headers || {}) },
  });

  const loadAdmins = async () => {
    if (role !== 'owner' || !session?.access_token) return;
    const response = await authorizedFetch('/api/admins');
    const result = await response.json();
    if (response.ok) setAdmins(result.admins || []);
    else setAdminMessage(result.error || 'Administrators could not be loaded.');
  };

  const loadNotifications = async () => {
    if (!session?.user) return;
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    if (Date.now() - activityCleanupRef.current > 5 * 60 * 1000) {
      activityCleanupRef.current = Date.now();
      await authorizedFetch('/api/activity', { method: 'DELETE' });
    }
    const { data, error } = await supabase.from('notifications').select('id, kind, title, message, read_at, created_at, booking_id').gte('created_at', cutoff).order('created_at', { ascending: false }).limit(20);
    if (!error) setNotifications(data || []);
  };

  useEffect(() => { loadAdmins(); }, [role, session?.access_token]);
  useEffect(() => {
    if (role !== 'owner' || !session?.access_token) return;
    authorizedFetch('/api/owner-pin').then(async (response) => {
      const result = await response.json();
      if (response.ok) setPinConfigured(Boolean(result.configured));
    });
  }, [role, session?.access_token]);
  useEffect(() => {
    loadNotifications();
    const timer = window.setInterval(loadNotifications, 20000);
    return () => window.clearInterval(timer);
  }, [session?.user?.id, refreshKey]);

  const blockWeekdays = [
    { value: 1, label: 'Mon' }, { value: 2, label: 'Tue' }, { value: 3, label: 'Wed' },
    { value: 4, label: 'Thu' }, { value: 5, label: 'Fri' }, { value: 6, label: 'Sat' },
    { value: 0, label: 'Sun' },
  ];

  const blockDates = useMemo(() => {
    const start = new Date(`${blockStartDate}T12:00:00`);
    const end = new Date(`${blockEndDate}T12:00:00`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return [];
    const dates = [];
    const cursor = new Date(start);
    while (cursor <= end && dates.length < 367) {
      if (blockDays.has(cursor.getDay())) dates.push(dateKey(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    return dates;
  }, [blockStartDate, blockEndDate, blockDays]);

  const blockCalendarDays = useMemo(() => monthCalendarDays(blockCalendarMonth), [blockCalendarMonth]);
  const previewRange = useMemo(() => {
    if (!blockRangeAnchor || !blockHoverDate) return { start: blockStartDate, end: blockEndDate };
    return blockHoverDate < blockRangeAnchor
      ? { start: blockHoverDate, end: blockRangeAnchor }
      : { start: blockRangeAnchor, end: blockHoverDate };
  }, [blockRangeAnchor, blockHoverDate, blockStartDate, blockEndDate]);

  const chooseBlockRangeDate = (date) => {
    if (date < manilaTodayKey()) return;
    if (!blockRangeAnchor) {
      setBlockStartDate(date);
      setBlockEndDate(date);
      setBlockRangeAnchor(date);
      setBlockHoverDate(date);
      return;
    }
    setBlockStartDate(date < blockRangeAnchor ? date : blockRangeAnchor);
    setBlockEndDate(date < blockRangeAnchor ? blockRangeAnchor : date);
    setBlockRangeAnchor(null);
    setBlockHoverDate(null);
  };

  const changeBlockCalendarMonth = (offset) => setBlockCalendarMonth((current) => new Date(current.getFullYear(), current.getMonth() + offset, 1, 12));

  const toggleBlockDay = (day) => setBlockDays((current) => {
    const next = new Set(current);
    if (next.has(day)) next.delete(day); else next.add(day);
    return next;
  });

  const toggleBlockCell = (hour, courtId) => setBlockCells((current) => {
    const next = new Set(current);
    const key = `${hour}|${courtId}`;
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const toggleBlockRow = (hour) => setBlockCells((current) => {
    const next = new Set(current);
    const keys = courtNames.map((_, index) => `${hour}|${index + 1}`);
    const allSelected = keys.every((key) => next.has(key));
    keys.forEach((key) => allSelected ? next.delete(key) : next.add(key));
    return next;
  });

  const toggleBlockCourt = (courtId) => setBlockCells((current) => {
    const next = new Set(current);
    const keys = hours.map((hour) => `${hour}|${courtId}`);
    const allSelected = keys.every((key) => next.has(key));
    keys.forEach((key) => allSelected ? next.delete(key) : next.add(key));
    return next;
  });

  const createBlock = async () => {
    setBlockMessage('');
    if (blockEndDate < blockStartDate) return setBlockMessage('The end date must be on or after the start date.');
    const totalCalendarDays = Math.floor((new Date(`${blockEndDate}T12:00:00`) - new Date(`${blockStartDate}T12:00:00`)) / 86400000) + 1;
    if (totalCalendarDays > 366) return setBlockMessage('Choose a date range of one year or less.');
    if (!blockDays.size) return setBlockMessage('Select at least one weekday.');
    if (!blockCells.size) return setBlockMessage('Select at least one court and time.');

    const now = Date.now();
    const hourlySelections = [];
    blockDates.forEach((date) => {
      blockCells.forEach((key) => {
        const [hourValue, courtValue] = key.split('|').map(Number);
        const hourIndex = hours.indexOf(hourValue);
        const endHour = hourIndex === hours.length - 1 ? 2 : hours[hourIndex + 1];
        const startsAt = manilaSlotIso(date, hourValue);
        const endsAt = manilaSlotIso(date, endHour);
        if (new Date(endsAt).getTime() > now) hourlySelections.push({ date, hour: hourValue, courtId: courtValue, startsAt, endsAt, startMs: new Date(startsAt).getTime(), endMs: new Date(endsAt).getTime() });
      });
    });
    if (!hourlySelections.length) return setBlockMessage('All selected times have already passed.');
    if (hourlySelections.length > 10000) return setBlockMessage('This selection is too large. Shorten the date range or select fewer times.');

    const courts = [...new Set(hourlySelections.map((item) => item.courtId))];
    const minStart = hourlySelections.reduce((value, item) => item.startsAt < value ? item.startsAt : value, hourlySelections[0].startsAt);
    const maxEnd = hourlySelections.reduce((value, item) => item.endsAt > value ? item.endsAt : value, hourlySelections[0].endsAt);
    setBlockSubmitting(true);

    const [{ data: bookings, error: bookingError }, { data: existingBlocks, error: blockError }] = await Promise.all([
      supabase.from('booking_slots').select('id, court_id, slot_start, slot_end').in('court_id', courts).in('status', ['held', 'payment_submitted', 'confirmed']).lt('slot_start', maxEnd).gt('slot_end', minStart),
      supabase.from('blocked_slots').select('id, court_id, starts_at, ends_at').in('court_id', courts).lt('starts_at', maxEnd).gt('ends_at', minStart),
    ]);
    if (bookingError || blockError) {
      setBlockMessage('The schedule could not be checked. Please try again.');
      setBlockSubmitting(false);
      return;
    }

    const overlaps = (slot, startField, endField, item) => Number(slot.court_id) === item.courtId && new Date(slot[startField]).getTime() < item.endMs && new Date(slot[endField]).getTime() > item.startMs;
    const bookingConflicts = hourlySelections.filter((item) => (bookings || []).some((slot) => overlaps(slot, 'slot_start', 'slot_end', item)));
    if (bookingConflicts.length) {
      setBlockMessage(`${bookingConflicts.length} selected court-hour${bookingConflicts.length === 1 ? '' : 's'} already contain an active booking. Nothing was blocked; adjust the selection and try again.`);
      setBlockSubmitting(false);
      return;
    }

    const availableSelections = hourlySelections.filter((item) => !(existingBlocks || []).some((slot) => overlaps(slot, 'starts_at', 'ends_at', item)));
    if (!availableSelections.length) {
      setBlockMessage('Every selected court-hour is already blocked.');
      setBlockSubmitting(false);
      return;
    }

    const grouped = new Map();
    availableSelections.forEach((item) => {
      const key = `${item.date}|${item.courtId}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(item);
    });
    const rows = [];
    grouped.forEach((items) => {
      items.sort((a, b) => hours.indexOf(a.hour) - hours.indexOf(b.hour));
      let run = null;
      items.forEach((item) => {
        if (run && run.ends_at === item.startsAt) run.ends_at = item.endsAt;
        else {
          if (run) rows.push(run);
          run = { court_id: item.courtId, starts_at: item.startsAt, ends_at: item.endsAt, reason: blockReason, created_by: session.user.id };
        }
      });
      if (run) rows.push(run);
    });

    for (let index = 0; index < rows.length; index += 200) {
      const { error } = await supabase.from('blocked_slots').insert(rows.slice(index, index + 200));
      if (error) {
        setBlockMessage(error.message);
        setBlockSubmitting(false);
        return;
      }
    }

    const skipped = hourlySelections.length - availableSelections.length;
    await authorizedFetch('/api/activity', { method: 'POST', body: JSON.stringify({ title: 'Court availability blocked', message: `${availableSelections.length} court-hour${availableSelections.length === 1 ? '' : 's'} across ${blockDates.length} date${blockDates.length === 1 ? '' : 's'} · ${blockReason}` }) });
    setBlockMessage(`${availableSelections.length} court-hour${availableSelections.length === 1 ? '' : 's'} blocked successfully.${skipped ? ` ${skipped} already-blocked selection${skipped === 1 ? ' was' : 's were'} skipped.` : ''}`);
    setBlockSubmitting(false);
    setRefreshKey((value) => value + 1);
  };

  const generateAdminPassword = () => {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$';
    const values = new Uint32Array(14);
    window.crypto.getRandomValues(values);
    setAdminPassword(Array.from(values, (value) => alphabet[value % alphabet.length]).join(''));
  };

  const addAdmin = async (event) => {
    event.preventDefault();
    setAdminMessage('');
    if (!adminName.trim() || !adminEmail.trim() || !validStaffPassword(adminPassword)) return setAdminMessage(passwordRequirements);
    setAdminSubmitting(true);
    const response = await authorizedFetch('/api/admins', { method: 'POST', body: JSON.stringify({ fullName: adminName, email: adminEmail, password: adminPassword }) });
    const result = await response.json();
    if (response.ok) {
      if (result.admin?.id) {
        setSessionAdminPasswords((current) => ({ ...current, [result.admin.id]: adminPassword }));
      }
      setAdminMessage('Administrator created. Click their row and verify the Owner PIN to view the temporary password before this page is closed.');
      setAdminName(''); setAdminEmail(''); setAdminPassword('');
      await loadAdmins();
    } else setAdminMessage(result.error || 'The administrator could not be created.');
    setAdminSubmitting(false);
  };

  const deactivateAdmin = async (id) => {
    const response = await authorizedFetch('/api/admins', { method: 'DELETE', body: JSON.stringify({ id }) });
    const result = await response.json();
    setAdminMessage(response.ok ? 'Administrator access disabled.' : (result.error || 'Access could not be disabled.'));
    if (response.ok) await loadAdmins();
  };

  const requestAdminDetails = (admin) => {
    if (expandedAdminId === admin.id) {
      setExpandedAdminId('');
      setAdminNewPassword('');
      setAdminPasswordOwnerPin('');
      setAdminPasswordChangeMessage('');
      return;
    }
    if (!pinConfigured) {
      setAdminMessage('Set your four-digit Owner PIN in Account security before opening administrator details.');
      setOwnerAccountOpen(true);
      return;
    }
    setAdminPinTarget(admin);
    setAdminAccessPin('');
    setAdminAccessMessage('');
    setAdminNewPassword('');
    setAdminPasswordOwnerPin('');
    setAdminPasswordChangeMessage('');
  };

  const verifyAdminDetailsPin = async (event) => {
    event.preventDefault();
    if (!/^\d{4}$/.test(adminAccessPin) || !adminPinTarget) return setAdminAccessMessage('Enter the four-digit Owner PIN.');
    setAdminAccessSubmitting(true);
    setAdminAccessMessage('');
    const response = await authorizedFetch('/api/owner-pin', { method: 'POST', body: JSON.stringify({ action: 'verify', pin: adminAccessPin }) });
    const result = await response.json();
    if (response.ok && result.verified) {
      setExpandedAdminId(adminPinTarget.id);
      setAdminPinTarget(null);
      setAdminAccessPin('');
    } else setAdminAccessMessage(result.error || 'The Owner PIN could not be verified.');
    setAdminAccessSubmitting(false);
  };

  const generateAdminResetPassword = () => {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$';
    const values = new Uint32Array(14);
    window.crypto.getRandomValues(values);
    setAdminNewPassword(Array.from(values, (value) => alphabet[value % alphabet.length]).join(''));
    setAdminPasswordChangeMessage('');
  };

  const changeAdminPassword = async (adminId) => {
    setAdminPasswordChangeMessage('');
    if (!validStaffPassword(adminNewPassword)) return setAdminPasswordChangeMessage(passwordRequirements);
    if (!/^\d{4}$/.test(adminPasswordOwnerPin)) return setAdminPasswordChangeMessage('Enter the four-digit Owner PIN to authorize this password change.');
    setAdminPasswordChangeSubmitting(true);
    const response = await authorizedFetch('/api/admins', { method: 'PATCH', body: JSON.stringify({ id: adminId, password: adminNewPassword, ownerPin: adminPasswordOwnerPin }) });
    const result = await response.json();
    if (response.ok) {
      setSessionAdminPasswords((current) => ({ ...current, [adminId]: adminNewPassword }));
      setAdminNewPassword('');
      setAdminPasswordOwnerPin('');
      setAdminPasswordChangeMessage('Administrator password changed. The new password is visible above until this page is closed.');
    } else setAdminPasswordChangeMessage(result.error || 'The administrator password could not be changed.');
    setAdminPasswordChangeSubmitting(false);
  };

  const changePassword = async (event) => {
    event.preventDefault();
    setPasswordMessage('');
    if (!validStaffPassword(newPassword)) return setPasswordMessage(passwordRequirements);
    if (newPassword !== confirmPassword) return setPasswordMessage('The new passwords do not match.');
    setPasswordSubmitting(true);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email: session.user.email, password: currentPassword });
    if (signInError) {
      setPasswordMessage('The current password is incorrect.');
      setPasswordSubmitting(false);
      return;
    }
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) setPasswordMessage(error.message);
    else {
      setPasswordMessage('Password changed successfully.');
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
    }
    setPasswordSubmitting(false);
  };

  const saveCancellationPin = async (event) => {
    event.preventDefault();
    setPinMessage('');
    if (!/^\d{4}$/.test(cancellationPin)) return setPinMessage('Enter exactly four digits.');
    if (cancellationPin !== confirmCancellationPin) return setPinMessage('The PIN entries do not match.');
    setPinSubmitting(true);
    const response = await authorizedFetch('/api/owner-pin', { method: 'PUT', body: JSON.stringify({ pin: cancellationPin }) });
    const result = await response.json();
    if (response.ok) {
      setPinConfigured(true);
      setCancellationPin('');
      setConfirmCancellationPin('');
      setPinMessage('Cancellation PIN saved securely.');
    } else setPinMessage(result.error || 'The cancellation PIN could not be saved.');
    setPinSubmitting(false);
  };

  const markNotificationRead = async (notification) => {
    if (!notification.read_at) await supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', notification.id);
    setNotifications((current) => current.map((item) => item.id === notification.id ? { ...item, read_at: item.read_at || new Date().toISOString() } : item));
  };

  const markAllNotificationsRead = async () => {
    const readAt = new Date().toISOString();
    const { error } = await supabase.from('notifications').update({ read_at: readAt }).is('read_at', null);
    if (!error) setNotifications((current) => current.map((item) => ({ ...item, read_at: item.read_at || readAt })));
  };

  const unreadCount = notifications.filter((item) => !item.read_at).length;
  const activityPanel = <article className="activity-card activity-panel"><div className="card-title"><div><small>LIVE ACTIVITY · LAST 7 DAYS</small><h3>Needs attention</h3></div><div className="activity-heading-actions"><button type="button" onClick={markAllNotificationsRead} disabled={!unreadCount}>Mark all read</button><span className="notify-dot">{unreadCount}</span></div></div><div className="activity-list">{notifications.length === 0 ? <p className="activity-empty">No activity in the last seven days.</p> : notifications.map((item) => <div className={`activity ${item.read_at ? 'read' : ''}`} key={item.id}><span className={item.kind === 'booking_expired' ? 'activity-icon expired' : 'activity-icon'}>{item.kind === 'payment_submitted' ? '₱' : item.kind === 'booking_expired' ? '×' : '•'}</span><div><strong>{item.title}</strong><small>{item.message} · {activityTimestamp(item.created_at)} · {relativeTime(item.created_at)}</small></div><button onClick={() => markNotificationRead(item)} disabled={Boolean(item.read_at)}>{item.read_at ? 'Read' : 'Mark read'}</button></div>)}</div></article>;

  return (
    <div className="dashboard">
      <section className="dashboard-zone dashboard-intro-zone">
      <div className="dashboard-top"><div><span className="eyebrow dark">{role === 'owner' ? 'OWNER DASHBOARD' : 'ADMIN DASHBOARD'}</span><h2>Good morning.</h2><p>Live venue operations for bookings, payments, staff access, and court availability.</p></div></div>

      <PaymentReview session={session} refreshKey={refreshKey} onChanged={() => setRefreshKey((value) => value + 1)} activityPanel={activityPanel} />
      </section>

      <div className="dashboard-court-zone">
      <section className="dashboard-zone dashboard-schedule-zone">
      <OperationsCalendar selectedDate={selectedDate} setSelectedDate={setSelectedDate} refreshKey={refreshKey} role={role} session={session} onChanged={() => setRefreshKey((value) => value + 1)} />
      </section>

      {role === 'owner' && <section className="dashboard-zone dashboard-owner-zone">
      <OwnerSalesReport session={session} refreshKey={refreshKey} />

      {false && <section className={`block-manager ${blockPanelOpen ? 'expanded' : 'collapsed'}`}>
        <button className="block-panel-toggle" type="button" aria-expanded={blockPanelOpen} onClick={() => setBlockPanelOpen((open) => !open)}>
          <span><small>AVAILABILITY CONTROL</small><strong>Block multiple courts and times</strong><em>{blockPanelOpen ? 'Hide blocking controls' : 'Choose dates, courts, and times'}</em></span>
          <span className="block-summary"><strong>{blockCells.size * blockDates.length}</strong><em>court-hours selected</em><b>{blockPanelOpen ? '−' : '+'}</b></span>
        </button>
        {blockPanelOpen && <div className="block-panel-content">
          <div className="block-range-layout">
            <div className="range-calendar" onMouseLeave={() => { if (blockRangeAnchor) setBlockHoverDate(blockRangeAnchor); }}>
              <div className="range-calendar-heading"><button type="button" onClick={() => changeBlockCalendarMonth(-1)} aria-label="Previous month">‹</button><strong>{blockCalendarMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</strong><button type="button" onClick={() => changeBlockCalendarMonth(1)} aria-label="Next month">›</button></div>
              <div className="range-weekdays">{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => <span key={day}>{day}</span>)}</div>
              <div className="range-days">{blockCalendarDays.map((day) => {
                const key = dateKey(day);
                const outsideMonth = day.getMonth() !== blockCalendarMonth.getMonth();
                const unavailable = key < manilaTodayKey();
                const inRange = key >= previewRange.start && key <= previewRange.end;
                const endpoint = key === previewRange.start || key === previewRange.end;
                return <button type="button" key={key} disabled={unavailable} className={`${outsideMonth ? 'outside' : ''} ${inRange ? 'in-range' : ''} ${endpoint ? 'endpoint' : ''}`} onMouseEnter={() => { if (blockRangeAnchor && !unavailable) setBlockHoverDate(key); }} onClick={() => chooseBlockRangeDate(key)} aria-label={`${blockRangeAnchor ? 'End' : 'Start'} blocking range on ${day.toLocaleDateString()}`}>{day.getDate()}</button>;
              })}</div>
            </div>
            <div className="range-settings">
              <div className="range-selection-summary"><small>{blockRangeAnchor ? 'SELECT AN END DATE' : 'SELECTED DATE RANGE'}</small><strong>{new Date(`${previewRange.start}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} — {new Date(`${previewRange.end}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</strong><span>{blockRangeAnchor ? 'Hover to preview, then click to finish the range.' : `${blockDates.length} matching date${blockDates.length === 1 ? '' : 's'} selected.`}</span></div>
              <label>Reason<select value={blockReason} onChange={(event) => setBlockReason(event.target.value)}><option>Maintenance</option><option>Private event</option><option>Weather</option><option>Venue closure</option></select></label>
              <div className="repeat-day-control"><span>Apply on</span><div className="block-weekdays">{blockWeekdays.map((day) => <button type="button" key={day.value} className={blockDays.has(day.value) ? 'active' : ''} aria-pressed={blockDays.has(day.value)} onClick={() => toggleBlockDay(day.value)}>{day.label}</button>)}</div></div>
            </div>
          </div>
          <p className="block-help">Click individual cells, or click a court or time heading to select its full column or row.</p>
          <div className="block-schedule-wrap">
            <table className="block-schedule-table">
              <thead><tr><th>Time</th>{courtNames.map((court, index) => <th key={court}><button type="button" onClick={() => toggleBlockCourt(index + 1)}>{court}</button></th>)}</tr></thead>
              <tbody>{hours.map((hour) => <tr key={hour}><th><button type="button" onClick={() => toggleBlockRow(hour)}>{timeRange(hour)}</button></th>{courtNames.map((court, index) => { const key = `${hour}|${index + 1}`; const active = blockCells.has(key); return <td key={court}><button type="button" className={active ? 'selected' : ''} aria-pressed={active} aria-label={`${active ? 'Remove' : 'Select'} ${court}, ${timeRange(hour)}`} onClick={() => toggleBlockCell(hour, index + 1)}>{active ? 'BLOCK' : 'Available'}</button></td>; })}</tr>)}</tbody>
            </table>
          </div>
          <div className="block-footer"><div><strong>{blockDates.length}</strong> matching date{blockDates.length === 1 ? '' : 's'} in this range{blockMessage && <span className="block-message">{blockMessage}</span>}</div><button className="block-clear" type="button" onClick={() => setBlockCells(new Set())}>Clear times</button><button className="block-button" onClick={createBlock} disabled={blockSubmitting || !blockCells.size || !blockDates.length || Boolean(blockRangeAnchor)}>{blockSubmitting ? 'Saving…' : 'Block selected schedule'}</button></div>
        </div>}
      </section>}

      <section className="team-manager">
        <form className={`owner-account ${ownerAccountOpen ? 'expanded' : 'collapsed'}`} onSubmit={changePassword}>
          <button className="team-title team-toggle" type="button" aria-expanded={ownerAccountOpen} onClick={() => setOwnerAccountOpen((open) => !open)}><div><small>OWNER ACCOUNT</small><h3>Account security</h3></div><span><span className="role-badge">OWNER ONLY</span><b>{ownerAccountOpen ? '−' : '+'}</b></span></button>
          {ownerAccountOpen && <div className="team-panel-content">
            <label>Login email<input value={session?.user?.email || ''} readOnly /></label>
            <label>Current password<input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" required /></label>
            <label>New password<input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" minLength="7" aria-describedby="owner-password-rules" required /></label>
            <label>Confirm new password<input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" minLength="7" required /></label>
            <small id="owner-password-rules" className="password-rules">{passwordRequirements}</small>
            <button className="account-action" type="submit" disabled={passwordSubmitting}>{passwordSubmitting ? 'Changing…' : 'Change password'}</button>
            {passwordMessage && <p className="form-message">{passwordMessage}</p>}
            <div className="owner-pin-settings"><div><small>BOOKING CANCELLATION PIN</small><h4>Four-digit owner PIN</h4><span className={pinConfigured ? 'configured' : ''}>{pinConfigured ? 'PIN configured' : 'No PIN configured'}</span></div><label>New PIN<input type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength="4" value={cancellationPin} onChange={(event) => setCancellationPin(event.target.value.replace(/\D/g, '').slice(0, 4))} autoComplete="off" /></label><label>Confirm PIN<input type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength="4" value={confirmCancellationPin} onChange={(event) => setConfirmCancellationPin(event.target.value.replace(/\D/g, '').slice(0, 4))} autoComplete="off" /></label><button type="button" onClick={saveCancellationPin} disabled={pinSubmitting}>{pinSubmitting ? 'Saving…' : pinConfigured ? 'Change PIN' : 'Set PIN'}</button>{pinMessage && <p>{pinMessage}</p>}<small>The PIN is encrypted and cannot be displayed after saving.</small></div>
          </div>}
        </form>

        <form className={`admin-manager ${adminManagerOpen ? 'expanded' : 'collapsed'}`} onSubmit={addAdmin}>
          <button className="team-title team-toggle" type="button" aria-expanded={adminManagerOpen} onClick={() => setAdminManagerOpen((open) => !open)}><div><small>ADMIN ACCESS</small><h3>Add multiple administrators</h3></div><span><span className="role-badge admin">OWNER MANAGED</span><b>{adminManagerOpen ? '−' : '+'}</b></span></button>
          {adminManagerOpen && <div className="team-panel-content">
            <div className="admin-form-grid"><label>Full name<input value={adminName} onChange={(event) => setAdminName(event.target.value)} placeholder="Admin name" required /></label><label>Email address<input type="email" value={adminEmail} onChange={(event) => setAdminEmail(event.target.value)} placeholder="admin@email.com" required /></label><label>Temporary password<span className="password-input"><input type="text" value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} placeholder="5 letters + capital, number & symbol" minLength="7" aria-describedby="admin-password-rules" required /><button type="button" onClick={generateAdminPassword}>Generate</button></span><small id="admin-password-rules" className="password-rules">{passwordRequirements}</small></label><button className="add-admin-button" type="submit" disabled={adminSubmitting}>{adminSubmitting ? 'Creating…' : 'Add administrator'}</button></div>
            {adminMessage && <p className="form-message">{adminMessage}</p>}
            <p className="admin-note">Administrators can manage bookings, payments, and court availability. Passwords are never stored in readable form; newly created temporary passwords remain visible only until this page closes.</p>
            <div className="admin-list">{admins.length === 0 ? <span className="empty-admins">No administrator accounts yet.</span> : admins.map((admin) => {
              const expanded = expandedAdminId === admin.id;
              const temporaryPassword = sessionAdminPasswords[admin.id];
              return <div className={`admin-entry ${expanded ? 'expanded' : ''}`} key={admin.id}>
                <button className="admin-summary" type="button" aria-expanded={expanded} onClick={() => requestAdminDetails(admin)}><span className="admin-avatar">{(admin.full_name || 'A').slice(0, 1).toUpperCase()}</span><span><strong>{admin.full_name || 'Administrator'}</strong><small>{admin.email} · {admin.active ? 'Active' : 'Access disabled'}</small></span><b>{expanded ? '−' : '+'}</b></button>
                {admin.active && <button className="disable-admin" type="button" onClick={() => deactivateAdmin(admin.id)}>Disable</button>}
                {expanded && <div className="admin-credentials"><div className="admin-detail-grid"><span><small>FULL NAME</small><strong>{admin.full_name || 'Administrator'}</strong></span><span><small>EMAIL ADDRESS</small><strong>{admin.email}</strong></span><span><small>STATUS</small><strong>{admin.active ? 'Active' : 'Access disabled'}</strong></span><span><small>CREATED</small><strong>{activityTimestamp(admin.created_at)}</strong></span></div><div className="admin-password-detail"><small>CURRENTLY VISIBLE PASSWORD</small>{temporaryPassword ? <><code>{temporaryPassword}</code><button type="button" onClick={() => navigator.clipboard?.writeText(temporaryPassword)}>Copy</button></> : <p>The old password is irreversibly hashed. Set a new password below to make the replacement visible.</p>}</div><div className="admin-password-reset"><div><small>CHANGE ADMINISTRATOR PASSWORD</small><strong>Set or generate a new visible password</strong></div><label>New password<span className="password-input"><input type="text" value={adminNewPassword} onChange={(event) => setAdminNewPassword(event.target.value)} placeholder="New temporary password" autoComplete="off" /><button type="button" onClick={generateAdminResetPassword}>Generate</button></span></label><label>Owner PIN<input type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength="4" value={adminPasswordOwnerPin} onChange={(event) => setAdminPasswordOwnerPin(event.target.value.replace(/\D/g, '').slice(0, 4))} autoComplete="off" /></label><button className="save-admin-password" type="button" disabled={adminPasswordChangeSubmitting || !adminNewPassword || adminPasswordOwnerPin.length !== 4} onClick={() => changeAdminPassword(admin.id)}>{adminPasswordChangeSubmitting ? 'Changing…' : 'Change password'}</button>{adminPasswordChangeMessage && <p>{adminPasswordChangeMessage}</p>}<em>The new password remains visible only until this page is closed. If it is forgotten later, set another replacement.</em></div></div>}
              </div>;
            })}</div>
          </div>}
        </form>
      </section>

      {adminPinTarget && <div className="admin-pin-modal" role="dialog" aria-modal="true" aria-label="Verify Owner PIN" onClick={() => setAdminPinTarget(null)}><form onSubmit={verifyAdminDetailsPin} onClick={(event) => event.stopPropagation()}><button className="modal-close" type="button" onClick={() => setAdminPinTarget(null)}>×</button><small>OWNER VERIFICATION</small><h3>Open administrator details?</h3><p>Enter the four-digit Owner PIN to view {adminPinTarget.full_name || 'this administrator'}&apos;s protected account information.</p><label>Owner PIN<input type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength="4" value={adminAccessPin} onChange={(event) => setAdminAccessPin(event.target.value.replace(/\D/g, '').slice(0, 4))} autoComplete="off" autoFocus /></label>{adminAccessMessage && <p className="admin-pin-error">{adminAccessMessage}</p>}<button className="verify-admin-pin" type="submit" disabled={adminAccessSubmitting || adminAccessPin.length !== 4}>{adminAccessSubmitting ? 'Verifying…' : 'Verify and open'}</button></form></div>}
      </section>}
      </div>
    </div>
  );
}

export default App;
