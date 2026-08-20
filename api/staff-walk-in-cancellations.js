import { requireStaff, sendJson } from './_supabase.js';

const bookingIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const forbiddenIdentityFields = new Set([
  'p_cancelled_by',
  'cancelled_by',
  'cancelledBy',
  'staff_id',
  'staffId',
  'admin_id',
  'adminId',
  'admin_name',
  'adminName',
  'role',
]);

function cancellationConflict(error) {
  return /walk_in_not_cancellable|walk_in_slots_not_cancellable|walk_in_cancellation_incomplete/i.test(error?.message || '');
}

export function createStaffWalkInCancellationHandler({ requireStaffFn = requireStaff } = {}) {
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
        return sendJson(response, 400, { error: 'The Walk-In cancellation request is malformed.' });
      }

      if (Object.keys(body).some((field) => forbiddenIdentityFields.has(field))) {
        return sendJson(response, 400, { error: 'Cancelling staff identity is determined from the authenticated session.' });
      }
      if (Object.keys(body).some((field) => field !== 'bookingId')) {
        return sendJson(response, 400, { error: 'Only a Walk-In booking identifier may be submitted.' });
      }
      const bookingId = String(body.bookingId || '');
      if (!bookingIdPattern.test(bookingId)) return sendJson(response, 400, { error: 'Choose a valid Walk-In booking.' });

      const { data, error } = await auth.admin.rpc('cancel_staff_walk_in_booking', {
        p_cancelled_by: auth.profile.id,
        p_booking_id: bookingId,
      });
      if (error) {
        if (/staff_not_authorized/i.test(error.message || '')) return sendJson(response, 403, { error: 'This account is not authorized to cancel Walk-In bookings.' });
        if (cancellationConflict(error)) return sendJson(response, 409, { error: 'This Walk-In booking can no longer be cancelled.' });
        console.error('[api/staff-walk-in-cancellations] RPC failed', { code: error.code || 'unknown' });
        return sendJson(response, 500, { error: 'The Walk-In booking could not be cancelled. Please try again.' });
      }

      const booking = Array.isArray(data) ? data[0] : data;
      if (!booking) throw new Error('missing_walk_in_cancellation_result');
      return sendJson(response, 200, {
        booking: {
          id: booking.booking_id,
          trackingNumber: booking.tracking_number,
          totalAmount: Number(booking.total_amount),
          cancelledAt: booking.cancelled_at,
          status: 'cancelled',
          source: 'walk_in',
        },
      });
    } catch (error) {
      console.error('[api/staff-walk-in-cancellations] failed', { code: error.code || 'unknown' });
      return sendJson(response, 500, { error: 'The Walk-In booking could not be cancelled. Please try again.' });
    }
  };
}

export default createStaffWalkInCancellationHandler();
