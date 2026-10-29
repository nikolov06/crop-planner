-- Семена: партиди и планиране по период.

create table public.seed_batch (
  batch_id             uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organization(organization_id) on delete cascade,
  variety_id           uuid not null references public.variety(variety_id),
  source_type          text not null check (source_type in ('purchased','own_production')),
  supplier             text,
  origin_farm_base_id  uuid references public.farm_base(farm_base_id),
  lot_code             text,
  reproduction_id      smallint references public.reproduction(reproduction_id),
  tkw_g                numeric(6,2) check (tkw_g > 0),
  germination_pct      numeric(5,2) check (germination_pct > 0 and germination_pct <= 100),
  analysis_source      text not null check (analysis_source in ('producer','lab')),
  analysis_date        date,
  lab_name             text,
  seeds_per_pack       integer check (seeds_per_pack > 0),
  pack_weight_kg       numeric(8,2) check (pack_weight_kg > 0),
  is_active            boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (batch_id, variety_id),
  constraint seed_batch_origin_only_own check (origin_farm_base_id is null or source_type = 'own_production')
);
comment on table public.seed_batch is 'Партида/произход на семената: МХЗ, кълняемост, опаковка. Закупени: данни от производителя; собствени: лабораторен анализ.';
create index seed_batch_org on public.seed_batch (organization_id);
create index seed_batch_variety on public.seed_batch (variety_id);
create trigger seed_batch_touch before update on public.seed_batch for each row execute function app.touch_updated_at();

create table public.planting_seed (
  planting_seed_id  uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organization(organization_id) on delete cascade,
  planting_id       uuid not null references public.field_planting(planting_id) on delete cascade,
  variety_id        uuid not null references public.variety(variety_id),
  batch_id          uuid,
  area_da           numeric(10,2) not null check (area_da > 0),
  target_rate       numeric(12,2) not null check (target_rate > 0),
  overage_pct       numeric(5,2) check (overage_pct >= 0),
  note              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint planting_seed_batch_variety foreign key (batch_id, variety_id)
    references public.seed_batch (batch_id, variety_id)
);
comment on table public.planting_seed is 'Сорт, партида, норма и индивидуален преразход на реда. Няколко реда за един период (два сорта на една площ).';
comment on column public.planting_seed.target_rate is 'Кълняеми семена/м² (слети) или семена/дка (редови) според crop.rate_basis. kg/дка и количествата се смятат във v_seed_calc.';
comment on column public.planting_seed.overage_pct is 'Преразход за реда, %; празно = crop.seed_overage_pct.';
create index planting_seed_planting on public.planting_seed (planting_id);
create index planting_seed_variety on public.planting_seed (variety_id);
create trigger aa_planting_seed_org before insert or update on public.planting_seed
  for each row execute function app.inherit_org('field_planting', 'planting_id', 'planting_id');
create trigger planting_seed_touch before update on public.planting_seed for each row execute function app.touch_updated_at();
