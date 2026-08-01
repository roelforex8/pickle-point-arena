import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function hashOwnerPin(pin) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(pin, salt, 32).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyOwnerPin(pin, stored) {
  const [, salt, expectedHex] = String(stored || '').split('$');
  if (!salt || !expectedHex) return false;
  const actual = scryptSync(pin, salt, 32);
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
