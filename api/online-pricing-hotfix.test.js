import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const migration = fs.readFileSync(new URL('../supabase/migrations/20260907010000_fix_online_booking_4pm_rate.sql', import.meta.url), 'utf8');
const priority5 = fs.readFileSync(new URL('../supabase/migrations/20260822010000_transactional_idempotent_operations.sql', import.meta.url), 'utf8');
const walkIn = fs.readFileSync(new URL('../supabase/migrations/20260820020000_add_walk_in_bookings.sql', import.meta.url), 'utf8');
const reports = fs.readFileSync(new URL('./reports.js', import.meta.url), 'utf8');

test('hotfix source-controls the complete deployed online booking contract', () => {
  assert.match(migration, /create or replace function public\.create_public_booking\([\s\S]+returns table\([\s\S]+booking_fee numeric,[\s\S]+total_amount numeric,[\s\S]+hold_expires_at timestamptz/i);
  assert.match(migration, /security definer[\s\S]+set search_path = pg_catalog, public, private/i);
  assert.match(migration, /perform private\.expire_stale_bookings\(\)/i);
  assert.match(migration, /pg_advisory_xact_lock[\s\S]+hashtextextended/i);
  assert.match(migration, /status in \('held', 'payment_submitted', 'confirmed'\)/i);
  assert.match(migration, /extensions\.gen_random_bytes/i);
});

test('online boundary is explicit while deployed operating hours stay unchanged', () => {
  assert.match(migration, /v_hour >= 6 and v_hour < 16[\s\S]+v_rate := 300/i);
  assert.match(migration, /v_hour >= 16 and v_hour <= 23[\s\S]+or v_hour in \(0, 1\)[\s\S]+v_rate := 350/i);
  assert.doesNotMatch(migration, /v_hour between 6 and 16/i);
  assert.match(migration, /date_trunc\('hour', v_start\) <> v_start/i);
});

test('trusted execution grants and browser write revocations remain explicit', () => {
  for (const role of ['public', 'anon', 'authenticated']) {
    assert.match(migration, new RegExp(`revoke all on function public\\.create_public_booking\\(text, text, jsonb\\) from ${role}`, 'i'));
  }
  assert.match(migration, /grant execute on function public\.create_public_booking\(text, text, jsonb\) to service_role/i);
});

test('Priority 5 continues to delegate and calculate the per-hour fee', () => {
  assert.match(priority5, /from public\.create_public_booking\([\s\S]+booking_fee = v_slot_count \* 10/i);
  assert.match(priority5, /private\.claim_idempotency/i);
});

test('Walk-In pricing and stored-total reporting remain untouched', () => {
  assert.match(walkIn, /v_hour >= 6 and v_hour < 16[\s\S]+v_rate := 300[\s\S]+v_hour >= 16 and v_hour <= 23[\s\S]+v_rate := 350/i);
  assert.match(reports, /booking_source, total_amount[\s\S]+Number\(booking\.total_amount \|\| 0\)/i);
});
