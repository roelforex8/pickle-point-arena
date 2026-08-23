-- Local test-only aggregate integrity oracle. Never apply remotely.
create or replace function public.test_priority5_integrity()
returns table(
  partial_transitions bigint,
  duplicate_payments bigint,
  duplicate_audit_events bigint,
  duplicate_successful_idempotency bigint,
  orphan_claims bigint,
  missing_claims bigint,
  incorrectly_released_occupied_slots bigint,
  referenced_receipts_deleted bigint,
  uncontrolled_orphan_receipts bigint,
  status_inconsistencies bigint
)
language sql
set search_path = pg_catalog, public, private, storage
as $function$
  with
  partial as (
    select count(*)::bigint n
    from public.bookings b
    where exists (select 1 from public.booking_slots s where s.booking_id = b.id)
      and exists (select 1 from public.booking_slots s where s.booking_id = b.id and s.status <> case b.status
        when 'awaiting_payment' then 'held'
        when 'payment_submitted' then 'payment_submitted'
        when 'confirmed' then 'confirmed'
        when 'rejected' then 'rejected'
        when 'expired' then 'expired'
        when 'cancelled' then 'cancelled' end)
  ),
  duplicate_payment as (
    select coalesce(sum(n - 1), 0)::bigint n from (select count(*) n from public.payments group by booking_id having count(*) > 1) d
  ),
  duplicate_audit as (
    select coalesce(sum(n - 1), 0)::bigint n from (
      select count(*) n from public.notifications
      group by recipient_id, booking_id, kind, title, message having count(*) > 1
    ) d
  ),
  duplicate_idempotency as (
    select coalesce(sum(n - 1), 0)::bigint n from (
      select count(*) n from private.idempotency_records
      where response is not null group by operation, actor_scope, idempotency_key having count(*) > 1
    ) d
  ),
  orphan_claim as (
    select count(*)::bigint n from private.court_hour_claims c
    where (c.source_type = 'booking_slot' and not exists (select 1 from public.booking_slots s where s.id = c.source_id))
       or (c.source_type = 'blocked_slot' and not exists (select 1 from public.blocked_slots b where b.id = c.source_id))
  ),
  missing_claim as (
    select (
      (select count(*) from public.booking_slots s where s.status in ('held','payment_submitted','confirmed') and not exists (
        select 1 from private.court_hour_claims c where c.source_type = 'booking_slot' and c.source_id = s.id
      )) +
      (select count(*) from public.blocked_slots b where not exists (
        select 1 from private.court_hour_claims c where c.source_type = 'blocked_slot' and c.source_id = b.id
      ))
    )::bigint n
  ),
  referenced_missing as (
    select count(*)::bigint n from public.payments p
    where not exists (select 1 from storage.objects o where o.bucket_id = 'payment-receipts' and o.name = p.receipt_path)
  ),
  orphan_receipt as (
    select count(*)::bigint n from storage.objects o
    where o.bucket_id = 'payment-receipts'
      and not exists (select 1 from public.payments p where p.receipt_path = o.name)
  ),
  inconsistent as (
    select count(*)::bigint n from public.bookings b
    where (b.booking_source = 'walk_in' and exists (select 1 from public.payments p where p.booking_id = b.id))
       or (b.status = 'payment_submitted' and not exists (select 1 from public.payments p where p.booking_id = b.id and p.status = 'pending_verification'))
       or (b.status = 'confirmed' and b.booking_source = 'online' and not exists (select 1 from public.payments p where p.booking_id = b.id and p.status = 'verified'))
       or (b.status = 'rejected' and not exists (select 1 from public.payments p where p.booking_id = b.id and p.status = 'rejected'))
  )
  select partial.n, duplicate_payment.n, duplicate_audit.n, duplicate_idempotency.n,
    orphan_claim.n, missing_claim.n, missing_claim.n, referenced_missing.n, orphan_receipt.n, inconsistent.n
  from partial, duplicate_payment, duplicate_audit, duplicate_idempotency,
    orphan_claim, missing_claim, referenced_missing, orphan_receipt, inconsistent;
$function$;

create or replace function public.test_priority5_seed_submitted(
  p_method text,
  p_court_id smallint,
  p_slot_start timestamptz,
  p_key uuid
)
returns uuid
language plpgsql
set search_path = pg_catalog, public, private, storage
as $function$
declare
  v_booking_id uuid := gen_random_uuid();
  v_path text;
begin
  insert into public.bookings (id, tracking_number, customer_name, customer_email, customer_mobile, status, subtotal, booking_fee, hold_expires_at, booking_source)
  values (v_booking_id, 'T-' || replace(v_booking_id::text, '-', ''), 'Test Customer', 'test@local.invalid', '09170000000', 'awaiting_payment', 300, 10, now() + interval '15 minutes', 'online');
  insert into public.booking_slots (booking_id, court_id, slot_start, slot_end, hourly_rate, status)
  values (v_booking_id, p_court_id, p_slot_start, p_slot_start + interval '1 hour', 300, 'held');
  v_path := (public.prepare_customer_payment_upload_idempotent(
    v_booking_id, 'image/png', 128, repeat('a', 64), 'png', p_key, repeat('b', 64)
  ) ->> 'receiptPath');
  insert into storage.objects (bucket_id, name) values ('payment-receipts', v_path);
  perform public.submit_customer_payment_idempotent(
    v_booking_id, p_method, 'TEST-REF', v_path, p_key, repeat('b', 64)
  );
  return v_booking_id;
end
$function$;

create or replace function public.test_priority5_forced_failure()
returns trigger language plpgsql set search_path = pg_catalog as $function$
begin
  if current_setting('ppa.test_failure', true) = tg_table_name then
    raise exception using errcode = 'P0001', message = 'forced_priority5_failure';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$function$;

create trigger test_priority5_fail_payment after insert on public.payments
for each row execute function public.test_priority5_forced_failure();
create trigger test_priority5_fail_booking after update on public.bookings
for each row execute function public.test_priority5_forced_failure();
create trigger test_priority5_fail_slot after update on public.booking_slots
for each row execute function public.test_priority5_forced_failure();
create trigger test_priority5_fail_audit after insert on public.notifications
for each row execute function public.test_priority5_forced_failure();
create trigger test_priority5_fail_claim_release after delete on private.court_hour_claims
for each row execute function public.test_priority5_forced_failure();
