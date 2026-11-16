-- ПРЗ каталог (регистър на БАБХ + собствени добавки) и разширение на каталога с торове.
-- Само добавя нови таблици/колони; не променя данни. Констрейнтите на fertilizer_product
-- се разширяват (виж коментарите), за да приемат непотвърдени продукти.

-- =====================================================================
-- 1. РАЗШИРЕНИЕ НА fertilizer_product
-- =====================================================================

-- повече категории (специализирани торове и биостимулатори)
alter table public.fertilizer_product drop constraint fertilizer_product_category_check;
alter table public.fertilizer_product add constraint fertilizer_product_category_check
  check (category in ('mineral','organic','foliar','specialty','biostimulant'));

alter table public.fertilizer_product
  add column mn_pct               numeric(5,3) check (mn_pct between 0 and 100),
  add column cu_pct               numeric(5,3) check (cu_pct between 0 and 100),
  add column fe_pct               numeric(5,3) check (fe_pct between 0 and 100),
  add column si_pct               numeric(5,3) check (si_pct between 0 and 100),
  add column n_nitrate_pct        numeric(5,2) check (n_nitrate_pct between 0 and 100),
  add column n_ammonium_pct       numeric(5,2) check (n_ammonium_pct between 0 and 100),
  add column n_urea_pct           numeric(5,2) check (n_urea_pct between 0 and 100),
  add column organic_c_pct        numeric(5,2) check (organic_c_pct between 0 and 100),
  add column organic_matter_pct   numeric(5,2) check (organic_matter_pct between 0 and 100),
  add column humic_fulvic_pct     numeric(5,2) check (humic_fulvic_pct between 0 and 100),
  add column amino_acids_pct      numeric(5,2) check (amino_acids_pct between 0 and 100),
  add column formula              text,
  add column series               text,
  add column application          text,   -- свободен текст: почвено / листно / фертигация
  add column form_note            text,   -- оригиналната форма от каталога (гранули, кристален, …)
  add column product_kind         text,   -- оригиналният вид/подвид от каталога
  add column active_components    text,
  add column technology           text,
  add column source_url           text,
  add column data_status          text not null default 'needs_check'
                                  check (data_status in ('verified','needs_check','generic')),
  add column check_note           text,
  add column verified_on          date;

comment on column public.fertilizer_product.data_status is
  'verified = съставът е потвърден по етикет; needs_check = за доуточняване; generic = типов продукт (не е конкретна марка).';

-- течните продукти без известна плътност са позволени само докато не са "verified"
alter table public.fertilizer_product drop constraint fp_liquid_needs_density;
alter table public.fertilizer_product add constraint fp_liquid_needs_density
  check (form = 'solid' or density_kg_l is not null or data_status <> 'verified');

-- =====================================================================
-- 2. ПРЗ: ПРОДУКТИ
-- =====================================================================
create table public.prz_product (
  prz_product_id    uuid primary key default gen_random_uuid(),
  source            text not null check (source in ('bfsa','own')),
  trade_name        text not null,
  permit_text       text,                 -- "Разрешение № 01486-ПРЗ-2/13.05.2026 г." или "Удостоверение № …"
  permit_no         text,                 -- 01486-ПРЗ-2
  permit_date       date,
  holder            text,
  holder_eik        text,
  active_substances text,
  function_raw      text,
  function_groups   text[] not null default '{}',
  use_category      text,                 -- професионална / непрофесионална
  classification    text,                 -- H/EUH/SP фрази
  register_status   text,                 -- ACTIVE / INACTIVE по регистъра
  register_date     date,                 -- датата на файла на БАБХ
  is_active         boolean not null default true,
  note              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint prz_function_groups_valid check (function_groups <@ array[
    'fungicide','herbicide','insecticide','acaricide','growth_regulator','desiccant',
    'molluscicide','rodenticide','nematicide','bactericide','repellent','fumigant','adjuvant','other']::text[])
);
create unique index prz_product_unique on public.prz_product (source, coalesce(permit_text, ''), trade_name);
create index prz_product_groups on public.prz_product using gin (function_groups);
comment on table public.prz_product is 'Продукти за растителна защита: официален регистър на БАБХ (source=bfsa) и собствени добавки като прилепители (source=own).';
create trigger prz_product_touch before update on public.prz_product for each row execute function app.touch_updated_at();

-- търговски имена и синоними (едно разрешение може да носи няколко имена)
create table public.prz_product_name (
  name_id        uuid primary key default gen_random_uuid(),
  prz_product_id uuid not null references public.prz_product(prz_product_id) on delete cascade,
  name           text not null,
  name_norm      text not null,           -- главни букви, без излишни интервали
  is_primary     boolean not null default false
);
create unique index prz_product_name_unique on public.prz_product_name (prz_product_id, name_norm);
create index prz_product_name_norm on public.prz_product_name (name_norm);
comment on table public.prz_product_name is 'Търговски имена/синоними на ПРЗ, за търсене и свързване с имената от AgroVIR.';

-- употреби: култура + доза + срокове (един ред от регистъра)
create table public.prz_use (
  prz_use_id        uuid primary key default gen_random_uuid(),
  prz_product_id    uuid not null references public.prz_product(prz_product_id) on delete cascade,
  crop_id           uuid references public.crop(crop_id),   -- само за нашите култури
  crop_text         text,                 -- култура и вредител, както е в регистъра
  target_text       text,
  use_type          text,                 -- З / П / О (според регистъра)
  dose_text         text,
  dose_min          numeric(10,3),
  dose_max          numeric(10,3),
  dose_unit         text check (dose_unit in ('ml_da','g_da','l_da','kg_da','ml_100l','l_100l','g_100l','kg_1000kg','ml_1000kg','other')),
  phi_text          text,
  phi_days          smallint,
  max_applications  smallint,
  interval_days     smallint,
  bbch_from         smallint,
  bbch_to           smallint,
  water_min_l_da    numeric(7,1),
  water_max_l_da    numeric(7,1),
  remarks           text
);
create index prz_use_product on public.prz_use (prz_product_id);
create index prz_use_crop on public.prz_use (crop_id) where crop_id is not null;
comment on table public.prz_use is 'Разрешени употреби от регистъра на БАБХ. Дозата е по продукт на декар, където е зададено така; иначе dose_unit показва единицата.';

-- =====================================================================
-- 3. RLS и одит (по образеца на fertilizer_product)
-- =====================================================================
alter table public.prz_product enable row level security;
create policy prz_product_select on public.prz_product for select to authenticated using (true);
create policy prz_product_insert on public.prz_product for insert to authenticated with check (app.is_any_admin());
create policy prz_product_update on public.prz_product for update to authenticated using (app.is_any_admin()) with check (app.is_any_admin());
create policy prz_product_delete on public.prz_product for delete to authenticated using (app.is_any_admin());

alter table public.prz_product_name enable row level security;
create policy prz_product_name_select on public.prz_product_name for select to authenticated using (true);
create policy prz_product_name_insert on public.prz_product_name for insert to authenticated with check (app.is_any_admin());
create policy prz_product_name_update on public.prz_product_name for update to authenticated using (app.is_any_admin()) with check (app.is_any_admin());
create policy prz_product_name_delete on public.prz_product_name for delete to authenticated using (app.is_any_admin());

alter table public.prz_use enable row level security;
create policy prz_use_select on public.prz_use for select to authenticated using (true);
create policy prz_use_insert on public.prz_use for insert to authenticated with check (app.is_any_admin());
create policy prz_use_update on public.prz_use for update to authenticated using (app.is_any_admin()) with check (app.is_any_admin());
create policy prz_use_delete on public.prz_use for delete to authenticated using (app.is_any_admin());

create trigger prz_product_audit after insert or update or delete on public.prz_product
  for each row execute function app.audit_row('prz_product_id');
