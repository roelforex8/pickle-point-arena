import { requireStaff, sendJson } from './_supabase.js';
import { notifyStaff } from './_booking.js';

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
    if (body.action === 'undo') {
      const { data: booking, error: fetchError } = await admin.from('bookings').select('id, tracking_number, customer_name, status, review_undo_count, payments(reviewed_at)').eq('id', bookingId).single();
      if (fetchError || !['confirmed', 'rejected'].includes(booking?.status)) return sendJson(response, 409, { error: 'Only a recent Confirm or Reject decision can be undone.' });
      const payment = Array.isArray(booking.payments) ? booking.payments[0] : booking.payments;
      const reviewedAt = new Date(payment?.reviewed_at || 0).getTime();
      if (!reviewedAt || Date.now() - reviewedAt >= 30 * 60 * 1000) return sendJson(response, 409, { error: 'The 30-minute undo window has expired. Only the Owner can override a confirmed booking by cancelling it with the Owner PIN.' });
      if (Number(booking.review_undo_count || 0) >= 2) return sendJson(response, 409, { error: 'This booking has already used both undo corrections.' });
      const nextUndoCount = Number(booking.review_undo_count || 0) + 1;
      const { error: paymentError } = await admin.from('payments').update({ status: 'pending_verification', reviewed_at: null, reviewed_by: null, review_note: `Decision undone (${nextUndoCount}/2).` }).eq('booking_id', bookingId);
      if (paymentError) throw paymentError;
      const { error: bookingError } = await admin.from('bookings').update({ status: 'payment_submitted', confirmed_at: null, confirmed_by: null, review_undo_count: nextUndoCount }).eq('id', bookingId).eq('status', booking.status);
      if (bookingError) throw bookingError;
      const { error: slotError } = await admin.from('booking_slots').update({ status: 'payment_submitted' }).eq('booking_id', bookingId).eq('status', booking.status);
      if (slotError) throw slotError;
      await notifyStaff(admin, { booking_id: bookingId, kind: 'system', title: `${booking.tracking_number} · Decision undone`, message: `${profile.full_name || 'Staff'} returned ${booking.customer_name}'s booking to payment review (${nextUndoCount}/2 corrections used).` });
      return sendJson(response, 200, { success: true, undoCount: nextUndoCount });
    }
    const action = body.action === 'reject' ? 'reject' : 'confirm';
    const { data: booking, error: bookingFetchError } = await admin.from('bookings').select('id, tracking_number, customer_name, status').eq('id', bookingId).single();
    if (bookingFetchError || booking.status !== 'payment_submitted') return sendJson(response, 409, { error: 'This booking is no longer awaiting verification.' });

    const confirmed = action === 'confirm';
    const now = new Date().toISOString();
    const { error: paymentError } = await admin.from('payments').update({ status: confirmed ? 'verified' : 'rejected', reviewed_at: now, reviewed_by: profile.id, review_note: confirmed ? 'Payment verified.' : 'Payment proof rejected.' }).eq('booking_id', bookingId).eq('status', 'pending_verification');
    if (paymentError) throw paymentError;
    const { error: bookingError } = await admin.from('bookings').update({ status: confirmed ? 'confirmed' : 'rejected', confirmed_at: confirmed ? now : null, confirmed_by: confirmed ? profile.id : null }).eq('id', bookingId);
    if (bookingError) throw bookingError;
    const { error: slotError } = await admin.from('booking_slots').update({ status: confirmed ? 'confirmed' : 'rejected' }).eq('booking_id', bookingId).eq('status', 'payment_submitted');
    if (slotError) throw slotError;

    await notifyStaff(admin, {
      booking_id: bookingId,
      kind: confirmed ? 'booking_confirmed' : 'system',
      title: `${booking.tracking_number} · ${confirmed ? 'Booking confirmed' : 'Payment rejected'}`,
      message: `${booking.customer_name}'s booking was ${confirmed ? 'confirmed' : 'rejected'} by ${profile.full_name || 'staff'}.`,
    });
    return sendJson(response, 200, { success: true });
  } catch (error) {
    return sendJson(response, 500, { error: error.message || 'The booking could not be updated.' });
  }
}
