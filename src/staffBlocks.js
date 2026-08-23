import { completeIdempotentOperation, pendingIdempotencyKey } from './idempotency.js';

export async function postStaffBlocks(supabaseClient, payload, fetchImpl = fetch) {
  const { data, error } = await supabaseClient.auth.getSession();
  const accessToken = data?.session?.access_token;
  if (error || !accessToken) throw new Error('Your session is no longer valid. Sign in again and retry.');

  const operation = `staff-blocks:${payload.action}`;
  const idempotencyKey = pendingIdempotencyKey(operation, payload);
  const response = await fetchImpl('/api/staff-blocks', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ ...payload, idempotencyKey }),
  });
  if (response.ok) completeIdempotentOperation(operation, idempotencyKey);
  return response;
}
