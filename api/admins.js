import { requireStaff, sendJson } from './_supabase.js';
import { verifyOwnerPin } from './_pin.js';

const LONG_AUTH_BAN = '876000h';

export function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

export function maskEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  const at = normalized.indexOf('@');
  if (at < 1) return 'Email unavailable';
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  return `${local.slice(0, 2)}${'*'.repeat(Math.max(3, Math.min(8, local.length - 2)))}@${domain}`;
}

export function adminStatus(profile, authUser) {
  const metadataStatus = authUser?.app_metadata?.administrator_status;
  if (metadataStatus === 'removed' || !authUser) return 'removed';
  if (profile?.active) return 'active';
  return 'disabled';
}

export function validAdminPassword(password) {
  const value = String(password || '');
  const letterCount = (value.match(/[A-Za-z]/g) || []).length;
  return letterCount >= 5 && /[A-Z]/.test(value) && /[0-9]/.test(value) && /[^A-Za-z0-9]/.test(value);
}

function safeAuthError(error, fallback) {
  const code = String(error?.code || '').toLowerCase();
  const message = String(error?.message || '').toLowerCase();
  if (code === 'email_exists' || code === 'user_already_exists' || code.includes('already') || message.includes('already') || message.includes('registered')) {
    return 'An account already exists for that email address.';
  }
  return fallback;
}

function metadataFor(authUser, administratorStatus) {
  return { ...(authUser?.app_metadata || {}), administrator_status: administratorStatus };
}

function publicAdmin(profile, authUser) {
  const status = adminStatus(profile, authUser);
  return {
    id: profile.id,
    full_name: profile.full_name,
    role: 'admin',
    active: status === 'active',
    status,
    email: maskEmail(authUser?.email),
    created_at: profile.created_at,
  };
}

export function createSupabaseAdminServices(admin) {
  return {
    async listProfiles() {
      const { data, error } = await admin.from('profiles').select('id, full_name, role, active, created_at').eq('role', 'admin').order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
    async listAuthUsers() {
      const users = [];
      for (let page = 1; page <= 10; page += 1) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 100 });
        if (error) throw error;
        users.push(...data.users);
        if (data.users.length < 100) break;
      }
      return users;
    },
    async getProfile(id) {
      const { data, error } = await admin.from('profiles').select('id, full_name, role, active, created_at, cancellation_pin_hash').eq('id', id).maybeSingle();
      if (error) throw error;
      return data;
    },
    async getAuthUser(id) {
      const { data, error } = await admin.auth.admin.getUserById(id);
      if (error?.status === 404 || error?.code === 'user_not_found') return null;
      if (error) throw error;
      return data.user;
    },
    async setProfileActive(id, active) {
      const { data, error } = await admin.from('profiles').update({ active }).eq('id', id).eq('role', 'admin').select('id').maybeSingle();
      if (error || !data) throw error || new Error('profile_update_failed');
    },
    async createAuthUser({ email, password, fullName }) {
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: fullName, must_change_password: true },
        app_metadata: { administrator_status: 'active' },
      });
      if (error) throw error;
      return data.user;
    },
    async upsertProfile({ id, fullName }) {
      const { error } = await admin.from('profiles').upsert({ id, full_name: fullName, role: 'admin', active: true }, { onConflict: 'id' });
      if (error) throw error;
    },
    async updateAuthUser(id, attributes) {
      const { data, error } = await admin.auth.admin.updateUserById(id, attributes);
      if (error || !data.user) throw error || new Error('auth_update_failed');
      return data.user;
    },
    async deleteAuthUser(id) {
      const { error } = await admin.auth.admin.deleteUser(id);
      if (error) throw error;
    },
  };
}

async function loadTarget(body, auth, services) {
  const id = String(body.id || '');
  if (!isUuid(id)) return { error: 'A valid administrator ID is required.', status: 400 };
  if (id === auth.profile.id) return { error: 'The Owner account cannot be managed here.', status: 403 };
  const profile = await services.getProfile(id);
  if (!profile) return { error: 'Administrator account not found.', status: 404 };
  if (profile.role !== 'admin') return { error: 'Only administrator accounts can be managed here.', status: 403 };
  const authUser = await services.getAuthUser(id);
  return { id, profile, authUser, currentStatus: adminStatus(profile, authUser) };
}

async function setDisabled(target, services) {
  if (target.currentStatus === 'removed') return { status: 409, body: { error: 'A removed administrator cannot be disabled.' } };
  const wasActive = Boolean(target.profile.active);
  await services.setProfileActive(target.id, false);
  try {
    await services.updateAuthUser(target.id, {
      ban_duration: LONG_AUTH_BAN,
      app_metadata: metadataFor(target.authUser, 'disabled'),
    });
  } catch (error) {
    if (wasActive) await services.setProfileActive(target.id, true).catch(() => {});
    throw error;
  }
  return { status: 200, body: { success: true, status: 'disabled' } };
}

async function setActive(target, services) {
  if (target.currentStatus === 'removed') return { status: 409, body: { error: 'A removed administrator cannot be reactivated.' } };
  if (!target.authUser) return { status: 409, body: { error: 'This administrator no longer has an authentication account.' } };
  await services.updateAuthUser(target.id, {
    ban_duration: 'none',
    app_metadata: metadataFor(target.authUser, 'active'),
  });
  try {
    await services.setProfileActive(target.id, true);
  } catch (error) {
    await services.updateAuthUser(target.id, {
      ban_duration: LONG_AUTH_BAN,
      app_metadata: metadataFor(target.authUser, 'disabled'),
    }).catch(() => {});
    throw error;
  }
  return { status: 200, body: { success: true, status: 'active' } };
}

async function setRemoved(target, services) {
  if (target.currentStatus === 'removed') return { status: 200, body: { success: true, status: 'removed' } };
  const wasActive = Boolean(target.profile.active);
  await services.setProfileActive(target.id, false);
  try {
    await services.updateAuthUser(target.id, {
      ban_duration: LONG_AUTH_BAN,
      app_metadata: metadataFor(target.authUser, 'removed'),
    });
  } catch (error) {
    if (wasActive) await services.setProfileActive(target.id, true).catch(() => {});
    throw error;
  }
  return { status: 200, body: { success: true, status: 'removed' } };
}

export function createAdminsHandler({
  requireStaffFn = requireStaff,
  verifyOwnerPinFn = verifyOwnerPin,
  servicesFactory = ({ admin }) => createSupabaseAdminServices(admin),
} = {}) {
  return async function handler(request, response) {
    if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(request.method)) {
      response.setHeader('Allow', 'GET, POST, PATCH, DELETE');
      return sendJson(response, 405, { error: 'Method not allowed.' });
    }

    let action = request.method.toLowerCase();
    try {
      const auth = await requireStaffFn(request, 'owner');
      if (auth.error) return sendJson(response, auth.status, { error: auth.error });
      const services = servicesFactory(auth);

      if (request.method === 'GET') {
        const [profiles, users] = await Promise.all([services.listProfiles(), services.listAuthUsers()]);
        const authById = new Map(users.map((user) => [user.id, user]));
        const rows = profiles.map((profile) => publicAdmin(profile, authById.get(profile.id)));
        return sendJson(response, 200, {
          admins: rows.filter((admin) => admin.status !== 'removed'),
          removedAdmins: rows.filter((admin) => admin.status === 'removed'),
        });
      }

      const body = typeof request.body === 'string' ? JSON.parse(request.body || '{}') : (request.body || {});

      if (request.method === 'POST') {
        action = 'create';
        const fullName = String(body.fullName || '').trim();
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');
        if (fullName.length < 2 || fullName.length > 120 || /[\u0000-\u001f]/.test(fullName)) {
          return sendJson(response, 400, { error: 'Enter a valid administrator name.' });
        }
        if (email.length > 254 || !/^\S+@\S+\.\S+$/.test(email)) {
          return sendJson(response, 400, { error: 'Enter a valid administrator email address.' });
        }
        if (!validAdminPassword(password)) {
          return sendJson(response, 400, { error: 'Use at least 5 letters, including 1 capital letter, plus 1 number and 1 special character.' });
        }

        let createdUser;
        try {
          createdUser = await services.createAuthUser({ email, password, fullName });
        } catch (error) {
          return sendJson(response, 400, { error: safeAuthError(error, 'The administrator account could not be created.') });
        }
        try {
          await services.upsertProfile({ id: createdUser.id, fullName });
        } catch (error) {
          await services.deleteAuthUser(createdUser.id).catch(() => {});
          throw error;
        }
        return sendJson(response, 201, {
          admin: { id: createdUser.id, full_name: fullName, email: maskEmail(email), role: 'admin', active: true, status: 'active' },
        });
      }

      const target = await loadTarget(body, auth, services);
      if (target.error) return sendJson(response, target.status, { error: target.error });

      if (request.method === 'DELETE') {
        action = 'remove';
        if (body.confirmation !== 'REMOVE') return sendJson(response, 400, { error: 'Type REMOVE to confirm administrator removal.' });
        const result = await setRemoved(target, services);
        return sendJson(response, result.status, result.body);
      }

      action = String(body.action || 'password').toLowerCase();
      if (action === 'disable') {
        const result = await setDisabled(target, services);
        return sendJson(response, result.status, result.body);
      }
      if (action === 'reactivate') {
        const result = await setActive(target, services);
        return sendJson(response, result.status, result.body);
      }
      if (action !== 'password') return sendJson(response, 400, { error: 'Unknown administrator action.' });

      const password = String(body.password || '');
      const ownerPin = String(body.ownerPin || '');
      if (!validAdminPassword(password)) return sendJson(response, 400, { error: 'Use at least 5 letters, including 1 capital letter, plus 1 number and 1 special character.' });
      if (!/^\d{4}$/.test(ownerPin)) return sendJson(response, 400, { error: 'Enter the four-digit Owner PIN.' });
      if (target.currentStatus === 'removed') return sendJson(response, 409, { error: 'A removed administrator cannot be edited.' });
      const owner = await services.getProfile(auth.profile.id);
      if (!owner || owner.role !== 'owner' || !owner.active) return sendJson(response, 403, { error: 'Owner access is required.' });
      if (!verifyOwnerPinFn(ownerPin, owner.cancellation_pin_hash)) return sendJson(response, 403, { error: 'The Owner PIN is incorrect.' });
      await services.updateAuthUser(target.id, { password });
      return sendJson(response, 200, { success: true });
    } catch (error) {
      console.error('[api/admins] failed', { method: request.method, action, code: error?.code || 'unknown' });
      return sendJson(response, 500, { error: 'The administrator request could not be completed. Please try again.' });
    }
  };
}

export default createAdminsHandler();
