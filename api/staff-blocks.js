import { requireStaff, sendJson } from './_supabase.js';
import { notifyStaff } from './_booking.js';

const HOUR_MS = 60 * 60 * 1000;

function selectionInterval(selection) {
  const date = String(selection?.date || '');
  const hour = Number(selection?.hour);
  const courtId = Number(selection?.courtId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(hour) || hour < 6 || hour > 25 || !Number.isInteger(courtId) || courtId < 1 || courtId > 6) return null;
  const dayOffset = hour >= 24 ? 1 : 0;
  const normalizedHour = hour % 24;
  const start = new Date(`${date}T${String(normalizedHour).padStart(2, '0')}:00:00+08:00`);
  start.setUTCDate(start.getUTCDate() + dayOffset);
  return { date, hour, courtId, startMs: start.getTime(), endMs: start.getTime() + HOUR_MS };
}

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store, max-age=0');
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return sendJson(response, 405, { error: 'Method not allowed.' });
  }

  try {
    const auth = await requireStaff(request);
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

    const minStart = new Date(Math.min(...selections.map((item) => item.startMs))).toISOString();
    const maxEnd = new Date(Math.max(...selections.map((item) => item.endMs))).toISOString();
    const courtIds = [...new Set(selections.map((item) => item.courtId))];
    const overlaps = (row, startField, endField, item) => Number(row.court_id) === item.courtId && new Date(row[startField]).getTime() < item.endMs && new Date(row[endField]).getTime() > item.startMs;

    if (action === 'block') {
      const [{ data: bookings, error: bookingError }, { data: blocks, error: blockError }] = await Promise.all([
        auth.admin.from('booking_slots').select('court_id, slot_start, slot_end, status').in('court_id', courtIds).lt('slot_start', maxEnd).gt('slot_end', minStart).in('status', ['held', 'payment_submitted', 'confirmed']),
        auth.admin.from('blocked_slots').select('court_id, starts_at, ends_at').in('court_id', courtIds).lt('starts_at', maxEnd).gt('ends_at', minStart),
      ]);
      if (bookingError || blockError) throw bookingError || blockError;
      const conflicts = selections.filter((item) => (bookings || []).some((row) => overlaps(row, 'slot_start', 'slot_end', item)));
      if (conflicts.length) return sendJson(response, 409, { error: `${conflicts.length} selected court-hour${conflicts.length === 1 ? '' : 's'} contain active bookings. Nothing was changed.` });
      const available = selections.filter((item) => !(blocks || []).some((row) => overlaps(row, 'starts_at', 'ends_at', item)));
      const reason = String(body.reason || 'Venue unavailable').trim().slice(0, 120) || 'Venue unavailable';
      const rows = available.map((item) => ({ court_id: item.courtId, starts_at: new Date(item.startMs).toISOString(), ends_at: new Date(item.endMs).toISOString(), reason, created_by: auth.profile.id }));
      if (rows.length) {
        const { error } = await auth.admin.from('blocked_slots').insert(rows);
        if (error) throw error;
      }
      const actorRole = auth.profile.role === 'owner' ? 'Owner' : 'Administrator';
      await notifyStaff(auth.admin, { kind: 'system', title: `Court availability blocked by ${auth.profile.full_name || actorRole}`, message: `${actorRole} · ${rows.length} court-hour${rows.length === 1 ? '' : 's'} blocked from the staff calendar.` });
      return sendJson(response, 200, { changed: rows.length, skipped: selections.length - rows.length });
    }

    const { data: blocks, error: blockError } = await auth.admin.from('blocked_slots').select('id, court_id, starts_at, ends_at, reason').in('court_id', courtIds).lt('starts_at', maxEnd).gt('ends_at', minStart);
    if (blockError) throw blockError;
    const affected = (blocks || []).filter((block) => selections.some((item) => overlaps(block, 'starts_at', 'ends_at', item)));
    const residual = [];
    affected.forEach((block) => {
      let segments = [{ startMs: new Date(block.starts_at).getTime(), endMs: new Date(block.ends_at).getTime() }];
      selections.filter((item) => Number(block.court_id) === item.courtId).forEach((item) => {
        segments = segments.flatMap((segment) => {
          if (item.startMs >= segment.endMs || item.endMs <= segment.startMs) return [segment];
          const pieces = [];
          if (segment.startMs < item.startMs) pieces.push({ startMs: segment.startMs, endMs: item.startMs });
          if (item.endMs < segment.endMs) pieces.push({ startMs: item.endMs, endMs: segment.endMs });
          return pieces;
        });
      });
      segments.forEach((segment) => residual.push({ court_id: block.court_id, starts_at: new Date(segment.startMs).toISOString(), ends_at: new Date(segment.endMs).toISOString(), reason: block.reason || 'Venue unavailable', created_by: auth.profile.id }));
    });
    if (affected.length) {
      const { error: deleteError } = await auth.admin.from('blocked_slots').delete().in('id', affected.map((block) => block.id));
      if (deleteError) throw deleteError;
      if (residual.length) {
        const { error: insertError } = await auth.admin.from('blocked_slots').insert(residual);
        if (insertError) throw insertError;
      }
    }
    const changed = selections.filter((item) => affected.some((block) => overlaps(block, 'starts_at', 'ends_at', item))).length;
    const actorRole = auth.profile.role === 'owner' ? 'Owner' : 'Administrator';
    await notifyStaff(auth.admin, { kind: 'system', title: `Court availability unblocked by ${auth.profile.full_name || actorRole}`, message: `${actorRole} · ${changed} court-hour${changed === 1 ? '' : 's'} unblocked from the staff calendar.` });
    return sendJson(response, 200, { changed, skipped: selections.length - changed });
  } catch (error) {
    return sendJson(response, 500, { error: error.message || 'Court availability could not be updated.' });
  }
}
