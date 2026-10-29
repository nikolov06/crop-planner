-- Почвени анализи и одит.

create table public.soil_analysis (
  analysis_id         uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organization(organization_id) on delete cascade,
  field_id            uuid not null references public.field(field_id) on delete cascade,
  sampled_on          date not null,
  season_id           smallint references public.season(season_id),
  lab                 text,
  depth_cm            smallint check (depth_cm > 0),
  ph_h2o              numeric(3,1) check (ph_h2o between 0 and 14),
  n_min_mg_kg         numeric(7,2),
  p2o5_mg_100g        numeric(7,2),
  k2o_mg_100g         numeric(7,2),
  mg_mg_kg            numeric(7,2),
  s_mg_kg             numeric(7,2),
  below_norm_elements text[] not null default '{}',
  note                text,
  unique (field_id, sampled_on)
);
comment on table public.soil_analysis is 'Почвени анализи по поле и дата. Единиците са предположение и се сверяват с колони BQ-BX от Excel.';
create trigger aa_soil_analysis_org before insert or update on public.soil_analysis
  for each row execute function app.inherit_org('field', 'field_id', 'field_id');

create table public.audit_log (
  audit_id        bigint generated always as identity primary key,
  organization_id uuid,
  table_name      text not null,
  record_id       uuid,
  action          text not null check (action in ('insert','update','delete')),
  changed_by      uuid,
  changed_at      timestamptz not null default now(),
  old_values      jsonb,
  new_values      jsonb
);
comment on table public.audit_log is 'Одит: кой, кога и какво е променил. Пише се само от тригери.';
create index audit_log_record on public.audit_log (table_name, record_id);
create index audit_log_org_time on public.audit_log (organization_id, changed_at desc);
