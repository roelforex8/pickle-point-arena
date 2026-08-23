import assert from 'node:assert/strict';
import test from 'node:test';

import { completeIdempotentOperation, pendingIdempotencyKey, resetIdempotencyForTests } from './idempotency.js';

test('identical pending operations reuse one cryptographically random UUID', () => {
  resetIdempotencyForTests();
  const first = pendingIdempotencyKey('payment:one', { method: 'gcash', amount: 310 });
  const retry = pendingIdempotencyKey('payment:one', { amount: 310, method: 'gcash' });
  assert.equal(retry, first);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test('changed payload receives a new key and completed operations do not reuse the old key', () => {
  resetIdempotencyForTests();
  const first = pendingIdempotencyKey('review:one', { action: 'confirm' });
  const changed = pendingIdempotencyKey('review:one', { action: 'reject' });
  assert.notEqual(changed, first);
  completeIdempotentOperation('review:one', changed);
  assert.notEqual(pendingIdempotencyKey('review:one', { action: 'reject' }), changed);
});
