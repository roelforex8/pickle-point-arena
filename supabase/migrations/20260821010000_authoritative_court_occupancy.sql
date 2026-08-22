begin;

create schema if not exists private;

create table if not exists private.court_hour_claims (
  court_id smallint not null references public.courts(id),
  slot_start timestamptz not null,
  source_type text not null check (source_type in ('booking_slot', 'blocked_slot')),
  source_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (court_id, slot_start),
  unique (source_type, source_id, court_id, slot_start)
);

comment on table private.court_hour_claims is
  'Authoritative one-owner-per-court-hour occupancy ledger for active booking slots and venue blocks.';

revoke all on table private.court_hour_claims from public, anon, authenticated, service_role;
grant select on table private.court_hour_claims to service_role;

create or replace function private.lock_court_occupancy()
returns void
language sql
security definer
set search_path = pg_catalog
as $function$
  select pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pickle-point-arena:court-occupancy', 0)
  );
$function$;

revoke all on function private.lock_court_occupancy() from public, anon, authenticated, service_role;

create or replace function private.lock_booking_occupancy_transaction()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $function$
begin
  -- Booking creation reaches this trigger before either booking RPC takes any
  -- per-court advisory lock, establishing one deterministic lock order.
  perform private.lock_court_occupancy();
  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;

revoke all on function private.lock_booking_occupancy_transaction() from public, anon, authenticated, service_role;

create or replace function private.claim_booking_slot_occupancy()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $function$
declare
  v_old_active boolean := tg_op <> 'INSERT'
    and old.status in ('held', 'payment_submitted', 'confirmed');
  v_new_active boolean := tg_op <> 'DELETE'
    and new.status in ('held', 'payment_submitted', 'confirmed');
begin
  perform private.lock_court_occupancy();

  if v_old_active then
    delete from private.court_hour_claims
    where source_type = 'booking_slot'
      and source_id = old.id;
  end if;

  if v_new_active then
    if new.slot_start <> date_trunc('hour', new.slot_start)
      or new.slot_end <> new.slot_start + interval '1 hour' then
      raise exception using errcode = 'P0001', message = 'invalid_court_hour';
    end if;

    begin
      insert into private.court_hour_claims (
        court_id, slot_start, source_type, source_id
      ) values (
        new.court_id, new.slot_start, 'booking_slot', new.id
      );
    exception when unique_violation then
      raise exception using errcode = 'P0001', message = 'occupancy_conflict';
    end;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;

create or replace function private.claim_blocked_slot_occupancy()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $function$
declare
  v_hour timestamptz;
begin
  perform private.lock_court_occupancy();

  if tg_op <> 'INSERT' then
    delete from private.court_hour_claims
    where source_type = 'blocked_slot'
      and source_id = old.id;
  end if;

  if tg_op <> 'DELETE' then
    if new.starts_at <> date_trunc('hour', new.starts_at)
      or new.ends_at <= new.starts_at
      or new.ends_at <> date_trunc('hour', new.ends_at) then
      raise exception using errcode = 'P0001', message = 'invalid_court_hour';
    end if;

    for v_hour in
      select value
      from generate_series(
        new.starts_at,
        new.ends_at - interval '1 hour',
        interval '1 hour'
      ) as value
      order by value
    loop
      begin
        insert into private.court_hour_claims (
          court_id, slot_start, source_type, source_id
        ) values (
          new.court_id, v_hour, 'blocked_slot', new.id
        );
      exception when unique_violation then
        raise exception using errcode = 'P0001', message = 'occupancy_conflict';
      end;
    end loop;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;

revoke all on function private.claim_booking_slot_occupancy() from public, anon, authenticated, service_role;
revoke all on function private.claim_blocked_slot_occupancy() from public, anon, authenticated, service_role;

drop trigger if exists bookings_occupancy_transaction_lock on public.bookings;
create trigger bookings_occupancy_transaction_lock
before insert or update or delete on public.bookings
for each row execute function private.lock_booking_occupancy_transaction();

drop trigger if exists booking_slots_occupancy_claim on public.booking_slots;
create trigger booking_slots_occupancy_claim
before insert or update or delete on public.booking_slots
for each row execute function private.claim_booking_slot_occupancy();

drop trigger if exists blocked_slots_occupancy_claim on public.blocked_slots;
create trigger blocked_slots_occupancy_claim
before insert or update or delete on public.blocked_slots
for each row execute function private.claim_blocked_slot_occupancy();

-- Backfill under the same global transaction lock used by every future mutation.
select private.lock_court_occupancy();

do $migration$
begin
  if exists (
    select 1
    from public.booking_slots as s
    where s.status in ('held', 'payment_submitted', 'confirmed')
      and (
        s.slot_start <> date_trunc('hour', s.slot_start)
        or s.slot_end <> s.slot_start + interval '1 hour'
      )
  ) then
    raise exception 'Active booking slots must use exact court-hour boundaries; no occupancy changes were applied.';
  end if;

  if exists (
    select 1
    from public.blocked_slots as bs
    where bs.starts_at <> date_trunc('hour', bs.starts_at)
      or bs.ends_at <= bs.starts_at
      or bs.ends_at <> date_trunc('hour', bs.ends_at)
  ) then
    raise exception 'Blocked slots must use exact court-hour boundaries; no occupancy changes were applied.';
  end if;
end
$migration$;

insert into private.court_hour_claims (court_id, slot_start, source_type, source_id)
select s.court_id, s.slot_start, 'booking_slot', s.id
from public.booking_slots as s
where s.status in ('held', 'payment_submitted', 'confirmed')
order by s.court_id, s.slot_start, s.id
on conflict (source_type, source_id, court_id, slot_start) do nothing;

insert into private.court_hour_claims (court_id, slot_start, source_type, source_id)
select bs.court_id, hours.slot_start, 'blocked_slot', bs.id
from public.blocked_slots as bs
cross join lateral generate_series(
  bs.starts_at,
  bs.ends_at - interval '1 hour',
  interval '1 hour'
) as hours(slot_start)
order by bs.court_id, hours.slot_start, bs.id
on conflict (source_type, source_id, court_id, slot_start) do nothing;

create or replace function public.manage_staff_blocked_slots(
  p_created_by uuid,
  p_action text,
  p_reason text,
  p_slots jsonb
)
returns table(changed integer, skipped integer)
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $function$
declare
  v_requested integer;
  v_changed integer := 0;
  v_item record;
  v_block record;
  v_found boolean;
begin
  if not exists (
    select 1
    from public.profiles as p
    where p.id = p_created_by
      and p.active = true
      and p.role in ('owner', 'admin')
  ) then
    raise exception using errcode = 'P0001', message = 'staff_not_authorized';
  end if;

  if p_action not in ('block', 'unblock')
    or p_slots is null
    or jsonb_typeof(p_slots) <> 'array' then
    raise exception using errcode = 'P0001', message = 'invalid_block_request';
  end if;

  create temporary table if not exists requested_staff_occupancy_slots (
    court_id smallint not null,
    slot_start timestamptz not null,
    primary key (court_id, slot_start)
  ) on commit drop;
  truncate table requested_staff_occupancy_slots;

  begin
    insert into requested_staff_occupancy_slots (court_id, slot_start)
    select
      (item ->> 'court_id')::smallint,
      (item ->> 'slot_start')::timestamptz
    from jsonb_array_elements(p_slots) as item;
  exception when others then
    raise exception using errcode = 'P0001', message = 'invalid_block_request';
  end;

  select count(*) into v_requested from requested_staff_occupancy_slots;
  if v_requested < 1 or v_requested > 500 or v_requested <> jsonb_array_length(p_slots) then
    raise exception using errcode = 'P0001', message = 'invalid_block_request';
  end if;

  if exists (
    select 1
    from requested_staff_occupancy_slots as r
    left join public.courts as c on c.id = r.court_id and c.active = true
    where c.id is null
      or r.slot_start <> date_trunc('hour', r.slot_start)
      or r.slot_start <= now()
      or extract(hour from r.slot_start at time zone 'Asia/Manila')::integer not between 6 and 23
  ) then
    raise exception using errcode = 'P0001', message = 'invalid_block_request';
  end if;

  perform private.lock_court_occupancy();
  perform private.expire_stale_bookings();

  if p_action = 'block' then
    if exists (
      select 1
      from requested_staff_occupancy_slots as r
      join private.court_hour_claims as claim
        on claim.court_id = r.court_id
       and claim.slot_start = r.slot_start
       and claim.source_type = 'booking_slot'
    ) then
      raise exception using errcode = 'P0001', message = 'occupancy_conflict';
    end if;

    insert into public.blocked_slots (
      court_id, starts_at, ends_at, reason, created_by
    )
    select
      r.court_id,
      r.slot_start,
      r.slot_start + interval '1 hour',
      coalesce(nullif(trim(p_reason), ''), 'Venue unavailable'),
      p_created_by
    from requested_staff_occupancy_slots as r
    where not exists (
      select 1
      from private.court_hour_claims as claim
      where claim.court_id = r.court_id
        and claim.slot_start = r.slot_start
    )
    order by r.court_id, r.slot_start;

    get diagnostics v_changed = row_count;
  else
    for v_item in
      select r.court_id, r.slot_start
      from requested_staff_occupancy_slots as r
      order by r.court_id, r.slot_start
    loop
      v_found := false;
      for v_block in
        select bs.*
        from public.blocked_slots as bs
        where bs.court_id = v_item.court_id
          and bs.starts_at < v_item.slot_start + interval '1 hour'
          and bs.ends_at > v_item.slot_start
        order by bs.starts_at, bs.id
        for update
      loop
        v_found := true;
        delete from public.blocked_slots where id = v_block.id;

        if v_block.starts_at < v_item.slot_start then
          insert into public.blocked_slots (
            court_id, starts_at, ends_at, reason, created_by
          ) values (
            v_block.court_id, v_block.starts_at, v_item.slot_start,
            v_block.reason, v_block.created_by
          );
        end if;
        if v_item.slot_start + interval '1 hour' < v_block.ends_at then
          insert into public.blocked_slots (
            court_id, starts_at, ends_at, reason, created_by
          ) values (
            v_block.court_id, v_item.slot_start + interval '1 hour', v_block.ends_at,
            v_block.reason, v_block.created_by
          );
        end if;
      end loop;
      if v_found then v_changed := v_changed + 1; end if;
    end loop;
  end if;

  return query select v_changed, v_requested - v_changed;
exception when unique_violation then
  raise exception using errcode = 'P0001', message = 'occupancy_conflict';
end;
$function$;

revoke all on function public.manage_staff_blocked_slots(uuid, text, text, jsonb) from public;
revoke all on function public.manage_staff_blocked_slots(uuid, text, text, jsonb) from anon;
revoke all on function public.manage_staff_blocked_slots(uuid, text, text, jsonb) from authenticated;
grant execute on function public.manage_staff_blocked_slots(uuid, text, text, jsonb) to service_role;

-- Staff blocking is server-mediated; browser sessions must not regain a direct write path.
revoke insert, update, delete on public.blocked_slots from anon, authenticated;

commit;
