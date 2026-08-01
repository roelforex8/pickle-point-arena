import { requireStaff, sendJson } from './_supabase.js';

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store, max-age=0');
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return sendJson(response, 405, { error: 'Method not allowed.' });
  }

  try {
    const auth = await requireStaff(request);
    if (auth.error) return sendJson(response, auth.status, { error: auth.error });
    const from = new Date(String(request.query?.from || ''));
    const to = new Date(String(request.query?.to || ''));
    const duration = to.getTime() - from.getTime();
    if (!Number.isFinite(duration) || duration <= 0 || duration > 8 * 86400000) return sendJson(response, 400, { error: 'Choose a valid schedule range.' });

    const [{ data: slots, error: slotError }, { data: blocks, error: blockError }] = await Promise.all([
      auth.admin.from('booking_slots').select('booking_id, court_id, slot_start, slot_end, status, bookings(tracking_number, customer_name, customer_email, status, hold_expires_at)').gte('slot_start', from.toISOString()).lt('slot_start', to.toISOString()).in('status', ['held', 'payment_submitted', 'confirmed']),
      auth.admin.from('blocked_slots').select('id, court_id, starts_at, ends_at, reason').lt('starts_at', to.toISOString()).gt('ends_at', from.toISOString()),
    ]);
    if (slotError || blockError) throw slotError || blockError;
    const now = Date.now();
    const activeSlots = (slots || []).filter((slot) => {
      if (slot.status !== 'held') return true;
      const booking = Array.isArray(slot.bookings) ? slot.bookings[0] : slot.bookings;
      return booking?.status === 'awaiting_payment' && new Date(booking.hold_expires_at).getTime() > now;
    });
    return sendJson(response, 200, { slots: activeSlots, blocks: blocks || [], refreshedAt: new Date().toISOString() });
  } catch (error) {
    return sendJson(response, 500, { error: error.message || 'The staff schedule could not be loaded.' });
  }
}
