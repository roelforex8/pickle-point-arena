-- Local-only extension of the Priority #3 production-shape fixture. Never link/apply remotely.
\ir priority3_local_baseline.sql

alter table public.profiles add column cancellation_pin_hash text;
alter table public.bookings add column customer_mobile text;

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  method text not null check (method in ('gcash', 'maya', 'metrobank', 'bpi')),
  reference_number text not null,
  receipt_path text not null,
  status text not null default 'pending_verification' check (status in ('pending_verification', 'verified', 'rejected')),
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id),
  review_note text
);

create schema storage;
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null,
  name text not null,
  metadata jsonb,
  created_at timestamptz not null default now(),
  unique (bucket_id, name)
);

alter table public.payments enable row level security;
alter table public.bookings enable row level security;
alter table public.booking_slots enable row level security;
grant usage on schema public to anon, authenticated, service_role;
