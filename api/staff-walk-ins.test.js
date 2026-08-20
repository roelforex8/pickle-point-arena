import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createStaffWalkInsHandler } from './staff-walk-ins.js';

const migrationSource = await readFile(new URL('../supabase/migrations/20260820020000_add_walk_in_bookings.sql', import.meta.url), 'utf8');
const onlineBookingSource = await readFile(new URL('./bookings.js', import.meta.url), 'utf8');

function responseRecorder() {
  return {
    headers: {}, statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    end(body) { this.body = JSON.parse(body); },
  };
}

function authenticatedSubject({ id = 'verified-profile-id', role = 'admin', rpcError = null } = {}) {
  const calls = { rpc: [] };
  const auth = {
    profile: { id, role, active: true, full_name: role === 'owner' ? 'Venue Owner' : 'Active Admin' },
    admin: {
      async rpc(name, payload) {
        calls.rpc.push({ name, payload });
        return rpcError ? { data: null, error: rpcError } : {
          data: [{ booking_id: 'walk-in-id', tracking_number: 'PPA-WALKIN', subtotal: 650, booking_fee: 0, total_amount: 650, confirmed_at: '2030-01-15T08:00:00Z' }],
          error: null,
        };
      },
    },
  };
  return { auth, calls };
}

const validSelections = [
  { date: '2099-01-15', hour: 15, courtId: 1 },
  { date: '2099-01-15', hour: 16, courtId: 2 },
];

for (const role of ['admin', 'owner']) {
  test(`active ${role} can create a Walk-In using the server-verified profile`, async () => {
    const subject = authenticatedSubject({ role });
    const handler = createStaffWalkInsHandler({ requireStaffFn: async () => subject.auth });
    const response = responseRecorder();
    await handler({ method: 'POST', body: { selections: validSelections }, headers: {} }, response);
    assert.equal(response.statusCode, 201);
    assert.equal(response.body.booking.bookingFee, 0);
    assert.equal(response.body.booking.totalAmount, 650);
    assert.equal(subject.calls.rpc[0].name, 'create_staff_walk_in_booking');
    assert.equal(subject.calls.rpc[0].payload.p_created_by, 'verified-profile-id');
    assert.equal('p_created_by' in response.body.booking, false);
  });
}

for (const [label, authResult, expectedStatus] of [
  ['unauthenticated caller', { error: 'Authentication required.', status: 401 }, 401],
  ['non-admin user', { error: 'This account is not authorized.', status: 403 }, 403],
  ['disabled admin', { error: 'This account is disabled.', status: 403 }, 403],
]) {
  test(`${label} is rejected`, async () => {
    const handler = createStaffWalkInsHandler({ requireStaffFn: async () => authResult });
    const response = responseRecorder();
    await handler({ method: 'POST', body: { selections: validSelections }, headers: {} }, response);
    assert.equal(response.statusCode, expectedStatus);
  });
}

test('client-supplied administrator identity is rejected before RPC execution', async () => {
  for (const field of ['created_by', 'createdBy', 'confirmed_by', 'confirmedBy', 'admin_id', 'adminId', 'admin_name', 'adminName', 'role']) {
    const subject = authenticatedSubject();
    const handler = createStaffWalkInsHandler({ requireStaffFn: async () => subject.auth });
    const response = responseRecorder();
    await handler({ method: 'POST', body: { selections: validSelections, [field]: 'impersonated-admin' }, headers: {} }, response);
    assert.equal(response.statusCode, 400, field);
    assert.equal(subject.calls.rpc.length, 0, field);
  }
});

test('duplicate selections are rejected and database conflicts return safe 409 responses', async () => {
  const subject = authenticatedSubject();
  const handler = createStaffWalkInsHandler({ requireStaffFn: async () => subject.auth });
  const duplicateResponse = responseRecorder();
  await handler({ method: 'POST', body: { selections: [validSelections[0], validSelections[0]] }, headers: {} }, duplicateResponse);
  assert.equal(duplicateResponse.statusCode, 400);
  assert.equal(subject.calls.rpc.length, 0);

  const conflictSubject = authenticatedSubject({ rpcError: { code: 'P0001', message: 'A selected court-hour is blocked by the venue.' } });
  const conflictHandler = createStaffWalkInsHandler({ requireStaffFn: async () => conflictSubject.auth });
  const conflictResponse = responseRecorder();
  await conflictHandler({ method: 'POST', body: { selections: validSelections }, headers: {} }, conflictResponse);
  assert.equal(conflictResponse.statusCode, 409);
  assert.doesNotMatch(conflictResponse.body.error, /postgres|constraint|P0001/i);
});

test('only POST is allowed and malformed or oversized requests are rejected', async () => {
  const subject = authenticatedSubject();
  const handler = createStaffWalkInsHandler({ requireStaffFn: async () => subject.auth });
  const methodResponse = responseRecorder();
  await handler({ method: 'GET', body: {}, headers: {} }, methodResponse);
  assert.equal(methodResponse.statusCode, 405);

  const malformedResponse = responseRecorder();
  await handler({ method: 'POST', body: '{invalid', headers: {} }, malformedResponse);
  assert.equal(malformedResponse.statusCode, 400);

  const oversizedResponse = responseRecorder();
  await handler({ method: 'POST', body: { selections: Array.from({ length: 501 }, () => validSelections[0]) }, headers: {} }, oversizedResponse);
  assert.equal(oversizedResponse.statusCode, 400);
  assert.equal(subject.calls.rpc.length, 0);
});

test('migration keeps Walk-In creation atomic, locked, confirmed, and service-role-only', () => {
  assert.match(migrationSource, /booking_source text not null default 'online'/i);
  assert.match(migrationSource, /check \(booking_source in \('online', 'walk_in'\)\)/i);
  assert.match(migrationSource, /'confirmed',[\s\S]+0,[\s\S]+0,[\s\S]+p_created_by,[\s\S]+'walk_in'/);
  assert.match(migrationSource, /if v_hour >= 6 and v_hour < 16 then\s+v_rate := 300;/);
  assert.match(migrationSource, /elsif v_hour >= 16 and v_hour <= 23 then\s+v_rate := 350;/);
  assert.match(migrationSource, /pg_advisory_xact_lock\(\s*hashtextextended\(v_court_id::text \|\| '\|' \|\| v_start::text, 0\)/);
  assert.match(migrationSource, /private\.expire_stale_bookings\(\)/);
  assert.match(migrationSource, /s\.status in \('held', 'payment_submitted', 'confirmed'\)/);
  assert.match(migrationSource, /tstzrange\(bs\.starts_at, bs\.ends_at, '\[\)'\)/);
  assert.match(migrationSource, /revoke all on function public\.create_staff_walk_in_booking\(uuid, jsonb\) from authenticated/);
  assert.match(migrationSource, /grant execute on function public\.create_staff_walk_in_booking\(uuid, jsonb\) to service_role/);
  assert.match(migrationSource, /confirmed_by,[\s\S]+booking_source[\s\S]+p_created_by,[\s\S]+'walk_in'/);
  assert.match(migrationSource, /Walk-In booking created by/);
});

test('online booking fee calculation remains unchanged', () => {
  assert.match(onlineBookingSource, /const bookingFee = pricedSlots\.length \* 10;/);
});
