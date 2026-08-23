import { getAdminClient, sendJson } from './_supabase.js';
import { idempotencyConflict, parseIdempotency, rpcResult } from './_idempotency.js';

function courtHour(slotStart) {
  const hourPart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(slotStart)).find((part) => part.type === 'hour');
  const hour = Number(hourPart?.value);
  if (!Number.isInteger(hour)) throw new Error('A selected booking time is invalid.');
  return hour;
}

function courtRate(slotStart) {
  const hour = courtHour(slotStart);
  return hour >= 6 && hour < 16 ? 300 : 350;
}

export function publicBookingRpcError(error) {
  if (/occupancy_conflict|no longer available|already booked|blocked|booking_slots_active_unique|duplicate key|unique constraint/i.test(error?.message || '')) {
    return {
      status: 409,
      message: 'One or more selected court-hours are no longer available. Nothing was booked.',
    };
  }
  return {
    status: 400,
    message: 'The booking request could not be completed. Please review the selected court-hours and try again.',
  };
}

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return sendJson(response, 405, { error: 'Method not allowed.' });
  }

  try {
    const admin = getAdminClient();
    const body = typeof request.body === 'string' ? JSON.parse(request.body || '{}') : (request.body || {});
    const customerName = String(body.customerName || '').trim();
    const customerEmail = String(body.customerEmail || '').trim().toLowerCase();
    const customerMobile = String(body.customerMobile || '').trim();
    if (customerName.length < 2 || !/^\S+@\S+\.\S+$/.test(customerEmail) || customerMobile.length > 24 || customerMobile.replace(/\D/g, '').length < 10) {
      return sendJson(response, 400, { error: 'Enter a valid full name, email address, and mobile number.' });
    }
    const slots = Array.isArray(body.slots) ? body.slots.map((slot) => ({ court_id: Number(slot.courtId), slot_start: String(slot.slotStart) })) : [];
    if (!slots.length || slots.some((slot) => {
      try {
        const hour = courtHour(slot.slot_start);
        return hour < 6 || hour > 23;
      } catch {
        return true;
      }
    })) return sendJson(response, 400, { error: 'Bookings are available from 6:00 AM to 12:00 AM Philippine time.' });
    const idempotency = parseIdempotency(body, {
      customerName,
      customerEmail,
      customerMobile,
      slots,
    });
    if (idempotency.error) return sendJson(response, 400, { error: idempotency.error });

    const { data, error } = await admin.rpc('create_public_booking_idempotent', {
      p_customer_name: customerName,
      p_customer_email: customerEmail,
      p_customer_mobile: customerMobile,
      p_slots: slots,
      p_idempotency_key: idempotency.key,
      p_request_hash: idempotency.hash,
    });
    if (error) {
      if (idempotencyConflict(error)) return sendJson(response, 409, { error: 'This request identifier was already used for different booking details.' });
      const safeError = publicBookingRpcError(error);
      return sendJson(response, safeError.status, { error: safeError.message });
    }
    const booking = rpcResult(data);
    if (!booking) throw new Error('The reservation was not created.');
    return sendJson(response, 201, {
      bookingId: booking.bookingId,
      trackingNumber: booking.trackingNumber,
      subtotal: Number(booking.subtotal),
      bookingFee: Number(booking.bookingFee),
      totalAmount: Number(booking.totalAmount),
      holdExpiresAt: booking.holdExpiresAt,
    });
  } catch (error) {
    console.error('Booking creation failed.', { code: error?.code || 'unknown' });
    return sendJson(response, 500, { error: 'The reservation could not be created. Please try again.' });
  }
}
