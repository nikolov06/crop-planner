-- Планиране семена: качество на семената по БЗС, ръчна норма кг/дка, оферти и цени за семена.
-- Изисква 20261117120000_product_prices и 20261124120000_seed_import.

-- =====================================================================
-- 1. Качество на семената: сорт → партида → БЗС (последното печели)
-- =====================================================================
alter table public.variety
  add column if not exists tkw_g           numeric(6,2) check (tkw_g > 0),
  add column if not exists germination_pct numeric(5,2) check (germination_pct > 0 and germination_pct <= 100);
comment on column public.variety.tkw_g is 'Маса на 1000 семена, г – по подразбиране за сорта (ако партидата няма стойност).';
comment on column public.variety.germination_pct is 'Кълняемост, % – по подразбиране за сорта (ако партидата няма стойност).';

alter table public.planting_seed
  add column if not exists tkw_g             numeric(6,2) check (tkw_g > 0),
  add column if not exists germination_pct   numeric(5,2) check (germination_pct > 0 and germination_pct <= 100),
  add column if not exists rate_kg_da_manual numeric(7,1) check (rate_kg_da_manual > 0);
comment on column public.planting_seed.tkw_g is 'Маса на 1000 семена за това БЗС; празно = от партидата, иначе от сорта.';
comment on column public.planting_seed.germination_pct is 'Кълняемост за това БЗС; празно = от партидата, иначе от сорта.';
comment on column public.planting_seed.rate_kg_da_manual is 'Ръчна норма кг/дка (1 знак). Празно = изчислената. Само за култури с поръчка в кг/т.';

-- =====================================================================
-- 2. Изчисление (същите колони в същия ред; новите са добавени накрая)
--    Брой семена/м² = CEILING(кълняеми / (кълняемост/100))
--    Норма кг/дка   = ROUND(брой × МХЗ / 1000 / стъпка) × стъпка, или ръчната
--    Нужда т        = норма × площ / 1000;  торби = семена × площ / семена в торба
--    С преразход    = нужда × (1 + преразход %)  – need_kg, need_t, packs (както досега, за заявката)
--    Без преразход  – need_t_base, packs_base (нови колони)
--    Рапица (слята, поръчка в торби): кг/дка само за информация, 2 знака (rate_kg_da_info)
-- =====================================================================
create or replace view public.v_seed_calc with (security_invoker = true) as
with base as (
  select
    ps.planting_seed_id, ps.organization_id, ps.planting_id, ps.variety_id, ps.batch_id,
    ps.area_da, ps.target_rate, ps.rate_kg_da_manual,
    ctx.season_id, ctx.farm_base_id, ctx.crop_id, ctx.crop_name,
    cr.seeding_method, cr.rate_basis, cr.convert_to_kg, cr.order_unit,
    coalesce(ps.overage_pct, cr.seed_overage_pct, 0) as overage_pct,
    coalesce(ps.tkw_g, b.tkw_g, v.tkw_g)::numeric(6,2) as tkw_g,
    coalesce(ps.germination_pct, b.germination_pct, v.germination_pct)::numeric(5,2) as germination_pct,
    case when ps.tkw_g is not null then 'bzs' when b.tkw_g is not null then 'batch' when v.tkw_g is not null then 'variety' end as tkw_source,
    case when ps.germination_pct is not null then 'bzs' when b.germination_pct is not null then 'batch' when v.germination_pct is not null then 'variety' end as germ_source,
    coalesce(b.seeds_per_pack, v.seeds_per_pack, cr.default_seeds_per_pack) as seeds_per_pack,
    coalesce(cr.rate_rounding_step, app.setting_num(ps.organization_id, 'seed_rate_rounding_step', 1)) as step
  from public.planting_seed ps
  join public.v_planting_context ctx on ctx.planting_id = ps.planting_id
  join public.crop cr on cr.crop_id = ctx.crop_id
  left join public.seed_batch b on b.batch_id = ps.batch_id
  left join public.variety v on v.variety_id = ps.variety_id
),
calc as (
  select base.*,
    case when seeding_method = 'solid' and germination_pct is not null
         then ceil(target_rate / (germination_pct / 100.0)) end as total_seeds_m2
  from base
),
calc2 as (
  select calc.*,
    case when total_seeds_m2 is not null and tkw_g is not null then total_seeds_m2 * tkw_g / 1000 end as raw_kg_da
  from calc
),
calc3 as (
  select calc2.*,
    case when raw_kg_da is not null then round(raw_kg_da / step) * step end as rate_kg_da_calc
  from calc2
),
calc4 as (
  select calc3.*,
    case when order_unit = 'kg' then coalesce(rate_kg_da_manual, rate_kg_da_calc) else rate_kg_da_calc end as rate_kg_da
  from calc3
)
select
  planting_seed_id, organization_id, planting_id, variety_id, batch_id, season_id, farm_base_id, crop_id, crop_name,
  seeding_method, rate_basis, order_unit, area_da, target_rate, overage_pct, step as rounding_step,
  tkw_g, germination_pct, seeds_per_pack,
  total_seeds_m2, raw_kg_da, rate_kg_da, rate_kg_da * 10 as rate_kg_ha,
  coalesce(case order_unit
    when 'kg'    then rate_kg_da is null
    when 'packs' then seeds_per_pack is null or (seeding_method = 'solid' and total_seeds_m2 is null)
  end, false) as missing_batch_data,
  case when order_unit = 'kg' and rate_kg_da is not null then rate_kg_da * area_da * (1 + overage_pct / 100) end as need_kg,
  case when order_unit = 'kg' and rate_kg_da is not null then rate_kg_da * area_da * (1 + overage_pct / 100) / 1000 end as need_t,
  case seeding_method
    when 'solid' then total_seeds_m2 * 1000 * area_da * (1 + overage_pct / 100)
    when 'row'   then target_rate * area_da * (1 + overage_pct / 100)
  end as seeds_total,
  case when order_unit = 'packs' and seeds_per_pack is not null then
    (case seeding_method
       when 'solid' then total_seeds_m2 * 1000 * area_da
       when 'row'   then target_rate * area_da
     end) * (1 + overage_pct / 100) / seeds_per_pack
  end as packs,
  -- нови колони
  rate_kg_da_calc,
  (order_unit = 'kg' and rate_kg_da_manual is not null) as rate_is_manual,
  tkw_source, germ_source,
  case when order_unit = 'kg' and rate_kg_da is not null then rate_kg_da * area_da / 1000 end as need_t_base,
  case when order_unit = 'packs' and seeds_per_pack is not null then
    (case seeding_method
       when 'solid' then total_seeds_m2 * 1000 * area_da
       when 'row'   then target_rate * area_da
     end) / seeds_per_pack
  end as packs_base,
  case when order_unit = 'packs' and raw_kg_da is not null then round(raw_kg_da, 2) end as rate_kg_da_info
from calc4;
comment on view public.v_seed_calc is 'Качество: БЗС → партида → сорт. Слети: брой семена/м² = CEILING(кълняеми / кълняемост); кг/дка = ROUND(брой × МХЗ / 1000) или ръчната. need_t/packs са С преразход (за заявка); need_t_base/packs_base – без. Редови и рапица: торби през семената; при рапица кг/дка само информативно (rate_kg_da_info).';

-- =====================================================================
-- 3. Доставчици: „Собствено производство“
-- =====================================================================
alter table public.supplier add column if not exists is_own_production boolean not null default false;
comment on column public.supplier.is_own_production is 'Вътрешен „доставчик“ за собствени семена (произход Б/, Т/, П/…); цената е вътрешна, EUR/т.';
create unique index if not exists supplier_own_one on public.supplier (organization_id) where is_own_production;
insert into public.supplier (organization_id, name, is_own_production)
select o.organization_id, 'Собствено производство', true from public.organization o
on conflict (organization_id, name) do update set is_own_production = true;

-- =====================================================================
-- 4. Оферти за семена: модул 'seed', ред по сорт, мерна единица торба | т | кг
-- =====================================================================
alter table public.offer drop constraint offer_module_check;
alter table public.offer add constraint offer_module_check check (module in ('prz','fert','seed'));

alter table public.offer_line add column if not exists variety_id uuid references public.variety(variety_id);
alter table public.offer_line add column if not exists min_qty numeric(12,2) check (min_qty > 0);
comment on column public.offer_line.variety_id is 'Сорт/хибрид (оферти за семена).';
comment on column public.offer_line.min_qty is 'Минимално количество в мерната единица на цената (по избор).';

alter table public.offer_line drop constraint offer_line_one_product;
alter table public.offer_line add constraint offer_line_one_product
  check (num_nonnulls(prz_product_id, fertilizer_product_id, variety_id) = 1);
alter table public.offer_line drop constraint offer_line_price_unit_check;
alter table public.offer_line add constraint offer_line_price_unit_check check (price_unit in ('l','kg','t','pack'));
alter table public.offer_line add constraint offer_line_fert_unit check (fertilizer_product_id is null or price_unit in ('l','kg','t'));
alter table public.offer_line add constraint offer_line_seed_unit check (variety_id is null or price_unit in ('pack','t','kg'));

create unique index offer_line_seed_uq on public.offer_line (offer_id, variety_id) where variety_id is not null;
create unique index offer_line_seed_pref on public.offer_line (organization_id, season_id, variety_id) where is_preferred and variety_id is not null;
create index offer_line_variety on public.offer_line (variety_id) where variety_id is not null;

create or replace function app.offer_line_defaults() returns trigger
language plpgsql as $$
declare o public.offer%rowtype;
begin
  select * into o from public.offer where offer_id = new.offer_id;
  if not found then raise exception 'Офертата не е намерена'; end if;
  new.organization_id := o.organization_id;
  new.season_id := o.season_id;
  if o.module = 'prz'  and new.prz_product_id is null        then raise exception 'Оферта за ПРЗ приема само ПРЗ продукти'; end if;
  if o.module = 'fert' and new.fertilizer_product_id is null then raise exception 'Оферта за торове приема само торове'; end if;
  if o.module = 'seed' and new.variety_id is null            then raise exception 'Оферта за семена приема само сортове/хибриди'; end if;
  return new;
end $$;

-- „Избрана“: при отбелязване се снема от останалите за същия продукт/сорт, сезон и организация
create or replace function app.price_single_preferred() returns trigger
language plpgsql as $$
begin
  if new.is_preferred then
    update public.offer_line p set is_preferred = false
     where p.offer_line_id <> new.offer_line_id and p.is_preferred
       and p.organization_id = new.organization_id and p.season_id = new.season_id
       and p.prz_product_id        is not distinct from new.prz_product_id
       and p.fertilizer_product_id is not distinct from new.fertilizer_product_id
       and p.variety_id            is not distinct from new.variety_id;
  end if;
  return new;
end $$;

-- Ефективната цена (ПРЗ/торове) трябва да различава и сорта, иначе всички редове за семена
-- (prz = null, fert = null) биха се слели в една група. variety_id е добавена накрая.
create or replace view public.v_product_price_effective with (security_invoker = true) as
select distinct on (l.organization_id, l.season_id, l.prz_product_id, l.fertilizer_product_id, l.variety_id)
       l.organization_id, l.season_id, l.prz_product_id, l.fertilizer_product_id,
       l.offer_line_id, o.offer_id, o.offer_no, o.supplier_id, s.name as supplier_name, l.price, l.price_unit, l.is_preferred,
       count(*) over (partition by l.organization_id, l.season_id, l.prz_product_id, l.fertilizer_product_id, l.variety_id) as n_offers,
       l.variety_id
  from public.offer_line l
  join public.offer o on o.offer_id = l.offer_id and o.status <> 'rejected'
  join public.supplier s on s.supplier_id = o.supplier_id
 order by l.organization_id, l.season_id, l.prz_product_id, l.fertilizer_product_id, l.variety_id,
          l.is_preferred desc, (o.status = 'accepted') desc, (l.price / case l.price_unit when 't' then 1000 else 1 end), l.offer_line_id;

-- Семена: САМО избраната оферта (без избрана → няма цена, екранът показва „—“ и жълт маркер)
create or replace view public.v_seed_price_selected with (security_invoker = true) as
select l.organization_id, l.season_id, l.variety_id, l.offer_line_id, o.offer_id, o.offer_no, o.offer_date, o.valid_until,
       o.supplier_id, s.name as supplier_name, s.is_own_production, l.price, l.price_unit, l.min_qty,
       (select count(*) from public.offer_line l2 join public.offer o2 on o2.offer_id = l2.offer_id and o2.status <> 'rejected'
         where l2.organization_id = l.organization_id and l2.season_id = l.season_id and l2.variety_id = l.variety_id) as n_offers
  from public.offer_line l
  join public.offer o on o.offer_id = l.offer_id and o.status <> 'rejected'
  join public.supplier s on s.supplier_id = o.supplier_id
 where l.variety_id is not null and l.is_preferred;
comment on view public.v_seed_price_selected is 'Избраната оферта за сорт и сезон. Планиране семена и рекапитулацията ползват само нея.';
