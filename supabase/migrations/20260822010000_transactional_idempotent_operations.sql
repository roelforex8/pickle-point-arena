begin;

create schema if not exists private;

alter table public.bookings
  add column if not exists customer_mobile text;

comment on column public.bookings.customer_mobile is
  'Customer mobile number collected during public reservation confirmation.';

create table if not exists private.idempotency_records (
  operation text not null,
  actor_scope text not null,
  idempotency_key uuid not null,
  request_hash text not null,
  response jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  primary key (operation, actor_scope, idempotency_key),
  constraint idempotency_request_hash_check check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint idempotency_actor_scope_check check (length(actor_scope) between 1 and 160),
  constraint idempotency_expiry_check check (expires_at > created_at)
);

create index if not exists idempotency_records_expiry_idx
  on private.idempotency_records (expires_at);

comment on table private.idempotency_records is
  'Successful retry results and in-transaction placeholders. Completed records are retained for 30 days; failed business transactions roll their placeholders back.';

do $migration$
begin
  if exists (
    select 1
    from public.payments
    where receipt_path is not null
    group by receipt_path
    having count(*) > 1
  ) then
    raise exception using errcode = 'P0001', message = 'duplicate_receipt_references';
  end if;
end
$migration$;

do $migration$
begin
  if exists (
    select 1 from public.payments group by booking_id having count(*) > 1
  ) then
    raise exception using errcode = 'P0001', message = 'duplicate_booking_payments';
  end if;
end
$migration$;

create unique index if not exists payments_booking_id_unique
  on public.payments (booking_id);

create unique index if not exists payments_receipt_path_unique
  on public.payments (receipt_path)
  where receipt_path is not null;

create or replace function private.claim_idempotency(
  p_operation text,
  p_actor_scope text,
  p_idempotency_key uuid,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, private
as $function$
declare
  v_record private.idempotency_records%rowtype;
begin
  if p_operation is null or length(p_operation) not between 1 and 80
    or p_actor_scope is null or length(p_actor_scope) not between 1 and 160
    or p_idempotency_key is null
    or p_request_hash is null or p_request_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_request';
  end if;

  delete from private.idempotency_records
  where expires_at <= now();

  insert into private.idempotency_records (
    operation, actor_scope, idempotency_key, request_hash
  ) values (
    p_operation, p_actor_scope, p_idempotency_key, p_request_hash
  )
  on conflict (operation, actor_scope, idempotency_key) do nothing;

  select r.*
  into v_record
  from private.idempotency_records as r
  where r.operation = p_operation
    and r.actor_scope = p_actor_scope
    and r.idempotency_key = p_idempotency_key
  for update;

  if v_record.request_hash <> p_request_hash then
    raise exception using errcode = 'P0001', message = 'idempotency_payload_mismatch';
  end if;

  return v_record.response;
end;
$function$;

create or replace function private.complete_idempotency(
  p_operation text,
  p_actor_scope text,
  p_idempotency_key uuid,
  p_request_hash text,
  p_response jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, private
as $function$
declare
  v_updated integer;
begin
  if p_response is null then
    raise exception using errcode = 'P0001', message = 'invalid_idempotency_response';
  end if;

  update private.idempotency_records
  set response = p_response,
      expires_at = now() + interval '30 days'
  where operation = p_operation
    and actor_scope = p_actor_scope
    and idempotency_key = p_idempotency_key
    and request_hash = p_request_hash;

  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception using errcode = 'P0001', message = 'idempotency_completion_failed';
  end if;
end;
$function$;

create or replace function private.staff_actor(
  p_actor_id uuid,
  p_owner_only boolean default false
)
returns table(actor_name text, actor_role text)
language sql
security definer
set search_path = pg_catalog, public
as $function$
  select
    coalesce(nullif(trim(p.full_name), ''), case when p.role = 'owner' then 'Owner' else 'Administrator' end),
    p.role
  from public.profiles as p
  where p.id = p_actor_id
    and p.active = true
    and p.role in ('owner', 'admin')
    and (not p_owner_only or p.role = 'owner');
$function$;

create or replace function private.public_booking_result(
  p_booking_id uuid
)
returns jsonb
language sql
security definer
set search_path = pg_catalog, public
as $function$
  select jsonb_build_object(
    'bookingId', b.id,
    'trackingNumber', b.tracking_number,
    'customerName', b.customer_name,
    'maskedEmail', case
      when position('@' in b.customer_email) > 1 then
        left(split_part(b.customer_email, '@', 1), 2) || '***@' || split_part(b.customer_email, '@', 2)
      else ''
    end,
    'status', b.status,
    'subtotal', b.subtotal,
    'bookingFee', b.booking_fee,
    'totalAmount', b.total_amount,
    'holdExpiresAt', b.hold_expires_at,
    'createdAt', b.created_at,
    'confirmedAt', b.confirmed_at,
    'slots', coalesce((
      select jsonb_agg(jsonb_build_object(
        'courtId', s.court_id,
        'slotStart', s.slot_start,
        'slotEnd', s.slot_end,
        'hourlyRate', s.hourly_rate,
        'status', s.status
      ) order by s.slot_start, s.court_id, s.id)
      from public.booking_slots as s
      where s.booking_id = b.id
    ), '[]'::jsonb),
    'payment', (
      select jsonb_build_object(
        'method', p.method,
        'status', p.status,
        'submittedAt', p.submitted_at
      )
      from public.payments as p
      where p.booking_id = b.id
      limit 1
    )
  )
  from public.bookings as b
  where b.id = p_booking_id;
$function$;

create or replace function public.create_public_booking_idempotent(
  p_customer_name text,
  p_customer_email text,
  p_customer_mobile text,
  p_slots jsonb,
  p_idempotency_key uuid,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $function$
declare
  v_actor_scope text;
  v_existing jsonb;
  v_created record;
  v_slot_count integer;
  v_subtotal numeric(10,2);
  v_result jsonb;
begin
  if length(trim(coalesce(p_customer_name, ''))) < 2
    or p_customer_email is null
    or p_customer_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or length(trim(coalesce(p_customer_mobile, ''))) > 24
    or length(regexp_replace(coalesce(p_customer_mobile, ''), '[^0-9]', '', 'g')) < 10 then
    raise exception using errcode = 'P0001', message = 'invalid_customer_details';
  end if;

  v_actor_scope := 'customer:' || encode(
    extensions.digest(convert_to(lower(trim(p_customer_email)), 'UTF8'), 'sha256'),
    'hex'
  );

  v_existing := private.claim_idempotency(
    'public_booking_create', v_actor_scope, p_idempotency_key, p_request_hash
  );
  if v_existing is not null then return v_existing; end if;

  select created.booking_id, created.tracking_number
  into v_created
  from public.create_public_booking(
    trim(p_customer_name), lower(trim(p_customer_email)), p_slots
  ) as created
  limit 1;

  if v_created.booking_id is null then
    raise exception using errcode = 'P0001', message = 'booking_creation_failed';
  end if;

  select count(*), coalesce(sum(s.hourly_rate), 0)
  into v_slot_count, v_subtotal
  from public.booking_slots as s
  where s.booking_id = v_created.booking_id;

  if v_slot_count < 1 or v_slot_count <> jsonb_array_length(p_slots) then
    raise exception using errcode = 'P0001', message = 'booking_slots_incomplete';
  end if;

  update public.bookings
  set hold_expires_at = now() + interval '15 minutes',
      subtotal = v_subtotal,
      booking_fee = v_slot_count * 10,
      customer_mobile = trim(p_customer_mobile)
  where id = v_created.booking_id
    and status = 'awaiting_payment';

  if not found then
    raise exception using errcode = 'P0001', message = 'booking_creation_failed';
  end if;

  select jsonb_build_object(
    'bookingId', b.id,
    'trackingNumber', b.tracking_number,
    'subtotal', b.subtotal,
    'bookingFee', b.booking_fee,
    'totalAmount', b.total_amount,
    'holdExpiresAt', b.hold_expires_at
  )
  into v_result
  from public.bookings as b
  where b.id = v_created.booking_id;

  perform private.complete_idempotency(
    'public_booking_create', v_actor_scope, p_idempotency_key, p_request_hash, v_result
  );
  return v_result;
exception when unique_violation then
  raise exception using errcode = 'P0001', message = 'occupancy_conflict';
end;
$function$;

create or replace function public.prepare_customer_payment_upload_idempotent(
  p_booking_id uuid,
  p_mime_type text,
  p_file_size bigint,
  p_file_sha256 text,
  p_extension text,
  p_idempotency_key uuid,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $function$
declare
  v_booking public.bookings%rowtype;
  v_payment public.payments%rowtype;
  v_actor_scope text := 'booking:' || p_booking_id::text;
  v_existing jsonb;
  v_receipt_path text;
  v_result jsonb;
begin
  select b.* into v_booking
  from public.bookings as b
  where b.id = p_booking_id
  for update;
  if not found or v_booking.booking_source <> 'online' then
    raise exception using errcode = 'P0001', message = 'booking_not_found';
  end if;

  v_existing := private.claim_idempotency(
    'customer_payment_prepare', v_actor_scope, p_idempotency_key, p_request_hash
  );
  if v_existing is not null then return v_existing; end if;

  if p_mime_type not in ('image/jpeg', 'image/png', 'application/pdf')
    or p_extension not in ('jpg', 'png', 'pdf')
    or (p_mime_type = 'image/jpeg' and p_extension <> 'jpg')
    or (p_mime_type = 'image/png' and p_extension <> 'png')
    or (p_mime_type = 'application/pdf' and p_extension <> 'pdf')
    or p_file_size not between 1 and 20971520
    or p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'receipt_metadata_invalid';
  end if;

  v_receipt_path := p_booking_id::text || '/' || p_idempotency_key::text || '.' || p_extension;

  select p.* into v_payment
  from public.payments as p
  where p.booking_id = p_booking_id
  for update;

  if v_booking.status = 'payment_submitted'
    and v_payment.booking_id is not null
    and v_payment.receipt_path = v_receipt_path then
    v_result := jsonb_build_object(
      'receiptPath', v_receipt_path,
      'finalized', true,
      'booking', private.public_booking_result(p_booking_id)
    );
    perform private.complete_idempotency(
      'customer_payment_prepare', v_actor_scope, p_idempotency_key, p_request_hash, v_result
    );
    return v_result;
  end if;

  if v_booking.status <> 'awaiting_payment'
    or v_booking.hold_expires_at <= now()
    or v_payment.booking_id is not null then
    raise exception using errcode = 'P0001', message = case
      when v_booking.status = 'expired' or v_booking.hold_expires_at <= now() then 'booking_expired'
      else 'payment_already_submitted'
    end;
  end if;

  v_result := jsonb_build_object(
    'receiptPath', v_receipt_path,
    'finalized', false,
    'mimeType', p_mime_type,
    'fileSize', p_file_size,
    'fileSha256', p_file_sha256
  );
  perform private.complete_idempotency(
    'customer_payment_prepare', v_actor_scope, p_idempotency_key, p_request_hash, v_result
  );
  return v_result;
end;
$function$;

create or replace function public.submit_customer_payment_idempotent(
  p_booking_id uuid,
  p_method text,
  p_reference_number text,
  p_receipt_path text,
  p_idempotency_key uuid,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private, storage
as $function$
declare
  v_booking public.bookings%rowtype;
  v_payment public.payments%rowtype;
  v_actor_scope text := 'booking:' || p_booking_id::text;
  v_existing jsonb;
  v_slot_count integer;
  v_updated_count integer;
  v_submitted_at timestamptz := now();
  v_reference_number text := coalesce(nullif(trim(p_reference_number), ''), 'Not provided');
  v_prepared private.idempotency_records%rowtype;
  v_result jsonb;
begin
  select b.* into v_booking
  from public.bookings as b
  where b.id = p_booking_id
  for update;

  if not found or v_booking.booking_source <> 'online' then
    raise exception using errcode = 'P0001', message = 'booking_not_found';
  end if;

  v_existing := private.claim_idempotency(
    'customer_payment_submit', v_actor_scope, p_idempotency_key, p_request_hash
  );
  if v_existing is not null then return v_existing; end if;

  select r.* into v_prepared
  from private.idempotency_records as r
  where r.operation = 'customer_payment_prepare'
    and r.actor_scope = v_actor_scope
    and r.idempotency_key = p_idempotency_key
  for update;
  if not found
    or v_prepared.request_hash <> p_request_hash
    or v_prepared.response ->> 'receiptPath' <> p_receipt_path then
    raise exception using errcode = 'P0001', message = 'receipt_prepare_missing';
  end if;

  select p.* into v_payment
  from public.payments as p
  where p.booking_id = p_booking_id
  for update;

  if v_booking.status = 'awaiting_payment' and v_booking.hold_expires_at <= now() then
    update public.booking_slots
    set status = 'expired'
    where booking_id = p_booking_id and status = 'held';
    update public.bookings
    set status = 'expired'
    where id = p_booking_id and status = 'awaiting_payment';
    v_result := jsonb_build_object('accepted', false, 'errorCode', 'booking_expired');
    perform private.complete_idempotency(
      'customer_payment_submit', v_actor_scope, p_idempotency_key, p_request_hash, v_result
    );
    return v_result;
  end if;

  if v_booking.status = 'payment_submitted' then
    if v_payment.booking_id is not null
      and v_payment.method = p_method
      and v_payment.reference_number = v_reference_number
      and v_payment.receipt_path = p_receipt_path
      and v_payment.status = 'pending_verification'
      and not exists (
        select 1 from public.booking_slots as s
        where s.booking_id = p_booking_id and s.status <> 'payment_submitted'
      ) then
      v_result := private.public_booking_result(p_booking_id);
      perform private.complete_idempotency(
        'customer_payment_submit', v_actor_scope, p_idempotency_key, p_request_hash, v_result
      );
      return v_result;
    end if;
    raise exception using errcode = 'P0001', message = 'payment_already_submitted';
  end if;

  if v_booking.status <> 'awaiting_payment' or v_payment.booking_id is not null then
    raise exception using errcode = 'P0001', message = 'payment_transition_invalid';
  end if;

  if p_method not in ('gcash', 'maya', 'metrobank', 'bpi') then
    raise exception using errcode = 'P0001', message = 'payment_method_invalid';
  end if;

  if lower(p_receipt_path) !~ ('^' || p_booking_id::text || '/' || p_idempotency_key::text || '\.(jpg|png|pdf)$') then
    raise exception using errcode = 'P0001', message = 'receipt_path_invalid';
  end if;

  if not exists (
    select 1 from storage.objects as o
    where o.bucket_id = 'payment-receipts' and o.name = p_receipt_path
  ) then
    raise exception using errcode = 'P0001', message = 'receipt_object_missing';
  end if;

  if exists (
    select 1 from public.payments as p where p.receipt_path = p_receipt_path
  ) then
    raise exception using errcode = 'P0001', message = 'receipt_already_referenced';
  end if;

  select count(*) into v_slot_count
  from public.booking_slots as s
  where s.booking_id = p_booking_id;
  if v_slot_count < 1 or exists (
    select 1 from public.booking_slots as s
    where s.booking_id = p_booking_id and s.status <> 'held'
  ) then
    raise exception using errcode = 'P0001', message = 'booking_slots_inconsistent';
  end if;

  insert into public.payments (
    booking_id, method, reference_number, receipt_path, status,
    submitted_at, reviewed_at, reviewed_by, review_note
  ) values (
    p_booking_id, p_method, v_reference_number,
    p_receipt_path, 'pending_verification', v_submitted_at, null, null, null
  );

  update public.bookings
  set status = 'payment_submitted'
  where id = p_booking_id and status = 'awaiting_payment';
  if not found then
    raise exception using errcode = 'P0001', message = 'payment_transition_invalid';
  end if;

  update public.booking_slots
  set status = 'payment_submitted'
  where booking_id = p_booking_id and status = 'held';
  get diagnostics v_updated_count = row_count;
  if v_updated_count <> v_slot_count then
    raise exception using errcode = 'P0001', message = 'booking_slots_incomplete';
  end if;

  insert into public.notifications (recipient_id, booking_id, kind, title, message)
  select
    recipient.id,
    p_booking_id,
    'payment_submitted',
    v_booking.tracking_number || ' - ' || upper(p_method) || ' proof uploaded',
    v_booking.customer_name || ' submitted payment proof for PHP ' ||
      trim(to_char(v_booking.total_amount, 'FM999999990.00')) || '.'
  from public.profiles as recipient
  where recipient.active = true and recipient.role in ('owner', 'admin');

  v_result := private.public_booking_result(p_booking_id);
  perform private.complete_idempotency(
    'customer_payment_submit', v_actor_scope, p_idempotency_key, p_request_hash, v_result
  );
  return v_result;
exception when unique_violation then
  raise exception using errcode = 'P0001', message = 'payment_already_submitted';
end;
$function$;

create or replace function public.review_payment_idempotent(
  p_actor_id uuid,
  p_booking_id uuid,
  p_decision text,
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
  v_booking public.bookings%rowtype;
  v_payment public.payments%rowtype;
  v_actor_scope text := 'staff:' || p_actor_id::text;
  v_existing jsonb;
  v_target_booking_status text;
  v_target_payment_status text;
  v_slot_count integer;
  v_updated_count integer;
  v_now timestamptz := now();
  v_result jsonb;
begin
  select * into v_actor from private.staff_actor(p_actor_id, false);
  if not found then
    raise exception using errcode = 'P0001', message = 'staff_not_authorized';
  end if;
  if p_decision not in ('confirm', 'reject') then
    raise exception using errcode = 'P0001', message = 'payment_decision_invalid';
  end if;

  select b.* into v_booking
  from public.bookings as b
  where b.id = p_booking_id
  for update;
  if not found or v_booking.booking_source <> 'online' then
    raise exception using errcode = 'P0001', message = 'booking_not_found';
  end if;

  v_existing := private.claim_idempotency(
    'admin_payment_decision', v_actor_scope, p_idempotency_key, p_request_hash
  );
  if v_existing is not null then return v_existing; end if;

  select p.* into v_payment
  from public.payments as p
  where p.booking_id = p_booking_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'payment_not_found';
  end if;

  v_target_booking_status := case when p_decision = 'confirm' then 'confirmed' else 'rejected' end;
  v_target_payment_status := case when p_decision = 'confirm' then 'verified' else 'rejected' end;

  if v_booking.status = v_target_booking_status and v_payment.status = v_target_payment_status then
    if exists (
      select 1 from public.booking_slots as s
      where s.booking_id = p_booking_id and s.status <> v_target_booking_status
    ) then
      raise exception using errcode = 'P0001', message = 'booking_slots_inconsistent';
    end if;
    v_result := jsonb_build_object(
      'success', true, 'status', v_target_booking_status, 'alreadyApplied', true
    );
    perform private.complete_idempotency(
      'admin_payment_decision', v_actor_scope, p_idempotency_key, p_request_hash, v_result
    );
    return v_result;
  end if;

  if v_booking.status <> 'payment_submitted' or v_payment.status <> 'pending_verification' then
    raise exception using errcode = 'P0001', message = 'payment_decision_conflict';
  end if;

  select count(*) into v_slot_count
  from public.booking_slots as s where s.booking_id = p_booking_id;
  if v_slot_count < 1 or exists (
    select 1 from public.booking_slots as s
    where s.booking_id = p_booking_id and s.status <> 'payment_submitted'
  ) then
    raise exception using errcode = 'P0001', message = 'booking_slots_inconsistent';
  end if;

  update public.payments
  set status = v_target_payment_status,
      reviewed_at = v_now,
      reviewed_by = p_actor_id,
      review_note = case when p_decision = 'confirm' then 'Payment verified.' else 'Payment proof rejected.' end
  where booking_id = p_booking_id and status = 'pending_verification';
  if not found then
    raise exception using errcode = 'P0001', message = 'payment_decision_conflict';
  end if;

  update public.bookings
  set status = v_target_booking_status,
      confirmed_at = case when p_decision = 'confirm' then v_now else null end,
      confirmed_by = case when p_decision = 'confirm' then p_actor_id else null end
  where id = p_booking_id and status = 'payment_submitted';
  if not found then
    raise exception using errcode = 'P0001', message = 'payment_decision_conflict';
  end if;

  update public.booking_slots
  set status = v_target_booking_status
  where booking_id = p_booking_id and status = 'payment_submitted';
  get diagnostics v_updated_count = row_count;
  if v_updated_count <> v_slot_count then
    raise exception using errcode = 'P0001', message = 'booking_slots_incomplete';
  end if;

  insert into public.notifications (recipient_id, booking_id, kind, title, message)
  select
    recipient.id,
    p_booking_id,
    case when p_decision = 'confirm' then 'booking_confirmed' else 'system' end,
    v_booking.tracking_number || ' - ' || case when p_decision = 'confirm' then 'Booking confirmed' else 'Payment rejected' end,
    v_booking.customer_name || '''s booking was ' ||
      case when p_decision = 'confirm' then 'confirmed' else 'rejected' end ||
      ' by ' || v_actor.actor_name || '.'
  from public.profiles as recipient
  where recipient.active = true and recipient.role in ('owner', 'admin');

  v_result := jsonb_build_object(
    'success', true, 'status', v_target_booking_status, 'alreadyApplied', false
  );
  perform private.complete_idempotency(
    'admin_payment_decision', v_actor_scope, p_idempotency_key, p_request_hash, v_result
  );
  return v_result;
end;
$function$;

create or replace function public.undo_payment_decision_idempotent(
  p_actor_id uuid,
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
  v_actor record;
  v_booking public.bookings%rowtype;
  v_payment public.payments%rowtype;
  v_actor_scope text := 'staff:' || p_actor_id::text;
  v_existing jsonb;
  v_slot_count integer;
  v_updated_count integer;
  v_next_undo_count integer;
  v_result jsonb;
begin
  select * into v_actor from private.staff_actor(p_actor_id, false);
  if not found then
    raise exception using errcode = 'P0001', message = 'staff_not_authorized';
  end if;

  select b.* into v_booking
  from public.bookings as b
  where b.id = p_booking_id
  for update;
  if not found or v_booking.booking_source <> 'online' then
    raise exception using errcode = 'P0001', message = 'booking_not_found';
  end if;

  v_existing := private.claim_idempotency(
    'admin_payment_undo', v_actor_scope, p_idempotency_key, p_request_hash
  );
  if v_existing is not null then return v_existing; end if;

  select p.* into v_payment
  from public.payments as p
  where p.booking_id = p_booking_id
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'payment_not_found';
  end if;

  if v_booking.status not in ('confirmed', 'rejected')
    or (v_booking.status = 'confirmed' and v_payment.status <> 'verified')
    or (v_booking.status = 'rejected' and v_payment.status <> 'rejected') then
    raise exception using errcode = 'P0001', message = 'payment_undo_invalid';
  end if;
  if v_payment.reviewed_at is null or now() - v_payment.reviewed_at >= interval '30 minutes' then
    raise exception using errcode = 'P0001', message = 'payment_undo_expired';
  end if;
  if v_booking.review_undo_count >= 2 then
    raise exception using errcode = 'P0001', message = 'payment_undo_limit';
  end if;

  select count(*) into v_slot_count
  from public.booking_slots as s where s.booking_id = p_booking_id;
  if v_slot_count < 1 or exists (
    select 1 from public.booking_slots as s
    where s.booking_id = p_booking_id and s.status <> v_booking.status
  ) then
    raise exception using errcode = 'P0001', message = 'booking_slots_inconsistent';
  end if;

  v_next_undo_count := v_booking.review_undo_count + 1;

  update public.payments
  set status = 'pending_verification',
      reviewed_at = null,
      reviewed_by = null,
      review_note = format('Decision undone (%s/2).', v_next_undo_count)
  where booking_id = p_booking_id and status = v_payment.status;
  if not found then
    raise exception using errcode = 'P0001', message = 'payment_undo_invalid';
  end if;

  update public.bookings
  set status = 'payment_submitted',
      confirmed_at = null,
      confirmed_by = null,
      review_undo_count = v_next_undo_count
  where id = p_booking_id and status = v_booking.status;
  if not found then
    raise exception using errcode = 'P0001', message = 'payment_undo_invalid';
  end if;

  update public.booking_slots
  set status = 'payment_submitted'
  where booking_id = p_booking_id and status = v_booking.status;
  get diagnostics v_updated_count = row_count;
  if v_updated_count <> v_slot_count then
    raise exception using errcode = 'P0001', message = 'booking_slots_incomplete';
  end if;

  insert into public.notifications (recipient_id, booking_id, kind, title, message)
  select
    recipient.id,
    p_booking_id,
    'system',
    v_booking.tracking_number || ' - Decision undone',
    v_actor.actor_name || ' returned ' || v_booking.customer_name ||
      '''s booking to payment review (' || v_next_undo_count || '/2 corrections used).'
  from public.profiles as recipient
  where recipient.active = true and recipient.role in ('owner', 'admin');

  v_result := jsonb_build_object(
    'success', true, 'status', 'payment_submitted',
    'undoCount', v_next_undo_count, 'alreadyApplied', false
  );
  perform private.complete_idempotency(
    'admin_payment_undo', v_actor_scope, p_idempotency_key, p_request_hash, v_result
  );
  return v_result;
exception when unique_violation then
  raise exception using errcode = 'P0001', message = 'occupancy_conflict';
end;
$function$;

create or replace function public.cancel_online_booking_idempotent(
  p_actor_id uuid,
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
  v_actor record;
  v_booking public.bookings%rowtype;
  v_actor_scope text := 'owner:' || p_actor_id::text;
  v_existing jsonb;
  v_slot_count integer;
  v_updated_count integer;
  v_result jsonb;
begin
  select * into v_actor from private.staff_actor(p_actor_id, true);
  if not found then
    raise exception using errcode = 'P0001', message = 'owner_not_authorized';
  end if;

  select b.* into v_booking
  from public.bookings as b
  where b.id = p_booking_id
  for update;
  if not found or v_booking.booking_source <> 'online' then
    raise exception using errcode = 'P0001', message = 'booking_not_found';
  end if;

  v_existing := private.claim_idempotency(
    'owner_booking_cancel', v_actor_scope, p_idempotency_key, p_request_hash
  );
  if v_existing is not null then return v_existing; end if;

  if v_booking.status = 'cancelled' then
    if exists (
      select 1 from public.booking_slots as s
      where s.booking_id = p_booking_id and s.status <> 'cancelled'
    ) then
      raise exception using errcode = 'P0001', message = 'booking_slots_inconsistent';
    end if;
    v_result := jsonb_build_object('success', true, 'status', 'cancelled', 'alreadyApplied', true);
    perform private.complete_idempotency(
      'owner_booking_cancel', v_actor_scope, p_idempotency_key, p_request_hash, v_result
    );
    return v_result;
  end if;

  if v_booking.status <> 'confirmed' then
    raise exception using errcode = 'P0001', message = 'booking_not_cancellable';
  end if;

  select count(*) into v_slot_count
  from public.booking_slots as s where s.booking_id = p_booking_id;
  if v_slot_count < 1 or exists (
    select 1 from public.booking_slots as s
    where s.booking_id = p_booking_id and s.status <> 'confirmed'
  ) then
    raise exception using errcode = 'P0001', message = 'booking_slots_inconsistent';
  end if;

  update public.bookings
  set status = 'cancelled'
  where id = p_booking_id and status = 'confirmed';
  if not found then
    raise exception using errcode = 'P0001', message = 'booking_not_cancellable';
  end if;

  update public.booking_slots
  set status = 'cancelled'
  where booking_id = p_booking_id and status = 'confirmed';
  get diagnostics v_updated_count = row_count;
  if v_updated_count <> v_slot_count then
    raise exception using errcode = 'P0001', message = 'booking_slots_incomplete';
  end if;

  insert into public.notifications (recipient_id, booking_id, kind, title, message)
  select
    recipient.id,
    p_booking_id,
    'system',
    v_booking.tracking_number || ' - Booking cancelled by ' || v_actor.actor_name,
    v_booking.customer_name || '''s confirmed booking was cancelled by the Owner.'
  from public.profiles as recipient
  where recipient.active = true and recipient.role in ('owner', 'admin');

  v_result := jsonb_build_object('success', true, 'status', 'cancelled', 'alreadyApplied', false);
  perform private.complete_idempotency(
    'owner_booking_cancel', v_actor_scope, p_idempotency_key, p_request_hash, v_result
  );
  return v_result;
end;
$function$;

create or replace function public.expire_public_booking(
  p_booking_id uuid
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_booking public.bookings%rowtype;
  v_slot_count integer;
  v_updated_count integer;
begin
  select b.* into v_booking
  from public.bookings as b
  where b.id = p_booking_id
  for update;
  if not found then return null; end if;
  if v_booking.status <> 'awaiting_payment' or v_booking.hold_expires_at > now() then
    return v_booking.status;
  end if;

  select count(*) into v_slot_count
  from public.booking_slots as s
  where s.booking_id = p_booking_id and s.status = 'held';

  update public.booking_slots
  set status = 'expired'
  where booking_id = p_booking_id and status = 'held';
  get diagnostics v_updated_count = row_count;
  if v_updated_count <> v_slot_count then
    raise exception using errcode = 'P0001', message = 'booking_slots_incomplete';
  end if;

  update public.bookings
  set status = 'expired'
  where id = p_booking_id and status = 'awaiting_payment';
  if not found then
    raise exception using errcode = 'P0001', message = 'booking_expiry_conflict';
  end if;
  return 'expired';
end;
$function$;

create or replace function public.record_staff_activity_idempotent(
  p_actor_id uuid,
  p_title text,
  p_message text,
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
  v_actor_scope text := 'staff:' || p_actor_id::text;
  v_existing jsonb;
  v_result jsonb;
begin
  select * into v_actor from private.staff_actor(p_actor_id, false);
  if not found then
    raise exception using errcode = 'P0001', message = 'staff_not_authorized';
  end if;
  if length(trim(coalesce(p_title, ''))) not between 1 and 160
    or length(trim(coalesce(p_message, ''))) not between 1 and 500 then
    raise exception using errcode = 'P0001', message = 'activity_invalid';
  end if;

  v_existing := private.claim_idempotency(
    'staff_activity', v_actor_scope, p_idempotency_key, p_request_hash
  );
  if v_existing is not null then return v_existing; end if;

  insert into public.notifications (recipient_id, kind, title, message)
  select recipient.id, 'system', trim(p_title), trim(p_message)
  from public.profiles as recipient
  where recipient.active = true and recipient.role in ('owner', 'admin');

  v_result := jsonb_build_object('success', true);
  perform private.complete_idempotency(
    'staff_activity', v_actor_scope, p_idempotency_key, p_request_hash, v_result
  );
  return v_result;
end;
$function$;

revoke all on table private.idempotency_records from public, anon, authenticated;
revoke all on function private.claim_idempotency(text, text, uuid, text) from public, anon, authenticated;
revoke all on function private.complete_idempotency(text, text, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function private.staff_actor(uuid, boolean) from public, anon, authenticated;
revoke all on function private.public_booking_result(uuid) from public, anon, authenticated;

revoke all on function public.create_public_booking_idempotent(text, text, text, jsonb, uuid, text) from public, anon, authenticated;
revoke all on function public.prepare_customer_payment_upload_idempotent(uuid, text, bigint, text, text, uuid, text) from public, anon, authenticated;
revoke all on function public.submit_customer_payment_idempotent(uuid, text, text, text, uuid, text) from public, anon, authenticated;
revoke all on function public.review_payment_idempotent(uuid, uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function public.undo_payment_decision_idempotent(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.cancel_online_booking_idempotent(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.expire_public_booking(uuid) from public, anon, authenticated;
revoke all on function public.record_staff_activity_idempotent(uuid, text, text, uuid, text) from public, anon, authenticated;

grant execute on function public.create_public_booking_idempotent(text, text, text, jsonb, uuid, text) to service_role;
grant execute on function public.prepare_customer_payment_upload_idempotent(uuid, text, bigint, text, text, uuid, text) to service_role;
grant execute on function public.submit_customer_payment_idempotent(uuid, text, text, text, uuid, text) to service_role;
grant execute on function public.review_payment_idempotent(uuid, uuid, text, uuid, text) to service_role;
grant execute on function public.undo_payment_decision_idempotent(uuid, uuid, uuid, text) to service_role;
grant execute on function public.cancel_online_booking_idempotent(uuid, uuid, uuid, text) to service_role;
grant execute on function public.expire_public_booking(uuid) to service_role;
grant execute on function public.record_staff_activity_idempotent(uuid, text, text, uuid, text) to service_role;

-- The legacy booking RPC remains available only to trusted server-side wrappers.
revoke all on function public.create_public_booking(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.create_public_booking(text, text, jsonb) to service_role;

-- Protected state transitions are server-mediated. Browser roles retain reads
-- allowed by existing RLS but cannot bypass the transactional RPCs with writes.
revoke insert, update, delete on public.bookings from anon, authenticated;
revoke insert, update, delete on public.booking_slots from anon, authenticated;
revoke insert, update, delete on public.payments from anon, authenticated;

commit;
