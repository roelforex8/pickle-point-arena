\set ON_ERROR_STOP on
\ir priority5_local_baseline.sql
\ir ../migrations/20260820020000_add_walk_in_bookings.sql
\ir ../migrations/20260820030000_add_walk_in_cancellation.sql
\ir ../migrations/20260820040000_fix_walk_in_cancellation_rpc.sql
\ir ../migrations/20260821010000_authoritative_court_occupancy.sql
\ir ../migrations/20260822010000_transactional_idempotent_operations.sql
\ir ../migrations/20260822020000_idempotent_staff_and_admin_operations.sql
\ir ../migrations/20260907010000_fix_online_booking_4pm_rate.sql
\ir priority5_integrity_helpers.sql

select count(*) = 11 as priority5_rpc_count
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like '%idempotent%';
