-- Load after the Walk-In and authoritative occupancy migrations in local tests.
create or replace function public.test_priority3_integrity()
returns table(
  duplicate_active_occupancy bigint,
  booking_block_conflicts bigint,
  walk_in_block_conflicts bigint,
  duplicate_slots_within_booking bigint,
  orphan_claims bigint,
  missing_active_claims bigint
)
language sql
set search_path = pg_catalog, public, private
as $function$
  with active_occupancy as (
    select s.court_id, s.slot_start
    from public.booking_slots as s
    where s.status in ('held', 'payment_submitted', 'confirmed')
    union all
    select bs.court_id, hours.slot_start
    from public.blocked_slots as bs
    cross join lateral generate_series(
      bs.starts_at, bs.ends_at - interval '1 hour', interval '1 hour'
    ) as hours(slot_start)
  ),
  duplicate_occupancy as (
    select coalesce(sum(item_count - 1), 0)::bigint as value
    from (
      select count(*) as item_count
      from active_occupancy
      group by court_id, slot_start
      having count(*) > 1
    ) as duplicates
  ),
  booking_block as (
    select count(*)::bigint as value
    from public.booking_slots as s
    join public.blocked_slots as bs
      on bs.court_id = s.court_id
     and tstzrange(bs.starts_at, bs.ends_at, '[)') && tstzrange(s.slot_start, s.slot_end, '[)')
    where s.status in ('held', 'payment_submitted', 'confirmed')
  ),
  walk_in_block as (
    select count(*)::bigint as value
    from public.booking_slots as s
    join public.bookings as b on b.id = s.booking_id and b.booking_source = 'walk_in'
    join public.blocked_slots as bs
      on bs.court_id = s.court_id
     and tstzrange(bs.starts_at, bs.ends_at, '[)') && tstzrange(s.slot_start, s.slot_end, '[)')
    where s.status in ('held', 'payment_submitted', 'confirmed')
  ),
  duplicate_booking_slots as (
    select coalesce(sum(item_count - 1), 0)::bigint as value
    from (
      select count(*) as item_count
      from public.booking_slots
      group by booking_id, court_id, slot_start
      having count(*) > 1
    ) as duplicates
  ),
  orphaned as (
    select count(*)::bigint as value
    from private.court_hour_claims as claim
    where (
      claim.source_type = 'booking_slot'
      and not exists (
        select 1 from public.booking_slots as s
        where s.id = claim.source_id
          and s.court_id = claim.court_id
          and s.slot_start = claim.slot_start
          and s.status in ('held', 'payment_submitted', 'confirmed')
      )
    ) or (
      claim.source_type = 'blocked_slot'
      and not exists (
        select 1 from public.blocked_slots as bs
        where bs.id = claim.source_id
          and bs.court_id = claim.court_id
          and claim.slot_start >= bs.starts_at
          and claim.slot_start < bs.ends_at
      )
    )
  ),
  missing as (
    select count(*)::bigint as value
    from (
      select s.court_id, s.slot_start, 'booking_slot'::text as source_type, s.id as source_id
      from public.booking_slots as s
      where s.status in ('held', 'payment_submitted', 'confirmed')
      union all
      select bs.court_id, hours.slot_start, 'blocked_slot', bs.id
      from public.blocked_slots as bs
      cross join lateral generate_series(
        bs.starts_at, bs.ends_at - interval '1 hour', interval '1 hour'
      ) as hours(slot_start)
    ) as expected
    where not exists (
      select 1 from private.court_hour_claims as claim
      where claim.court_id = expected.court_id
        and claim.slot_start = expected.slot_start
        and claim.source_type = expected.source_type
        and claim.source_id = expected.source_id
    )
  )
  select
    duplicate_occupancy.value,
    booking_block.value,
    walk_in_block.value,
    duplicate_booking_slots.value,
    orphaned.value,
    missing.value
  from duplicate_occupancy, booking_block, walk_in_block,
       duplicate_booking_slots, orphaned, missing;
$function$;
