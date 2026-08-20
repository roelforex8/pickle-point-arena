import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const appSource = await readFile(new URL('./App.jsx', import.meta.url), 'utf8');
const styleSource = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
const staffScheduleSource = await readFile(new URL('../api/staff-schedule.js', import.meta.url), 'utf8');
const publicAvailabilitySource = await readFile(new URL('../api/availability.js', import.meta.url), 'utf8');
const walkInClientSource = await readFile(new URL('./walkInBooking.js', import.meta.url), 'utf8');

test('admin batch selection retains blocking and adds the Walk-In review flow', () => {
  assert.match(appSource, />Walk-In<\/button>/);
  assert.match(appSource, />Block selected<\/button>/);
  assert.match(appSource, /Review Walk-In booking/);
  assert.match(appSource, /Court-hours<strong>\{walkInSummary\.courtHours\}/);
  assert.match(appSource, /Booking fee<strong>₱0<\/strong>/);
  assert.match(appSource, /Total amount<strong>₱\{walkInSummary\.totalAmount/);
  assert.match(styleSource, /\.walk-in-modal/);
  assert.match(styleSource, /\.walk-in-selected/);
});

test('admin schedule identifies Walk-In while public availability remains ordinary booked state', () => {
  assert.match(staffScheduleSource, /booking_source/);
  assert.match(appSource, /booking_source === 'walk_in' \? 'walkIn' : 'booked'/);
  assert.match(appSource, /walkIn: \{ label: 'Confirmed Walk-In booking', short: 'Walk-In' \}/);
  assert.doesNotMatch(publicAvailabilitySource, /booking_source|walk_in|Walk-In/);
  assert.match(publicAvailabilitySource, /: 'booked';/);
});

test('Walk-In client submits slots only and does not enter payment or receipt flows', () => {
  assert.match(walkInClientSource, /body: JSON\.stringify\(\{ selections \}\)/);
  assert.doesNotMatch(walkInClientSource, /created_by|confirmed_by|payment|receipt/i);
});

test('owner report exposes All, Online, and Walk-In source controls and details', () => {
  assert.match(appSource, /\{ value: 'all', label: 'All' \}/);
  assert.match(appSource, /\{ value: 'online', label: 'Online' \}/);
  assert.match(appSource, /\{ value: 'walk_in', label: 'Walk-In' \}/);
  assert.match(appSource, /source=\$\{reportSource\}/);
  assert.match(appSource, /report\.walkInBookings\.map/);
  assert.match(appSource, /Created by \{booking\.createdBy\}/);
});
