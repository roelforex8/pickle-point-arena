import assert from 'node:assert/strict';
import test from 'node:test';
import { createStaffScheduleHandler } from './staff-schedule.js';

function responseRecorder() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader() {},
    end(body) { this.body = JSON.parse(body); },
  };
}

function chain(result) {
  return {
    select() { return this; },
    gte() { return this; },
    lt() { return this; },
    gt() { return result; },
    in() { return result; },
  };
}

test('authenticated staff schedule returns the saved Walk-In name for every slot on the same booking', async () => {
  const slots = [
    { booking_id: 'walk-in-id', court_id: 1, slot_start: '2030-01-15T00:00:00.000Z', slot_end: '2030-01-15T01:00:00.000Z', status: 'confirmed', bookings: { booking_source: 'walk_in', walk_in_customer_name: 'Juan Dela Cruz' } },
    { booking_id: 'walk-in-id', court_id: 2, slot_start: '2030-01-15T01:00:00.000Z', slot_end: '2030-01-15T02:00:00.000Z', status: 'confirmed', bookings: { booking_source: 'walk_in', walk_in_customer_name: 'Juan Dela Cruz' } },
    { booking_id: 'historical-walk-in-id', court_id: 3, slot_start: '2030-01-15T02:00:00.000Z', slot_end: '2030-01-15T03:00:00.000Z', status: 'confirmed', bookings: { booking_source: 'walk_in', walk_in_customer_name: null } },
  ];
  const auth = {
    admin: {
      from(table) {
        return chain(table === 'booking_slots' ? { data: slots, error: null } : { data: [], error: null });
      },
    },
  };
  const handler = createStaffScheduleHandler({ requireStaffFn: async () => auth });
  const response = responseRecorder();
  await handler({ method: 'GET', query: { from: '2030-01-15T00:00:00.000Z', to: '2030-01-15T08:00:00.000Z' } }, response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.slots.map((slot) => slot.bookings.walk_in_customer_name), ['Juan Dela Cruz', 'Juan Dela Cruz', null]);
});
