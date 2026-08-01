begin;

alter table public.bookings
  add column if not exists review_undo_count integer not null default 0;

alter table public.profiles
  add column if not exists cancellation_pin_hash text;

alter table public.bookings
  drop constraint if exists bookings_status_check;
alter table public.bookings
  add constraint bookings_status_check check (status in (
    'awaiting_payment', 'payment_submitted', 'confirmed', 'rejected', 'expired', 'cancelled'
  ));

alter table public.booking_slots
  drop constraint if exists booking_slots_status_check;
alter table public.booking_slots
  add constraint booking_slots_status_check check (status in (
    'held', 'payment_submitted', 'confirmed', 'rejected', 'expired', 'cancelled'
  ));

commit;
