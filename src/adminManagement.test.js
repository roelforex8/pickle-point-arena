import assert from 'node:assert/strict';
import test from 'node:test';

import { administratorRemovalConfirmation, administratorStatusLabel, canConfirmAdministratorRemoval } from './adminManagement.js';

test('administrator removal requires the exact REMOVE confirmation', () => {
  assert.equal(administratorRemovalConfirmation, 'REMOVE');
  assert.equal(canConfirmAdministratorRemoval('REMOVE'), true);
  assert.equal(canConfirmAdministratorRemoval('remove'), false);
  assert.equal(canConfirmAdministratorRemoval(' REMOVE '), false);
  assert.equal(canConfirmAdministratorRemoval('REMOVE', true), false);
});

test('administrator statuses have clear customer-safe labels', () => {
  assert.equal(administratorStatusLabel('active'), 'Active');
  assert.equal(administratorStatusLabel('disabled'), 'Access disabled');
  assert.equal(administratorStatusLabel('removed'), 'Removed');
});
