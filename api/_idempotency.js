import { createHash } from 'node:crypto';

const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

export function canonicalPayload(value) {
  return JSON.stringify(canonicalize(value));
}

export function requestPayloadHash(value) {
  return createHash('sha256').update(canonicalPayload(value)).digest('hex');
}

export function parseIdempotency(body, payload) {
  const key = String(body?.idempotencyKey || '').trim().toLowerCase();
  if (!uuidV4Pattern.test(key)) {
    return { error: 'A valid idempotency key is required.' };
  }
  return { key, hash: requestPayloadHash(payload) };
}

export function idempotencyConflict(error) {
  return /idempotency_payload_mismatch/i.test(error?.message || '');
}

export function idempotencyInProgress(result) {
  return result?.disposition === 'in_progress';
}

export function rpcResult(data) {
  if (Array.isArray(data)) return data[0] || null;
  return data || null;
}
