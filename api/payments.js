import { randomUUID } from 'node:crypto';
import { getAdminClient, sendJson } from './_supabase.js';
import { findPublicBooking, notifyStaff, publicBookingPayload } from './_booking.js';

const allowedTypes = new Set(['image/jpeg', 'image/png', 'application/pdf']);

export default async function handler(request, response) {
  if (!['POST', 'PUT'].includes(request.method)) {
    response.setHeader('Allow', 'POST, PUT');
    return sendJson(response, 405, { error: 'Method not allowed.' });
  }

  try {
    const admin = getAdminClient();
    const body = typeof request.body === 'string' ? JSON.parse(request.body || '{}') : (request.body || {});
    const booking = await findPublicBooking(admin, body.lookupMethod, body.lookupValue);
    if (!booking) return sendJson(response, 404, { error: 'Booking not found.' });
    if (booking.status === 'expired') return sendJson(response, 409, { error: 'The 15-minute payment hold has expired and the slots are available again.' });
    if (!['awaiting_payment', 'payment_submitted'].includes(booking.status)) return sendJson(response, 409, { error: 'This booking no longer accepts payment proof.' });

    if (request.method === 'POST') {
      const mimeType = String(body.mimeType || '').toLowerCase();
      if (!allowedTypes.has(mimeType)) return sendJson(response, 400, { error: 'Upload a JPG, PNG, or PDF receipt.' });
      const extension = mimeType === 'application/pdf' ? 'pdf' : mimeType === 'image/png' ? 'png' : 'jpg';
      const path = `${booking.id}/${randomUUID()}.${extension}`;
      const { data, error } = await admin.storage.from('payment-receipts').createSignedUploadUrl(path);
      if (error) throw error;
      return sendJson(response, 200, { path, token: data.token });
    }

    const referenceNumber = String(body.referenceNumber || '').trim();
    const receiptPath = String(body.receiptPath || '');
    if (referenceNumber.length < 3 || !receiptPath.startsWith(`${booking.id}/`)) return sendJson(response, 400, { error: 'Enter the payment reference number and upload the receipt.' });

    const paymentRecord = {
      booking_id: booking.id,
      method: 'gcash',
      reference_number: referenceNumber,
      receipt_path: receiptPath,
      status: 'pending_verification',
      submitted_at: new Date().toISOString(),
      reviewed_at: null,
      reviewed_by: null,
      review_note: null,
    };
    const { error: paymentError } = await admin.from('payments').upsert(paymentRecord, { onConflict: 'booking_id' });
    if (paymentError) throw paymentError;
    const { error: bookingError } = await admin.from('bookings').update({ status: 'payment_submitted' }).eq('id', booking.id);
    if (bookingError) throw bookingError;
    const { error: slotError } = await admin.from('booking_slots').update({ status: 'payment_submitted' }).eq('booking_id', booking.id).eq('status', 'held');
    if (slotError) throw slotError;

    await notifyStaff(admin, {
      booking_id: booking.id,
      kind: 'payment_submitted',
      title: `${booking.tracking_number} · GCash proof uploaded`,
      message: `${booking.customer_name} submitted payment proof for ₱${Number(booking.total_amount).toLocaleString('en-PH')}.`,
    });
    booking.status = 'payment_submitted';
    booking.payments = [{ method: 'gcash', status: 'pending_verification', submitted_at: paymentRecord.submitted_at }];
    return sendJson(response, 200, { booking: publicBookingPayload(booking) });
  } catch (error) {
    return sendJson(response, 500, { error: error.message || 'The payment proof could not be submitted.' });
  }
}
