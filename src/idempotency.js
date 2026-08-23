const pendingOperations = new Map();

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function randomUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (!bytes.some(Boolean)) throw new Error('Secure request identifiers are unavailable in this browser.');
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function pendingIdempotencyKey(operation, payload) {
  const signature = JSON.stringify(stableValue(payload));
  const current = pendingOperations.get(operation);
  if (current?.signature === signature) return current.key;
  const key = randomUuid();
  pendingOperations.set(operation, { signature, key });
  return key;
}

export function completeIdempotentOperation(operation, key) {
  const current = pendingOperations.get(operation);
  if (current?.key === key) pendingOperations.delete(operation);
}

export function resetIdempotencyForTests() {
  pendingOperations.clear();
}
