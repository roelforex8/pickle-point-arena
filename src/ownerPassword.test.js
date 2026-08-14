import assert from 'node:assert/strict';
import test from 'node:test';

import { changeOwnerPassword, ownerPasswordErrorMessage } from './ownerPassword.js';

test('changes the owner password with one update call that verifies the current password', async () => {
  const calls = [];
  const auth = {
    updateUser: async (attributes) => {
      calls.push(attributes);
      return { data: { user: { id: 'owner-test-id' } }, error: null };
    },
  };

  await changeOwnerPassword(auth, {
    currentPassword: 'Current-password-1!',
    newPassword: 'Replacement-password-2!',
  });

  assert.deepEqual(calls, [{
    password: 'Replacement-password-2!',
    current_password: 'Current-password-1!',
  }]);
});

test('returns a safe message for an incorrect current password', async () => {
  const auth = {
    updateUser: async () => ({ data: { user: null }, error: { code: 'invalid_credentials' } }),
  };

  await assert.rejects(
    changeOwnerPassword(auth, { currentPassword: 'wrong', newPassword: 'Replacement-password-2!' }),
    { message: 'The current password is incorrect.' },
  );
});

test('does not expose unknown Supabase errors', () => {
  assert.equal(
    ownerPasswordErrorMessage({ message: 'internal database detail' }),
    'The password could not be changed. Check your connection and try again.',
  );
});

test('turns a network exception into a safe retry message', async () => {
  const auth = {
    updateUser: async () => { throw new Error('private network detail'); },
  };

  await assert.rejects(
    changeOwnerPassword(auth, { currentPassword: 'current', newPassword: 'replacement' }),
    { message: 'The password could not be changed. Check your connection and try again.' },
  );
});
