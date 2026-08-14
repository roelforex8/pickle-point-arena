import assert from 'node:assert/strict';
import test from 'node:test';

import { authorizeStaffProfile } from './_supabase.js';
import { adminStatus, createAdminsHandler, maskEmail } from './admins.js';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';

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

function fakeServices(overrides = {}) {
  const profiles = new Map([
    [OWNER_ID, { id: OWNER_ID, full_name: 'Owner', role: 'owner', active: true, cancellation_pin_hash: 'hash' }],
    [ADMIN_ID, { id: ADMIN_ID, full_name: 'Test Administrator', role: 'admin', active: true, created_at: '2026-01-01T00:00:00Z' }],
  ]);
  const authUsers = new Map([
    [ADMIN_ID, { id: ADMIN_ID, email: 'admin@example.invalid', app_metadata: { provider: 'email' } }],
  ]);
  const calls = { created: [], upserted: [], updatedAuth: [], profileActive: [], deletedAuth: [] };
  const services = {
    async listProfiles() { return [...profiles.values()].filter((profile) => profile.role === 'admin'); },
    async listAuthUsers() { return [...authUsers.values()]; },
    async getProfile(id) { return profiles.get(id) || null; },
    async getAuthUser(id) { return authUsers.get(id) || null; },
    async setProfileActive(id, active) {
      calls.profileActive.push({ id, active });
      const profile = profiles.get(id);
      if (!profile) throw new Error('missing profile');
      profile.active = active;
    },
    async createAuthUser(input) {
      calls.created.push(input);
      return { id: OTHER_ID, email: input.email, app_metadata: { administrator_status: 'active' } };
    },
    async upsertProfile(input) { calls.upserted.push(input); },
    async updateAuthUser(id, attributes) {
      calls.updatedAuth.push({ id, attributes });
      const user = authUsers.get(id);
      if (!user) throw new Error('missing auth user');
      user.app_metadata = attributes.app_metadata || user.app_metadata;
      return user;
    },
    async deleteAuthUser(id) { calls.deletedAuth.push(id); authUsers.delete(id); },
    ...overrides,
  };
  return { services, profiles, authUsers, calls };
}

function ownerHandler(services, requireStaffFn = async () => ({
  admin: {},
  profile: { id: OWNER_ID, role: 'owner', active: true },
  user: { id: OWNER_ID },
})) {
  return createAdminsHandler({
    requireStaffFn,
    verifyOwnerPinFn: () => true,
    servicesFactory: () => services,
  });
}

async function invoke(handler, method, body = {}) {
  const response = responseRecorder();
  await handler({ method, body, headers: {} }, response);
  return response;
}

test('owner can add only an administrator role and receives a masked email', async () => {
  const { services, calls } = fakeServices();
  const response = await invoke(ownerHandler(services), 'POST', {
    fullName: 'New Administrator',
    email: 'NEW.ADMIN@EXAMPLE.INVALID',
    password: 'SecureA1!',
    role: 'owner',
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.body.admin.role, 'admin');
  assert.notEqual(response.body.admin.email, 'new.admin@example.invalid');
  assert.equal(calls.created[0].email, 'new.admin@example.invalid');
  assert.deepEqual(calls.upserted[0], { id: OTHER_ID, fullName: 'New Administrator' });
});

test('administrator and unauthenticated callers cannot add administrators', async () => {
  for (const denied of [
    { error: 'Owner access is required.', status: 403 },
    { error: 'Authentication required.', status: 401 },
  ]) {
    const { services, calls } = fakeServices();
    const handler = ownerHandler(services, async () => denied);
    const response = await invoke(handler, 'POST', { fullName: 'New Admin', email: 'new@example.invalid', password: 'SecureA1!' });
    assert.equal(response.statusCode, denied.status);
    assert.equal(calls.created.length, 0);
  }
});

test('administrator callers cannot disable, reactivate, or remove another administrator', async () => {
  for (const [method, body] of [
    ['PATCH', { id: ADMIN_ID, action: 'disable' }],
    ['PATCH', { id: ADMIN_ID, action: 'reactivate' }],
    ['DELETE', { id: ADMIN_ID, confirmation: 'REMOVE' }],
  ]) {
    const { services, calls } = fakeServices();
    const handler = ownerHandler(services, async () => ({ error: 'Owner access is required.', status: 403 }));
    const response = await invoke(handler, method, body);
    assert.equal(response.statusCode, 403);
    assert.equal(calls.profileActive.length, 0);
    assert.equal(calls.updatedAuth.length, 0);
  }
});

test('duplicate email is rejected without leaking Supabase details', async () => {
  const { services } = fakeServices({
    async createAuthUser() { throw { code: 'email_exists', message: 'private duplicate details' }; },
  });
  const response = await invoke(ownerHandler(services), 'POST', { fullName: 'New Admin', email: 'duplicate@example.invalid', password: 'SecureA1!' });
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.error, 'An account already exists for that email address.');
  assert.doesNotMatch(response.body.error, /duplicate@example|private/i);
});

test('profile creation failure rolls back the newly created Auth user', async () => {
  const { services, calls } = fakeServices({ async upsertProfile() { throw new Error('private database error'); } });
  const response = await invoke(ownerHandler(services), 'POST', { fullName: 'New Admin', email: 'new@example.invalid', password: 'SecureA1!' });
  assert.equal(response.statusCode, 500);
  assert.deepEqual(calls.deletedAuth, [OTHER_ID]);
  assert.doesNotMatch(response.body.error, /database|private/i);
});

test('disable revokes Auth login and deactivates the profile', async () => {
  const { services, profiles, calls } = fakeServices();
  const response = await invoke(ownerHandler(services), 'PATCH', { id: ADMIN_ID, action: 'disable' });
  assert.equal(response.statusCode, 200);
  assert.equal(profiles.get(ADMIN_ID).active, false);
  assert.equal(calls.updatedAuth[0].attributes.ban_duration, '876000h');
  assert.equal(calls.updatedAuth[0].attributes.app_metadata.administrator_status, 'disabled');
});

test('failed Auth disable restores the prior active profile and leaves the row visible', async () => {
  const base = fakeServices();
  base.services.updateAuthUser = async () => { throw new Error('private auth error'); };
  const response = await invoke(ownerHandler(base.services), 'PATCH', { id: ADMIN_ID, action: 'disable' });
  assert.equal(response.statusCode, 500);
  assert.equal(base.profiles.get(ADMIN_ID).active, true);
  assert.deepEqual(base.calls.profileActive.map(({ active }) => active), [false, true]);
});

test('owner can reactivate a disabled administrator', async () => {
  const base = fakeServices();
  base.profiles.get(ADMIN_ID).active = false;
  base.authUsers.get(ADMIN_ID).app_metadata.administrator_status = 'disabled';
  const response = await invoke(ownerHandler(base.services), 'PATCH', { id: ADMIN_ID, action: 'reactivate' });
  assert.equal(response.statusCode, 200);
  assert.equal(base.profiles.get(ADMIN_ID).active, true);
  assert.equal(base.calls.updatedAuth[0].attributes.ban_duration, 'none');
  assert.equal(base.calls.updatedAuth[0].attributes.app_metadata.administrator_status, 'active');
});

test('remove archives the administrator without deleting Auth or profile history', async () => {
  const base = fakeServices();
  const response = await invoke(ownerHandler(base.services), 'DELETE', { id: ADMIN_ID, confirmation: 'REMOVE' });
  assert.equal(response.statusCode, 200);
  assert.equal(base.profiles.has(ADMIN_ID), true);
  assert.equal(base.authUsers.has(ADMIN_ID), true);
  assert.equal(base.profiles.get(ADMIN_ID).active, false);
  assert.equal(base.calls.deletedAuth.length, 0);
  assert.equal(base.calls.updatedAuth[0].attributes.app_metadata.administrator_status, 'removed');
  assert.equal(base.calls.updatedAuth[0].attributes.ban_duration, '876000h');
});

test('repeated removal is idempotent and removed administrators cannot be reactivated', async () => {
  const base = fakeServices();
  base.profiles.get(ADMIN_ID).active = false;
  base.authUsers.get(ADMIN_ID).app_metadata.administrator_status = 'removed';
  const removed = await invoke(ownerHandler(base.services), 'DELETE', { id: ADMIN_ID, confirmation: 'REMOVE' });
  const reactivated = await invoke(ownerHandler(base.services), 'PATCH', { id: ADMIN_ID, action: 'reactivate' });
  assert.equal(removed.statusCode, 200);
  assert.equal(base.calls.updatedAuth.length, 0);
  assert.equal(reactivated.statusCode, 409);
});

test('administrator list separates removed accounts and returns masked emails only', async () => {
  const base = fakeServices();
  base.profiles.get(ADMIN_ID).active = false;
  base.authUsers.get(ADMIN_ID).app_metadata.administrator_status = 'removed';
  base.profiles.set(OTHER_ID, { id: OTHER_ID, full_name: 'Disabled Admin', role: 'admin', active: false, created_at: '2026-01-02T00:00:00Z' });
  base.authUsers.set(OTHER_ID, { id: OTHER_ID, email: 'disabled@example.invalid', app_metadata: { administrator_status: 'disabled' } });
  const response = await invoke(ownerHandler(base.services), 'GET');
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.admins.length, 1);
  assert.equal(response.body.admins[0].status, 'disabled');
  assert.equal(response.body.removedAdmins.length, 1);
  assert.equal(response.body.removedAdmins[0].status, 'removed');
  assert.doesNotMatch(JSON.stringify(response.body), /admin@example\.invalid|disabled@example\.invalid/);
});

test('owner, non-administrator, malformed, and unconfirmed targets are rejected', async () => {
  const base = fakeServices();
  base.profiles.set(OTHER_ID, { id: OTHER_ID, role: 'customer', active: true });
  const cases = [
    [{ id: OWNER_ID, action: 'disable' }, 403],
    [{ id: OTHER_ID, action: 'disable' }, 403],
    [{ id: 'not-a-uuid', action: 'disable' }, 400],
  ];
  for (const [body, status] of cases) {
    const response = await invoke(ownerHandler(base.services), 'PATCH', body);
    assert.equal(response.statusCode, status);
  }
  const noConfirmation = await invoke(ownerHandler(base.services), 'DELETE', { id: ADMIN_ID, confirmation: 'remove' });
  assert.equal(noConfirmation.statusCode, 400);
});

test('disabled and unsupported profiles cannot access protected staff APIs', () => {
  assert.equal(authorizeStaffProfile({ role: 'admin', active: true }), null);
  assert.equal(authorizeStaffProfile({ role: 'admin', active: false }).status, 403);
  assert.equal(authorizeStaffProfile({ role: 'customer', active: true }).status, 403);
  assert.equal(authorizeStaffProfile({ role: 'admin', active: true }, 'owner').status, 403);
});

test('status and email helpers do not expose removed accounts or full emails', () => {
  assert.equal(adminStatus({ active: false }, { app_metadata: { administrator_status: 'removed' } }), 'removed');
  assert.equal(adminStatus({ active: false }, { app_metadata: {} }), 'disabled');
  assert.equal(adminStatus({ active: true }, { app_metadata: {} }), 'active');
  assert.equal(maskEmail('administrator@example.invalid'), 'ad********@example.invalid');
});

test('unexpected failures log only method, action, and sanitized code', async () => {
  const base = fakeServices({ async getProfile() { throw { code: 'db_failure', message: 'private admin@example.invalid token' }; } });
  const originalError = console.error;
  const logged = [];
  console.error = (...values) => logged.push(values);
  try {
    const response = await invoke(ownerHandler(base.services), 'PATCH', { id: ADMIN_ID, action: 'disable' });
    assert.equal(response.statusCode, 500);
  } finally {
    console.error = originalError;
  }
  const serialized = JSON.stringify(logged);
  assert.match(serialized, /db_failure/);
  assert.doesNotMatch(serialized, /private|admin@example|token/i);
});
