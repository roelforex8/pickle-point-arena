import assert from 'node:assert/strict';
import test from 'node:test';
import { postStaffWalkIn, postStaffWalkInCancellation, walkInBookingSummary, walkInHourlyRate } from './walkInBooking.js';

test('Walk-In pricing changes at 4 PM and never adds a booking fee', () => {
  assert.equal(walkInHourlyRate(6), 300);
  assert.equal(walkInHourlyRate(15), 300);
  assert.equal(walkInHourlyRate(16), 350);
  assert.equal(walkInHourlyRate(23), 350);
  assert.deepEqual(walkInBookingSummary([{ hour: 15 }, { hour: 16 }]), {
    items: [{ hour: 15, hourlyRate: 300 }, { hour: 16, hourlyRate: 350 }],
    courtHours: 2,
    subtotal: 650,
    bookingFee: 0,
    totalAmount: 650,
  });
});

test('Walk-In requests send only selections with the current authenticated session', async () => {
  let request;
  const client = { auth: { getSession: async () => ({ data: { session: { access_token: 'verified-token' } }, error: null }) } };
  const selections = [{ date: '2030-01-15', hour: 16, courtId: 2 }];
  await postStaffWalkIn(client, selections, async (url, options) => { request = { url, options }; return { ok: true }; });
  assert.equal(request.url, '/api/staff-walk-ins');
  assert.equal(request.options.headers.Authorization, 'Bearer verified-token');
  assert.deepEqual(JSON.parse(request.options.body), { selections });
  assert.doesNotMatch(request.options.body, /created|confirmed|admin|role/i);
});

test('multi-slot and multi-court summaries preserve every selection and mixed rates', () => {
  const selections = [
    { date: '2030-01-15', hour: 15, courtId: 1 },
    { date: '2030-01-15', hour: 16, courtId: 1 },
    { date: '2030-01-15', hour: 16, courtId: 2 },
  ];
  const summary = walkInBookingSummary(selections);
  assert.deepEqual(summary.items.map(({ courtId, hour, hourlyRate }) => ({ courtId, hour, hourlyRate })), [
    { courtId: 1, hour: 15, hourlyRate: 300 },
    { courtId: 1, hour: 16, hourlyRate: 350 },
    { courtId: 2, hour: 16, hourlyRate: 350 },
  ]);
  assert.equal(summary.courtHours, 3);
  assert.equal(summary.subtotal, 1000);
  assert.equal(summary.bookingFee, 0);
  assert.equal(summary.totalAmount, 1000);
});

test('non-consecutive and same-time different-court selections remain valid', () => {
  const summary = walkInBookingSummary([
    { date: '2030-01-15', hour: 8, courtId: 1 },
    { date: '2030-01-15', hour: 10, courtId: 1 },
    { date: '2030-01-15', hour: 10, courtId: 2 },
  ]);
  assert.equal(summary.items.length, 3);
  assert.equal(summary.totalAmount, 900);
});

test('Walk-In cancellation client sends only the booking ID with the current session', async () => {
  let request;
  const client = { auth: { getSession: async () => ({ data: { session: { access_token: 'verified-token' } }, error: null }) } };
  const bookingId = '11111111-1111-4111-8111-111111111111';
  await postStaffWalkInCancellation(client, bookingId, async (url, options) => { request = { url, options }; return { ok: true }; });
  assert.equal(request.url, '/api/staff-walk-in-cancellations');
  assert.equal(request.options.headers.Authorization, 'Bearer verified-token');
  assert.deepEqual(JSON.parse(request.options.body), { bookingId });
  assert.doesNotMatch(request.options.body, /cancelled|staff|admin|owner|role/i);
});
