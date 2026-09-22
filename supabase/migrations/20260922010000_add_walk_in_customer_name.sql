alter table public.bookings
  add column if not exists walk_in_customer_name text;

create or replace function public.create_staff_walk_in_booking(
  p_created_by uuid,
  p_slots jsonb,
  p_customer_name text
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
  v_customer_name text := trim(coalesce(p_customer_name, ''));
  v_created record;
begin
  if length(v_customer_name) not between 2 and 120 then
    raise exception using errcode = 'P0001', message = 'walk_in_customer_name_invalid';
  end if;

  select created.* into v_created
  from public.create_staff_walk_in_booking(p_created_by, p_slots) as created
  limit 1;

  update public.bookings
  set walk_in_customer_name = v_customer_name
  where id = v_created.booking_id;

  return query
  select
    v_created.booking_id,
    v_created.tracking_number,
    v_created.subtotal,
    v_created.booking_fee,
    v_created.total_amount,
    v_created.confirmed_at;
end;
$function$;

create or replace function public.create_staff_walk_in_booking_idempotent(
  p_created_by uuid,
  p_slots jsonb,
  p_customer_name text,
  p_idempotency_key uuid,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $function$
declare
  v_actor_scope text := 'staff:' || p_created_by::text;
  v_existing jsonb;
  v_created record;
  v_result jsonb;
begin
  v_existing := private.claim_idempotency(
    'staff_walk_in_create', v_actor_scope, p_idempotency_key, p_request_hash
  );
  if v_existing is not null then return v_existing; end if;

  select created.* into v_created
  from public.create_staff_walk_in_booking(p_created_by, p_slots, p_customer_name) as created
  limit 1;
  if v_created.booking_id is null then
    raise exception using errcode = 'P0001', message = 'walk_in_creation_failed';
  end if;

  v_result := jsonb_build_object(
    'bookingId', v_created.booking_id,
    'trackingNumber', v_created.tracking_number,
    'subtotal', v_created.subtotal,
    'bookingFee', v_created.booking_fee,
    'totalAmount', v_created.total_amount,
    'confirmedAt', v_created.confirmed_at
  );
  perform private.complete_idempotency(
    'staff_walk_in_create', v_actor_scope, p_idempotency_key, p_request_hash, v_result
  );
  return v_result;
end;
$function$;

revoke all on function public.create_staff_walk_in_booking(uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.create_staff_walk_in_booking_idempotent(uuid, jsonb, text, uuid, text) from public, anon, authenticated;
grant execute on function public.create_staff_walk_in_booking(uuid, jsonb, text) to service_role;
grant execute on function public.create_staff_walk_in_booking_idempotent(uuid, jsonb, text, uuid, text) to service_role;
