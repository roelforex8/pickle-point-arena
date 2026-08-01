begin;

-- Server-side API routes use Supabase's secret key, which assumes the
-- service_role database role. These grants do not apply to anon or regular
-- authenticated users and do not weaken the existing RLS policies.
grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select, update on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

-- Preserve the same access for tables, sequences, and functions added later.
alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables to service_role;
alter default privileges for role postgres in schema public
  grant usage, select, update on sequences to service_role;
alter default privileges for role postgres in schema public
  grant execute on functions to service_role;

-- Publish calendar source tables exactly once. Staff subscriptions still obey
-- the tables' RLS policies.
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
