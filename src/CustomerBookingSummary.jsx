import { groupBookingSlots, VENUE_TIME_ZONE } from './bookingSummary.js';
import './customerBookingSummary.css';

const statusDetails = {
  awaiting_payment: { heading: 'Booking submitted', label: 'Submitted', step: 0 },
  payment_submitted: { heading: 'Payment under review', label: 'Under review', step: 1 },
  confirmed: { heading: 'Booking confirmed', label: 'Confirmed', step: 2 },
  completed: { heading: 'Booking completed', label: 'Completed', step: 3 },
  rejected: { heading: 'Booking rejected', label: 'Rejected', step: -1 },
  cancelled: { heading: 'Booking cancelled', label: 'Cancelled', step: -1 },
  expired: { heading: 'Reservation expired', label: 'Expired', step: -1 },
};

const progressSteps = ['Submitted', 'Under Review', 'Confirmed', 'Completed'];

function formatMoney(value) {
  return `₱${Number(value || 0).toLocaleString('en-PH')}`;
}

function formatTimestamp(value) {
  if (!value) return '';
  return new Date(value).toLocaleString('en-PH', {
    timeZone: VENUE_TIME_ZONE,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

function InfoRow({ icon, label, children, className = '' }) {
  return <div className={`customer-summary-info-row ${className}`.trim()}>
    <span className="customer-summary-icon" aria-hidden="true">{icon}</span>
    <div><small>{label}</small>{children}</div>
  </div>;
}

export default function CustomerBookingSummary({ booking, location, onBack, children }) {
  const status = statusDetails[booking?.status] || { heading: booking?.status || 'Booking status', label: booking?.status || 'Unknown', step: -1 };
  const schedule = groupBookingSlots(booking?.slots || []);
  const courtHours = schedule.reduce((total, dateGroup) => total + dateGroup.courts.reduce((courtTotal, court) => courtTotal + court.ranges.reduce((rangeTotal, range) => rangeTotal + range.durationHours, 0), 0), 0);
  const paymentReference = booking?.payment?.referenceNumber;

  return <article className={`customer-booking-summary status-${booking?.status || 'unknown'}`}>
    <header className="customer-summary-header">
      <div><small>{booking?.trackingNumber}</small><h3>{status.heading}</h3><p>{booking?.customerName}{booking?.maskedEmail ? ` · ${booking.maskedEmail}` : ''}</p></div>
      {onBack && <button type="button" onClick={onBack} aria-label="Back to booking lookup">← Back</button>}
    </header>

    <div className="customer-summary-highlights">
      <span>Total<strong>{formatMoney(booking?.totalAmount)}</strong></span>
      <span>Court-hours<strong>{courtHours}</strong></span>
    </div>

    <ol className="customer-status-progress" aria-label="Booking progress">
      {progressSteps.map((step, index) => <li className={index < status.step ? 'done' : index === status.step ? 'current' : ''} key={step} aria-current={index === status.step ? 'step' : undefined}>
        <span aria-hidden="true">{index < status.step ? '✓' : index + 1}</span><strong>{step}</strong>
      </li>)}
    </ol>
    {status.step < 0 && <p className="customer-status-alert">Current status: <strong>{status.label}</strong></p>}

    <section className="customer-summary-panel" aria-labelledby="customer-booking-summary-title">
      <div className="customer-summary-panel-heading"><small>CURRENT STATUS · {status.label.toUpperCase()}</small><h4 id="customer-booking-summary-title">Booking Summary</h4></div>

      {schedule.map((dateGroup) => <div className="customer-summary-date" key={dateGroup.dateKey}>
        <InfoRow icon="▣" label="BOOKING DATE"><strong>{dateGroup.dateLabel}</strong></InfoRow>
        <div className="customer-summary-schedule"><small>COURT SCHEDULE</small><div>
          {dateGroup.courts.flatMap((court) => court.ranges.map((range) => <div className="customer-summary-court" key={`${court.courtId}-${range.startTime}`}>
            <span className="customer-summary-icon" aria-hidden="true">◷</span><div><strong>Court {court.courtId}</strong><span>{range.startTime}–{range.endTime} ({range.durationLabel})</span></div>
          </div>))}
        </div></div>
      </div>)}

      <div className="customer-summary-personal">
        {booking?.customerName && <InfoRow icon="♙" label="BOOKED BY"><strong>{booking.customerName}</strong>{booking.maskedEmail && <span>{booking.maskedEmail}</span>}</InfoRow>}
        {paymentReference && <InfoRow icon="#" label="PAYMENT REFERENCE"><strong>{paymentReference}</strong></InfoRow>}
        {booking?.payment?.method && <InfoRow icon="₱" label="PAYMENT METHOD"><strong>{booking.payment.method}</strong></InfoRow>}
        {location && <InfoRow icon="⌖" label="LOCATION" className="customer-summary-location"><strong>{location}</strong></InfoRow>}
      </div>

      <div className="customer-payment-total">
        <small>TOTAL PAYMENT</small>
        <strong>{formatMoney(booking?.totalAmount)}</strong>
      </div>

      <div className="customer-summary-timestamps">
        <small>BOOKING TIMELINE · PHILIPPINE TIME</small>
        {booking?.createdAt && <span>Booking created<strong>{formatTimestamp(booking.createdAt)}</strong></span>}
        {booking?.payment?.submittedAt && <span>Proof submitted<strong>{formatTimestamp(booking.payment.submittedAt)}</strong></span>}
        {booking?.confirmedAt && <span>Booking confirmed<strong>{formatTimestamp(booking.confirmedAt)}</strong></span>}
      </div>
    </section>

    {children && <div className="customer-summary-action">{children}</div>}
  </article>;
}
