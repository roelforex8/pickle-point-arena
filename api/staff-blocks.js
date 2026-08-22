import { requireStaff, sendJson } from './_supabase.js';
import { notifyStaff } from './_booking.js';

const HOUR_MS = 60 * 60 * 1000;

export function selectionInterval(selection) {
  const date = String(selection?.date || '');
  const hour = Number(selection?.hour);
  const courtId = Number(selection?.courtId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(hour) || hour < 6 || hour > 23 || !Number.isInteger(courtId) || courtId < 1 || courtId > 6) return null;
  const dayOffset = hour >= 24 ? 1 : 0;
  const normalizedHour = hour % 24;
  const start = new Date(`${date}T${String(normalizedHour).padStart(2, '0')}:00:00+08:00`);
  start.setUTCDate(start.getUTCDate() + dayOffset);
  return { date, hour, courtId, startMs: start.getTime(), endMs: start.getTime() + HOUR_MS };
}

export async function handler(request, response, { requireStaffFn = requireStaff, notify = notifyStaff } = {}) {
  response.setHeader('Cache-Control', 'no-store, max-age=0');
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return sendJson(response, 405, { error: 'Method not allowed.' });
  }

  try {
    const auth = await requireStaffFn(request);
    if (auth.error) return sendJson(response, auth.status, { error: auth.error });
    const body = typeof request.body === 'string' ? JSON.parse(request.body || '{}') : (request.body || {});
    const action = body.action === 'unblock' ? 'unblock' : 'block';
    const unique = new Map();
    (Array.isArray(body.selections) ? body.selections : []).forEach((selection) => {
      const parsed = selectionInterval(selection);
      if (parsed) unique.set(`${parsed.date}|${parsed.hour}|${parsed.courtId}`, parsed);
    });
    const selections = [...unique.values()];
    if (!selections.length || selections.length > 500) return sendJson(response, 400, { error: 'Select between 1 and 500 valid court-hours.' });
    if (selections.some((item) => item.startMs <= Date.now())) return sendJson(response, 400, { error: 'Past court-hours cannot be changed.' });

    const reason = String(body.reason || 'Venue unavailable').trim().slice(0, 120) || 'Venue unavailable';
    const { data, error } = await auth.admin.rpc('manage_staff_blocked_slots', {
      p_created_by: auth.profile.id,
      p_action: action,
      p_reason: reason,
      p_slots: selections.map((item) => ({
        court_id: item.courtId,
        slot_start: new Date(item.startMs).toISOString(),
      })),
    });
    if (error) {
      if (/occupancy_conflict/i.test(error.message || '')) {
        return sendJson(response, 409, { error: 'One or more selected court-hours are no longer available. Nothing was changed.' });
      }
      if (/staff_not_authorized/i.test(error.message || '')) {
        return sendJson(response, 403, { error: 'This account is not authorized.' });
      }
      throw error;
    }

    const result = Array.isArray(data) ? data[0] : data;
    if (!result) throw new Error('missing_staff_block_result');
    const changed = Number(result.changed || 0);
    const skipped = Number(result.skipped || 0);
    const actorRole = auth.profile.role === 'owner' ? 'Owner' : 'Administrator';
    try {
      await notify(auth.admin, {
        kind: 'system',
        title: `Court availability ${action === 'block' ? 'blocked' : 'unblocked'} by ${auth.profile.full_name || actorRole}`,
        message: `${actorRole} · ${changed} court-hour${changed === 1 ? '' : 's'} ${action === 'block' ? 'blocked' : 'unblocked'} from the staff calendar.`,
      });
    } catch (notificationError) {
      console.error('[api/staff-blocks] notification failed', { code: notificationError.code || 'unknown' });
    }
    return sendJson(response, 200, { changed, skipped });
  } catch (error) {
    console.error('[api/staff-blocks] failed', { code: error.code || 'unknown' });
    return sendJson(response, 500, { error: 'Court availability could not be updated. Please try again.' });
  }
}

export default handler;
