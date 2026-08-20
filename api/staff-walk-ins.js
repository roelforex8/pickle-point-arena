import { requireStaff, sendJson } from './_supabase.js';
import { selectionInterval } from './staff-blocks.js';

const forbiddenIdentityFields = new Set([
  'created_by',
  'createdBy',
  'confirmed_by',
  'confirmedBy',
  'admin_id',
  'adminId',
  'admin_name',
  'adminName',
  'role',
]);

function conflictError(error) {
  return /blocked|no longer available|overlap|conflict/i.test(error?.message || '');
}

export function createStaffWalkInsHandler({ requireStaffFn = requireStaff } = {}) {
  return async function handler(request, response) {
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      return sendJson(response, 405, { error: 'Method not allowed.' });
    }

    try {
      const auth = await requireStaffFn(request);
      if (auth.error) return sendJson(response, auth.status, { error: auth.error });
      let body;
      try {
        body = typeof request.body === 'string' ? JSON.parse(request.body || '{}') : (request.body || {});
      } catch {
        return sendJson(response, 400, { error: 'The Walk-In request is malformed.' });
      }
      if (Object.keys(body).some((field) => forbiddenIdentityFields.has(field))) {
        return sendJson(response, 400, { error: 'Administrator identity is determined from the authenticated session.' });
      }

      const requested = Array.isArray(body.selections) ? body.selections : [];
      if (!requested.length || requested.length > 500) return sendJson(response, 400, { error: 'Select between 1 and 500 valid court-hours.' });
      const parsed = requested.map(selectionInterval);
      if (parsed.some((selection) => !selection)) return sendJson(response, 400, { error: 'One or more selected court-hours are invalid.' });
      const unique = new Map(parsed.map((selection) => [`${selection.date}|${selection.hour}|${selection.courtId}`, selection]));
      if (unique.size !== parsed.length) return sendJson(response, 400, { error: 'The same court-hour was selected more than once.' });
      const selections = [...unique.values()];
      if (selections.some((selection) => selection.startMs <= Date.now())) return sendJson(response, 400, { error: 'Past court-hours cannot be booked.' });

      const { data, error } = await auth.admin.rpc('create_staff_walk_in_booking', {
        p_created_by: auth.profile.id,
        p_slots: selections.map((selection) => ({ court_id: selection.courtId, slot_start: new Date(selection.startMs).toISOString() })),
      });
      if (error) {
        if (conflictError(error)) return sendJson(response, 409, { error: 'One or more selected court-hours are no longer available. Nothing was booked.' });
        console.error('[api/staff-walk-ins] RPC failed', { code: error.code || 'unknown' });
        return sendJson(response, 500, { error: 'The Walk-In booking could not be created. Please try again.' });
      }
      const booking = Array.isArray(data) ? data[0] : data;
      if (!booking) throw new Error('missing_walk_in_result');
      return sendJson(response, 201, {
        booking: {
          id: booking.booking_id,
          trackingNumber: booking.tracking_number,
          subtotal: Number(booking.subtotal),
          bookingFee: Number(booking.booking_fee),
          totalAmount: Number(booking.total_amount),
          confirmedAt: booking.confirmed_at,
          source: 'walk_in',
        },
      });
    } catch (error) {
      console.error('[api/staff-walk-ins] failed', { code: error.code || 'unknown' });
      return sendJson(response, 500, { error: 'The Walk-In booking could not be created. Please try again.' });
    }
  };
}

export default createStaffWalkInsHandler();
