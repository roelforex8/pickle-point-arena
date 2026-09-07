\set ON_ERROR_STOP on

begin;

do $test$
declare
  v_result jsonb;
  v_booking_id uuid;
  v_retry jsonb;
begin
  -- 3:00 PM, exactly 4:00 PM, and 5:00 PM Philippine time, across two courts.
  v_result := public.create_public_booking_idempotent(
    'Pricing Test', 'pricing@example.invalid', '09170000000',
    '[{"court_id":1,"slot_start":"2031-01-14T07:00:00Z"},{"court_id":1,"slot_start":"2031-01-14T08:00:00Z"},{"court_id":2,"slot_start":"2031-01-14T09:00:00Z"}]'::jsonb,
    '41000000-0000-4000-8000-000000000001', repeat('a',64)
  );
  v_booking_id := (v_result->>'bookingId')::uuid;
  if (select array_agg(hourly_rate order by slot_start,court_id) from public.booking_slots where booking_id=v_booking_id)
       <> array[300::numeric,350::numeric,350::numeric] then
    raise exception '3 PM / 4 PM / 5 PM rate boundary failed';
  end if;
  if (v_result->>'subtotal')::numeric <> 1000 or (v_result->>'bookingFee')::numeric <> 30
     or (v_result->>'totalAmount')::numeric <> 1030 then
    raise exception 'multi-hour or per-hour fee total failed: %',v_result;
  end if;

  v_retry := public.create_public_booking_idempotent(
    'Pricing Test', 'pricing@example.invalid', '09170000000',
    '[{"court_id":1,"slot_start":"2031-01-14T07:00:00Z"},{"court_id":1,"slot_start":"2031-01-14T08:00:00Z"},{"court_id":2,"slot_start":"2031-01-14T09:00:00Z"}]'::jsonb,
    '41000000-0000-4000-8000-000000000001', repeat('a',64)
  );
  if (v_retry->>'bookingId')::uuid <> v_booking_id then raise exception 'idempotent retry diverged'; end if;

  begin
    perform public.create_public_booking_idempotent(
      'Pricing Test', 'pricing@example.invalid', '09170000000',
      '[{"court_id":3,"slot_start":"2031-01-14T08:00:00Z"}]'::jsonb,
      '41000000-0000-4000-8000-000000000001', repeat('b',64)
    );
    raise exception 'same-key different-payload unexpectedly succeeded';
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'idempotency_payload_mismatch' then raise; end if;
  end;

  -- Midnight and 1:00 AM retain deployed behavior; 2:00 AM remains closing.
  v_result := public.create_public_booking_idempotent(
    'Overnight Test', 'overnight@example.invalid', '09170000000',
    '[{"court_id":4,"slot_start":"2031-01-14T16:00:00Z"},{"court_id":4,"slot_start":"2031-01-14T17:00:00Z"}]'::jsonb,
    '41000000-0000-4000-8000-000000000002', repeat('c',64)
  );
  if (v_result->>'subtotal')::numeric <> 700 or (v_result->>'bookingFee')::numeric <> 20 then
    raise exception 'overnight deployed behavior changed';
  end if;
  begin
    perform public.create_public_booking('Closing Test','closing@example.invalid','[{"court_id":4,"slot_start":"2031-01-14T18:00:00Z"}]'::jsonb);
    raise exception '2 AM opening unexpectedly succeeded';
  exception when others then
    if sqlerrm <> 'The selected time is outside operating hours.' then raise; end if;
  end;

  -- Non-hour boundary values remain rejected before pricing can be stored.
  begin
    perform public.create_public_booking('Before Boundary','before@example.invalid','[{"court_id":5,"slot_start":"2031-01-14T07:59:00Z"}]'::jsonb);
    raise exception '3:59 PM unexpectedly succeeded';
  exception when others then if sqlerrm <> 'Bookings must start on the hour.' then raise; end if; end;
  begin
    perform public.create_public_booking('After Boundary','after@example.invalid','[{"court_id":5,"slot_start":"2031-01-14T08:01:00Z"}]'::jsonb);
    raise exception '4:01 PM unexpectedly succeeded';
  exception when others then if sqlerrm <> 'Bookings must start on the hour.' then raise; end if; end;
end
$test$;

-- Stale request-time expiration releases its authoritative claim.
do $test$
declare
  v_stale uuid := gen_random_uuid();
  v_new jsonb;
begin
  insert into public.bookings(id,tracking_number,customer_name,customer_email,status,subtotal,booking_fee,hold_expires_at,booking_source)
  values(v_stale,'STALE-'||v_stale,'Stale Test','stale@example.invalid','awaiting_payment',300,10,now()-interval '1 minute','online');
  insert into public.booking_slots(booking_id,court_id,slot_start,slot_end,hourly_rate,status)
  values(v_stale,6,'2031-01-14T08:00:00Z','2031-01-14T09:00:00Z',350,'held');
  if not exists(select 1 from private.court_hour_claims where source_type='booking_slot' and source_id in(select id from public.booking_slots where booking_id=v_stale)) then
    raise exception 'stale fixture claim missing';
  end if;
  v_new := public.create_public_booking_idempotent(
    'Replacement Test','replacement@example.invalid','09170000000',
    '[{"court_id":6,"slot_start":"2031-01-14T08:00:00Z"}]'::jsonb,
    '41000000-0000-4000-8000-000000000003',repeat('d',64));
  if (select status from public.bookings where id=v_stale) <> 'expired' then raise exception 'stale booking not expired'; end if;
  if exists(select 1 from private.court_hour_claims where source_type='booking_slot' and source_id in(select id from public.booking_slots where booking_id=v_stale)) then
    raise exception 'stale claim not released';
  end if;
  if (v_new->>'subtotal')::numeric <> 350 or (v_new->>'bookingFee')::numeric <> 10 then raise exception 'replacement 4 PM total failed'; end if;
end
$test$;

select 'online_pricing_hotfix_passed' as result;
rollback;
