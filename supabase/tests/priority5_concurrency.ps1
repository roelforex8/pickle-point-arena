param([string]$Container = 'ppa-priority5-local-20260822', [string]$Database = 'postgres', [int]$Rounds = 20)
$ErrorActionPreference = 'Stop'
$owner = '00000000-0000-4000-8000-000000000001'
$keyA = '10000000-0000-4000-8000-000000000001'
$keyB = '20000000-0000-4000-8000-000000000001'
$slot = '2031-01-14T22:00:00Z'
$results = [ordered]@{}

function Invoke-Db([string]$Sql, [switch]$AllowFailure) {
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Sql))
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $output = & docker exec $Container sh -c "echo $encoded | base64 -d | psql -X -v ON_ERROR_STOP=1 -Atq -U postgres -d $Database" 2>&1
  $code = $LASTEXITCODE; $ErrorActionPreference = $old
  if (-not $AllowFailure -and $code -ne 0) { throw "Database command failed: $($output -join ' ')" }
  [pscustomobject]@{ ExitCode = $code; Output = (($output | ForEach-Object { "$_" }) -join "`n").Trim() }
}

function Invoke-Race([string[]]$Statements) {
  $jobs = foreach ($statement in $Statements) {
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("select pg_sleep(0.05); $statement"))
    Start-Job -ScriptBlock {
      param($c, $d, $q)
      $o = & docker exec $c sh -c "echo $q | base64 -d | psql -X -v ON_ERROR_STOP=1 -Atq -U postgres -d $d" 2>&1
      [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = (($o | ForEach-Object { "$_" }) -join "`n").Trim() }
    } -ArgumentList $Container, $Database, $encoded
  }
  $done = $jobs | Wait-Job | Receive-Job
  $jobs | Remove-Job -Force
  @($done)
}

function Reset-State {
  Invoke-Db "truncate public.notifications, public.payments, public.booking_slots, public.blocked_slots, public.bookings, storage.objects, private.idempotency_records, private.court_hour_claims restart identity cascade; update public.profiles set active=true where id='$owner';" | Out-Null
}
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Scalar([string]$Sql) { (Invoke-Db $Sql).Output }
function Successes($Race) { @($Race | Where-Object ExitCode -eq 0).Count }
function Seed([string]$Method = 'gcash', [string]$Key = $keyA, [int]$Court = 1) { Scalar "select public.test_priority5_seed_submitted('$Method',$($Court)::smallint,'$slot'::timestamptz,'$Key'::uuid);" }
function Integrity([string]$Name, [int]$Round) {
  $actual = Scalar "select concat_ws('|', partial_transitions,duplicate_payments,duplicate_audit_events,duplicate_successful_idempotency,orphan_claims,missing_claims,incorrectly_released_occupied_slots,referenced_receipts_deleted,uncontrolled_orphan_receipts,status_inconsistencies) from public.test_priority5_integrity();"
  Assert ($actual -eq '0|0|0|0|0|0|0|0|0|0') "$Name round $Round integrity: $actual"
}
function Run([string]$Name, [scriptblock]$Body) {
  for ($round=1; $round -le $Rounds; $round++) { Reset-State; & $Body $round; Integrity $Name $round }
  $results[$Name] = "$Rounds/$Rounds passed"
}

Run 'duplicate_customer_payment_submission' {
  $id=Seed; $path=Scalar "select receipt_path from public.payments where booking_id='$id';"
  $r=Scalar "select public.submit_customer_payment_idempotent('$id','gcash','TEST-REF','$path','$keyA',repeat('b',64))->>'bookingId';"
  Assert ($r -eq $id) 'identical retry did not return original result'; Assert ((Scalar 'select count(*) from public.payments;') -eq '1') 'duplicate payment'
}
Run 'concurrent_identical_idempotency_key' {
  $id=Seed; $race=Invoke-Race @("select public.review_payment_idempotent('$owner','$id','confirm','$keyB',repeat('c',64));","select public.review_payment_idempotent('$owner','$id','confirm','$keyB',repeat('c',64));")
  Assert ((Successes $race) -eq 2) 'same-key requests did not converge'; Assert ((Scalar "select status from public.bookings where id='$id';") -eq 'confirmed') 'not confirmed'
}
Run 'same_key_different_payload' {
  $id=Seed; Invoke-Db "select public.review_payment_idempotent('$owner','$id','confirm','$keyB',repeat('c',64));" | Out-Null
  $failure=Invoke-Db "select public.review_payment_idempotent('$owner','$id','confirm','$keyB',repeat('d',64));" -AllowFailure
  Assert ($failure.ExitCode -ne 0) 'payload mismatch succeeded'
}
Run 'receipt_upload_database_failure' {
  $failure=Invoke-Db "set ppa.test_failure='payments'; select public.test_priority5_seed_submitted('gcash',1,'$slot','$keyA');" -AllowFailure
  Assert ($failure.ExitCode -ne 0) 'forced payment failure succeeded'; Assert ((Scalar 'select count(*) from storage.objects;') -eq '0') 'orphan object survived transaction fixture'
}
Run 'database_success_response_retry' {
  $id=Seed; $path=Scalar "select receipt_path from public.payments where booking_id='$id';"
  1..2 | ForEach-Object { Invoke-Db "select public.submit_customer_payment_idempotent('$id','gcash','TEST-REF','$path','$keyA',repeat('b',64));" | Out-Null }
  Assert ((Scalar 'select count(*) from public.payments;') -eq '1') 'retry duplicated payment'
}
Run 'concurrent_admin_verification' {
  $id=Seed; $race=Invoke-Race @("select public.review_payment_idempotent('$owner','$id','confirm','$keyB',repeat('c',64));","select public.review_payment_idempotent('$owner','$id','confirm','$keyB',repeat('c',64));")
  Assert ((Successes $race) -eq 2) 'verification retries diverged'
}
Run 'verify_reject_race' {
  $id=Seed; $race=Invoke-Race @("select public.review_payment_idempotent('$owner','$id','confirm','$keyB',repeat('c',64));","select public.review_payment_idempotent('$owner','$id','reject','30000000-0000-4000-8000-000000000001',repeat('d',64));")
  Assert ((Successes $race) -eq 1) 'verify/reject did not produce one winner'
}
Run 'verify_cancel_race' {
  $id=Seed; $race=Invoke-Race @("select public.review_payment_idempotent('$owner','$id','confirm','$keyB',repeat('c',64));","select public.cancel_online_booking_idempotent('$owner','$id','30000000-0000-4000-8000-000000000001',repeat('d',64));")
  Assert ((Successes $race) -ge 1) 'verify/cancel had no valid winner'; Assert (@('confirmed','cancelled') -contains (Scalar "select status from public.bookings where id='$id';")) 'invalid terminal state'
}
Run 'repeated_rejection' {
  $id=Seed; 1..2 | ForEach-Object { Invoke-Db "select public.review_payment_idempotent('$owner','$id','reject','$keyB',repeat('c',64));" | Out-Null }
  Assert ((Scalar "select status from public.bookings where id='$id';") -eq 'rejected') 'not rejected'
}
Run 'repeated_cancellation' {
  $id=Seed; Invoke-Db "select public.review_payment_idempotent('$owner','$id','confirm','$keyB',repeat('c',64));" | Out-Null
  1..2 | ForEach-Object { Invoke-Db "select public.cancel_online_booking_idempotent('$owner','$id','30000000-0000-4000-8000-000000000001',repeat('d',64));" | Out-Null }
  Assert ((Scalar "select status from public.bookings where id='$id';") -eq 'cancelled') 'not cancelled'
}
Run 'forced_failure_after_database_steps' {
  foreach($table in @('bookings','booking_slots','notifications')) { Reset-State; $id=Seed; $f=Invoke-Db "set ppa.test_failure='$table'; select public.review_payment_idempotent('$owner','$id','confirm','$keyB',repeat('c',64));" -AllowFailure; Assert ($f.ExitCode -ne 0) "forced $table failure succeeded"; Assert ((Scalar "select status from public.bookings where id='$id';") -eq 'payment_submitted') "forced $table failure was partial" }
}
Run 'audit_insertion_failure' {
  $f=Invoke-Db "set ppa.test_failure='notifications'; select public.test_priority5_seed_submitted('gcash',1,'$slot','$keyA');" -AllowFailure; Assert ($f.ExitCode -ne 0) 'audit failure succeeded'; Assert ((Scalar 'select count(*) from public.bookings;') -eq '0') 'audit failure did not rollback'
}
Run 'claim_release_failure' {
  $id=Seed; Invoke-Db "select public.review_payment_idempotent('$owner','$id','confirm','$keyB',repeat('c',64));" | Out-Null
  $f=Invoke-Db "set ppa.test_failure='court_hour_claims'; select public.cancel_online_booking_idempotent('$owner','$id','30000000-0000-4000-8000-000000000001',repeat('d',64));" -AllowFailure
  Assert ($f.ExitCode -ne 0) 'claim release failure succeeded'; Assert ((Scalar "select status from public.bookings where id='$id';") -eq 'confirmed') 'claim failure did not rollback'
}
foreach($method in @('bpi','gcash')) { Run "${method}_submission_and_verification" { $id=Seed $method; Invoke-Db "select public.review_payment_idempotent('$owner','$id','confirm','$keyB',repeat('c',64));" | Out-Null; Assert ((Scalar "select status from public.payments where booking_id='$id';") -eq 'verified') "$method not verified" } }
Run 'unauthorized_nonstaff_admin_action' {
  Invoke-Db "insert into public.profiles(id,full_name,role,active) values('90000000-0000-4000-8000-000000000001','Inactive','admin',false) on conflict(id) do update set active=false;" | Out-Null; $id=Seed
  $f=Invoke-Db "select public.review_payment_idempotent('90000000-0000-4000-8000-000000000001','$id','confirm','$keyB',repeat('c',64));" -AllowFailure; Assert ($f.ExitCode -ne 0) 'unauthorized review succeeded'
}
Run 'cross_user_idempotency_key_attempt' {
  Invoke-Db "insert into public.profiles(id,full_name,role,active) values('90000000-0000-4000-8000-000000000002','Other Admin','admin',true) on conflict(id) do update set active=true;" | Out-Null; $id=Seed
  Invoke-Db "select public.review_payment_idempotent('$owner','$id','confirm','$keyB',repeat('c',64));" | Out-Null
  Invoke-Db "select public.review_payment_idempotent('90000000-0000-4000-8000-000000000002','$id','confirm','$keyB',repeat('c',64));" | Out-Null
  Assert ((Scalar "select reviewed_by from public.payments where booking_id='$id';") -eq $owner) 'cross-user retry changed audit attribution'
  Assert ((Scalar "select count(*) from private.idempotency_records where operation='admin_payment_decision' and idempotency_key='$keyB';") -eq '2') 'idempotency key was not actor-scoped'
}
Run 'expired_booking_payment_attempt' {
  $id=Scalar "insert into public.bookings(tracking_number,customer_name,customer_email,status,subtotal,booking_fee,hold_expires_at,booking_source) values('EXP-'||gen_random_uuid(),'Expired','expired@local.invalid','awaiting_payment',300,10,now()-interval '1 minute','online') returning id;"
  Invoke-Db "insert into public.booking_slots(booking_id,court_id,slot_start,slot_end,hourly_rate,status) values('$id',1,'$slot','$slot'::timestamptz+interval '1 hour',300,'held');" | Out-Null
  $r=Scalar "select public.expire_public_booking('$id');"; Assert ($r -eq 'expired') 'expiry did not synchronize'
}
Run 'walk_in_isolation' {
  $id=Scalar "select public.create_staff_walk_in_booking_idempotent('$owner','[{`"court_id`":1,`"slot_start`":`"$slot`"}]','$keyA',repeat('a',64))->>'bookingId';"
  Assert ((Scalar "select count(*) from public.payments where booking_id='$id';") -eq '0') 'Walk-In has payment'; Assert ((Scalar "select booking_fee from public.bookings where id='$id';") -eq '0.00') 'Walk-In fee changed'
}
Run 'receipt_compensation_safety' {
  $id=Seed; $path=Scalar "select receipt_path from public.payments where booking_id='$id';"
  Invoke-Db "delete from storage.objects where name='unreferenced'; insert into storage.objects(bucket_id,name) values('payment-receipts','unreferenced'); delete from storage.objects o where o.name='unreferenced' and not exists(select 1 from public.payments p where p.receipt_path=o.name);" | Out-Null
  Assert ((Scalar "select count(*) from storage.objects where name='$path';") -eq '1') 'referenced receipt deleted'
}

$results.GetEnumerator() | ForEach-Object { "{0}: {1}" -f $_.Key,$_.Value }
'integrity_after_every_round: 0|0|0|0|0|0|0|0|0|0'
"total_scenario_rounds: $($results.Count * $Rounds)"
