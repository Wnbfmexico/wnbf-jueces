alter table public.athletes
  add column if not exists wnbf_athlete_id uuid,
  add column if not exists measured_by text,
  add column if not exists measures_complete boolean not null default false,
  add column if not exists external_updated_at timestamptz;

update public.athletes
set wnbf_athlete_id = nullif(
  substring(registered_division from length('WNBF_REGISTRATION_V1:') + 1)::jsonb
    #>> '{external,athleteId}',
  ''
)::uuid
where wnbf_athlete_id is null
  and registered_division like 'WNBF_REGISTRATION_V1:%';

create unique index if not exists athletes_competition_wnbf_id_key
  on public.athletes (competition_id, wnbf_athlete_id)
  where wnbf_athlete_id is not null;

alter table public.wnbf_webhook_outbox
  drop constraint if exists wnbf_webhook_outbox_event_type_check;

alter table public.wnbf_webhook_outbox
  add constraint wnbf_webhook_outbox_event_type_check
  check (event_type in ('papeleta_enviada', 'resultado_confirmado', 'medidas_registradas'));

drop policy if exists athletes_read_event on public.athletes;
create policy athletes_read_event
  on public.athletes
  for select
  to authenticated
  using ((select public.can_access_competition(competition_id)));

revoke all on function public.get_wnbf_secret(text) from public, anon, authenticated;
grant execute on function public.get_wnbf_secret(text) to service_role;
