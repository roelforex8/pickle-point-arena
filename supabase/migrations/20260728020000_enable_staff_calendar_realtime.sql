begin;

-- The staff calendar listens for changes on these tables and then performs a
-- fresh, RLS-protected query. Keep this migration idempotent for environments
-- where one or more tables have already been enabled in the Supabase dashboard.
do $migration$
declare
  table_name text;
begin
  foreach table_name in array array['bookings', 'booking_slots', 'blocked_slots']
  loop
    if to_regclass(format('public.%I', table_name)) is null then
      raise exception 'Required table public.% does not exist', table_name;
    end if;

    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = table_name
    ) then
      execute format('alter publication supabase_realtime add table public.%I', table_name);
    end if;
  end loop;
end
$migration$;

commit;
