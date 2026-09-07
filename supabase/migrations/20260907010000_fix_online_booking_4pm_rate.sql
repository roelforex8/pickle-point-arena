begin;

-- Complete authoritative definition of the trusted server-side online booking
-- function. This preserves the deployed behavior while correcting only the
-- 4:00 PM Asia/Manila pricing boundary.
create or replace function public.create_public_booking(
  p_customer_name text,
  p_customer_email text,
  p_slots jsonb
)
returns table(
  booking_id uuid,
  tracking_number text,
  subtotal numeric,
  booking_fee numeric,
  total_amount numeric,
  hold_expires_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $function$
declare
  v_booking_id uuid := gen_random_uuid();
  v_tracking text;
  v_subtotal numeric(10,2) := 0;
  v_item jsonb;
  v_court_id smallint;
  v_start timestamptz;
  v_local_start timestamp;
  v_hour integer;
  v_rate numeric(10,2);
  v_count integer;
begin
  if p_customer_name is null or char_length(trim(p_customer_name)) not between 2 and 120 then
    raise exception 'Please enter a valid full name.';
  end if;

  if p_customer_email is null
     or char_length(trim(p_customer_email)) > 254
     or trim(p_customer_email) !~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$' then
    raise exception 'Please enter a valid email address.';
  end if;

  if p_slots is null or jsonb_typeof(p_slots) <> 'array' then
    raise exception 'Booking slots must be supplied as an array.';
  end if;

  v_count := jsonb_array_length(p_slots);
  if v_count < 1 or v_count > 108 then
    raise exception 'Select between 1 and 108 court-hours.';
  end if;

  if v_count <> (
    select count(distinct (value ->> 'court_id') || '|' || (value ->> 'slot_start'))
    from jsonb_array_elements(p_slots)
  ) then
    raise exception 'The same court-hour was selected more than once.';
  end if;

  perform private.expire_stale_bookings();

  loop
    v_tracking := 'PPA-' || upper(substr(encode(extensions.gen_random_bytes(8), 'hex'), 1, 12));
    exit when not exists (
      select 1 from public.bookings b where b.tracking_number = v_tracking
    );
  end loop;

  insert into public.bookings (
    id, tracking_number, customer_name, customer_email, subtotal, booking_fee
  ) values (
    v_booking_id, v_tracking, trim(p_customer_name), lower(trim(p_customer_email)), 0, 10
  );

  for v_item in
    select value
    from jsonb_array_elements(p_slots)
    order by (value ->> 'court_id'), (value ->> 'slot_start')
  loop
    begin
      v_court_id := (v_item ->> 'court_id')::smallint;
      v_start := (v_item ->> 'slot_start')::timestamptz;
    exception when others then
      raise exception 'One or more selected slots are invalid.';
    end;

    if not exists (select 1 from public.courts where id = v_court_id and active = true) then
      raise exception 'The selected court is unavailable.';
    end if;

    if date_trunc('hour', v_start) <> v_start then
      raise exception 'Bookings must start on the hour.';
    end if;

    if v_start <= now() then
      raise exception 'Bookings must be in the future.';
    end if;

    v_local_start := v_start at time zone 'Asia/Manila';
    v_hour := extract(hour from v_local_start)::integer;

    if v_hour >= 6 and v_hour < 16 then
      v_rate := 300;
    elsif v_hour >= 16 and v_hour <= 23
       or v_hour in (0, 1) then
      v_rate := 350;
    else
      raise exception 'The selected time is outside operating hours.';
    end if;

    perform pg_advisory_xact_lock(
      hashtextextended(v_court_id::text || '|' || v_start::text, 0)
    );

    if exists (
      select 1 from public.blocked_slots bs
      where bs.court_id = v_court_id
        and tstzrange(bs.starts_at, bs.ends_at, '[)')
            && tstzrange(v_start, v_start + interval '1 hour', '[)')
    ) then
      raise exception 'A selected court-hour is blocked by the venue.';
    end if;

    if exists (
      select 1 from public.booking_slots s
      where s.court_id = v_court_id
        and s.slot_start = v_start
        and s.status in ('held', 'payment_submitted', 'confirmed')
    ) then
      raise exception 'A selected court-hour is no longer available.';
    end if;

    insert into public.booking_slots (
      booking_id, court_id, slot_start, slot_end, hourly_rate, status
    ) values (
      v_booking_id, v_court_id, v_start, v_start + interval '1 hour', v_rate, 'held'
    );

    v_subtotal := v_subtotal + v_rate;
  end loop;

  update public.bookings
  set subtotal = v_subtotal
  where id = v_booking_id;

  return query
  select b.id, b.tracking_number, b.subtotal, b.booking_fee,
         b.total_amount, b.hold_expires_at
  from public.bookings b
  where b.id = v_booking_id;
end;
$function$;

revoke all on function public.create_public_booking(text, text, jsonb) from public;
revoke all on function public.create_public_booking(text, text, jsonb) from anon;
revoke all on function public.create_public_booking(text, text, jsonb) from authenticated;
grant execute on function public.create_public_booking(text, text, jsonb) to service_role;

commit;
