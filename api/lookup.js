import { getAdminClient, sendJson } from './_supabase.js';
import { findPublicBooking, publicBookingPayload } from './_booking.js';

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return sendJson(response, 405, { error: 'Method not allowed.' });
  }
  try {
    const body = typeof request.body === 'string' ? JSON.parse(request.body || '{}') : (request.body || {});
    const booking = await findPublicBooking(getAdminClient(), body.method, body.value);
    if (!booking) return sendJson(response, 404, { error: 'No booking matched that information.' });
    return sendJson(response, 200, { booking: publicBookingPayload(booking) });
  } catch (error) {
    return sendJson(response, 500, { error: error.message || 'The booking could not be found.' });
  }
}
