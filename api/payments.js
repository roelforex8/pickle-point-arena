import { getAdminClient, sendJson } from './_supabase.js';
import { findPublicBooking } from './_booking.js';
import { idempotencyConflict, parseIdempotency, rpcResult } from './_idempotency.js';

const maxReceiptBytes = 20 * 1024 * 1024;
const allowedTypes = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['application/pdf', 'pdf'],
]);
const allowedPaymentMethods = new Set(['gcash', 'maya', 'metrobank', 'bpi']);

export function normalizePaymentReference(value) {
  return String(value || '').trim() || 'Not provided';
}

function paymentError(error) {
  const message = String(error?.message || '');
  if (/booking_expired/i.test(message)) return { status: 409, message: 'The 15-minute payment hold has expired and the slots are available again.' };
  if (/payment_already_submitted|payment_transition_invalid/i.test(message)) return { status: 409, message: 'Payment proof was already submitted or this booking no longer accepts payment.' };
  if (/receipt_object_missing/i.test(message)) return { status: 409, message: 'The uploaded receipt could not be verified. Please upload it again.' };
  if (/receipt_prepare_missing|receipt_path_invalid|receipt_already_referenced/i.test(message)) return { status: 409, message: 'The receipt upload could not be safely finalized. Please start the upload again.' };
  if (idempotencyConflict(error)) return { status: 409, message: 'This request identifier was already used for different payment details.' };
  return { status: 500, message: 'The payment proof could not be submitted. Please try again, or contact the venue if the problem continues.' };
}

async function receiptObjectExists(admin, bookingId, receiptPath) {
  const name = receiptPath.slice(bookingId.length + 1);
  const { data, error } = await admin.storage.from('payment-receipts').list(bookingId, { search: name, limit: 2 });
  if (error) throw error;
  return (data || []).some((item) => item.name === name && item.id);
}

export async function compensateUnreferencedReceipt(admin, receiptPath) {
  const { data: references, error: referenceError } = await admin
    .from('payments')
    .select('id')
    .eq('receipt_path', receiptPath)
    .limit(1);
  if (referenceError) return { outcome: 'preserved', reason: 'reference_check_failed' };
  if (references?.length) return { outcome: 'preserved', reason: 'referenced' };
  const { error: removeError } = await admin.storage.from('payment-receipts').remove([receiptPath]);
  if (removeError) return { outcome: 'preserved', reason: 'removal_failed' };
  return { outcome: 'removed', reason: 'proven_unreferenced' };
}

export function createPaymentsHandler({ getAdmin = getAdminClient, findBooking = findPublicBooking } = {}) {
  return async function handler(request, response) {
    if (!['POST', 'PUT'].includes(request.method)) {
      response.setHeader('Allow', 'POST, PUT');
      return sendJson(response, 405, { error: 'Method not allowed.' });
    }

    let admin;
    let receiptPath = '';
    let mayCompensate = false;
    try {
      admin = getAdmin();
      const body = typeof request.body === 'string' ? JSON.parse(request.body || '{}') : (request.body || {});
      const booking = await findBooking(admin, body.lookupMethod, body.lookupValue);
      if (!booking) return sendJson(response, 404, { error: 'Booking not found.' });

      const mimeType = String(body.mimeType || '').toLowerCase();
      const fileSize = Number(body.fileSize || 0);
      const fileSha256 = String(body.fileSha256 || '').trim().toLowerCase();
      const paymentMethod = String(body.paymentMethod || 'gcash').trim().toLowerCase();
      const referenceNumber = normalizePaymentReference(body.referenceNumber);
      if (!allowedTypes.has(mimeType)) return sendJson(response, 400, { error: 'Upload a JPG, PNG, or PDF receipt.' });
      if (!Number.isFinite(fileSize) || fileSize <= 0 || fileSize > maxReceiptBytes) return sendJson(response, 400, { error: 'The receipt must be a non-empty file no larger than 20 MB.' });
      if (!/^[0-9a-f]{64}$/.test(fileSha256)) return sendJson(response, 400, { error: 'The receipt integrity check is missing. Select the file again.' });
      if (!allowedPaymentMethods.has(paymentMethod)) return sendJson(response, 400, { error: 'Choose a valid payment method.' });

      const extension = allowedTypes.get(mimeType);
      const payload = { bookingId: booking.id, paymentMethod, referenceNumber, mimeType, fileSize, fileSha256, extension };
      const idempotency = parseIdempotency(body, payload);
      if (idempotency.error) return sendJson(response, 400, { error: idempotency.error });

      if (request.method === 'POST') {
        const { data, error } = await admin.rpc('prepare_customer_payment_upload_idempotent', {
          p_booking_id: booking.id,
          p_mime_type: mimeType,
          p_file_size: fileSize,
          p_file_sha256: fileSha256,
          p_extension: extension,
          p_idempotency_key: idempotency.key,
          p_request_hash: idempotency.hash,
        });
        if (error) {
          const safe = paymentError(error);
          return sendJson(response, safe.status, { error: safe.message });
        }
        const prepared = rpcResult(data);
        if (!prepared?.receiptPath) throw new Error('receipt_prepare_failed');
        if (prepared.finalized) return sendJson(response, 200, { finalized: true, booking: prepared.booking });
        receiptPath = prepared.receiptPath;
        const alreadyUploaded = await receiptObjectExists(admin, booking.id, receiptPath);
        if (alreadyUploaded) return sendJson(response, 200, { path: receiptPath, alreadyUploaded: true });
        const { data: signed, error: signedError } = await admin.storage.from('payment-receipts').createSignedUploadUrl(receiptPath);
        if (signedError) throw signedError;
        return sendJson(response, 200, { path: receiptPath, token: signed.token, alreadyUploaded: false });
      }

      receiptPath = String(body.receiptPath || '');
      mayCompensate = true;
      const { data, error } = await admin.rpc('submit_customer_payment_idempotent', {
        p_booking_id: booking.id,
        p_method: paymentMethod,
        p_reference_number: referenceNumber,
        p_receipt_path: receiptPath,
        p_idempotency_key: idempotency.key,
        p_request_hash: idempotency.hash,
      });
      if (error) {
        const safe = paymentError(error);
        if (!idempotencyConflict(error) && !/receipt_prepare_missing/i.test(error.message || '')) {
          const compensation = await compensateUnreferencedReceipt(admin, receiptPath);
          console.info('[api/payments] finalize compensation', { outcome: compensation.outcome, reason: compensation.reason });
        }
        return sendJson(response, safe.status, { error: safe.message });
      }
      const result = rpcResult(data);
      if (result?.accepted === false && result.errorCode === 'booking_expired') {
        const compensation = await compensateUnreferencedReceipt(admin, receiptPath);
        console.info('[api/payments] expired upload compensation', { outcome: compensation.outcome, reason: compensation.reason });
        return sendJson(response, 409, { error: 'The 15-minute payment hold has expired and the slots are available again.' });
      }
      if (!result?.bookingId) throw new Error('payment_result_missing');
      return sendJson(response, 200, { booking: result });
    } catch (error) {
      if (admin && mayCompensate && receiptPath) {
        const compensation = await compensateUnreferencedReceipt(admin, receiptPath).catch(() => ({ outcome: 'preserved', reason: 'compensation_exception' }));
        console.info('[api/payments] exception compensation', { outcome: compensation.outcome, reason: compensation.reason });
      }
      console.error('[api/payments] failed', { method: request.method, code: error?.code || 'unknown' });
      return sendJson(response, 500, { error: 'The payment proof could not be submitted. Please try again, or contact the venue if the problem continues.' });
    }
  };
}

export default createPaymentsHandler();
