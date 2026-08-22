import assert from 'node:assert/strict';
import test from 'node:test';
import { publicBookingRpcError } from './bookings.js';

test('public booking occupancy conflicts return one stable safe 409 response', () => {
  for (const message of [
    'occupancy_conflict',
    'duplicate key value violates unique constraint "court_hour_claims_pkey"',
    'booking_slots_active_unique',
  ]) {
    const result = publicBookingRpcError({ message, code: 'P0001' });
    assert.deepEqual(result, {
      status: 409,
      message: 'One or more selected court-hours are no longer available. Nothing was booked.',
    });
    assert.doesNotMatch(result.message, /postgres|duplicate|unique|constraint|P0001|occupancy_conflict/i);
  }
});

test('unexpected public booking RPC errors never expose database internals', () => {
  const result = publicBookingRpcError({ message: 'relation private.court_hour_claims does not exist', code: '42P01' });
  assert.equal(result.status, 400);
  assert.equal(result.message, 'The booking request could not be completed. Please review the selected court-hours and try again.');
  assert.doesNotMatch(result.message, /private|relation|42P01|court_hour_claims/i);
});
