begin;

create or replace function public.create_staff_walk_in_booking_idempotent(
  p_created_by uuid,
  p_slots jsonb,
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
  from public.create_staff_walk_in_booking(p_created_by, p_slots) as created
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

create or replace function public.cancel_staff_walk_in_booking_idempotent(
  p_cancelled_by uuid,
  p_booking_id uuid,
  p_idempotency_key uuid,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $function$
declare
  v_actor_scope text := 'staff:' || p_cancelled_by::text;
  v_existing jsonb;
  v_cancelled record;
  v_result jsonb;
begin
  v_existing := private.claim_idempotency(
    'staff_walk_in_cancel', v_actor_scope, p_idempotency_key, p_request_hash
  );
  if v_existing is not null then return v_existing; end if;

  select cancelled.* into v_cancelled
  from public.cancel_staff_walk_in_booking(p_cancelled_by, p_booking_id) as cancelled
  limit 1;
  if v_cancelled.booking_id is null then
    raise exception using errcode = 'P0001', message = 'walk_in_cancellation_failed';
  end if;

  v_result := jsonb_build_object(
    'bookingId', v_cancelled.booking_id,
    'trackingNumber', v_cancelled.tracking_number,
    'totalAmount', v_cancelled.total_amount,
    'cancelledAt', v_cancelled.cancelled_at
  );
  perform private.complete_idempotency(
    'staff_walk_in_cancel', v_actor_scope, p_idempotency_key, p_request_hash, v_result
  );
  return v_result;
end;
$function$;

create or replace function public.manage_staff_blocked_slots_idempotent(
  p_created_by uuid,
  p_action text,
  p_reason text,
  p_slots jsonb,
  p_idempotency_key uuid,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $function$
declare
  v_actor record;
  v_actor_scope text := 'staff:' || p_created_by::text;
  v_existing jsonb;
  v_changed record;
  v_result jsonb;
begin
  select * into v_actor from private.staff_actor(p_created_by, false);
  if not found then
    raise exception using errcode = 'P0001', message = 'staff_not_authorized';
  end if;

  v_existing := private.claim_idempotency(
    'staff_blocked_slots', v_actor_scope, p_idempotency_key, p_request_hash
  );
  if v_existing is not null then return v_existing; end if;

  select managed.* into v_changed
  from public.manage_staff_blocked_slots(
    p_created_by, p_action, p_reason, p_slots
  ) as managed
  limit 1;
  if v_changed.changed is null then
    raise exception using errcode = 'P0001', message = 'staff_block_operation_failed';
  end if;

  if v_changed.changed > 0 then
    insert into public.notifications (recipient_id, kind, title, message)
    select
      recipient.id,
      'system',
      'Court availability ' || case when p_action = 'block' then 'blocked' else 'unblocked' end ||
        ' by ' || v_actor.actor_name,
      case when v_actor.actor_role = 'owner' then 'Owner' else 'Administrator' end ||
        ' - ' || v_changed.changed || ' court-hour' || case when v_changed.changed = 1 then '' else 's' end ||
        ' ' || case when p_action = 'block' then 'blocked' else 'unblocked' end || ' from the staff calendar.'
    from public.profiles as recipient
    where recipient.active = true and recipient.role in ('owner', 'admin');
  end if;

  v_result := jsonb_build_object('changed', v_changed.changed, 'skipped', v_changed.skipped);
  perform private.complete_idempotency(
    'staff_blocked_slots', v_actor_scope, p_idempotency_key, p_request_hash, v_result
  );
  return v_result;
end;
$function$;

create or replace function public.set_owner_pin_hash_idempotent(
  p_actor_id uuid,
  p_pin_hash text,
  p_idempotency_key uuid,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $function$
declare
  v_actor record;
  v_actor_scope text := 'owner:' || p_actor_id::text;
  v_existing jsonb;
  v_result jsonb;
begin
  select * into v_actor from private.staff_actor(p_actor_id, true);
  if not found then
    raise exception using errcode = 'P0001', message = 'owner_not_authorized';
  end if;
  if p_pin_hash is null or length(p_pin_hash) < 20 then
    raise exception using errcode = 'P0001', message = 'pin_hash_invalid';
  end if;

  v_existing := private.claim_idempotency(
    'owner_pin_update', v_actor_scope, p_idempotency_key, p_request_hash
  );
  if v_existing is not null then return v_existing; end if;

  update public.profiles
  set cancellation_pin_hash = p_pin_hash
  where id = p_actor_id and active = true and role = 'owner';
  if not found then
    raise exception using errcode = 'P0001', message = 'owner_not_authorized';
  end if;

  v_result := jsonb_build_object('configured', true);
  perform private.complete_idempotency(
    'owner_pin_update', v_actor_scope, p_idempotency_key, p_request_hash, v_result
  );
  return v_result;
end;
$function$;

create or replace function public.claim_external_admin_operation(
  p_operation text,
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $function$
declare
  v_actor record;
  v_actor_scope text := 'owner:' || p_actor_id::text;
  v_record private.idempotency_records%rowtype;
  v_inserted integer;
begin
  select * into v_actor from private.staff_actor(p_actor_id, true);
  if not found then
    raise exception using errcode = 'P0001', message = 'owner_not_authorized';
  end if;
  if p_operation not in (
    'admin_create', 'admin_disable', 'admin_reactivate', 'admin_remove', 'admin_password'
  ) or p_idempotency_key is null or p_request_hash is null or p_request_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_request';
  end if;

  delete from private.idempotency_records where expires_at <= now();

  insert into private.idempotency_records (
    operation, actor_scope, idempotency_key, request_hash
  ) values (
    p_operation, v_actor_scope, p_idempotency_key, p_request_hash
  )
  on conflict (operation, actor_scope, idempotency_key) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted = 1 then
    return jsonb_build_object('disposition', 'execute');
  end if;

  select r.* into v_record
  from private.idempotency_records as r
  where r.operation = p_operation
    and r.actor_scope = v_actor_scope
    and r.idempotency_key = p_idempotency_key
  for update;

  if v_record.request_hash <> p_request_hash then
    raise exception using errcode = 'P0001', message = 'idempotency_payload_mismatch';
  end if;
  if v_record.response is not null then
    return jsonb_build_object('disposition', 'completed', 'result', v_record.response);
  end if;
  return jsonb_build_object('disposition', 'in_progress');
end;
$function$;

create or replace function public.complete_external_admin_operation(
  p_operation text,
  p_actor_id uuid,
  p_target_id uuid,
  p_target_full_name text,
  p_target_active boolean,
  p_idempotency_key uuid,
  p_request_hash text,
  p_response jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $function$
declare
  v_actor record;
  v_actor_scope text := 'owner:' || p_actor_id::text;
  v_record private.idempotency_records%rowtype;
  v_title text;
begin
  select * into v_actor from private.staff_actor(p_actor_id, true);
  if not found then
    raise exception using errcode = 'P0001', message = 'owner_not_authorized';
  end if;
  if p_operation not in (
    'admin_create', 'admin_disable', 'admin_reactivate', 'admin_remove', 'admin_password'
  ) or p_target_id is null or p_target_id = p_actor_id or p_response is null then
    raise exception using errcode = 'P0001', message = 'admin_operation_invalid';
  end if;

  select r.* into v_record
  from private.idempotency_records as r
  where r.operation = p_operation
    and r.actor_scope = v_actor_scope
    and r.idempotency_key = p_idempotency_key
  for update;
  if not found or v_record.request_hash <> p_request_hash then
    raise exception using errcode = 'P0001', message = 'idempotency_completion_failed';
  end if;
  if v_record.response is not null then return v_record.response; end if;

  if p_operation = 'admin_create' then
    if length(trim(coalesce(p_target_full_name, ''))) not between 2 and 120 then
      raise exception using errcode = 'P0001', message = 'admin_operation_invalid';
    end if;
    insert into public.profiles (id, full_name, role, active)
    values (p_target_id, trim(p_target_full_name), 'admin', true)
    on conflict (id) do update
      set full_name = excluded.full_name, role = 'admin', active = true
      where public.profiles.role = 'admin';
    v_title := 'Administrator account created by ' || v_actor.actor_name;
  elsif p_operation in ('admin_disable', 'admin_reactivate', 'admin_remove') then
    update public.profiles
    set active = p_target_active
    where id = p_target_id and role = 'admin';
    if not found then
      raise exception using errcode = 'P0001', message = 'admin_target_invalid';
    end if;
    v_title := 'Administrator access ' || case p_operation
      when 'admin_disable' then 'disabled'
      when 'admin_reactivate' then 'reactivated'
      else 'removed'
    end || ' by ' || v_actor.actor_name;
  else
    if not exists (select 1 from public.profiles where id = p_target_id and role = 'admin') then
      raise exception using errcode = 'P0001', message = 'admin_target_invalid';
    end if;
    v_title := 'Administrator password changed by ' || v_actor.actor_name;
  end if;

  insert into public.notifications (recipient_id, kind, title, message)
  select recipient.id, 'system', v_title, 'Administrator access management was completed.'
  from public.profiles as recipient
  where recipient.active = true and recipient.role in ('owner', 'admin');

  update private.idempotency_records
  set response = p_response,
      expires_at = now() + interval '30 days'
  where operation = p_operation
    and actor_scope = v_actor_scope
    and idempotency_key = p_idempotency_key
    and request_hash = p_request_hash;
  if not found then
    raise exception using errcode = 'P0001', message = 'idempotency_completion_failed';
  end if;
  return p_response;
end;
$function$;

create or replace function public.release_external_admin_operation(
  p_operation text,
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_request_hash text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $function$
declare
  v_actor record;
begin
  select * into v_actor from private.staff_actor(p_actor_id, true);
  if not found then
    raise exception using errcode = 'P0001', message = 'owner_not_authorized';
  end if;
  delete from private.idempotency_records
  where operation = p_operation
    and actor_scope = 'owner:' || p_actor_id::text
    and idempotency_key = p_idempotency_key
    and request_hash = p_request_hash
    and response is null;
  return found;
end;
$function$;

revoke all on function public.create_staff_walk_in_booking_idempotent(uuid, jsonb, uuid, text) from public, anon, authenticated;
revoke all on function public.cancel_staff_walk_in_booking_idempotent(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.manage_staff_blocked_slots_idempotent(uuid, text, text, jsonb, uuid, text) from public, anon, authenticated;
revoke all on function public.set_owner_pin_hash_idempotent(uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function public.claim_external_admin_operation(text, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.complete_external_admin_operation(text, uuid, uuid, text, boolean, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.release_external_admin_operation(text, uuid, uuid, text) from public, anon, authenticated;

grant execute on function public.create_staff_walk_in_booking_idempotent(uuid, jsonb, uuid, text) to service_role;
grant execute on function public.cancel_staff_walk_in_booking_idempotent(uuid, uuid, uuid, text) to service_role;
grant execute on function public.manage_staff_blocked_slots_idempotent(uuid, text, text, jsonb, uuid, text) to service_role;
grant execute on function public.set_owner_pin_hash_idempotent(uuid, text, uuid, text) to service_role;
grant execute on function public.claim_external_admin_operation(text, uuid, uuid, text) to service_role;
grant execute on function public.complete_external_admin_operation(text, uuid, uuid, text, boolean, uuid, text, jsonb) to service_role;
grant execute on function public.release_external_admin_operation(text, uuid, uuid, text) to service_role;

commit;
