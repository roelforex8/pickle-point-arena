import { requireStaff, sendJson } from './_supabase.js';
import { verifyOwnerPin } from './_pin.js';
import { idempotencyConflict, idempotencyInProgress, parseIdempotency, rpcResult } from './_idempotency.js';

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
    async claimExternal({ operation, actorId, idempotencyKey, requestHash }) {
      const { data, error } = await admin.rpc('claim_external_admin_operation', {
        p_operation: operation, p_actor_id: actorId,
        p_idempotency_key: idempotencyKey, p_request_hash: requestHash,
      });
      if (error) throw error;
      return rpcResult(data);
    },
    async completeExternal({ operation, actorId, targetId, targetFullName, targetActive, idempotencyKey, requestHash, result }) {
      const { data, error } = await admin.rpc('complete_external_admin_operation', {
        p_operation: operation, p_actor_id: actorId, p_target_id: targetId,
        p_target_full_name: targetFullName || null, p_target_active: targetActive,
        p_idempotency_key: idempotencyKey, p_request_hash: requestHash, p_response: result,
      });
      if (error) throw error;
      return rpcResult(data);
    },
    async releaseExternal({ operation, actorId, idempotencyKey, requestHash }) {
      const { error } = await admin.rpc('release_external_admin_operation', {
        p_operation: operation, p_actor_id: actorId,
        p_idempotency_key: idempotencyKey, p_request_hash: requestHash,
      });
      if (error) throw error;
    },
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

async function claimAdminOperation(services, actorId, operation, body, payload) {
  const idempotency = parseIdempotency(body, payload);
  if (idempotency.error) return { error: idempotency.error, status: 400 };
  try {
    const claim = await services.claimExternal({ operation, actorId, idempotencyKey: idempotency.key, requestHash: idempotency.hash });
    if (claim?.disposition === 'completed') return { completed: claim.result };
    if (idempotencyInProgress(claim)) return { error: 'This administrator operation is already in progress. Retry shortly.', status: 409 };
    return { idempotency };
  } catch (error) {
    if (idempotencyConflict(error)) return { error: 'This request key was already used for a different administrator operation.', status: 409 };
    throw error;
  }
}

async function completeAdminOperation(services, auth, operation, idempotency, target, result) {
  return services.completeExternal({
    operation, actorId: auth.profile.id, targetId: target.id,
    targetFullName: target.fullName || target.profile?.full_name || null,
    targetActive: target.active, idempotencyKey: idempotency.key,
    requestHash: idempotency.hash, result,
  });
}

async function releaseAfterCompensation(services, auth, operation, idempotency) {
  await services.releaseExternal({ operation, actorId: auth.profile.id, idempotencyKey: idempotency.key, requestHash: idempotency.hash });
}

async function reconcileAmbiguousCompletion(services, auth, operation, idempotency) {
  try {
    const claim = await services.claimExternal({
      operation, actorId: auth.profile.id,
      idempotencyKey: idempotency.key, requestHash: idempotency.hash,
    });
    if (claim?.disposition === 'completed') return { completed: claim.result };
    if (claim?.disposition === 'in_progress') return { safeToCompensate: true };
  } catch {}
  return { preserveExternalState: true };
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

        const claimed = await claimAdminOperation(services, auth.profile.id, 'admin_create', body, { fullName, email, password });
        if (claimed.error) return sendJson(response, claimed.status, { error: claimed.error });
        if (claimed.completed) return sendJson(response, 201, claimed.completed);

        let createdUser;
        try {
          createdUser = await services.createAuthUser({ email, password, fullName });
        } catch (error) {
          await releaseAfterCompensation(services, auth, 'admin_create', claimed.idempotency).catch(() => {});
          return sendJson(response, 400, { error: safeAuthError(error, 'The administrator account could not be created.') });
        }
        const result = { admin: { id: createdUser.id, full_name: fullName, email: maskEmail(email), role: 'admin', active: true, status: 'active' } };
        try {
          await completeAdminOperation(services, auth, 'admin_create', claimed.idempotency, { id: createdUser.id, fullName, active: true }, result);
        } catch (error) {
          const reconciliation = await reconcileAmbiguousCompletion(services, auth, 'admin_create', claimed.idempotency);
          if (reconciliation.completed) return sendJson(response, 201, reconciliation.completed);
          if (!reconciliation.safeToCompensate) throw error;
          let compensated = false;
          try { await services.deleteAuthUser(createdUser.id); compensated = true; } catch {}
          if (compensated) await releaseAfterCompensation(services, auth, 'admin_create', claimed.idempotency).catch(() => {});
          throw error;
        }
        return sendJson(response, 201, result);
      }

      const target = await loadTarget(body, auth, services);
      if (target.error) return sendJson(response, target.status, { error: target.error });

      if (request.method === 'DELETE') {
        action = 'remove';
        if (body.confirmation !== 'REMOVE') return sendJson(response, 400, { error: 'Type REMOVE to confirm administrator removal.' });
        const claimed = await claimAdminOperation(services, auth.profile.id, 'admin_remove', body, { id: target.id, confirmation: 'REMOVE' });
        if (claimed.error) return sendJson(response, claimed.status, { error: claimed.error });
        if (claimed.completed) return sendJson(response, 200, claimed.completed);
        if (target.currentStatus === 'removed') {
          const result = { success: true, status: 'removed' };
          await completeAdminOperation(services, auth, 'admin_remove', claimed.idempotency, { ...target, active: false }, result);
          return sendJson(response, 200, result);
        }
        try {
          await services.updateAuthUser(target.id, { ban_duration: LONG_AUTH_BAN, app_metadata: metadataFor(target.authUser, 'removed') });
          const result = { success: true, status: 'removed' };
          await completeAdminOperation(services, auth, 'admin_remove', claimed.idempotency, { ...target, active: false }, result);
          return sendJson(response, 200, result);
        } catch (error) {
          const reconciliation = await reconcileAmbiguousCompletion(services, auth, 'admin_remove', claimed.idempotency);
          if (reconciliation.completed) return sendJson(response, 200, reconciliation.completed);
          if (!reconciliation.safeToCompensate) throw error;
          let compensated = false;
          try {
            await services.updateAuthUser(target.id, { ban_duration: target.currentStatus === 'active' ? 'none' : LONG_AUTH_BAN, app_metadata: metadataFor(target.authUser, target.currentStatus) });
            compensated = true;
          } catch {}
          if (compensated) await releaseAfterCompensation(services, auth, 'admin_remove', claimed.idempotency).catch(() => {});
          throw error;
        }
      }

      action = String(body.action || 'password').toLowerCase();
      if (action === 'disable') {
        if (target.currentStatus === 'removed') return sendJson(response, 409, { error: 'A removed administrator cannot be disabled.' });
        const claimed = await claimAdminOperation(services, auth.profile.id, 'admin_disable', body, { id: target.id, action });
        if (claimed.error) return sendJson(response, claimed.status, { error: claimed.error });
        if (claimed.completed) return sendJson(response, 200, claimed.completed);
        try {
          await services.updateAuthUser(target.id, { ban_duration: LONG_AUTH_BAN, app_metadata: metadataFor(target.authUser, 'disabled') });
          const result = { success: true, status: 'disabled' };
          await completeAdminOperation(services, auth, 'admin_disable', claimed.idempotency, { ...target, active: false }, result);
          return sendJson(response, 200, result);
        } catch (error) {
          const reconciliation = await reconcileAmbiguousCompletion(services, auth, 'admin_disable', claimed.idempotency);
          if (reconciliation.completed) return sendJson(response, 200, reconciliation.completed);
          if (!reconciliation.safeToCompensate) throw error;
          let compensated = false;
          try { await services.updateAuthUser(target.id, { ban_duration: target.currentStatus === 'active' ? 'none' : LONG_AUTH_BAN, app_metadata: metadataFor(target.authUser, target.currentStatus) }); compensated = true; } catch {}
          if (compensated) await releaseAfterCompensation(services, auth, 'admin_disable', claimed.idempotency).catch(() => {});
          throw error;
        }
      }
      if (action === 'reactivate') {
        if (target.currentStatus === 'removed') return sendJson(response, 409, { error: 'A removed administrator cannot be reactivated.' });
        if (!target.authUser) return sendJson(response, 409, { error: 'This administrator no longer has an authentication account.' });
        const claimed = await claimAdminOperation(services, auth.profile.id, 'admin_reactivate', body, { id: target.id, action });
        if (claimed.error) return sendJson(response, claimed.status, { error: claimed.error });
        if (claimed.completed) return sendJson(response, 200, claimed.completed);
        try {
          await services.updateAuthUser(target.id, { ban_duration: 'none', app_metadata: metadataFor(target.authUser, 'active') });
          const result = { success: true, status: 'active' };
          await completeAdminOperation(services, auth, 'admin_reactivate', claimed.idempotency, { ...target, active: true }, result);
          return sendJson(response, 200, result);
        } catch (error) {
          const reconciliation = await reconcileAmbiguousCompletion(services, auth, 'admin_reactivate', claimed.idempotency);
          if (reconciliation.completed) return sendJson(response, 200, reconciliation.completed);
          if (!reconciliation.safeToCompensate) throw error;
          let compensated = false;
          try { await services.updateAuthUser(target.id, { ban_duration: LONG_AUTH_BAN, app_metadata: metadataFor(target.authUser, 'disabled') }); compensated = true; } catch {}
          if (compensated) await releaseAfterCompensation(services, auth, 'admin_reactivate', claimed.idempotency).catch(() => {});
          throw error;
        }
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
      const claimed = await claimAdminOperation(services, auth.profile.id, 'admin_password', body, { id: target.id, password, ownerPin });
      if (claimed.error) return sendJson(response, claimed.status, { error: claimed.error });
      if (claimed.completed) return sendJson(response, 200, claimed.completed);
      await services.updateAuthUser(target.id, { password });
      const result = { success: true };
      await completeAdminOperation(services, auth, 'admin_password', claimed.idempotency, { ...target, active: target.profile.active }, result);
      return sendJson(response, 200, result);
    } catch (error) {
      console.error('[api/admins] failed', { method: request.method, action, code: error?.code || 'unknown' });
      return sendJson(response, 500, { error: 'The administrator request could not be completed. Please try again.' });
    }
  };
}

export default createAdminsHandler();
