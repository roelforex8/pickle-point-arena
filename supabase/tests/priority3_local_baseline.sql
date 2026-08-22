-- Local-only production-shape fixture. Never apply this file to a linked project.
do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$roles$;
create schema if not exists extensions;
create schema if not exists private;
create extension if not exists pgcrypto with schema extensions;

create table public.courts (
  id smallint primary key,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.courts (id, name)
select value, 'Court ' || value from generate_series(1, 6) as value;

create table public.profiles (
  id uuid primary key,
  full_name text,
  role text not null default 'admin',
  active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.profiles (id, full_name, role, active)
values ('00000000-0000-4000-8000-000000000001', 'Local Owner', 'owner', true);

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  tracking_number text not null unique,
  customer_name text not null,
  customer_email text not null,
  status text not null default 'awaiting_payment' check (
    status in ('awaiting_payment', 'payment_submitted', 'confirmed', 'rejected', 'expired', 'cancelled')
  ),
  subtotal numeric(10,2) not null default 0,
  booking_fee numeric(10,2) not null default 10,
  total_amount numeric(10,2) generated always as (subtotal + booking_fee) stored,
  hold_expires_at timestamptz not null default now() + interval '15 minutes',
  confirmed_at timestamptz,
  confirmed_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  review_undo_count integer not null default 0
);

create table public.booking_slots (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  court_id smallint not null references public.courts(id),
  slot_start timestamptz not null,
  slot_end timestamptz not null,
  hourly_rate numeric(10,2) not null,
  status text not null default 'held' check (
    status in ('held', 'payment_submitted', 'confirmed', 'rejected', 'expired', 'cancelled')
  ),
  created_at timestamptz not null default now()
);

create unique index booking_slots_active_unique
on public.booking_slots (court_id, slot_start)
where status in ('held', 'payment_submitted', 'confirmed');

create table public.blocked_slots (
  id uuid primary key default gen_random_uuid(),
  court_id smallint not null references public.courts(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text not null default 'Venue unavailable',
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles(id),
  booking_id uuid references public.bookings(id),
  kind text not null,
  title text not null,
  message text not null,
  created_at timestamptz not null default now()
);

create or replace function private.expire_stale_bookings()
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  update public.booking_slots as s
  set status = 'expired'
  from public.bookings as b
  where b.id = s.booking_id
    and b.status = 'awaiting_payment'
    and b.hold_expires_at <= now()
    and s.status = 'held';

  update public.bookings
  set status = 'expired'
  where status = 'awaiting_payment'
    and hold_expires_at <= now();
end;
$function$;

create or replace function public.create_public_booking(
  p_customer_name text,
  p_customer_email text,
  p_slots jsonb
)
returns table(booking_id uuid, tracking_number text)
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $function$
declare
  v_booking_id uuid := gen_random_uuid();
  v_tracking text := 'PPA-' || upper(substr(encode(extensions.gen_random_bytes(8), 'hex'), 1, 12));
  v_item jsonb;
  v_court_id smallint;
  v_start timestamptz;
  v_hour integer;
  v_rate numeric(10,2);
  v_subtotal numeric(10,2) := 0;
begin
  if jsonb_typeof(p_slots) <> 'array' or jsonb_array_length(p_slots) not between 1 and 108 then
    raise exception 'Select between 1 and 108 court-hours.';
  end if;
  perform private.expire_stale_bookings();

  insert into public.bookings (
    id, tracking_number, customer_name, customer_email, status, subtotal, booking_fee
  ) values (
    v_booking_id, v_tracking, p_customer_name, p_customer_email, 'awaiting_payment', 0,
    jsonb_array_length(p_slots) * 10
  );

  for v_item in
    select value from jsonb_array_elements(p_slots)
    order by (value ->> 'court_id')::smallint, (value ->> 'slot_start')::timestamptz
  loop
    v_court_id := (v_item ->> 'court_id')::smallint;
    v_start := (v_item ->> 'slot_start')::timestamptz;
    v_hour := extract(hour from v_start at time zone 'Asia/Manila')::integer;
    if v_start <= now() or v_start <> date_trunc('hour', v_start) or v_hour not between 6 and 23 then
      raise exception 'A selected court-hour is invalid.';
    end if;
    v_rate := case when v_hour < 16 then 300 else 350 end;
    insert into public.booking_slots (
      booking_id, court_id, slot_start, slot_end, hourly_rate, status
    ) values (
      v_booking_id, v_court_id, v_start, v_start + interval '1 hour', v_rate, 'held'
    );
    v_subtotal := v_subtotal + v_rate;
  end loop;

  update public.bookings set subtotal = v_subtotal where id = v_booking_id;
  return query select v_booking_id, v_tracking;
end;
$function$;

create or replace function public.test_force_late_booking_failure(p_slots jsonb)
returns void
language plpgsql
set search_path = pg_catalog, public
as $function$
begin
  perform public.create_public_booking('Forced Failure', 'forced@local.invalid', p_slots);
  raise exception using errcode = 'P0001', message = 'forced_late_failure';
end;
$function$;
