export async function findPublicBooking(admin, method, value) {
  const normalizedMethod = method === 'email' ? 'email' : 'tracking';
  const normalizedValue = String(value || '').trim();
  if (!normalizedValue) return null;

  let query = admin
    .from('bookings')
    .select('id, tracking_number, customer_name, customer_email, status, subtotal, booking_fee, total_amount, hold_expires_at, created_at, confirmed_at, booking_slots(court_id, slot_start, slot_end, hourly_rate, status), payments(method, reference_number, status, submitted_at, receipt_path)')
    .order('created_at', { ascending: false })
    .limit(1);

  query = normalizedMethod === 'email'
    ? query.eq('customer_email', normalizedValue.toLowerCase())
    : query.eq('tracking_number', normalizedValue.toUpperCase());

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return expireIfNeeded(admin, data);
}

export async function expireIfNeeded(admin, booking) {
  if (booking.status !== 'awaiting_payment' || new Date(booking.hold_expires_at).getTime() > Date.now()) return booking;
  await admin.from('booking_slots').update({ status: 'expired' }).eq('booking_id', booking.id).eq('status', 'held');
  await admin.from('bookings').update({ status: 'expired' }).eq('id', booking.id).eq('status', 'awaiting_payment');
  booking.status = 'expired';
  booking.booking_slots = (booking.booking_slots || []).map((slot) => slot.status === 'held' ? { ...slot, status: 'expired' } : slot);
  return booking;
}

export function publicBookingPayload(booking) {
  const email = booking.customer_email || '';
  const [local, domain] = email.split('@');
  const maskedEmail = domain ? `${local.slice(0, 2)}***@${domain}` : '';
  const paymentRecord = Array.isArray(booking.payments) ? booking.payments[0] : booking.payments;
  return {
    trackingNumber: booking.tracking_number,
    customerName: booking.customer_name,
    maskedEmail,
    status: booking.status,
    subtotal: Number(booking.subtotal),
    bookingFee: Number(booking.booking_fee),
    totalAmount: Number(booking.total_amount),
    holdExpiresAt: booking.hold_expires_at,
    createdAt: booking.created_at,
    confirmedAt: booking.confirmed_at,
    slots: (booking.booking_slots || []).map((slot) => ({
      courtId: slot.court_id,
      slotStart: slot.slot_start,
      slotEnd: slot.slot_end,
      hourlyRate: Number(slot.hourly_rate),
      status: slot.status,
    })),
    payment: paymentRecord ? {
      method: paymentRecord.method,
      status: paymentRecord.status,
      submittedAt: paymentRecord.submitted_at,
    } : null,
  };
}

export async function notifyStaff(admin, notification) {
  const { data: recipients, error } = await admin.from('profiles').select('id').eq('active', true).in('role', ['owner', 'admin']);
  if (error) throw error;
  if (!recipients?.length) return;
  const { error: insertError } = await admin.from('notifications').insert(recipients.map(({ id }) => ({ recipient_id: id, ...notification })));
  if (insertError) throw insertError;
}
