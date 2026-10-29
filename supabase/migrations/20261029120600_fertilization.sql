-- Торене: допустими продукти по етап, CNP рецепти, задаване, ред от плана.

create table public.stage_product (
  stage_product_id    uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organization(organization_id) on delete cascade,
  stage_id            smallint not null references public.fertilization_stage(stage_id),
  product_id          uuid not null references public.fertilizer_product(product_id),
  farm_base_id        uuid references public.farm_base(farm_base_id),
  default_rate_per_da numeric(8,3) check (default_rate_per_da >= 0),
  unit                text not null check (unit in ('kg_da','l_da')),
  is_default          boolean not null default false,
  is_active           boolean not null default true
);
comment on table public.stage_product is 'Допустими продукти за етапа; farm_base_id празно = за цялата организация.';
create unique index stage_product_unique on public.stage_product
  (organization_id, stage_id, product_id, coalesce(farm_base_id, '00000000-0000-0000-0000-000000000000'::uuid));
create unique index stage_product_one_default on public.stage_product
  (organization_id, stage_id, coalesce(farm_base_id, '00000000-0000-0000-0000-000000000000'::uuid)) where is_default;
create index stage_product_product on public.stage_product (product_id);

create table public.cnp (
  cnp_id             uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organization(organization_id) on delete cascade,
  name               text not null,
  crop_id            uuid not null references public.crop(crop_id),
  season_id          smallint not null references public.season(season_id),
  company_id         uuid references public.company(company_id),
  farm_base_id       uuid references public.farm_base(farm_base_id),
  target_yield_kg_da numeric(7,1) check (target_yield_kg_da > 0),
  status             text not null default 'draft' check (status in ('draft','active','archived')),
  copied_from_cnp_id uuid references public.cnp(cnp_id),
  note               text,
  created_by         uuid default auth.uid(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
comment on table public.cnp is 'Рецепта (Crop Nutrition Plan) за култура и стопанска година.';
create index cnp_org on public.cnp (organization_id, season_id, crop_id);
create trigger cnp_touch before update on public.cnp for each row execute function app.touch_updated_at();

create table public.cnp_stage (
  cnp_stage_id    uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organization(organization_id) on delete cascade,
  cnp_id          uuid not null references public.cnp(cnp_id) on delete cascade,
  stage_id        smallint not null references public.fertilization_stage(stage_id),
  seq_no          smallint not null,
  period_from     date,
  period_to       date,
  bbch_from       smallint check (bbch_from between 0 and 99),
  bbch_to         smallint check (bbch_to between 0 and 99),
  unique (cnp_id, seq_no),
  unique (cnp_id, stage_id),
  constraint cnp_stage_period check (period_to is null or period_from is null or period_to >= period_from)
);
comment on table public.cnp_stage is 'Етап в рецептата. Вегетационно 1 и 2 са два отделни етапа.';
create trigger aa_cnp_stage_org before insert or update on public.cnp_stage
  for each row execute function app.inherit_org('cnp', 'cnp_id', 'cnp_id');

create table public.cnp_stage_product (
  cnp_stage_product_id uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organization(organization_id) on delete cascade,
  cnp_stage_id         uuid not null references public.cnp_stage(cnp_stage_id) on delete cascade,
  product_id           uuid not null references public.fertilizer_product(product_id),
  rate_per_da          numeric(8,3) not null check (rate_per_da >= 0),
  unit                 text not null check (unit in ('kg_da','l_da')),
  unique (cnp_stage_id, product_id)
);
comment on table public.cnp_stage_product is 'Продукт и норма в етапа. Един продукт може да е в различни етапи на същата CNP.';
create index cnp_stage_product_product on public.cnp_stage_product (product_id);
create trigger aa_cnp_stage_product_org before insert or update on public.cnp_stage_product
  for each row execute function app.inherit_org('cnp_stage', 'cnp_stage_id', 'cnp_stage_id');

create table public.cnp_assignment (
  assignment_id    uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organization(organization_id) on delete cascade,
  planting_id      uuid not null references public.field_planting(planting_id) on delete cascade,
  cnp_id           uuid not null references public.cnp(cnp_id),
  assigned_at      timestamptz not null default now(),
  assigned_by      uuid default auth.uid(),
  is_active        boolean not null default true,
  replaced_at      timestamptz
);
comment on table public.cnp_assignment is 'Задаване на CNP към период. Най-много едно активно; заменените остават като история.';
create unique index cnp_assignment_one_active on public.cnp_assignment (planting_id) where is_active;
create index cnp_assignment_cnp on public.cnp_assignment (cnp_id) where is_active;
create trigger aa_cnp_assignment_org before insert or update on public.cnp_assignment
  for each row execute function app.inherit_org('field_planting', 'planting_id', 'planting_id');

create table public.fert_plan_line (
  line_id               uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organization(organization_id) on delete cascade,
  planting_id           uuid not null references public.field_planting(planting_id) on delete cascade,
  stage_id              smallint not null references public.fertilization_stage(stage_id),
  product_id            uuid not null references public.fertilizer_product(product_id),
  rate_per_da           numeric(8,3) not null check (rate_per_da >= 0),
  unit                  text not null check (unit in ('kg_da','l_da')),
  treated_area_da       numeric(10,2) check (treated_area_da > 0),
  period_from           date,
  period_to             date,
  source                text not null default 'manual' check (source in ('cnp','manual')),
  assignment_id         uuid references public.cnp_assignment(assignment_id),
  cnp_stage_product_id  uuid references public.cnp_stage_product(cnp_stage_product_id) on delete set null,
  cnp_rate_per_da       numeric(8,3),
  is_deviation          boolean not null default false,
  note                  text,
  created_by            uuid default auth.uid(),
  updated_by            uuid,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (planting_id, stage_id, product_id),
  constraint fpl_period check (period_to is null or period_from is null or period_to >= period_from),
  constraint fpl_cnp_needs_assignment check (source = 'manual' or assignment_id is not null)
);
comment on table public.fert_plan_line is 'Ред от плана: период x етап x продукт. Пазят се само входните данни; количествата и а.в. са във v_fert_plan_calc.';
comment on column public.fert_plan_line.is_deviation is 'true, когато нормата е променена ръчно спрямо CNP; такъв ред не се презаписва при промяна на CNP.';
create index fpl_planting on public.fert_plan_line (planting_id);
create index fpl_stage on public.fert_plan_line (stage_id);
create index fpl_product on public.fert_plan_line (product_id);
create index fpl_assignment on public.fert_plan_line (assignment_id);
create trigger aa_fpl_org before insert or update on public.fert_plan_line
  for each row execute function app.inherit_org('field_planting', 'planting_id', 'planting_id');
