import assert from 'node:assert/strict';
import test from 'node:test';

import { createActivityHandler } from './activity.js';

function responseRecorder() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    end(body) { this.body = JSON.parse(body); },
  };
}

function fakeAdmin() {
  const calls = { tables: [], notificationDeletes: 0, storageDeletes: 0, receiptPathUpdates: 0 };
  const admin = {
    storage: {
      from() {
        return {
          async remove() { calls.storageDeletes += 1; return { error: null }; },
        };
      },
    },
    from(table) {
      calls.tables.push(table);
      if (table === 'payments') {
        return {
          update(value) {
            if (value?.receipt_path === null) calls.receiptPathUpdates += 1;
            return { in: async () => ({ error: null }) };
          },
        };
      }
      if (table === 'notifications') {
        return {
          delete() {
            calls.notificationDeletes += 1;
            return { lt: async () => ({ error: null }) };
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  };
  return { admin, calls };
}

async function invoke(handler, { method = 'GET', authorization, userAgent } = {}) {
  const response = responseRecorder();
  await handler({
    method,
    headers: {
      ...(authorization ? { authorization } : {}),
      ...(userAgent ? { 'user-agent': userAgent } : {}),
    },
    body: {},
  }, response);
  return response;
}

function cronHandler(secret) {
  const { admin, calls } = fakeAdmin();
  let adminRequests = 0;
  const handler = createActivityHandler({
    getCronSecret: () => secret,
    getAdmin: () => { adminRequests += 1; return admin; },
  });
  return { handler, calls, getAdminRequests: () => adminRequests };
}

test('missing CRON_SECRET returns non-success without requesting an admin client', async () => {
  const subject = cronHandler(undefined);
  const response = await invoke(subject.handler, { authorization: 'Bearer ignored' });
  assert.equal(response.statusCode, 503);
  assert.equal(subject.getAdminRequests(), 0);
  assert.equal(subject.calls.notificationDeletes, 0);
});

test('missing or wrong bearer authorization returns 401 without cleanup', async () => {
  for (const authorization of [undefined, 'Bearer wrong-secret']) {
    const subject = cronHandler('local-test-secret');
    const response = await invoke(subject.handler, { authorization });
    assert.equal(response.statusCode, 401);
    assert.equal(subject.getAdminRequests(), 0);
    assert.equal(subject.calls.notificationDeletes, 0);
  }
});

test('spoofed Vercel cron User-Agent does not authorize cleanup', async () => {
  const subject = cronHandler('local-test-secret');
  const response = await invoke(subject.handler, { userAgent: 'vercel-cron/1.0' });
  assert.equal(response.statusCode, 401);
  assert.equal(subject.getAdminRequests(), 0);
});

test('correct bearer token performs notification retention only', async () => {
  const subject = cronHandler('local-test-secret');
  const response = await invoke(subject.handler, { authorization: 'Bearer local-test-secret' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(subject.calls.tables, ['notifications']);
  assert.equal(subject.calls.notificationDeletes, 1);
  assert.equal(subject.calls.storageDeletes, 0);
  assert.equal(subject.calls.receiptPathUpdates, 0);
});

test('DELETE is method-not-allowed and cannot run any cleanup', async () => {
  const subject = cronHandler('local-test-secret');
  const response = await invoke(subject.handler, { method: 'DELETE', authorization: 'Bearer local-test-secret' });
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.Allow, 'GET, POST');
  assert.equal(subject.getAdminRequests(), 0);
  assert.equal(subject.calls.notificationDeletes, 0);
  assert.equal(subject.calls.storageDeletes, 0);
  assert.equal(subject.calls.receiptPathUpdates, 0);
});
