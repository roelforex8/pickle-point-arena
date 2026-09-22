import assert from 'node:assert/strict';
import test from 'node:test';
import { nextDateInputValue } from './dateInput.js';

test('Admin date input keeps the last valid date for empty or malformed values', () => {
  const currentDate = '2030-01-15';
  assert.equal(nextDateInputValue(currentDate, '2030-01-16'), '2030-01-16');
  assert.equal(nextDateInputValue(currentDate, ''), currentDate);
  assert.equal(nextDateInputValue(currentDate, '2030-02-31'), currentDate);
  assert.equal(nextDateInputValue(currentDate, '01/16/2030'), currentDate);
});
