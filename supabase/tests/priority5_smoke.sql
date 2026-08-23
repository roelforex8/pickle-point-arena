\set ON_ERROR_STOP on

do $test$
declare
  v_owner constant uuid := '00000000-0000-4000-8000-000000000001';
  v_booking jsonb;
  v_booking_id uuid;
  v_path text;
  v_result jsonb;
begin
  v_booking := public.create_public_booking_idempotent(
    'Local Customer', 'local@example.invalid', '09170000000',
    '[{"court_id":1,"slot_start":"2027-08-22T02:00:00Z"}]'::jsonb,
    '10000000-0000-4000-8000-000000000001', repeat('a', 64)
  );
  v_booking_id := (v_booking ->> 'bookingId')::uuid;
  if v_booking_id is null then raise exception 'booking smoke failed'; end if;

  v_result := public.prepare_customer_payment_upload_idempotent(
    v_booking_id, 'image/png', 128, repeat('b', 64), 'png',
    '20000000-0000-4000-8000-000000000001', repeat('d', 64)
  );
  v_path := v_result ->> 'receiptPath';
  insert into storage.objects (bucket_id, name) values ('payment-receipts', v_path);

  v_result := public.submit_customer_payment_idempotent(
    v_booking_id, 'gcash', 'LOCAL-REF', v_path,
    '20000000-0000-4000-8000-000000000001', repeat('d', 64)
  );
  if v_result ->> 'status' <> 'payment_submitted' then raise exception 'submit smoke failed: %', v_result; end if;

  v_result := public.review_payment_idempotent(
    v_owner, v_booking_id, 'confirm',
    '30000000-0000-4000-8000-000000000001', repeat('e', 64)
  );
  if v_result ->> 'status' <> 'confirmed' then raise exception 'review smoke failed: %', v_result; end if;

  if (select count(*) from public.payments where booking_id = v_booking_id) <> 1 then raise exception 'duplicate payment'; end if;
  if (select count(*) from private.court_hour_claims c join public.booking_slots s on s.id = c.source_id where s.booking_id = v_booking_id) <> 1 then raise exception 'claim missing'; end if;
end
$test$;

select 'priority5_smoke_passed' as result;
