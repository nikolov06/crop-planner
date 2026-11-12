-- Семена в торба: стойност по подразбиране за културата (crop.default_seeds_per_pack),
-- която може да се променя за конкретен сорт/хибрид (variety.seeds_per_pack) или партида (seed_batch.seeds_per_pack).
alter table public.variety add column if not exists seeds_per_pack integer check (seeds_per_pack > 0);
comment on column public.variety.seeds_per_pack is 'Семена в торба за този сорт/хибрид; празно = по подразбиране за културата.';

-- По подразбиране за културите (само ако още няма стойност)
update public.crop set default_seeds_per_pack = 150000  where name_bg = 'СЛЪНЧОГЛЕД'       and default_seeds_per_pack is null;
update public.crop set default_seeds_per_pack = 80000   where name_bg in ('ЦАРЕВИЦА','ПОЛИВНА ЦАРЕВИЦА') and default_seeds_per_pack is null;
update public.crop set default_seeds_per_pack = 1500000 where name_bg = 'РАПИЦА'           and default_seeds_per_pack is null;
update public.crop set default_seeds_per_pack = 300000  where name_bg = 'СОРГО'            and default_seeds_per_pack is null;

-- Приоритет: партида > сорт/хибрид > култура
create or replace view public.v_seed_calc with (security_invoker = true) as
with base as (
  select
    ps.planting_seed_id, ps.organization_id, ps.planting_id, ps.variety_id, ps.batch_id,
    ps.area_da, ps.target_rate,
    ctx.season_id, ctx.farm_base_id, ctx.crop_id, ctx.crop_name,
    cr.seeding_method, cr.rate_basis, cr.convert_to_kg, cr.order_unit,
    coalesce(ps.overage_pct, cr.seed_overage_pct, 0) as overage_pct,
    b.tkw_g, b.germination_pct,
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
    case when raw_kg_da is not null then round(raw_kg_da / step) * step end as rate_kg_da
  from calc2
)
select
  planting_seed_id, organization_id, planting_id, variety_id, batch_id, season_id, farm_base_id, crop_id, crop_name,
  seeding_method, rate_basis, order_unit, area_da, target_rate, overage_pct, step as rounding_step,
  tkw_g, germination_pct, seeds_per_pack,
  total_seeds_m2, raw_kg_da, rate_kg_da, rate_kg_da * 10 as rate_kg_ha,
  (seeding_method = 'solid' and (germination_pct is null or tkw_g is null)) as missing_batch_data,
  case when order_unit = 'kg' and rate_kg_da is not null
       then rate_kg_da * area_da * (1 + overage_pct / 100) end as need_kg,
  case when order_unit = 'kg' and rate_kg_da is not null
       then rate_kg_da * area_da * (1 + overage_pct / 100) / 1000 end as need_t,
  case seeding_method
    when 'solid' then total_seeds_m2 * 1000 * area_da * (1 + overage_pct / 100)
    when 'row'   then target_rate * area_da * (1 + overage_pct / 100)
  end as seeds_total,
  case when order_unit = 'packs' and seeds_per_pack is not null then
    (case seeding_method
       when 'solid' then total_seeds_m2 * 1000 * area_da * (1 + overage_pct / 100)
       when 'row'   then target_rate * area_da * (1 + overage_pct / 100)
     end) / seeds_per_pack
  end as packs
from calc3;
comment on view public.v_seed_calc is 'Слети: общи семена/м2 = кълняеми / кълняемост; kg/дка = общи x МХЗ / 1000, закръглено по стъпка; количество = kg/дка x площ x (1 + преразход). Редови: семена/дка x площ x (1 + преразход) / семена в торба.';
