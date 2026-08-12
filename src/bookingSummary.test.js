import test from 'node:test';
import assert from 'node:assert/strict';
import { groupBookingSlots } from './bookingSummary.js';

const slot = (court, start, end) => ({ court_id: court, slot_start: start, slot_end: end });

test('one court with one slot', () => {
  const result = groupBookingSlots([slot(1, '2026-08-25T11:00:00Z', '2026-08-25T12:00:00Z')]);
  assert.deepEqual(result[0].courts[0].ranges[0], { startTime: '7:00 PM', endTime: '8:00 PM', durationHours: 1, durationLabel: '1 hr' });
});

test('one court with three consecutive slots', () => {
  const result = groupBookingSlots([
    slot(4, '2026-08-25T13:00:00Z', '2026-08-25T14:00:00Z'),
    slot(4, '2026-08-25T11:00:00Z', '2026-08-25T12:00:00Z'),
    slot(4, '2026-08-25T12:00:00Z', '2026-08-25T13:00:00Z'),
  ]);
  assert.deepEqual(result[0].courts[0].ranges[0], { startTime: '7:00 PM', endTime: '10:00 PM', durationHours: 3, durationLabel: '3 hrs' });
});

test('multiple courts with consecutive slots are grouped and court-sorted', () => {
  const result = groupBookingSlots([
    slot(6, '2026-08-25T12:00:00Z', '2026-08-25T13:00:00Z'),
    slot(4, '2026-08-25T11:00:00Z', '2026-08-25T12:00:00Z'),
    slot(6, '2026-08-25T11:00:00Z', '2026-08-25T12:00:00Z'),
    slot(4, '2026-08-25T12:00:00Z', '2026-08-25T13:00:00Z'),
  ]);
  assert.deepEqual(result[0].courts.map((court) => [court.courtId, court.ranges[0].durationHours]), [[4, 2], [6, 2]]);
});

test('non-consecutive slots remain separate and start-time sorted', () => {
  const result = groupBookingSlots([
    slot(2, '2026-08-25T13:00:00Z', '2026-08-25T14:00:00Z'),
    slot(2, '2026-08-25T11:00:00Z', '2026-08-25T12:00:00Z'),
  ]);
  assert.deepEqual(result[0].courts[0].ranges.map((range) => `${range.startTime}–${range.endTime}`), ['7:00 PM–8:00 PM', '9:00 PM–10:00 PM']);
});

test('bookings across multiple dates are separated and date-sorted', () => {
  const result = groupBookingSlots([
    slot(1, '2026-08-26T11:00:00Z', '2026-08-26T12:00:00Z'),
    slot(1, '2026-08-25T11:00:00Z', '2026-08-25T12:00:00Z'),
  ]);
  assert.deepEqual(result.map((group) => group.dateLabel), ['August 25, 2026', 'August 26, 2026']);
});

test('Philippine timezone preserves the venue date across a UTC boundary', () => {
  const result = groupBookingSlots([slot(3, '2026-08-24T16:00:00Z', '2026-08-24T17:00:00Z')]);
  assert.equal(result[0].dateKey, '2026-08-25');
  assert.equal(result[0].dateLabel, 'August 25, 2026');
  assert.equal(result[0].courts[0].ranges[0].startTime, '12:00 AM');
});
