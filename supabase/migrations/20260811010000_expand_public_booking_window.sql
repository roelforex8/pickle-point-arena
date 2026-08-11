begin;

do $migration$
declare
  target_oid oid;
  target_count integer;
  function_definition text;
  patched_definition text;
begin
  select count(*), (array_agg(p.oid))[1]
    into target_count, target_oid
  from pg_proc as p
  join pg_namespace as n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'create_public_booking';

  if target_count <> 1 then
    raise exception 'Expected exactly one public.create_public_booking function, found %', target_count;
  end if;

  function_definition := pg_get_functiondef(target_oid);
  patched_definition := function_definition;

  -- A single day contains at most 18 bookable hours across six courts.
  -- Keep a defensive capacity check without rejecting legitimate multi-court bookings.
  patched_definition := replace(patched_definition, 'between 1 and 12', 'between 1 and 108');
  patched_definition := replace(patched_definition, 'BETWEEN 1 AND 12', 'BETWEEN 1 AND 108');
  patched_definition := replace(patched_definition, 'v_count > 12', 'v_count > 108');
  patched_definition := replace(patched_definition, 'V_COUNT > 12', 'V_COUNT > 108');
  patched_definition := regexp_replace(
    patched_definition,
    '(jsonb_array_length\s*\(\s*p_slots\s*\)|cardinality\s*\(\s*p_slots\s*\)|array_length\s*\(\s*p_slots\s*,\s*1\s*\))\s*>\s*12',
    '\1 > 108',
    'gi'
  );
  patched_definition := replace(
    patched_definition,
    'Select between 1 and 12 court-hours.',
    'Select between 1 and 108 court-hours.'
  );

  -- Retain the future-only rule and remove the upper booking-date boundary.
  patched_definition := replace(
    patched_definition,
    'v_start <= now() or v_start > now() + interval ''90 days''',
    'v_start <= now()'
  );
  patched_definition := replace(
    patched_definition,
    'Bookings must be in the future and within 90 days.',
    'Bookings must be in the future.'
  );

  if patched_definition = function_definition then
    raise exception 'The public booking limits were not found; no database changes were applied.';
  end if;

  if patched_definition ~* 'between\s+1\s+and\s+12'
    or patched_definition ~* '(v_count|jsonb_array_length|cardinality|array_length)[^;]*>\s*12'
    or patched_definition ~* '90\s+days' then
    raise exception 'One or more legacy public booking limits remain; no database changes were applied.';
  end if;

  execute patched_definition;
end
$migration$;

commit;
