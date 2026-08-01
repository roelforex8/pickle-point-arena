import { getAdminClient, sendJson } from './_supabase.js';

const visibleStatuses = new Set(['held', 'payment_submitted', 'confirmed']);

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store, max-age=0');
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return sendJson(response, 405, { error: 'Method not allowed.' });
  }

  try {
    const from = new Date(String(request.query?.from || ''));
    const to = new Date(String(request.query?.to || ''));
    const duration = to.getTime() - from.getTime();
    if (!Number.isFinite(duration) || duration <= 0 || duration > 8 * 86400000) {
      return sendJson(response, 400, { error: 'Choose a valid availability range of eight days or less.' });
    }

    const admin = getAdminClient();
    const [{ data: bookingSlots, error: bookingError }, { data: blocks, error: blockError }] = await Promise.all([
      admin.from('booking_slots').select('court_id, slot_start, status, bookings(status, hold_expires_at)').gte('slot_start', from.toISOString()).lt('slot_start', to.toISOString()).in('status', [...visibleStatuses]),
      admin.from('blocked_slots').select('court_id, starts_at, ends_at').lt('starts_at', to.toISOString()).gt('ends_at', from.toISOString()),
    ]);
    if (bookingError || blockError) throw bookingError || blockError;

    const now = Date.now();
    const slots = (bookingSlots || []).flatMap((slot) => {
      const booking = Array.isArray(slot.bookings) ? slot.bookings[0] : slot.bookings;
      if (slot.status === 'held' && (!booking || booking.status !== 'awaiting_payment' || new Date(booking.hold_expires_at).getTime() <= now)) return [];
      const status = slot.status === 'held' ? 'awaiting' : slot.status === 'payment_submitted' ? 'pending' : 'booked';
      return [{ courtId: Number(slot.court_id), slotStart: slot.slot_start, status }];
    });

    return sendJson(response, 200, {
      slots,
      blocks: (blocks || []).map((block) => ({ courtId: Number(block.court_id), startsAt: block.starts_at, endsAt: block.ends_at })),
      refreshedAt: new Date().toISOString(),
    });
  } catch (error) {
    return sendJson(response, 500, { error: error.message || 'Availability could not be loaded.' });
  }
}
