import assert from 'node:assert/strict';
import test from 'node:test';

import { passwordInputType, passwordToggleLabel } from './passwordVisibility.js';

test('passwords are hidden by default and use the show label', () => {
  assert.equal(passwordInputType(false), 'password');
  assert.equal(passwordToggleLabel(false), 'Show password');
});

test('visible passwords use text type and the hide label', () => {
  assert.equal(passwordInputType(true), 'text');
  assert.equal(passwordToggleLabel(true), 'Hide password');
});
