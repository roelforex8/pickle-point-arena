import assert from 'node:assert/strict';
import test from 'node:test';
import { postStaffWalkIn, walkInBookingSummary, walkInHourlyRate } from './walkInBooking.js';

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
