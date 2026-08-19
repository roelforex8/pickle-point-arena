export async function postStaffBlocks(supabaseClient, payload, fetchImpl = fetch) {
  const { data, error } = await supabaseClient.auth.getSession();
  const accessToken = data?.session?.access_token;
  if (error || !accessToken) throw new Error('Your session is no longer valid. Sign in again and retry.');

  return fetchImpl('/api/staff-blocks', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  });
}
