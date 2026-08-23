import { requireStaff, sendJson } from './_supabase.js';
import { hashOwnerPin, verifyOwnerPin } from './_pin.js';
import { idempotencyConflict, parseIdempotency, rpcResult } from './_idempotency.js';

export default async function handler(request, response) {
  if (!['GET', 'PUT', 'POST'].includes(request.method)) {
    response.setHeader('Allow', 'GET, PUT, POST');
    return sendJson(response, 405, { error: 'Method not allowed.' });
  }
  try {
    const auth = await requireStaff(request, 'owner');
    if (auth.error) return sendJson(response, auth.status, { error: auth.error });
    const { admin, profile } = auth;
    const { data: owner, error: ownerError } = await admin.from('profiles').select('cancellation_pin_hash').eq('id', profile.id).single();
    if (ownerError) throw ownerError;
    if (request.method === 'GET') return sendJson(response, 200, { configured: Boolean(owner?.cancellation_pin_hash) });
    const body = typeof request.body === 'string' ? JSON.parse(request.body || '{}') : (request.body || {});
    const pin = String(body.pin || '');
    if (!/^\d{4}$/.test(pin)) return sendJson(response, 400, { error: 'Enter exactly four digits.' });
    if (request.method === 'PUT') {
      const idempotency = parseIdempotency(body, { pin });
      if (idempotency.error) return sendJson(response, 400, { error: idempotency.error });
      const { error } = await admin.rpc('set_owner_pin_hash_idempotent', {
        p_actor_id: profile.id, p_pin_hash: hashOwnerPin(pin),
        p_idempotency_key: idempotency.key, p_request_hash: idempotency.hash,
      });
      if (idempotencyConflict(error)) return sendJson(response, 409, { error: 'This request key was already used for a different PIN change.' });
      if (error) throw error;
      return sendJson(response, 200, { configured: true });
    }
    if (!verifyOwnerPin(pin, owner?.cancellation_pin_hash)) return sendJson(response, 403, { error: 'The cancellation PIN is incorrect.' });
    if (body.action === 'verify') return sendJson(response, 200, { verified: true });
    const bookingId = String(body.bookingId || '');
    const idempotency = parseIdempotency(body, { bookingId });
    if (idempotency.error) return sendJson(response, 400, { error: idempotency.error });
    const { data, error } = await admin.rpc('cancel_online_booking_idempotent', {
      p_actor_id: profile.id, p_booking_id: bookingId,
      p_idempotency_key: idempotency.key, p_request_hash: idempotency.hash,
    });
    if (idempotencyConflict(error)) return sendJson(response, 409, { error: 'This request key was already used for a different cancellation.' });
    if (/booking_not_confirmed/i.test(error?.message || '')) return sendJson(response, 409, { error: 'Only a confirmed booking can be cancelled.' });
    if (error) throw error;
    return sendJson(response, 200, rpcResult(data));
  } catch (error) {
    console.error('[api/owner-pin] failed', { code: error.code || 'unknown' });
    return sendJson(response, 500, { error: 'The owner request failed. Please try again.' });
  }
}
