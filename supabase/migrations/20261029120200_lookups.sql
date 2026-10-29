-- Глобални справочници (общи за всички организации).

-- ---------- CROP: култури + настройки за семена ----------
create table public.crop (
  crop_id               uuid primary key default gen_random_uuid(),
  name_bg               text not null unique,
  name_en               text,
  crop_group            text,
  culture_code          text unique,
  short_name            text,
  subsidy_crop_id       uuid references public.crop(crop_id),
  is_active             boolean not null default true,
  -- настройки за семена (празни за култури без сеитбено планиране)
  seeding_method        text check (seeding_method in ('solid','row')),
  rate_basis            text check (rate_basis in ('germ_seeds_m2','seeds_da')),
  convert_to_kg         boolean not null default false,
  order_unit            text check (order_unit in ('kg','packs')),
  default_seeds_per_pack integer check (default_seeds_per_pack > 0),
  seed_overage_pct      numeric(5,2) check (seed_overage_pct >= 0),
  rate_rounding_step    numeric(5,3) check (rate_rounding_step > 0),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint crop_subsidy_not_self check (subsidy_crop_id is null or subsidy_crop_id <> crop_id),
  constraint crop_seed_consistent check (
       (seeding_method is null and rate_basis is null and order_unit is null and not convert_to_kg)
    or (seeding_method = 'solid' and rate_basis = 'germ_seeds_m2' and order_unit is not null and convert_to_kg)
    or (seeding_method = 'row'   and rate_basis = 'seeds_da'      and order_unit is not null and not convert_to_kg)
  )
);
comment on table public.crop is 'Справочник на културите и настройките за планиране на семена.';
comment on column public.crop.seeding_method is 'solid = слети (пшеница, ечемик, рапица); row = редови (царевица, слънчоглед, сорго).';
comment on column public.crop.rate_basis is 'germ_seeds_m2 = кълняеми семена на м² (слети); seeds_da = семена на дка (редови).';
comment on column public.crop.convert_to_kg is 'true за слетите: нормата се превръща в kg/дка и kg/ха за сеялката.';
comment on column public.crop.order_unit is 'kg = поръчка в kg/тонове; packs = поръчка в торби.';
comment on column public.crop.seed_overage_pct is 'Преразход (презастъпване) при планиране на семена, %; може да се замени на ред в planting_seed.';
comment on column public.crop.rate_rounding_step is 'Стъпка на закръгляне на нормата, kg/дка; празно = общата настройка seed_rate_rounding_step.';
create trigger crop_touch before update on public.crop for each row execute function app.touch_updated_at();

-- ---------- SEASON ----------
create table public.season (
  season_id   smallint generated always as identity primary key,
  year_end    smallint not null unique,
  label       text generated always as (((year_end - 1)::text) || '/' || (year_end::text)) stored,
  start_date  date not null,
  end_date    date not null,
  is_current  boolean not null default false,
  constraint season_dates check (end_date > start_date),
  constraint season_no_overlap exclude using gist (daterange(start_date, end_date, '[]') with &&)
);
comment on table public.season is 'Стопански години. year_end = годината на прибиране (2027 за 2026/2027).';
create unique index season_one_current on public.season (is_current) where is_current;

-- ---------- SETTLEMENT, POTENTIAL_CLASS, TILLAGE_TYPE, REPRODUCTION ----------
create table public.settlement (
  settlement_id uuid primary key default gen_random_uuid(),
  name          text not null,
  ekatte        text unique,
  municipality  text,
  region        text
);
comment on table public.settlement is 'Землища (ЕКАТТЕ).';

create table public.potential_class (
  potential_id smallint primary key,
  name_bg      text not null unique,
  sort_order   smallint not null
);
comment on table public.potential_class is 'Потенциал на земята: число -> клас.';

create table public.tillage_type (
  tillage_id smallint generated always as identity primary key,
  name_bg    text not null unique,
  is_active  boolean not null default true
);
comment on table public.tillage_type is 'Технология / основна обработка на почвата.';

create table public.reproduction (
  reproduction_id smallint generated always as identity primary key,
  name            text not null unique,
  sort_order      smallint not null default 0
);
comment on table public.reproduction is 'Размножение (генерация) на сорта: C1, C2, Базови...';

-- ---------- VARIETY ----------
create table public.variety (
  variety_id uuid primary key default gen_random_uuid(),
  crop_id    uuid not null references public.crop(crop_id),
  name       text not null,
  breeder    text,
  technology text,
  is_active  boolean not null default true,
  unique (crop_id, name)
);
comment on table public.variety is 'Сортове и хибриди по култура.';

-- ---------- FERTILIZATION_STAGE ----------
create table public.fertilization_stage (
  stage_id   smallint generated always as identity primary key,
  name_bg    text not null unique,
  name_en    text,
  method     text not null check (method in ('soil','foliar','fertigation')),
  sort_order smallint not null,
  is_active  boolean not null default true
);
comment on table public.fertilization_stage is 'Единен справочник на етапите/видовете торене (по AgroVIR).';

-- ---------- FERTILIZER_PRODUCT ----------
create table public.fertilizer_product (
  product_id           uuid primary key default gen_random_uuid(),
  code                 text not null unique,
  name                 text not null,
  category             text not null check (category in ('mineral','organic','foliar')),
  form                 text not null check (form in ('solid','liquid')),
  density_kg_l         numeric(5,3) check (density_kg_l > 0),
  n_pct                numeric(5,2) check (n_pct between 0 and 100),
  p2o5_pct             numeric(5,2) check (p2o5_pct between 0 and 100),
  k2o_pct              numeric(5,2) check (k2o_pct between 0 and 100),
  ca_pct               numeric(5,2) check (ca_pct between 0 and 100),
  mg_pct               numeric(5,2) check (mg_pct between 0 and 100),
  na_pct               numeric(5,2) check (na_pct between 0 and 100),
  s_pct                numeric(5,2) check (s_pct between 0 and 100),
  b_pct                numeric(5,3) check (b_pct between 0 and 100),
  mo_pct               numeric(5,3) check (mo_pct between 0 and 100),
  zn_pct               numeric(5,3) check (zn_pct between 0 and 100),
  ca_basis             text not null default 'element' check (ca_basis in ('element','oxide')),
  mg_basis             text not null default 'element' check (mg_basis in ('element','oxide')),
  s_basis              text not null default 'element' check (s_basis in ('element','oxide')),
  n_organic_share_pct  numeric(5,2) not null default 0 check (n_organic_share_pct between 0 and 100),
  parent_product_id    uuid references public.fertilizer_product(product_id),
  manufacturer         text,
  price_per_unit       numeric(10,2) check (price_per_unit >= 0),
  is_active            boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint fp_liquid_needs_density check (form = 'solid' or density_kg_l is not null),
  constraint fp_npk_le_100 check (coalesce(n_pct,0) + coalesce(p2o5_pct,0) + coalesce(k2o_pct,0) <= 100),
  constraint fp_parent_not_self check (parent_product_id is null or parent_product_id <> product_id)
);
comment on table public.fertilizer_product is 'Номенклатура на торовете. % са по маса; P и K са оксиди (P2O5, K2O).';
comment on column public.fertilizer_product.density_kg_l is 'kg/l. За твърди се приема 1 (в изчисленията). За течни е задължителна.';
comment on column public.fertilizer_product.ca_basis is 'element = стойността е Ca; oxide = CaO (както е на етикета). Аналогично mg_basis (MgO), s_basis (SO3).';
comment on column public.fertilizer_product.n_organic_share_pct is 'Дял от N, който е органичен (0 за минерални, 100 за напр. био хумик).';
create trigger fertilizer_product_touch before update on public.fertilizer_product for each row execute function app.touch_updated_at();

-- ---------- Правила за диверсификация (ДЗЕС, ЕКОРОК) ----------
create table public.diversification_rule (
  rule_id               uuid primary key default gen_random_uuid(),
  rule_set              text not null,
  check_type            text not null check (check_type in ('top_n_max','nth_min')),
  n                     smallint not null check (n between 1 and 4),
  threshold_pct         numeric(5,2) not null check (threshold_pct between 0 and 100),
  message_bg            text not null,
  valid_from_season_id  smallint references public.season(season_id),
  valid_to_season_id    smallint references public.season(season_id)
);
comment on table public.diversification_rule is 'top_n_max: сборът на първите N култури трябва да е под прага (нарушение при >=). nth_min: N-тата култура трябва да е над минимума (нарушение при <=). Семантиката е както в BI на AgroVIR.';

create table public.diversification_rule_crop (
  rule_set text not null,
  crop_id  uuid not null references public.crop(crop_id),
  primary key (rule_set, crop_id)
);
comment on table public.diversification_rule_crop is 'Култури, участващи в проверката (един списък за знаменател и числител).';
