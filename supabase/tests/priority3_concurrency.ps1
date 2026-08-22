param(
  [string]$Container = 'ppa-priority3-validation-829c7d9',
  [string]$Database = 'priority3',
  [int]$Rounds = 20
)

$ErrorActionPreference = 'Stop'
$ownerId = '00000000-0000-4000-8000-000000000001'
$results = [ordered]@{}

function Invoke-Db([string]$Sql, [switch]$AllowFailure) {
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Sql))
  $previousErrorPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $output = & docker exec $Container sh -c "echo $encoded | base64 -d | psql -X -v ON_ERROR_STOP=1 -Atq -U postgres -d $Database" 2>&1
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorPreference
  if (-not $AllowFailure -and $exitCode -ne 0) {
    throw "Database command failed: $($output -join ' ')"
  }
  [pscustomobject]@{ ExitCode = $exitCode; Output = (($output | ForEach-Object { "$_" }) -join "`n").Trim() }
}

function Invoke-Race([string[]]$Sql) {
  $jobs = foreach ($statement in $Sql) {
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("select pg_sleep(0.10); $statement"))
    Start-Job -ScriptBlock {
      param($containerName, $databaseName, $encodedQuery)
      $output = & docker exec $containerName sh -c "echo $encodedQuery | base64 -d | psql -X -v ON_ERROR_STOP=1 -Atq -U postgres -d $databaseName" 2>&1
      [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = (($output | ForEach-Object { "$_" }) -join "`n").Trim() }
    } -ArgumentList $Container, $Database, $encoded
  }
  $completed = $jobs | Wait-Job | Receive-Job
  $jobs | Remove-Job -Force
  @($completed)
}

function Reset-State {
  Invoke-Db 'truncate table public.notifications, public.booking_slots, public.blocked_slots, public.bookings, private.court_hour_claims restart identity cascade;' | Out-Null
}

function Assert-Equal($Actual, $Expected, [string]$Message) {
  if ("$Actual" -ne "$Expected") { throw "$Message Expected [$Expected], got [$Actual]." }
}

function Assert-Integrity([string]$Scenario, [int]$Round) {
  $integrity = Invoke-Db "select concat_ws('|', duplicate_active_occupancy, booking_block_conflicts, walk_in_block_conflicts, duplicate_slots_within_booking, orphan_claims, missing_active_claims) from public.test_priority3_integrity();"
  Assert-Equal $integrity.Output '0|0|0|0|0|0' "$Scenario round $Round integrity failure."
}

function SlotJson([array]$Slots) {
  (ConvertTo-Json -InputObject @($Slots) -Compress -Depth 4).Replace("'", "''")
}

function OnlineSql([array]$Slots) {
  $json = SlotJson $Slots
  "select * from public.create_public_booking('Online Test', 'online@local.invalid', '$json'::jsonb);"
}

function WalkInSql([array]$Slots) {
  $json = SlotJson $Slots
  "select * from public.create_staff_walk_in_booking('$ownerId'::uuid, '$json'::jsonb);"
}

function BlockSql([array]$Slots, [string]$Action = 'block') {
  $json = SlotJson $Slots
  "select changed || '|' || skipped from public.manage_staff_blocked_slots('$ownerId'::uuid, '$Action', 'Local concurrency test', '$json'::jsonb);"
}

function SuccessCount([array]$RaceResult) {
  @($RaceResult | Where-Object ExitCode -eq 0).Count
}

function Run-ConcurrentScenario([string]$Name, [scriptblock]$Body) {
  for ($round = 1; $round -le $Rounds; $round++) {
    Reset-State
    & $Body $round
    Assert-Integrity $Name $round
  }
  $results[$Name] = "$Rounds/$Rounds passed"
}

$h06 = '2031-01-14T22:00:00Z'
$h07 = '2031-01-14T23:00:00Z'
$h08 = '2031-01-15T00:00:00Z'
$h15 = '2031-01-15T07:00:00Z'
$h16 = '2031-01-15T08:00:00Z'
$h23 = '2031-01-15T15:00:00Z'
$h05 = '2031-01-14T21:00:00Z'
$h24 = '2031-01-15T16:00:00Z'

$c1h06 = @(@{ court_id = 1; slot_start = $h06 })
$c1h07 = @(@{ court_id = 1; slot_start = $h07 })
$c2h06 = @(@{ court_id = 2; slot_start = $h06 })

Run-ConcurrentScenario 'online_vs_online' {
  $race = Invoke-Race @((OnlineSql $c1h06), (OnlineSql $c1h06))
  Assert-Equal (SuccessCount $race) 1 'Online vs online winner count.'
  Assert-Equal (Invoke-Db 'select count(*) from public.booking_slots;').Output 1 'Online vs online slot count.'
}

Run-ConcurrentScenario 'online_vs_staff_block' {
  $race = Invoke-Race @((OnlineSql $c1h06), (BlockSql $c1h06))
  Assert-Equal (SuccessCount $race) 1 'Online vs staff block winner count.'
  Assert-Equal (Invoke-Db 'select count(*) from private.court_hour_claims;').Output 1 'Online vs staff block claim count.'
}

Run-ConcurrentScenario 'staff_block_vs_staff_block' {
  $race = Invoke-Race @((BlockSql $c1h06), (BlockSql $c1h06))
  Assert-Equal (SuccessCount $race) 2 'Staff block vs staff block request completion count.'
  $changed = 0
  foreach ($item in $race) { if ($item.Output -match '(?m)^([01])\|[01]$') { $changed += [int]$matches[1] } }
  Assert-Equal $changed 1 'Staff block vs staff block changed count.'
  Assert-Equal (Invoke-Db 'select count(*) from public.blocked_slots;').Output 1 'Staff block vs staff block row count.'
}

Run-ConcurrentScenario 'online_vs_walk_in' {
  $race = Invoke-Race @((OnlineSql $c1h06), (WalkInSql $c1h06))
  Assert-Equal (SuccessCount $race) 1 'Online vs Walk-In winner count.'
}

Run-ConcurrentScenario 'walk_in_vs_walk_in' {
  $race = Invoke-Race @((WalkInSql $c1h06), (WalkInSql $c1h06))
  Assert-Equal (SuccessCount $race) 1 'Walk-In vs Walk-In winner count.'
}

Run-ConcurrentScenario 'walk_in_vs_staff_block' {
  $race = Invoke-Race @((WalkInSql $c1h06), (BlockSql $c1h06))
  Assert-Equal (SuccessCount $race) 1 'Walk-In vs staff block winner count.'
}

Run-ConcurrentScenario 'multi_slot_overlap' {
  $left = @(@{ court_id = 1; slot_start = $h06 }, @{ court_id = 1; slot_start = $h07 })
  $right = @(@{ court_id = 1; slot_start = $h07 }, @{ court_id = 1; slot_start = $h08 })
  $race = Invoke-Race @((OnlineSql $left), (OnlineSql $right))
  Assert-Equal (SuccessCount $race) 1 'Multi-slot overlap winner count.'
  Assert-Equal (Invoke-Db 'select count(*) from public.booking_slots;').Output 2 'Multi-slot overlap atomic slot count.'
}

Run-ConcurrentScenario 'multi_court_partial_conflict' {
  $booking = @(@{ court_id = 1; slot_start = $h06 }, @{ court_id = 2; slot_start = $h06 })
  $blocking = @(@{ court_id = 2; slot_start = $h06 }, @{ court_id = 3; slot_start = $h06 })
  $race = Invoke-Race @((OnlineSql $booking), (BlockSql $blocking))
  Assert-Equal (SuccessCount $race) 1 'Multi-court partial conflict winner count.'
  Assert-Equal (Invoke-Db 'select count(*) from private.court_hour_claims;').Output 2 'Multi-court partial conflict atomic claim count.'
}

Run-ConcurrentScenario 'same_time_different_courts' {
  $race = Invoke-Race @((OnlineSql $c1h06), (OnlineSql $c2h06))
  Assert-Equal (SuccessCount $race) 2 'Same time/different courts success count.'
  Assert-Equal (Invoke-Db 'select count(*) from private.court_hour_claims;').Output 2 'Same time/different courts claim count.'
}

Run-ConcurrentScenario 'same_court_different_times' {
  $race = Invoke-Race @((OnlineSql $c1h06), (OnlineSql $c1h07))
  Assert-Equal (SuccessCount $race) 2 'Same court/different times success count.'
  Assert-Equal (Invoke-Db 'select count(*) from private.court_hour_claims;').Output 2 'Same court/different times claim count.'
}

Run-ConcurrentScenario 'immediate_retry_double_submission' {
  $race = Invoke-Race @((OnlineSql $c1h06), (OnlineSql $c1h06))
  Assert-Equal (SuccessCount $race) 1 'Immediate retry winner count.'
  Assert-Equal (Invoke-Db 'select count(*) from public.bookings;').Output 1 'Immediate retry booking count.'
}

Run-ConcurrentScenario 'forced_late_transaction_failure' {
  $json = SlotJson @(@{ court_id = 1; slot_start = $h06 }, @{ court_id = 1; slot_start = $h07 })
  $failure = Invoke-Db "select public.test_force_late_booking_failure('$json'::jsonb);" -AllowFailure
  if ($failure.ExitCode -eq 0) { throw 'Forced late failure unexpectedly succeeded.' }
  Assert-Equal (Invoke-Db "select (select count(*) from public.bookings) || '|' || (select count(*) from public.booking_slots) || '|' || (select count(*) from private.court_hour_claims);").Output '0|0|0' 'Forced late failure residue.'
}

Run-ConcurrentScenario 'cancellation_and_release' {
  Invoke-Db (WalkInSql $c1h06) | Out-Null
  Invoke-Db "select * from public.cancel_staff_walk_in_booking('$ownerId'::uuid, (select id from public.bookings where booking_source = 'walk_in' and status = 'confirmed'));" | Out-Null
  Invoke-Db (OnlineSql $c1h06) | Out-Null
  Assert-Equal (Invoke-Db "select count(*) from public.booking_slots where status = 'cancelled';").Output 1 'Cancelled Walk-In history count.'
  Assert-Equal (Invoke-Db 'select count(*) from private.court_hour_claims;').Output 1 'Cancellation release claim count.'
}

Run-ConcurrentScenario 'stale_hold_expiration' {
  Invoke-Db (OnlineSql $c1h06) | Out-Null
  Invoke-Db "update public.bookings set hold_expires_at = now() - interval '1 minute' where status = 'awaiting_payment';" | Out-Null
  Invoke-Db (OnlineSql $c1h06) | Out-Null
  Assert-Equal (Invoke-Db "select count(*) from public.bookings where status = 'expired';").Output 1 'Stale booking expiration count.'
  Assert-Equal (Invoke-Db "select count(*) from public.booking_slots where status = 'held';").Output 1 'Replacement active slot count.'
}

Run-ConcurrentScenario 'operating_hours_and_pricing_boundaries' {
  $boundary = @(
    @{ court_id = 1; slot_start = $h06 }, @{ court_id = 1; slot_start = $h15 },
    @{ court_id = 1; slot_start = $h16 }, @{ court_id = 1; slot_start = $h23 }
  )
  $walkBoundary = @(
    @{ court_id = 2; slot_start = $h06 }, @{ court_id = 2; slot_start = $h15 },
    @{ court_id = 2; slot_start = $h16 }, @{ court_id = 2; slot_start = $h23 }
  )
  Invoke-Db (OnlineSql $boundary) | Out-Null
  Invoke-Db (WalkInSql $walkBoundary) | Out-Null
  Assert-Equal (Invoke-Db "select subtotal || '|' || booking_fee || '|' || total_amount from public.bookings where booking_source = 'online';").Output '1300.00|40.00|1340.00' 'Online pricing boundary.'
  Assert-Equal (Invoke-Db "select subtotal || '|' || booking_fee || '|' || total_amount from public.bookings where booking_source = 'walk_in';").Output '1300.00|0.00|1300.00' 'Walk-In pricing boundary.'
  $invalid05 = Invoke-Db (OnlineSql @(@{ court_id = 3; slot_start = $h05 })) -AllowFailure
  $invalid24 = Invoke-Db (WalkInSql @(@{ court_id = 3; slot_start = $h24 })) -AllowFailure
  if ($invalid05.ExitCode -eq 0) { throw '5 AM boundary unexpectedly succeeded.' }
  if ($invalid24.ExitCode -eq 0) { throw 'Midnight boundary unexpectedly succeeded.' }
}

$results.GetEnumerator() | ForEach-Object { "{0}: {1}" -f $_.Key, $_.Value }
"integrity_after_every_round: 0|0|0|0|0|0"
"total_scenario_rounds: $($results.Count * $Rounds)"
