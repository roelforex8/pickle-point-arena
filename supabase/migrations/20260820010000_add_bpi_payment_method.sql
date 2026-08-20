alter table public.payments
drop constraint if exists payments_method_check;

alter table public.payments
add constraint payments_method_check
check (method in ('gcash', 'maya', 'metrobank', 'bpi'));
