import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createStaffWalkInCancellationHandler } from './staff-walk-in-cancellations.js';

const migrationSource = await readFile(new URL('../supabase/migrations/20260820030000_add_walk_in_cancellation.sql', import.meta.url), 'utf8');
const fixMigrationSource = await readFile(new URL('../supabase/migrations/20260820040000_fix_walk_in_cancellation_rpc.sql', import.meta.url), 'utf8');
const validBookingId = '11111111-1111-4111-8111-111111111111';

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
  return {
    calls,
    auth: {
      profile: { id, role, active: true, full_name: role === 'owner' ? 'Venue Owner' : 'Active Admin' },
      admin: {
        async rpc(name, payload) {
          calls.rpc.push({ name, payload });
          return rpcError ? { data: null, error: rpcError } : {
            data: [{ booking_id: validBookingId, tracking_number: 'PPA-WALKIN', total_amount: 1000, cancelled_at: '2030-01-15T08:00:00Z' }],
            error: null,
          };
        },
      },
    },
  };
}

for (const role of ['admin', 'owner']) {
  test(`active ${role} cancels a Walk-In using only the server-verified identity`, async () => {
    const subject = authenticatedSubject({ role });
    const handler = createStaffWalkInCancellationHandler({ requireStaffFn: async () => subject.auth });
    const response = responseRecorder();
    await handler({ method: 'POST', body: { bookingId: validBookingId }, headers: {} }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.booking.status, 'cancelled');
    assert.equal(subject.calls.rpc[0].name, 'cancel_staff_walk_in_booking');
    assert.deepEqual(subject.calls.rpc[0].payload, { p_cancelled_by: 'verified-profile-id', p_booking_id: validBookingId });
    assert.equal('p_cancelled_by' in response.body.booking, false);
  });
}

for (const [label, authResult, expectedStatus] of [
  ['unauthenticated caller', { error: 'Authentication required.', status: 401 }, 401],
  ['non-staff caller', { error: 'This account is not authorized.', status: 403 }, 403],
  ['disabled staff caller', { error: 'This account is disabled.', status: 403 }, 403],
]) {
  test(`${label} cannot cancel a Walk-In`, async () => {
    const handler = createStaffWalkInCancellationHandler({ requireStaffFn: async () => authResult });
    const response = responseRecorder();
    await handler({ method: 'POST', body: { bookingId: validBookingId }, headers: {} }, response);
    assert.equal(response.statusCode, expectedStatus);
  });
}

test('client cannot select or impersonate the cancellation actor', async () => {
  for (const field of ['p_cancelled_by', 'cancelled_by', 'cancelledBy', 'staff_id', 'staffId', 'admin_id', 'adminId', 'admin_name', 'adminName', 'role']) {
    const subject = authenticatedSubject();
    const handler = createStaffWalkInCancellationHandler({ requireStaffFn: async () => subject.auth });
    const response = responseRecorder();
    await handler({ method: 'POST', body: { bookingId: validBookingId, [field]: 'impersonated-staff' }, headers: {} }, response);
    assert.equal(response.statusCode, 400, field);
    assert.equal(subject.calls.rpc.length, 0, field);
  }
});

test('malformed requests and non-POST methods are rejected before RPC execution', async () => {
  const subject = authenticatedSubject();
  const handler = createStaffWalkInCancellationHandler({ requireStaffFn: async () => subject.auth });
  for (const request of [
    { method: 'GET', body: {}, headers: {} },
    { method: 'POST', body: '{invalid', headers: {} },
    { method: 'POST', body: { bookingId: 'not-a-uuid' }, headers: {} },
    { method: 'POST', body: { bookingId: validBookingId, extra: true }, headers: {} },
  ]) {
    const response = responseRecorder();
    await handler(request, response);
    assert.ok([400, 405].includes(response.statusCode));
  }
  assert.equal(subject.calls.rpc.length, 0);
});

test('online and already-cancelled bookings receive the same safe conflict response', async () => {
  for (const databaseMessage of ['walk_in_not_cancellable', 'walk_in_slots_not_cancellable']) {
    const subject = authenticatedSubject({ rpcError: { code: 'P0001', message: databaseMessage } });
    const handler = createStaffWalkInCancellationHandler({ requireStaffFn: async () => subject.auth });
    const response = responseRecorder();
    await handler({ method: 'POST', body: { bookingId: validBookingId }, headers: {} }, response);
    assert.equal(response.statusCode, 409);
    assert.doesNotMatch(response.body.error, /postgres|P0001|walk_in_/i);
  }
});

test('migration performs whole-booking cancellation atomically without changing identity, source, or amount', () => {
  assert.match(migrationSource, /where b\.id = p_booking_id\s+and b\.booking_source = 'walk_in'\s+and b\.status = 'confirmed'\s+for update/i);
  assert.match(migrationSource, /count\(\*\) filter \(where s\.status in \('held', 'payment_submitted', 'confirmed'\)\)/i);
  assert.match(migrationSource, /v_active_slot_count <> v_total_slot_count/i);
  assert.match(migrationSource, /update public\.bookings\s+set status = 'cancelled'/i);
  assert.match(migrationSource, /update public\.booking_slots\s+set status = 'cancelled'/i);
  assert.match(migrationSource, /v_updated_slot_count <> v_active_slot_count/i);
  assert.match(migrationSource, /Walk-In booking cancelled by/);
  assert.match(migrationSource, /p\.id = p_cancelled_by[\s\S]+p\.active = true[\s\S]+p\.role in \('admin', 'owner'\)/i);
  assert.doesNotMatch(migrationSource, /set\s+(confirmed_by|booking_source|total_amount)\s*=/i);
  assert.doesNotMatch(migrationSource, /delete from/i);
  assert.match(migrationSource, /revoke all on function public\.cancel_staff_walk_in_booking\(uuid, uuid\) from authenticated/i);
  assert.match(migrationSource, /grant execute on function public\.cancel_staff_walk_in_booking\(uuid, uuid\) to service_role/i);
});

test('follow-up migration qualifies the booking-slot references without changing cancellation permissions', () => {
  assert.match(fixMigrationSource, /update public\.booking_slots as s\s+set status = 'cancelled'\s+where s\.booking_id = p_booking_id\s+and s\.status in \('held', 'payment_submitted', 'confirmed'\)/i);
  assert.match(fixMigrationSource, /security definer/i);
  assert.match(fixMigrationSource, /revoke all on function public\.cancel_staff_walk_in_booking\(uuid, uuid\) from anon/i);
  assert.match(fixMigrationSource, /revoke all on function public\.cancel_staff_walk_in_booking\(uuid, uuid\) from authenticated/i);
  assert.match(fixMigrationSource, /grant execute on function public\.cancel_staff_walk_in_booking\(uuid, uuid\) to service_role/i);
});
