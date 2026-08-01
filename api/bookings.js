import { getAdminClient, sendJson } from './_supabase.js';

function courtRate(slotStart) {
  const hourPart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(slotStart)).find((part) => part.type === 'hour');
  const hour = Number(hourPart?.value);
  if (!Number.isInteger(hour)) throw new Error('A selected booking time is invalid.');
  return hour >= 6 && hour < 16 ? 300 : 350;
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
    const slots = Array.isArray(body.slots) ? body.slots.map((slot) => ({ court_id: Number(slot.courtId), slot_start: String(slot.slotStart) })) : [];
    const { data, error } = await admin.rpc('create_public_booking', { p_customer_name: customerName, p_customer_email: customerEmail, p_slots: slots });
    if (error) return sendJson(response, 400, { error: error.message });
    const booking = data?.[0];
    if (!booking) throw new Error('The reservation was not created.');
    const { data: createdSlots, error: slotsError } = await admin
      .from('booking_slots')
      .select('id, slot_start')
      .eq('booking_id', booking.booking_id);
    if (slotsError) throw slotsError;
    if (!createdSlots?.length) throw new Error('No booking slots were created.');
    const pricedSlots = createdSlots.map((slot) => ({ ...slot, hourlyRate: courtRate(slot.slot_start) }));
    const slotUpdates = await Promise.all(pricedSlots.map((slot) => admin.from('booking_slots').update({ hourly_rate: slot.hourlyRate }).eq('id', slot.id)));
    const slotUpdateError = slotUpdates.find((result) => result.error)?.error;
    if (slotUpdateError) throw slotUpdateError;
    const subtotal = pricedSlots.reduce((sum, slot) => sum + slot.hourlyRate, 0);
    const bookingFee = pricedSlots.length * 10;
    const totalAmount = subtotal + bookingFee;
    const holdExpiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const { data: updatedBooking, error: holdError } = await admin
      .from('bookings')
      .update({ hold_expires_at: holdExpiresAt, subtotal, booking_fee: bookingFee, total_amount: totalAmount })
      .eq('id', booking.booking_id)
      .select('hold_expires_at, subtotal, booking_fee, total_amount')
      .single();
    if (holdError) throw holdError;
    return sendJson(response, 201, {
      bookingId: booking.booking_id,
      trackingNumber: booking.tracking_number,
      subtotal: Number(updatedBooking.subtotal),
      bookingFee: Number(updatedBooking.booking_fee),
      totalAmount: Number(updatedBooking.total_amount),
      holdExpiresAt: updatedBooking.hold_expires_at,
    });
  } catch (error) {
    return sendJson(response, 500, { error: error.message || 'The reservation could not be created.' });
  }
}
