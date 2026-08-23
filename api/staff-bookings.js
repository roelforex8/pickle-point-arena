import { requireStaff, sendJson } from './_supabase.js';
import { idempotencyConflict, parseIdempotency, rpcResult } from './_idempotency.js';

function reviewError(error, action) {
  const message = String(error?.message || '');
  if (idempotencyConflict(error)) return { status: 409, message: 'This request identifier was already used for a different payment decision.' };
  if (/payment_undo_expired/i.test(message)) return { status: 409, message: 'The 30-minute undo window has expired. Only the Owner can cancel a confirmed booking.' };
  if (/payment_undo_limit/i.test(message)) return { status: 409, message: 'This booking has already used both undo corrections.' };
  if (/occupancy_conflict/i.test(message)) return { status: 409, message: 'The decision cannot be undone because one or more court-hours are no longer available.' };
  if (/payment_undo_invalid/i.test(message)) return { status: 409, message: 'Only a recent Confirm or Reject decision can be undone.' };
  if (/payment_decision_conflict|booking_slots_inconsistent|payment_not_found|booking_not_found/i.test(message)) {
    return { status: 409, message: action === 'undo' ? 'This decision can no longer be undone.' : 'This booking is no longer awaiting verification.' };
  }
  return { status: 500, message: 'The booking could not be updated. Please try again.' };
}

export default async function handler(request, response) {
  if (!['GET', 'PATCH'].includes(request.method)) {
    response.setHeader('Allow', 'GET, PATCH');
    return sendJson(response, 405, { error: 'Method not allowed.' });
  }

  try {
    const auth = await requireStaff(request);
    if (auth.error) return sendJson(response, auth.status, { error: auth.error });
    const { admin, profile } = auth;

    if (request.method === 'GET') {
      const { data, error } = await admin
        .from('bookings')
        .select('id, tracking_number, customer_name, customer_email, status, total_amount, hold_expires_at, created_at, review_undo_count, booking_slots(court_id, slot_start, slot_end, status), payments(id, method, reference_number, receipt_path, status, submitted_at, reviewed_at)')
        .in('status', ['payment_submitted', 'awaiting_payment', 'confirmed', 'rejected'])
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      const bookings = await Promise.all((data || []).map(async (booking) => {
        const payment = Array.isArray(booking.payments) ? booking.payments[0] : booking.payments;
        let receiptUrl = null;
        if (payment?.receipt_path) {
          const { data: signed } = await admin.storage.from('payment-receipts').createSignedUrl(payment.receipt_path, 600);
          receiptUrl = signed?.signedUrl || null;
        }
        return { ...booking, receiptUrl };
      }));
      return sendJson(response, 200, { bookings });
    }

    const body = typeof request.body === 'string' ? JSON.parse(request.body || '{}') : (request.body || {});
    const bookingId = String(body.bookingId || '');
    const action = String(body.action || '').toLowerCase();
    if (!['confirm', 'reject', 'undo'].includes(action)) return sendJson(response, 400, { error: 'Choose a valid payment decision.' });
    const idempotency = parseIdempotency(body, { bookingId, action });
    if (idempotency.error) return sendJson(response, 400, { error: idempotency.error });
    const rpcName = action === 'undo' ? 'undo_payment_decision_idempotent' : 'review_payment_idempotent';
    const params = {
      p_actor_id: profile.id,
      p_booking_id: bookingId,
      p_idempotency_key: idempotency.key,
      p_request_hash: idempotency.hash,
      ...(action === 'undo' ? {} : { p_decision: action }),
    };
    const { data, error } = await admin.rpc(rpcName, params);
    if (error) {
      const safe = reviewError(error, action);
      return sendJson(response, safe.status, { error: safe.message });
    }
    const result = rpcResult(data);
    if (!result?.success) throw new Error('missing_payment_decision_result');
    return sendJson(response, 200, result);
  } catch (error) {
    console.error('[api/staff-bookings] failed', { code: error?.code || 'unknown' });
    return sendJson(response, 500, { error: 'The booking could not be updated. Please try again.' });
  }
}
