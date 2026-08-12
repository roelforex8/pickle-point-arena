export const VENUE_TIME_ZONE = 'Asia/Manila';

const datePartsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: VENUE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const dateLabelFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: VENUE_TIME_ZONE,
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});

const timeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: VENUE_TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
});

function manilaDateKey(value) {
  const parts = Object.fromEntries(datePartsFormatter.formatToParts(value).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function durationLabel(milliseconds) {
  const hours = milliseconds / 3_600_000;
  const value = Number.isInteger(hours) ? hours : Number(hours.toFixed(2));
  return `${value} hr${value === 1 ? '' : 's'}`;
}

/** Groups receipt slots by their Philippine calendar date, court, and consecutive ranges. */
export function groupBookingSlots(slots = []) {
  const validSlots = slots
    .map((slot) => ({
      courtId: Number(slot.court_id ?? slot.courtId),
      start: new Date(slot.slot_start ?? slot.slotStart),
      end: new Date(slot.slot_end ?? slot.slotEnd),
    }))
    .filter((slot) => Number.isFinite(slot.courtId) && !Number.isNaN(slot.start.getTime()) && slot.end > slot.start)
    .map((slot) => ({ ...slot, dateKey: manilaDateKey(slot.start) }))
    .sort((first, second) => first.dateKey.localeCompare(second.dateKey) || first.courtId - second.courtId || first.start - second.start);

  const dateGroups = [];
  for (const slot of validSlots) {
    let dateGroup = dateGroups.at(-1);
    if (!dateGroup || dateGroup.dateKey !== slot.dateKey) {
      dateGroup = {
        dateKey: slot.dateKey,
        dateLabel: dateLabelFormatter.format(slot.start),
        courts: [],
      };
      dateGroups.push(dateGroup);
    }

    let court = dateGroup.courts.at(-1);
    if (!court || court.courtId !== slot.courtId) {
      court = { courtId: slot.courtId, ranges: [] };
      dateGroup.courts.push(court);
    }

    const previous = court.ranges.at(-1);
    if (previous && previous.end.getTime() === slot.start.getTime()) {
      previous.end = slot.end;
      previous.durationMs += slot.end - slot.start;
    } else {
      court.ranges.push({ start: slot.start, end: slot.end, durationMs: slot.end - slot.start });
    }
  }

  return dateGroups.map((dateGroup) => ({
    ...dateGroup,
    courts: dateGroup.courts.map((court) => ({
      ...court,
      ranges: court.ranges.map((range) => ({
        startTime: timeFormatter.format(range.start),
        endTime: timeFormatter.format(range.end),
        durationHours: range.durationMs / 3_600_000,
        durationLabel: durationLabel(range.durationMs),
      })),
    })),
  }));
}
