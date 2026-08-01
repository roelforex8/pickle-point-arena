import { getAdminClient, requireStaff, sendJson } from './_supabase.js';

const receiptRetentionHours = 12;

async function deleteExpiredReceipts(admin, batchLimit = 5000) {
  const cutoff = new Date(Date.now() - receiptRetentionHours * 60 * 60 * 1000).toISOString();
  let deleted = 0;
  while (deleted < batchLimit) {
    const batchSize = Math.min(250, batchLimit - deleted);
    const { data: payments, error: lookupError } = await admin.from('payments').select('id, receipt_path').not('receipt_path', 'is', null).lt('submitted_at', cutoff).limit(batchSize);
    if (lookupError) throw lookupError;
    if (!payments?.length) break;
    const { error: storageError } = await admin.storage.from('payment-receipts').remove(payments.map((payment) => payment.receipt_path).filter(Boolean));
    if (storageError) throw storageError;
    const { error: updateError } = await admin.from('payments').update({ receipt_path: null }).in('id', payments.map((payment) => payment.id));
    if (updateError) throw updateError;
    deleted += payments.length;
    if (payments.length < batchSize) break;
  }
  return { deleted, cutoff, limitReached: deleted >= batchLimit };
}

export default async function handler(request, response) {
  if (!['GET', 'POST', 'DELETE'].includes(request.method)) {
    response.setHeader('Allow', 'GET, POST, DELETE');
    return sendJson(response, 405, { error: 'Method not allowed.' });
  }

  try {
    if (request.method === 'GET') {
      const configuredSecret = process.env.CRON_SECRET;
      const authorization = request.headers.authorization || '';
      const isVercelCron = String(request.headers['user-agent'] || '').startsWith('vercel-cron/');
      if (configuredSecret ? authorization !== `Bearer ${configuredSecret}` : !isVercelCron) return sendJson(response, 401, { error: 'Cleanup authorization required.' });
      const result = await deleteExpiredReceipts(getAdminClient());
      return sendJson(response, 200, { success: true, retentionHours: receiptRetentionHours, ...result });
    }
    const auth = await requireStaff(request);
    if (auth.error) return sendJson(response, auth.status, { error: auth.error });
    if (request.method === 'DELETE') {
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { error } = await auth.admin.from('notifications').delete().lt('created_at', cutoff);
      if (error) throw error;
      const receiptCleanup = await deleteExpiredReceipts(auth.admin);
      return sendJson(response, 200, { success: true, cutoff, receiptRetentionHours, receiptCleanup });
    }
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
}
