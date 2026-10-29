-- Физически парцел, история на базата, годишна регистрация, култивационен период.

create table public.field (
  field_id              uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organization(organization_id) on delete cascade,
  settlement_id         uuid references public.settlement(settlement_id),
  current_farm_base_id  uuid references public.farm_base(farm_base_id),
  massif                text,
  is_irrigated          boolean,
  slope_pct             numeric(5,2),
  ph                    numeric(3,1) check (ph between 0 and 14),
  soil_type             text,
  mechanical_composition text,
  horizon_depth_cm      smallint check (horizon_depth_cm > 0),
  erosion_factor        text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
comment on table public.field is 'Физически парцел. Вътрешен UUID, независим от ИСАК номера. Годишните атрибути са във field_crop_year.';
comment on column public.field.current_farm_base_id is 'Текуща стопанска база; историята е във field_base.';
comment on column public.field.massif is 'Основен масив (групиране на съседни полета).';
create index field_org on public.field (organization_id);
create index field_settlement on public.field (settlement_id);
create trigger field_touch before update on public.field for each row execute function app.touch_updated_at();

-- Деление/сливане: нов field с връзка назад. Събитието е на ниво "дете" и стопанска година.
create table public.field_lineage (
  lineage_id       uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organization(organization_id) on delete cascade,
  child_field_id   uuid not null references public.field(field_id) on delete cascade,
  parent_field_id  uuid not null references public.field(field_id),
  kind             text not null check (kind in ('split','merge')),
  season_id        smallint references public.season(season_id),
  unique (child_field_id, parent_field_id),
  check (child_field_id <> parent_field_id)
);
comment on table public.field_lineage is 'Заменя split_from_field_ids / merged_from_field_ids с масив: връзките имат външни ключове.';
create index field_lineage_parent on public.field_lineage (parent_field_id);
create trigger aa_field_lineage_org before insert or update on public.field_lineage
  for each row execute function app.inherit_org('field', 'child_field_id', 'field_id');

create table public.field_base (
  field_base_id    uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organization(organization_id) on delete cascade,
  field_id         uuid not null references public.field(field_id) on delete cascade,
  farm_base_id     uuid not null references public.farm_base(farm_base_id),
  valid_from       date not null,
  valid_to         date,
  constraint field_base_dates check (valid_to is null or valid_to >= valid_from),
  constraint field_base_no_overlap exclude using gist
    (field_id with =, daterange(valid_from, valid_to, '[]') with &&)
);
comment on table public.field_base is 'История на стопанската база на полето (валидна от/до; празно "до" = още активна).';
create index field_base_field on public.field_base (field_id);
create trigger aa_field_base_org before insert or update on public.field_base
  for each row execute function app.inherit_org('field', 'field_id', 'field_id');

-- Поддържа field.current_farm_base_id от историята.
create or replace function app.sync_current_base() returns trigger
language plpgsql as $$
declare v_field uuid := coalesce(new.field_id, old.field_id);
begin
  update public.field f
     set current_farm_base_id = (
       select fb.farm_base_id from public.field_base fb
        where fb.field_id = v_field and fb.valid_from <= current_date
          and (fb.valid_to is null or fb.valid_to >= current_date)
        order by fb.valid_from desc limit 1)
   where f.field_id = v_field;
  return null;
end $$;
create trigger field_base_sync after insert or update or delete on public.field_base
  for each row execute function app.sync_current_base();

create table public.field_crop_year (
  fcy_id           uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organization(organization_id) on delete cascade,
  field_id         uuid not null references public.field(field_id) on delete cascade,
  season_id        smallint not null references public.season(season_id),
  company_id       uuid references public.company(company_id),
  field_name       text,
  isak_number      text,
  isak_area_da     numeric(10,2) check (isak_area_da >= 0),
  ownership        text check (ownership in ('own','rent')),
  buffer_area_da   numeric(10,2) not null default 0 check (buffer_area_da >= 0),
  eco_schemes      text[] not null default '{}',
  potential_id     smallint references public.potential_class(potential_id),
  bonitet_pct      numeric(5,2),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (field_id, season_id)
);
comment on table public.field_crop_year is 'Годишна регистрация на полето (без култура). Площите са в дка; при внос от ИСАК ha x 10.';
comment on column public.field_crop_year.isak_number is 'БЗС номер за годината; променя се при деление и последната цифра варира.';
create index fcy_org_season on public.field_crop_year (organization_id, season_id);
create index fcy_company on public.field_crop_year (company_id);
create trigger aa_fcy_org before insert or update on public.field_crop_year
  for each row execute function app.inherit_org('field', 'field_id', 'field_id');
create trigger fcy_touch before update on public.field_crop_year for each row execute function app.touch_updated_at();

create table public.field_planting (
  planting_id         uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organization(organization_id) on delete cascade,
  fcy_id              uuid not null references public.field_crop_year(fcy_id) on delete cascade,
  role                text not null default 'main' check (role in ('main','second')),
  crop_id             uuid not null references public.crop(crop_id),
  planted_area_da     numeric(10,2) not null check (planted_area_da > 0),
  tillage_id          smallint references public.tillage_type(tillage_id),
  sowing_date_plan    date,
  sowing_date_actual  date,
  harvest_date_plan   date,
  harvest_date_actual date,
  is_locked           boolean not null default false,
  is_test_area        boolean not null default false,
  note                text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint planting_dates_plan check (harvest_date_plan is null or sowing_date_plan is null or harvest_date_plan >= sowing_date_plan),
  constraint planting_dates_actual check (harvest_date_actual is null or sowing_date_actual is null or harvest_date_actual >= sowing_date_actual)
);
comment on table public.field_planting is 'Култивационен период = поле + култура + стопанска година. Пресяването е втори ред с role = second.';
create unique index field_planting_one_main on public.field_planting (fcy_id) where role = 'main';
create index planting_org on public.field_planting (organization_id);
create index planting_fcy on public.field_planting (fcy_id);
create index planting_crop on public.field_planting (crop_id);
create trigger aa_planting_org before insert or update on public.field_planting
  for each row execute function app.inherit_org('field_crop_year', 'fcy_id', 'fcy_id');
create trigger planting_touch before update on public.field_planting for each row execute function app.touch_updated_at();
