alter table public.bookings
  add column if not exists customer_mobile text;

comment on column public.bookings.customer_mobile is
  'Customer mobile number collected during public reservation confirmation.';
