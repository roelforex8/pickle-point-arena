import assert from 'node:assert/strict';
import test from 'node:test';
import { createPaymentsHandler, normalizePaymentReference } from './payments.js';

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

function booking(overrides = {}) {
  return {
    id: 'fake-booking-id',
    tracking_number: 'PPA-FAKE',
    customer_name: 'Test Customer',
    customer_email: 'test@example.invalid',
    status: 'awaiting_payment',
    subtotal: 100,
    booking_fee: 10,
    total_amount: 110,
    hold_expires_at: '2099-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    confirmed_at: null,
    booking_slots: [],
    payments: [],
    ...overrides,
  };
}

function fakeAdmin({ paymentError = null } = {}) {
  const calls = { paymentRecord: null, removed: [] };
  const admin = {
    storage: {
      from() {
        return {
          async remove(paths) { calls.removed.push(...paths); return { error: null }; },
          async createSignedUploadUrl() { return { data: { token: 'fake-token' }, error: null }; },
        };
      },
    },
    from(table) {
      if (table === 'payments') return {
        async upsert(record) { calls.paymentRecord = record; return { error: paymentError }; },
      };
      return {
        update() {
          const chain = { eq() { return chain; }, then(resolve) { resolve({ error: null }); } };
          return chain;
        },
      };
    },
  };
  return { admin, calls };
}

test('blank optional payment reference uses the production-safe placeholder', () => {
  assert.equal(normalizePaymentReference('   '), 'Not provided');
  assert.equal(normalizePaymentReference(null), 'Not provided');
  assert.equal(normalizePaymentReference('  AB-12  '), 'AB-12');
});

test('blank reference finalizes without inserting an empty or null database value', async () => {
  const { admin, calls } = fakeAdmin();
  const handler = createPaymentsHandler({
    getAdmin: () => admin,
    findBooking: async () => booking(),
    notify: async () => {},
  });
  const response = responseRecorder();

  await handler({ method: 'PUT', body: { referenceNumber: '', receiptPath: 'fake-booking-id/fake-receipt.png' } }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(calls.paymentRecord.reference_number, 'Not provided');
  assert.equal(calls.paymentRecord.method, 'gcash');
});

test('supported payment methods are stored in pending verification', async (t) => {
  for (const paymentMethod of ['gcash', 'maya', 'metrobank', 'bpi']) {
    await t.test(paymentMethod, async () => {
      const { admin, calls } = fakeAdmin();
      const handler = createPaymentsHandler({
        getAdmin: () => admin,
        findBooking: async () => booking(),
        notify: async () => {},
      });
      const response = responseRecorder();

      await handler({ method: 'PUT', body: { paymentMethod, receiptPath: 'fake-booking-id/fake-receipt.png' } }, response);

      assert.equal(response.statusCode, 200);
      assert.equal(calls.paymentRecord.method, paymentMethod);
      assert.equal(calls.paymentRecord.status, 'pending_verification');
      assert.equal(response.body.booking.status, 'payment_submitted');
      assert.equal(response.body.booking.payment.status, 'pending_verification');
    });
  }
});

test('invalid payment methods are rejected without creating a payment', async () => {
  const { admin, calls } = fakeAdmin();
  const handler = createPaymentsHandler({
    getAdmin: () => admin,
    findBooking: async () => booking(),
    notify: async () => {},
  });
  const response = responseRecorder();

  await handler({ method: 'PUT', body: { paymentMethod: 'verified', receiptPath: 'fake-booking-id/fake-receipt.png' } }, response);

  assert.equal(response.statusCode, 400);
  assert.equal(calls.paymentRecord, null);
});

test('payment insertion failure removes the newly uploaded object and hides database details', async () => {
  const { admin, calls } = fakeAdmin({ paymentError: new Error('private constraint detail') });
  const handler = createPaymentsHandler({
    getAdmin: () => admin,
    findBooking: async () => booking(),
    notify: async () => {},
  });
  const response = responseRecorder();

  await handler({ method: 'PUT', body: { referenceNumber: '', receiptPath: 'fake-booking-id/fake-receipt.png' } }, response);

  assert.equal(response.statusCode, 500);
  assert.deepEqual(calls.removed, ['fake-booking-id/fake-receipt.png']);
  assert.doesNotMatch(response.body.error, /constraint|database|private/i);
});

test('existing submitted proof is rejected before another upload is prepared', async () => {
  const { admin } = fakeAdmin();
  const handler = createPaymentsHandler({
    getAdmin: () => admin,
    findBooking: async () => booking({ status: 'payment_submitted', payments: [{ receipt_path: 'fake-booking-id/existing.png' }] }),
    notify: async () => {},
  });
  const response = responseRecorder();

  await handler({ method: 'POST', body: { mimeType: 'image/png', fileSize: 100 } }, response);

  assert.equal(response.statusCode, 409);
  assert.match(response.body.error, /already submitted/i);
});
