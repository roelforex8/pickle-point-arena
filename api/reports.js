import { requireStaff, sendJson } from './_supabase.js';

function manilaDateKey(value) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function shiftDateKey(key, days) {
  const date = new Date(`${key}T12:00:00+08:00`);
  date.setUTCDate(date.getUTCDate() + days);
  return manilaDateKey(date);
}

function weekKey(value) {
  const key = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : manilaDateKey(value);
  const date = new Date(`${key}T12:00:00+08:00`);
  const offset = date.getUTCDay() === 0 ? -6 : 1 - date.getUTCDay();
  return shiftDateKey(key, offset);
}

function shiftMonthKey(key, months) {
  const [year, month] = key.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1 + months, 15));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function daysBetween(start, end) {
  const startDate = new Date(`${start}T12:00:00+08:00`);
  const endDate = new Date(`${end}T12:00:00+08:00`);
  return Math.round((endDate.getTime() - startDate.getTime()) / 86400000);
}

export default async function handler(request, response) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    return sendJson(response, 405, { error: 'Method not allowed.' });
  }

  try {
    const auth = await requireStaff(request, 'owner');
    if (auth.error) return sendJson(response, auth.status, { error: auth.error });

    const [{ data: confirmed, error: confirmedError }, { data: pending, error: pendingError }] = await Promise.all([
      auth.admin.from('bookings').select('id, total_amount, confirmed_at, booking_slots(id, court_id, hourly_rate)').eq('status', 'confirmed').order('confirmed_at', { ascending: false }).limit(5000),
      auth.admin.from('bookings').select('id, total_amount').eq('status', 'payment_submitted').limit(5000),
    ]);
    if (confirmedError || pendingError) throw confirmedError || pendingError;

    const totalRevenue = (confirmed || []).reduce((sum, booking) => sum + Number(booking.total_amount || 0), 0);
    const courtHours = (confirmed || []).reduce((sum, booking) => sum + (booking.booking_slots?.length || 0), 0);
    const pendingRevenue = (pending || []).reduce((sum, booking) => sum + Number(booking.total_amount || 0), 0);
    const today = manilaDateKey(new Date());
    const period = ['day', 'week', 'month', 'range'].includes(request.query?.period) ? request.query.period : 'day';
    const requestedFrom = String(request.query?.from || '');
    const requestedTo = String(request.query?.to || '');
    const validDateKey = /^\d{4}-\d{2}-\d{2}$/;
    if (period === 'range' && (!validDateKey.test(requestedFrom) || !validDateKey.test(requestedTo))) {
      return sendJson(response, 400, { error: 'Choose a valid start and end date.' });
    }
    const rangeDays = period === 'range' ? daysBetween(requestedFrom, requestedTo) + 1 : 0;
    if (period === 'range' && (rangeDays < 1 || rangeDays > 366)) {
      return sendJson(response, 400, { error: 'The sales range must be between 1 and 366 days.' });
    }
    const currentKey = period === 'day' ? today : period === 'week' ? weekKey(today) : period === 'month' ? today.slice(0, 7) : requestedFrom;
    const previousKey = period === 'day' ? shiftDateKey(currentKey, -1) : period === 'week' ? shiftDateKey(currentKey, -7) : period === 'month' ? shiftMonthKey(currentKey, -1) : shiftDateKey(requestedFrom, -rangeDays);
    const currentEnd = period === 'range' ? requestedTo : currentKey;
    const previousEnd = period === 'range' ? shiftDateKey(requestedFrom, -1) : previousKey;
    const bookingPeriodKey = (booking) => {
      if (!booking.confirmed_at) return '';
      return period === 'day' ? manilaDateKey(booking.confirmed_at) : period === 'week' ? weekKey(booking.confirmed_at) : period === 'month' ? manilaDateKey(booking.confirmed_at).slice(0, 7) : manilaDateKey(booking.confirmed_at);
    };
    const inWindow = (booking, start, end = start) => {
      const key = bookingPeriodKey(booking);
      return key >= start && key <= end;
    };
    const periodRevenue = (key) => (confirmed || []).filter((booking) => bookingPeriodKey(booking) === key).reduce((sum, booking) => sum + Number(booking.total_amount || 0), 0);
    const windowRevenue = (start, end) => (confirmed || []).filter((booking) => inWindow(booking, start, end)).reduce((sum, booking) => sum + Number(booking.total_amount || 0), 0);
    const windowBookings = (start, end) => (confirmed || []).filter((booking) => inWindow(booking, start, end)).length;
    const currentRevenue = windowRevenue(currentKey, currentEnd);
    const previousRevenue = windowRevenue(previousKey, previousEnd);
    const courtBreakdown = (start, end = start) => {
      const courts = Array.from({ length: 6 }, (_, index) => ({ courtId: index + 1, revenue: 0, courtHours: 0 }));
      (confirmed || []).filter((booking) => inWindow(booking, start, end)).forEach((booking) => {
        const slots = booking.booking_slots || [];
        const weight = slots.reduce((sum, slot) => sum + Math.max(1, Number(slot.hourly_rate || 0)), 0) || 1;
        slots.forEach((slot) => {
          const court = courts[Number(slot.court_id) - 1];
          if (!court) return;
          court.courtHours += 1;
          court.revenue += Number(booking.total_amount || 0) * (Math.max(1, Number(slot.hourly_rate || 0)) / weight);
        });
      });
      return courts.map((court) => ({ ...court, revenue: Math.round(court.revenue) }));
    };
    const currentCourtSales = courtBreakdown(currentKey, currentEnd);
    const previousCourtSales = courtBreakdown(previousKey, previousEnd);
    const seriesLength = period === 'day' ? 7 : period === 'week' ? 8 : period === 'month' ? 12 : rangeDays;
    const series = Array.from({ length: seriesLength }, (_, index) => {
      const distance = seriesLength - 1 - index;
      const key = period === 'day' ? shiftDateKey(currentKey, -distance) : period === 'week' ? shiftDateKey(currentKey, -distance * 7) : period === 'month' ? shiftMonthKey(currentKey, -distance) : shiftDateKey(currentKey, index);
      const label = period === 'day'
        ? new Date(`${key}T12:00:00+08:00`).toLocaleDateString('en-US', { timeZone: 'Asia/Manila', weekday: 'short' })
        : period === 'week'
          ? new Date(`${key}T12:00:00+08:00`).toLocaleDateString('en-US', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric' })
          : period === 'month'
            ? new Date(`${key}-15T12:00:00+08:00`).toLocaleDateString('en-US', { timeZone: 'Asia/Manila', month: 'short' })
            : new Date(`${key}T12:00:00+08:00`).toLocaleDateString('en-US', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric' });
      return { key, label, revenue: periodRevenue(key) };
    });

    return sendJson(response, 200, {
      totalRevenue,
      confirmedBookings: confirmed?.length || 0,
      courtHours,
      averageBooking: confirmed?.length ? Math.round(totalRevenue / confirmed.length) : 0,
      pendingRevenue,
      pendingBookings: pending?.length || 0,
      period,
      rangeFrom: period === 'range' ? requestedFrom : null,
      rangeTo: period === 'range' ? requestedTo : null,
      rangeDays: period === 'range' ? rangeDays : null,
      currentRevenue,
      previousRevenue,
      currentBookings: windowBookings(currentKey, currentEnd),
      previousBookings: windowBookings(previousKey, previousEnd),
      changeAmount: currentRevenue - previousRevenue,
      changePercent: previousRevenue ? Math.round(((currentRevenue - previousRevenue) / previousRevenue) * 100) : currentRevenue ? 100 : 0,
      courtSales: currentCourtSales.map((court, index) => {
        const previous = previousCourtSales[index];
        return {
          courtId: court.courtId,
          currentRevenue: court.revenue,
          previousRevenue: previous.revenue,
          currentCourtHours: court.courtHours,
          previousCourtHours: previous.courtHours,
          changePercent: previous.revenue ? Math.round(((court.revenue - previous.revenue) / previous.revenue) * 100) : court.revenue ? 100 : 0,
        };
      }),
      series,
    });
  } catch (error) {
    return sendJson(response, 500, { error: error.message || 'The sales report could not be loaded.' });
  }
}
