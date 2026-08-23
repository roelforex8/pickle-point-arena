import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalPayload, parseIdempotency, requestPayloadHash } from './_idempotency.js';

test('payload hashing is stable across object key order but changes with content', () => {
  assert.equal(canonicalPayload({ b: 2, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":2}');
  assert.equal(requestPayloadHash({ b: 2, a: 1 }), requestPayloadHash({ a: 1, b: 2 }));
  assert.notEqual(requestPayloadHash({ a: 1 }), requestPayloadHash({ a: 2 }));
});

test('only UUID v4 client keys are accepted', () => {
  const accepted = parseIdempotency({ idempotencyKey: '123e4567-e89b-42d3-a456-426614174000' }, { action: 'confirm' });
  assert.equal(accepted.key, '123e4567-e89b-42d3-a456-426614174000');
  assert.match(accepted.hash, /^[0-9a-f]{64}$/);
  assert.ok(parseIdempotency({ idempotencyKey: '123e4567-e89b-12d3-a456-426614174000' }, {}).error);
});
