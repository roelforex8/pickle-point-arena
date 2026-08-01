import { getAdminClient, sendJson } from './_supabase.js';

export default async function handler(request, response) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return sendJson(response, 405, { error: 'Method not allowed.' });
  }

  const key = process.env.SUPABASE_SECRET_KEY || '';
  const keyType = key.startsWith('sb_secret_') ? 'secret' : key.startsWith('eyJ') ? 'legacy-service-key' : 'invalid';

  try {
    const { error } = await getAdminClient().from('bookings').select('id').limit(1);
    return sendJson(response, error ? 503 : 200, {
      status: error ? 'degraded' : 'ok',
      databaseAccess: error ? 'denied' : 'ok',
      secretKeyType: keyType,
      errorCode: error?.code || null,
    });
  } catch {
    return sendJson(response, 503, {
      status: 'degraded',
      databaseAccess: 'unavailable',
      secretKeyType: keyType,
      errorCode: 'configuration_error',
    });
  }
}
