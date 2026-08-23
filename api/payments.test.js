import assert from 'node:assert/strict';
import test from 'node:test';
import { compensateUnreferencedReceipt, createPaymentsHandler, normalizePaymentReference } from './payments.js';

const key = '11111111-1111-4111-8111-111111111111';
const bookingId = '22222222-2222-4222-8222-222222222222';
const fileSha256 = 'a'.repeat(64);

function responseRecorder() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, setHeader() {}, end(body) { this.body = JSON.parse(body); } };
}

function fakeAdmin({ rpcError = null, referenced = false, listUploaded = false, removeError = null } = {}) {
  const calls = { rpc: [], removed: [], signed: [] };
  const admin = {
    async rpc(name, args) {
      calls.rpc.push({ name, args });
      if (rpcError) return { data: null, error: rpcError };
      const path = `${bookingId}/${key}.png`;
      if (name.startsWith('prepare_')) return { data: { receiptPath: path, finalized: false }, error: null };
      return { data: { bookingId, trackingNumber: 'PPA-TEST', status: 'payment_submitted' }, error: null };
    },
    from(table) {
      assert.equal(table, 'payments');
      return { select() { return this; }, eq() { return this; }, limit: async () => ({ data: referenced ? [{ id: 'payment' }] : [], error: null }) };
    },
    storage: { from() { return {
      list: async () => ({ data: listUploaded ? [{ name: `${key}.png`, id: 'object' }] : [], error: null }),
      createSignedUploadUrl: async (path) => { calls.signed.push(path); return { data: { token: 'token' }, error: null }; },
      remove: async (paths) => { calls.removed.push(...paths); return { error: removeError }; },
    }; } },
  };
  return { admin, calls };
}

const booking = { id: bookingId, status: 'awaiting_payment', booking_source: 'online' };
const requestBody = { lookupMethod: 'tracking', lookupValue: 'PPA-TEST', paymentMethod: 'gcash', referenceNumber: '', mimeType: 'image/png', fileSize: 128, fileSha256, idempotencyKey: key };

test('blank optional payment reference uses the production-safe placeholder', () => {
  assert.equal(normalizePaymentReference('   '), 'Not provided');
});

test('prepare uses deterministic immutable path and recognizes an existing upload', async () => {
  const { admin, calls } = fakeAdmin({ listUploaded: true });
  const handler = createPaymentsHandler({ getAdmin: () => admin, findBooking: async () => booking });
  const response = responseRecorder();
  await handler({ method: 'POST', body: requestBody }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.path, `${bookingId}/${key}.png`);
  assert.equal(response.body.alreadyUploaded, true);
  assert.equal(calls.signed.length, 0);
  assert.equal(calls.rpc[0].name, 'prepare_customer_payment_upload_idempotent');
});

test('GCash and BPI finalize through the same atomic RPC in pending review', async (t) => {
  for (const paymentMethod of ['gcash', 'bpi']) await t.test(paymentMethod, async () => {
    const { admin, calls } = fakeAdmin();
    const handler = createPaymentsHandler({ getAdmin: () => admin, findBooking: async () => booking });
    const response = responseRecorder();
    await handler({ method: 'PUT', body: { ...requestBody, paymentMethod, receiptPath: `${bookingId}/${key}.png` } }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.booking.status, 'payment_submitted');
    assert.equal(calls.rpc[0].name, 'submit_customer_payment_idempotent');
    assert.equal(calls.rpc[0].args.p_method, paymentMethod);
    assert.equal(calls.rpc[0].args.p_reference_number, 'Not provided');
  });
});

test('same key with a different payload returns a safe conflict and preserves the object', async () => {
  const { admin, calls } = fakeAdmin({ rpcError: { code: 'P0001', message: 'idempotency_payload_mismatch private detail' } });
  const handler = createPaymentsHandler({ getAdmin: () => admin, findBooking: async () => booking });
  const response = responseRecorder();
  await handler({ method: 'PUT', body: { ...requestBody, receiptPath: `${bookingId}/${key}.png` } }, response);
  assert.equal(response.statusCode, 409);
  assert.equal(calls.removed.length, 0);
  assert.doesNotMatch(response.body.error, /private|P0001/i);
});

test('compensation removes only a proven unreferenced receipt', async () => {
  const unreferenced = fakeAdmin();
  assert.deepEqual(await compensateUnreferencedReceipt(unreferenced.admin, 'safe/path.png'), { outcome: 'removed', reason: 'proven_unreferenced' });
  assert.deepEqual(unreferenced.calls.removed, ['safe/path.png']);
  const referenced = fakeAdmin({ referenced: true });
  assert.deepEqual(await compensateUnreferencedReceipt(referenced.admin, 'safe/path.png'), { outcome: 'preserved', reason: 'referenced' });
  assert.equal(referenced.calls.removed.length, 0);
});

test('invalid metadata is rejected before any Storage or database mutation', async () => {
  const { admin, calls } = fakeAdmin();
  const handler = createPaymentsHandler({ getAdmin: () => admin, findBooking: async () => booking });
  const response = responseRecorder();
  await handler({ method: 'POST', body: { ...requestBody, fileSha256: 'bad' } }, response);
  assert.equal(response.statusCode, 400);
  assert.equal(calls.rpc.length, 0);
  assert.equal(calls.removed.length, 0);
});
