export function walkInHourlyRate(hour) {
  const value = Number(hour);
  if (!Number.isInteger(value) || value < 6 || value > 23) throw new Error('A selected Walk-In time is invalid.');
  return value < 16 ? 300 : 350;
}

export function walkInBookingSummary(selections = []) {
  const items = selections.map((selection) => ({ ...selection, hourlyRate: walkInHourlyRate(selection.hour) }));
  const subtotal = items.reduce((sum, item) => sum + item.hourlyRate, 0);
  return { items, courtHours: items.length, subtotal, bookingFee: 0, totalAmount: subtotal };
}

export async function postStaffWalkIn(supabaseClient, selections, fetchImpl = fetch) {
  const { data, error } = await supabaseClient.auth.getSession();
  const accessToken = data?.session?.access_token;
  if (error || !accessToken) throw new Error('Your session is no longer valid. Sign in again and retry.');
  return fetchImpl('/api/staff-walk-ins', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ selections }),
  });
}

export async function postStaffWalkInCancellation(supabaseClient, bookingId, fetchImpl = fetch) {
  const { data, error } = await supabaseClient.auth.getSession();
  const accessToken = data?.session?.access_token;
  if (error || !accessToken) throw new Error('Your session is no longer valid. Sign in again and retry.');
  return fetchImpl('/api/staff-walk-in-cancellations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ bookingId }),
  });
}
