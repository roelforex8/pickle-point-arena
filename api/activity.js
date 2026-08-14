import { timingSafeEqual } from 'node:crypto';

import { getAdminClient, requireStaff, sendJson } from './_supabase.js';

const notificationRetentionDays = 7;

function matchesCronAuthorization(authorization, configuredSecret) {
  const received = Buffer.from(String(authorization || ''));
  const expected = Buffer.from(`Bearer ${configuredSecret}`);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

async function deleteExpiredNotifications(admin) {
  const cutoff = new Date(Date.now() - notificationRetentionDays * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await admin.from('notifications').delete().lt('created_at', cutoff);
  if (error) throw error;
  return { cutoff };
}

export function createActivityHandler({
  getAdmin = getAdminClient,
  requireStaffFn = requireStaff,
  getCronSecret = () => process.env.CRON_SECRET,
} = {}) {
  return async function handler(request, response) {
    if (!['GET', 'POST'].includes(request.method)) {
      response.setHeader('Allow', 'GET, POST');
      return sendJson(response, 405, { error: 'Method not allowed.' });
    }

    try {
      if (request.method === 'GET') {
        const configuredSecret = getCronSecret();
        if (!configuredSecret) return sendJson(response, 503, { error: 'Scheduled maintenance is unavailable.' });
        if (!matchesCronAuthorization(request.headers.authorization, configuredSecret)) {
          return sendJson(response, 401, { error: 'Cleanup authorization required.' });
        }

        // Payment receipt cleanup is intentionally disabled pending a separate
        // reconciliation and an approved, non-destructive receipt lifecycle design.
        const result = await deleteExpiredNotifications(getAdmin());
        return sendJson(response, 200, { success: true, ...result });
      }

      const auth = await requireStaffFn(request);
      if (auth.error) return sendJson(response, auth.status, { error: auth.error });
      const body = typeof request.body === 'string' ? JSON.parse(request.body || '{}') : (request.body || {});
      const title = String(body.title || '').trim().slice(0, 160);
      const message = String(body.message || '').trim().slice(0, 500);
      if (!title || !message) return sendJson(response, 400, { error: 'Activity title and message are required.' });

      const { data: recipients, error: recipientError } = await auth.admin
        .from('profiles')
        .select('id')
        .eq('active', true)
        .in('role', ['owner', 'admin']);
      if (recipientError) throw recipientError;

      const { error } = await auth.admin.from('notifications').insert(
        recipients.map(({ id }) => ({ recipient_id: id, kind: 'system', title, message })),
      );
      if (error) throw error;
      return sendJson(response, 201, { success: true });
    } catch (error) {
      return sendJson(response, 500, { error: error.message || 'The activity could not be recorded.' });
    }
  };
}

export default createActivityHandler();
