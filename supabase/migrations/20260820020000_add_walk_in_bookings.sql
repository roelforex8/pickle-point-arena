alter table public.bookings
  add column booking_source text not null default 'online';

alter table public.bookings
  add constraint bookings_booking_source_check
  check (booking_source in ('online', 'walk_in'));

create or replace function public.create_staff_walk_in_booking(
  p_created_by uuid,
  p_slots jsonb
)
returns table(
  booking_id uuid,
  tracking_number text,
  subtotal numeric,
  booking_fee numeric,
  total_amount numeric,
  confirmed_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $function$
declare
  v_booking_id uuid := gen_random_uuid();
  v_tracking text;
  v_creator_name text;
  v_creator_role text;
  v_subtotal numeric(10,2) := 0;
  v_item jsonb;
  v_court_id smallint;
  v_start timestamptz;
  v_local_start timestamp;
  v_hour integer;
  v_rate numeric(10,2);
  v_count integer;
  v_activity_message text;
begin
  select p.full_name, p.role
  into v_creator_name, v_creator_role
  from public.profiles as p
  where p.id = p_created_by
    and p.active = true
    and p.role in ('owner', 'admin');

  if not found then
    raise exception 'An active Administrator or Owner is required.';
  end if;

  if p_slots is null or jsonb_typeof(p_slots) <> 'array' then
    raise exception 'Walk-In slots must be supplied as an array.';
  end if;

  v_count := jsonb_array_length(p_slots);
  if v_count < 1 or v_count > 500 then
    raise exception 'Select between 1 and 500 valid court-hours.';
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
      select 1
      from public.bookings as b
      where b.tracking_number = v_tracking
    );
  end loop;

  insert into public.bookings (
    id,
    tracking_number,
    customer_name,
    customer_email,
    status,
    subtotal,
    booking_fee,
    hold_expires_at,
    confirmed_at,
    confirmed_by,
    booking_source
  ) values (
    v_booking_id,
    v_tracking,
    'Walk-In',
    'walk-in@local.invalid',
    'confirmed',
    0,
    0,
    now(),
    now(),
    p_created_by,
    'walk_in'
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
      raise exception 'One or more selected Walk-In slots are invalid.';
    end;

    if not exists (
      select 1
      from public.courts as c
      where c.id = v_court_id
        and c.active = true
    ) then
      raise exception 'The selected court is unavailable.';
    end if;

    if date_trunc('hour', v_start) <> v_start then
      raise exception 'Walk-In bookings must start on the hour.';
    end if;

    if v_start <= now() then
      raise exception 'Walk-In bookings must be in the future.';
    end if;

    v_local_start := v_start at time zone 'Asia/Manila';
    v_hour := extract(hour from v_local_start)::integer;

    if v_hour >= 6 and v_hour < 16 then
      v_rate := 300;
    elsif v_hour >= 16 and v_hour <= 23 then
      v_rate := 350;
    else
      raise exception 'The selected time is outside operating hours.';
    end if;

    perform pg_advisory_xact_lock(
      hashtextextended(v_court_id::text || '|' || v_start::text, 0)
    );

    if exists (
      select 1
      from public.blocked_slots as bs
      where bs.court_id = v_court_id
        and tstzrange(bs.starts_at, bs.ends_at, '[)')
            && tstzrange(v_start, v_start + interval '1 hour', '[)')
    ) then
      raise exception 'A selected court-hour is blocked by the venue.';
    end if;

    if exists (
      select 1
      from public.booking_slots as s
      where s.court_id = v_court_id
        and s.status in ('held', 'payment_submitted', 'confirmed')
        and tstzrange(s.slot_start, s.slot_end, '[)')
            && tstzrange(v_start, v_start + interval '1 hour', '[)')
    ) then
      raise exception 'A selected court-hour is no longer available.';
    end if;

    insert into public.booking_slots (
      booking_id,
      court_id,
      slot_start,
      slot_end,
      hourly_rate,
      status
    ) values (
      v_booking_id,
      v_court_id,
      v_start,
      v_start + interval '1 hour',
      v_rate,
      'confirmed'
    );

    v_subtotal := v_subtotal + v_rate;
  end loop;

  update public.bookings
  set subtotal = v_subtotal
  where id = v_booking_id;

  select format(
    '%s · Courts %s · %s to %s · %s court-hour%s · ₱%s',
    case when v_creator_role = 'owner' then 'Owner' else 'Administrator' end,
    string_agg(distinct s.court_id::text, ', ' order by s.court_id::text),
    to_char(min(s.slot_start) at time zone 'Asia/Manila', 'Mon DD, YYYY HH12:MI AM'),
    to_char(max(s.slot_end) at time zone 'Asia/Manila', 'Mon DD, YYYY HH12:MI AM'),
    count(*),
    case when count(*) = 1 then '' else 's' end,
    trim(to_char(v_subtotal, 'FM999999990.00'))
  )
  into v_activity_message
  from public.booking_slots as s
  where s.booking_id = v_booking_id;

  insert into public.notifications (
    recipient_id,
    booking_id,
    kind,
    title,
    message
  )
  select
    recipient.id,
    v_booking_id,
    'system',
    'Walk-In booking created by ' || coalesce(nullif(trim(v_creator_name), ''), case when v_creator_role = 'owner' then 'Owner' else 'Administrator' end),
    v_activity_message
  from public.profiles as recipient
  where recipient.active = true
    and recipient.role in ('owner', 'admin');

  return query
  select
    b.id,
    b.tracking_number,
    b.subtotal,
    b.booking_fee,
    b.total_amount,
    b.confirmed_at
  from public.bookings as b
  where b.id = v_booking_id;
end;
$function$;

revoke all on function public.create_staff_walk_in_booking(uuid, jsonb) from public;
revoke all on function public.create_staff_walk_in_booking(uuid, jsonb) from anon;
revoke all on function public.create_staff_walk_in_booking(uuid, jsonb) from authenticated;
grant execute on function public.create_staff_walk_in_booking(uuid, jsonb) to service_role;
