create or replace function public.cancel_staff_walk_in_booking(
  p_cancelled_by uuid,
  p_booking_id uuid
)
returns table(
  booking_id uuid,
  tracking_number text,
  total_amount numeric,
  cancelled_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_booking public.bookings%rowtype;
  v_actor_name text;
  v_actor_role text;
  v_cancelled_at timestamptz := now();
  v_total_slot_count integer;
  v_active_slot_count integer;
  v_updated_slot_count integer;
  v_updated_booking_count integer;
  v_schedule_context text;
begin
  select nullif(trim(p.full_name), ''), p.role
  into v_actor_name, v_actor_role
  from public.profiles as p
  where p.id = p_cancelled_by
    and p.active = true
    and p.role in ('admin', 'owner');

  if not found then
    raise exception using errcode = 'P0001', message = 'staff_not_authorized';
  end if;

  select b.*
  into v_booking
  from public.bookings as b
  where b.id = p_booking_id
    and b.booking_source = 'walk_in'
    and b.status = 'confirmed'
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'walk_in_not_cancellable';
  end if;

  select
    count(*),
    count(*) filter (where s.status in ('held', 'payment_submitted', 'confirmed')),
    string_agg(
      format(
        'Court %s %s-%s',
        s.court_id,
        to_char(s.slot_start at time zone 'Asia/Manila', 'Mon DD, YYYY HH12:MI AM'),
        to_char(s.slot_end at time zone 'Asia/Manila', 'HH12:MI AM')
      ),
      '; ' order by s.slot_start, s.court_id
    )
  into v_total_slot_count, v_active_slot_count, v_schedule_context
  from public.booking_slots as s
  where s.booking_id = p_booking_id;

  if v_total_slot_count < 1 or v_active_slot_count <> v_total_slot_count then
    raise exception using errcode = 'P0001', message = 'walk_in_slots_not_cancellable';
  end if;

  update public.bookings
  set status = 'cancelled'
  where id = p_booking_id
    and booking_source = 'walk_in'
    and status = 'confirmed';

  get diagnostics v_updated_booking_count = row_count;

  if v_updated_booking_count <> 1 then
    raise exception using errcode = 'P0001', message = 'walk_in_not_cancellable';
  end if;

  update public.booking_slots as s
  set status = 'cancelled'
  where s.booking_id = p_booking_id
    and s.status in ('held', 'payment_submitted', 'confirmed');

  get diagnostics v_updated_slot_count = row_count;

  if v_updated_slot_count <> v_active_slot_count then
    raise exception using errcode = 'P0001', message = 'walk_in_cancellation_incomplete';
  end if;

  insert into public.notifications (
    recipient_id,
    booking_id,
    kind,
    title,
    message
  )
  select
    recipient.id,
    p_booking_id,
    'system',
    'Walk-In booking cancelled by ' || coalesce(
      v_actor_name,
      case when v_actor_role = 'owner' then 'Owner' else 'Administrator' end
    ),
    format(
      '%s · %s · ₱%s · Cancelled %s',
      v_booking.tracking_number,
      v_schedule_context,
      trim(to_char(v_booking.total_amount, 'FM999999990.00')),
      to_char(v_cancelled_at at time zone 'Asia/Manila', 'Mon DD, YYYY HH12:MI AM')
    )
  from public.profiles as recipient
  where recipient.active = true
    and recipient.role in ('admin', 'owner');

  return query
  select
    v_booking.id,
    v_booking.tracking_number,
    v_booking.total_amount,
    v_cancelled_at;
end;
$function$;

revoke all on function public.cancel_staff_walk_in_booking(uuid, uuid) from public;
revoke all on function public.cancel_staff_walk_in_booking(uuid, uuid) from anon;
revoke all on function public.cancel_staff_walk_in_booking(uuid, uuid) from authenticated;
grant execute on function public.cancel_staff_walk_in_booking(uuid, uuid) to service_role;
