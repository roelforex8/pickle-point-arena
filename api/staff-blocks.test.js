import assert from 'node:assert/strict';
import test from 'node:test';
import { handler, selectionInterval } from './staff-blocks.js';

const futureSelection = { date: '2030-01-15', hour: 6, courtId: 1 };
const futureStart = '2030-01-14T22:00:00.000Z';
const futureEnd = '2030-01-14T23:00:00.000Z';

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

function makeAdmin({ bookings = [], blocks = [] } = {}) {
  const calls = { inserts: [], deletes: [] };

  class Query {
    constructor(table) {
      this.table = table;
      this.operation = 'select';
    }
    select() { this.operation = 'select'; return this; }
    insert(rows) {
      calls.inserts.push({ table: this.table, rows });
      return Promise.resolve({ error: null });
    }
    delete() { this.operation = 'delete'; return this; }
    in(field, values) {
      if (this.operation === 'delete') calls.deletes.push({ table: this.table, field, values });
      return this;
    }
    lt() { return this; }
    gt() { return this; }
    then(resolve, reject) {
      const data = this.table === 'booking_slots' ? bookings : blocks;
      return Promise.resolve({ data, error: null }).then(resolve, reject);
    }
  }

  return {
    admin: { from(table) { return new Query(table); } },
    calls,
  };
}

async function invoke({ role = 'owner', authError, body, adminState } = {}) {
  const { admin, calls } = makeAdmin(adminState);
  const profile = { id: `${role}-id`, role, active: true, full_name: '' };
  const dependencies = {
    requireStaffFn: async () => authError || { admin, profile, user: { id: profile.id } },
    notify: async () => {},
  };
  const response = responseRecorder();
  await handler({ method: 'POST', headers: { authorization: 'Bearer test-token' }, body }, response, dependencies);
  return { response, calls };
}

for (const role of ['owner', 'admin']) {
  test(`authenticated ${role} can request a valid court block`, async () => {
    const { response, calls } = await invoke({
      role,
      body: { action: 'block', reason: 'Maintenance', selections: [futureSelection] },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { changed: 1, skipped: 0 });
    assert.equal(calls.inserts.length, 1);
    assert.deepEqual(calls.inserts[0].rows, [{
      court_id: 1,
      starts_at: futureStart,
      ends_at: futureEnd,
      reason: 'Maintenance',
      created_by: `${role}-id`,
    }]);
  });
}

test('unauthenticated and non-staff requests remain rejected', async (t) => {
  await t.test('unauthenticated', async () => {
    const { response, calls } = await invoke({
      authError: { error: 'Authentication required.', status: 401 },
      body: { action: 'block', selections: [futureSelection] },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(calls.inserts.length, 0);
  });

  await t.test('non-staff', async () => {
    const { response, calls } = await invoke({
      authError: { error: 'This account is not authorized.', status: 403 },
      body: { action: 'block', selections: [futureSelection] },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(calls.inserts.length, 0);
  });
});

test('invalid staff block payloads remain rejected', async () => {
  const { response, calls } = await invoke({
    body: { action: 'block', selections: [{ ...futureSelection, courtId: 7 }] },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /valid court-hours/i);
  assert.equal(calls.inserts.length, 0);
});

test('active booking conflicts return the stable safe conflict response', async () => {
  const { response, calls } = await invoke({
    body: { action: 'block', selections: [futureSelection] },
    adminState: {
      bookings: [{ court_id: 1, slot_start: futureStart, slot_end: futureEnd, status: 'confirmed' }],
    },
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.error, '1 selected court-hour contain active bookings. Nothing was changed.');
  assert.equal(calls.inserts.length, 0);
});

test('selection intervals preserve Asia/Manila court-hour conversion', () => {
  const interval = selectionInterval(futureSelection);
  assert.equal(new Date(interval.startMs).toISOString(), futureStart);
  assert.equal(new Date(interval.endMs).toISOString(), futureEnd);
});

test('existing unblock behavior remains unchanged', async () => {
  const { response, calls } = await invoke({
    role: 'admin',
    body: { action: 'unblock', selections: [futureSelection] },
    adminState: {
      blocks: [{ id: 'block-id', court_id: 1, starts_at: futureStart, ends_at: futureEnd, reason: 'Maintenance' }],
    },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { changed: 1, skipped: 0 });
  assert.deepEqual(calls.deletes, [{ table: 'blocked_slots', field: 'id', values: ['block-id'] }]);
  assert.equal(calls.inserts.length, 0);
});
