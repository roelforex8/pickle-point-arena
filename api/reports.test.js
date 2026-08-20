import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { bookingSourceTotals, bookingsForSource, normalizeReportSource } from './reports.js';

const reportSource = await readFile(new URL('./reports.js', import.meta.url), 'utf8');

const bookings = [
  { id: 'online-1', booking_source: 'online', total_amount: 310, booking_slots: [{ court_id: 1 }] },
  { id: 'online-legacy', total_amount: 360, booking_slots: [{ court_id: 2 }] },
  { id: 'walk-in-1', booking_source: 'walk_in', total_amount: 650, booking_slots: [{ court_id: 1 }, { court_id: 2 }] },
];

test('report source filter supports All, Online, and Walk-In without duplication', () => {
  assert.equal(normalizeReportSource('invalid'), 'all');
  assert.deepEqual(bookingsForSource(bookings, 'all').map((booking) => booking.id), ['online-1', 'online-legacy', 'walk-in-1']);
  assert.deepEqual(bookingsForSource(bookings, 'online').map((booking) => booking.id), ['online-1', 'online-legacy']);
  assert.deepEqual(bookingsForSource(bookings, 'walk_in').map((booking) => booking.id), ['walk-in-1']);
});

test('combined totals equal Online plus Walk-In totals', () => {
  assert.deepEqual(bookingSourceTotals(bookings), {
    all: { bookingCount: 3, revenue: 1320, courtHours: 4 },
    online: { bookingCount: 2, revenue: 670, courtHours: 2 },
    walkIn: { bookingCount: 1, revenue: 650, courtHours: 2 },
  });
});

test('reports count confirmed bookings only and never query blocked slots as revenue', () => {
  assert.match(reportSource, /\.eq\('status', 'confirmed'\)/);
  assert.doesNotMatch(reportSource, /from\('blocked_slots'\)/);
});
