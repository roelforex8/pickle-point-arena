import { requireStaff, sendJson } from './_supabase.js';
import { verifyOwnerPin } from './_pin.js';

export default async function handler(request, response) {
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(request.method)) {
    response.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return sendJson(response, 405, { error: 'Method not allowed.' });
  }

  try {
    const auth = await requireStaff(request, 'owner');
    if (auth.error) return sendJson(response, auth.status, { error: auth.error });
    const { admin, userClient } = auth;

    if (request.method === 'GET') {
      const { data, error } = await userClient
        .from('profiles')
        .select('id, full_name, role, active, created_at')
        .eq('role', 'admin')
        .order('created_at', { ascending: false });
      if (error) throw error;

      const users = [];
      let page = 1;
      while (page <= 10) {
        const { data: pageData, error: listError } = await admin.auth.admin.listUsers({ page, perPage: 100 });
        if (listError) throw listError;
        users.push(...pageData.users);
        if (pageData.users.length < 100) break;
        page += 1;
      }
      const emailById = new Map(users.map((user) => [user.id, user.email]));
      return sendJson(response, 200, {
        admins: data.map((profile) => ({ ...profile, email: emailById.get(profile.id) || 'Email unavailable' })),
      });
    }

    const body = typeof request.body === 'string' ? JSON.parse(request.body || '{}') : (request.body || {});

    if (request.method === 'PATCH') {
      const id = String(body.id || '');
      const password = String(body.password || '');
      const ownerPin = String(body.ownerPin || '');
      const letterCount = (password.match(/[A-Za-z]/g) || []).length;
      const validPassword = letterCount >= 5 && /[A-Z]/.test(password) && /[0-9]/.test(password) && /[^A-Za-z0-9]/.test(password);
      if (!id || !validPassword) return sendJson(response, 400, { error: 'Use at least 5 letters, including 1 capital letter, plus 1 number and 1 special character.' });
      if (!/^\d{4}$/.test(ownerPin)) return sendJson(response, 400, { error: 'Enter the four-digit Owner PIN.' });
      const { data: owner, error: ownerError } = await admin.from('profiles').select('cancellation_pin_hash').eq('id', auth.profile.id).single();
      if (ownerError) throw ownerError;
      if (!verifyOwnerPin(ownerPin, owner?.cancellation_pin_hash)) return sendJson(response, 403, { error: 'The Owner PIN is incorrect.' });
      const { data: targetProfile, error: targetError } = await admin.from('profiles').select('id, role, active').eq('id', id).single();
      if (targetError || targetProfile?.role !== 'admin') return sendJson(response, 404, { error: 'Administrator account not found.' });
      const { error: updateError } = await admin.auth.admin.updateUserById(id, { password });
      if (updateError) return sendJson(response, 400, { error: updateError.message });
      return sendJson(response, 200, { success: true });
    }

    if (request.method === 'DELETE') {
      const id = String(body.id || '');
      if (!id) return sendJson(response, 400, { error: 'Administrator ID is required.' });
      const { error } = await userClient.from('profiles').update({ active: false }).eq('id', id).eq('role', 'admin');
      if (error) throw error;
      return sendJson(response, 200, { success: true });
    }

    const fullName = String(body.fullName || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const letterCount = (password.match(/[A-Za-z]/g) || []).length;
    const validPassword = letterCount >= 5 && /[A-Z]/.test(password) && /[0-9]/.test(password) && /[^A-Za-z0-9]/.test(password);
    if (fullName.length < 2 || !/^\S+@\S+\.\S+$/.test(email) || !validPassword) {
      return sendJson(response, 400, { error: 'Use at least 5 letters, including 1 capital letter, plus 1 number and 1 special character.' });
    }

    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName, must_change_password: true },
    });
    if (createError) return sendJson(response, 400, { error: createError.message });

    const { error: profileError } = await userClient
      .from('profiles')
      .update({ full_name: fullName, role: 'admin', active: true })
      .eq('id', created.user.id);
    if (profileError) {
      await admin.auth.admin.deleteUser(created.user.id);
      throw profileError;
    }

    return sendJson(response, 201, {
      admin: { id: created.user.id, full_name: fullName, email, role: 'admin', active: true },
    });
  } catch (error) {
    return sendJson(response, 500, { error: error.message || 'The administrator request failed.' });
  }
}
