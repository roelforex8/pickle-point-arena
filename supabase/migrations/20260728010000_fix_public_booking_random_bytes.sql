begin;

do $migration$
declare
  target_oid oid;
  target_count integer;
  function_definition text;
  patched_definition text;
begin
  if to_regprocedure('extensions.gen_random_bytes(integer)') is null then
    raise exception 'extensions.gen_random_bytes(integer) is unavailable; enable pgcrypto in the extensions schema first';
  end if;

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

  if strpos(function_definition, 'extensions.gen_random_bytes(') > 0 then
    return;
  end if;

  if strpos(function_definition, 'gen_random_bytes(') = 0 then
    raise exception 'public.create_public_booking does not contain the expected gen_random_bytes call';
  end if;

  patched_definition := replace(
    function_definition,
    'gen_random_bytes(',
    'extensions.gen_random_bytes('
  );

  execute patched_definition;
end
$migration$;

commit;
