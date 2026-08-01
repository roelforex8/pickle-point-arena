import { requireStaff, sendJson } from './_supabase.js';
import { notifyStaff } from './_booking.js';
import { hashOwnerPin, verifyOwnerPin } from './_pin.js';

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
      const { error } = await admin.from('profiles').update({ cancellation_pin_hash: hashOwnerPin(pin) }).eq('id', profile.id);
      if (error) throw error;
      return sendJson(response, 200, { configured: true });
    }

    if (!verifyOwnerPin(pin, owner?.cancellation_pin_hash)) return sendJson(response, 403, { error: 'The cancellation PIN is incorrect.' });
    if (body.action === 'verify') return sendJson(response, 200, { verified: true });
    const bookingId = String(body.bookingId || '');
    const { data: booking, error: bookingError } = await admin.from('bookings').select('id, tracking_number, customer_name, status').eq('id', bookingId).single();
    if (bookingError || booking?.status !== 'confirmed') return sendJson(response, 409, { error: 'Only a confirmed booking can be cancelled.' });
    const now = new Date().toISOString();
    const { error: updateError } = await admin.from('bookings').update({ status: 'cancelled' }).eq('id', bookingId).eq('status', 'confirmed');
    if (updateError) throw updateError;
    const { error: slotError } = await admin.from('booking_slots').update({ status: 'cancelled' }).eq('booking_id', bookingId).eq('status', 'confirmed');
    if (slotError) throw slotError;
    await notifyStaff(admin, { booking_id: bookingId, kind: 'system', title: `${booking.tracking_number} · Booking cancelled by ${profile.full_name || 'Owner'}`, message: `${booking.customer_name}'s confirmed booking was cancelled by the Owner. The exact activity timestamp is recorded below.` });
    return sendJson(response, 200, { success: true });
  } catch (error) {
    return sendJson(response, 500, { error: error.message || 'The owner cancellation request failed.' });
  }
}
