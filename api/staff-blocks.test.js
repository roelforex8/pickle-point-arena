import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { handler, selectionInterval } from './staff-blocks.js';

const futureSelection = { date: '2030-01-15', hour: 6, courtId: 1 };
const futureStart = '2030-01-14T22:00:00.000Z';
const migrationSource = await readFile(new URL('../supabase/migrations/20260821010000_authoritative_court_occupancy.sql', import.meta.url), 'utf8');

function responseRecorder() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    status(value) { this.statusCode = value; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    end(value) { this.body = JSON.parse(value); },
  };
}

function makeAdmin({ rpcData = [{ changed: 1, skipped: 0 }], rpcError = null } = {}) {
  const calls = { rpc: [] };
  return {
    admin: {
      async rpc(name, args) {
        calls.rpc.push({ name, args });
        return { data: rpcData, error: rpcError };
      },
    },
    calls,
  };
}

async function invoke({ role = 'owner', authError, body, adminState, notify = async () => {} } = {}) {
  const { admin, calls } = makeAdmin(adminState);
  const profile = { id: `${role}-id`, role, active: true, full_name: '' };
  const response = responseRecorder();
  await handler(
    { method: 'POST', headers: { authorization: 'Bearer test-token' }, body },
    response,
    { requireStaffFn: async () => authError || { admin, profile, user: { id: profile.id } }, notify },
  );
  return { response, calls };
}

for (const role of ['owner', 'admin']) {
  test(`authenticated ${role} uses the atomic staff-block RPC`, async () => {
    const { response, calls } = await invoke({
      role,
      body: { action: 'block', reason: 'Maintenance', selections: [futureSelection] },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { changed: 1, skipped: 0 });
    assert.deepEqual(calls.rpc, [{
      name: 'manage_staff_blocked_slots',
      args: {
        p_created_by: `${role}-id`,
        p_action: 'block',
        p_reason: 'Maintenance',
        p_slots: [{ court_id: 1, slot_start: futureStart }],
      },
    }]);
  });
}

test('unauthenticated and non-staff requests remain rejected', async (t) => {
  for (const subject of [
    { label: 'unauthenticated', error: { error: 'Authentication required.', status: 401 } },
    { label: 'non-staff', error: { error: 'This account is not authorized.', status: 403 } },
  ]) {
    await t.test(subject.label, async () => {
      const { response, calls } = await invoke({
        authError: subject.error,
        body: { action: 'block', selections: [futureSelection] },
      });
      assert.equal(response.statusCode, subject.error.status);
      assert.equal(calls.rpc.length, 0);
    });
  }
});

test('invalid staff block payloads remain rejected', async () => {
  const { response, calls } = await invoke({
    body: { action: 'block', selections: [{ ...futureSelection, courtId: 7 }] },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /valid court-hours/i);
  assert.equal(calls.rpc.length, 0);
});

test('database occupancy conflicts return one stable safe response', async () => {
  const { response } = await invoke({
    body: { action: 'block', selections: [futureSelection] },
    adminState: { rpcError: { message: 'occupancy_conflict', code: 'P0001' } },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.error, 'One or more selected court-hours are no longer available. Nothing was changed.');
  assert.doesNotMatch(response.body.error, /postgres|unique|constraint|P0001/i);
});

test('selection intervals preserve Asia/Manila court-hour conversion', () => {
  const interval = selectionInterval(futureSelection);
  assert.equal(new Date(interval.startMs).toISOString(), futureStart);
  assert.equal(new Date(interval.endMs).toISOString(), '2030-01-14T23:00:00.000Z');
});

test('unblock uses the same atomic RPC and preserves changed/skipped counts', async () => {
  const { response, calls } = await invoke({
    role: 'admin',
    body: { action: 'unblock', selections: [futureSelection] },
    adminState: { rpcData: [{ changed: 0, skipped: 1 }] },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { changed: 0, skipped: 1 });
  assert.equal(calls.rpc[0].args.p_action, 'unblock');
});

test('a notification failure cannot turn a committed block into an API failure', async () => {
  const { response } = await invoke({
    body: { action: 'block', selections: [futureSelection] },
    notify: async () => { throw new Error('notification unavailable'); },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { changed: 1, skipped: 0 });
});

test('migration installs one private ledger, authoritative triggers, and a service-role-only RPC', () => {
  assert.match(migrationSource, /create table if not exists private\.court_hour_claims/i);
  assert.match(migrationSource, /primary key \(court_id, slot_start\)/i);
  assert.match(migrationSource, /booking_slots_occupancy_claim/i);
  assert.match(migrationSource, /blocked_slots_occupancy_claim/i);
  assert.match(migrationSource, /bookings_occupancy_transaction_lock/i);
  assert.match(migrationSource, /pg_advisory_xact_lock/i);
  assert.match(migrationSource, /security definer/i);
  assert.match(migrationSource, /set search_path = pg_catalog, public, private/i);
  assert.match(migrationSource, /revoke all on function public\.manage_staff_blocked_slots[^;]+from authenticated/i);
  assert.match(migrationSource, /grant execute on function public\.manage_staff_blocked_slots[^;]+to service_role/i);
  assert.match(migrationSource, /revoke insert, update, delete on public\.blocked_slots from anon, authenticated/i);
});
