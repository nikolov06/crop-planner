-- Изгледи. Всички са security_invoker: RLS политиките на таблиците важат и за изгледите.
-- Количества и активни вещества не се пазят в таблиците, а се смятат тук.

-- ---------- Контекст на периода (общи съединения) ----------
create or replace view public.v_planting_context with (security_invoker = true) as
select
  p.planting_id, p.organization_id, p.fcy_id, y.field_id,
  y.season_id, s.label as season_label, s.year_end as season_year_end,
  y.company_id, co.name as company_name,
  fb.farm_base_id, fbn.name as farm_base_name,
  f.settlement_id, st.name as settlement_name, f.massif,
  y.isak_number, y.field_name,
  y.potential_id, pc.name_bg as potential_name,
  p.crop_id, c.name_bg as crop_name, c.subsidy_crop_id,
  p.role, p.planted_area_da, p.tillage_id, tt.name_bg as tillage_name,
  p.sowing_date_plan, p.sowing_date_actual, p.is_locked, p.is_test_area
from public.field_planting p
join public.field_crop_year y on y.fcy_id = p.fcy_id
join public.season s on s.season_id = y.season_id
join public.field f on f.field_id = y.field_id
join public.crop c on c.crop_id = p.crop_id
left join public.company co on co.company_id = y.company_id
left join public.settlement st on st.settlement_id = f.settlement_id
left join public.potential_class pc on pc.potential_id = y.potential_id
left join public.tillage_type tt on tt.tillage_id = p.tillage_id
left join lateral (
  select b.farm_base_id from public.field_base b
   where b.field_id = f.field_id and b.valid_from <= s.end_date and (b.valid_to is null or b.valid_to >= s.start_date)
   order by b.valid_from desc limit 1
) hist on true
cross join lateral (select coalesce(hist.farm_base_id, f.current_farm_base_id) as farm_base_id) fb
left join public.farm_base fbn on fbn.farm_base_id = fb.farm_base_id;
comment on view public.v_planting_context is 'Период с всички описателни полета; стопанската база е тази, валидна през стопанската година.';

-- ---------- Изчисления за торене (F5) ----------
create or replace view public.v_fert_plan_calc with (security_invoker = true) as
select
  l.line_id, l.organization_id, l.planting_id, l.stage_id, l.product_id,
  l.rate_per_da, l.unit, l.treated_area_da, l.source, l.is_deviation, l.period_from, l.period_to, l.assignment_id,
  p.code as product_code, p.name as product_name, p.form, x.rho,
  l.rate_per_da * l.treated_area_da as quantity_native,
  l.rate_per_da * l.treated_area_da * case when p.form = 'solid' then 1 else x.rho end as quantity_kg,
  l.rate_per_da * l.treated_area_da * case when p.form = 'solid' then 1 else x.rho end / 1000 as quantity_t,
  l.rate_per_da * x.rho * (coalesce(p.n_pct, 0) * (1)) / 100 as av_n_da,
  l.rate_per_da * x.rho * (coalesce(p.n_pct, 0) * (1)) / 100 * l.treated_area_da as av_n_total,
  l.rate_per_da * x.rho * (coalesce(p.p2o5_pct, 0) * (1)) / 100 as av_p2o5_da,
  l.rate_per_da * x.rho * (coalesce(p.p2o5_pct, 0) * (1)) / 100 * l.treated_area_da as av_p2o5_total,
  l.rate_per_da * x.rho * (coalesce(p.k2o_pct, 0) * (1)) / 100 as av_k2o_da,
  l.rate_per_da * x.rho * (coalesce(p.k2o_pct, 0) * (1)) / 100 * l.treated_area_da as av_k2o_total,
  l.rate_per_da * x.rho * (coalesce(p.ca_pct, 0) * (case p.ca_basis when 'oxide' then 0.7147 else 1 end)) / 100 as av_ca_da,
  l.rate_per_da * x.rho * (coalesce(p.ca_pct, 0) * (case p.ca_basis when 'oxide' then 0.7147 else 1 end)) / 100 * l.treated_area_da as av_ca_total,
  l.rate_per_da * x.rho * (coalesce(p.mg_pct, 0) * (case p.mg_basis when 'oxide' then 0.6030 else 1 end)) / 100 as av_mg_da,
  l.rate_per_da * x.rho * (coalesce(p.mg_pct, 0) * (case p.mg_basis when 'oxide' then 0.6030 else 1 end)) / 100 * l.treated_area_da as av_mg_total,
  l.rate_per_da * x.rho * (coalesce(p.na_pct, 0) * (1)) / 100 as av_na_da,
  l.rate_per_da * x.rho * (coalesce(p.na_pct, 0) * (1)) / 100 * l.treated_area_da as av_na_total,
  l.rate_per_da * x.rho * (coalesce(p.s_pct, 0) * (case p.s_basis when 'oxide' then 0.4005 else 1 end)) / 100 as av_s_da,
  l.rate_per_da * x.rho * (coalesce(p.s_pct, 0) * (case p.s_basis when 'oxide' then 0.4005 else 1 end)) / 100 * l.treated_area_da as av_s_total,
  l.rate_per_da * x.rho * (coalesce(p.b_pct, 0) * (1)) / 100 as av_b_da,
  l.rate_per_da * x.rho * (coalesce(p.b_pct, 0) * (1)) / 100 * l.treated_area_da as av_b_total,
  l.rate_per_da * x.rho * (coalesce(p.mo_pct, 0) * (1)) / 100 as av_mo_da,
  l.rate_per_da * x.rho * (coalesce(p.mo_pct, 0) * (1)) / 100 * l.treated_area_da as av_mo_total,
  l.rate_per_da * x.rho * (coalesce(p.zn_pct, 0) * (1)) / 100 as av_zn_da,
  l.rate_per_da * x.rho * (coalesce(p.zn_pct, 0) * (1)) / 100 * l.treated_area_da as av_zn_total,
  l.rate_per_da * x.rho * coalesce(p.n_pct, 0) / 100 * p.n_organic_share_pct / 100 as av_n_organic_da,
  l.rate_per_da * x.rho * coalesce(p.n_pct, 0) / 100 * (100 - p.n_organic_share_pct) / 100 as av_n_mineral_da
from public.fert_plan_line l
join public.fertilizer_product p on p.product_id = l.product_id
cross join lateral (select case when p.form = 'solid' then 1::numeric else p.density_kg_l end as rho) x;
comment on view public.v_fert_plan_calc is 'Количество = норма x площ; а.в. = норма x плътност x % / 100 (за твърди плътност = 1). P и K са оксиди; Ca/Mg/S се превръщат в елемент според ca_basis/mg_basis/s_basis.';

create or replace view public.v_fert_plan_period_sum with (security_invoker = true) as
select
  planting_id, organization_id,
  sum(av_n_da) as av_n_da,
  sum(av_n_total) as av_n_total,
  sum(av_p2o5_da) as av_p2o5_da,
  sum(av_p2o5_total) as av_p2o5_total,
  sum(av_k2o_da) as av_k2o_da,
  sum(av_k2o_total) as av_k2o_total,
  sum(av_ca_da) as av_ca_da,
  sum(av_ca_total) as av_ca_total,
  sum(av_mg_da) as av_mg_da,
  sum(av_mg_total) as av_mg_total,
  sum(av_na_da) as av_na_da,
  sum(av_na_total) as av_na_total,
  sum(av_s_da) as av_s_da,
  sum(av_s_total) as av_s_total,
  sum(av_b_da) as av_b_da,
  sum(av_b_total) as av_b_total,
  sum(av_mo_da) as av_mo_da,
  sum(av_mo_total) as av_mo_total,
  sum(av_zn_da) as av_zn_da,
  sum(av_zn_total) as av_zn_total,
  sum(av_n_organic_da) as av_n_organic_da,
  sum(av_n_mineral_da) as av_n_mineral_da
from public.v_fert_plan_calc
group by planting_id, organization_id;
comment on view public.v_fert_plan_period_sum is 'Сума на активните вещества по период (всички етапи), на дка и общо.';

-- ---------- F9: плосък експорт (един ред = период x етап x продукт) ----------
create or replace view public.v_fert_plan_flat with (security_invoker = true) as
select
  c.organization_id,
  c.company_name as "Фирма",
  c.farm_base_name as "Стопанска база",
  c.settlement_name as "Землище",
  c.isak_number as "БЗС",
  c.crop_name as "Култура",
  case c.role when 'main' then 'Основна' else 'Втора' end as "Основна/втора",
  (select string_agg(distinct v.name, ', ' order by v.name)
     from public.planting_seed ps join public.variety v on v.variety_id = ps.variety_id
    where ps.planting_id = c.planting_id) as "Сорт/хибрид",
  c.planted_area_da as "Площ (дка)",
  cn.name as "CNP",
  fs.name_bg as "Етап",
  case fs.method when 'soil' then 'Почвено' when 'foliar' then 'Листно' else 'Фертигация' end as "Начин на внасяне",
  k.product_name as "Продукт",
  'План' as "Източник (План/Факт)",
  case k.source when 'cnp' then 'CNP' else 'Ръчно' end as "Произход на реда",
  k.is_deviation as "Отклонение от CNP",
  round(k.rate_per_da, 2) as "Норма (kg или l/дка)",
  case k.unit when 'kg_da' then 'kg/дка' else 'l/дка' end as "Единица",
  round(k.quantity_native, 0) as "Количество (kg или l)",
  round(k.quantity_t, 3) as "Количество (t)",
  round(k.av_n_da, 2) as "N (kg/дка)",
  round(k.av_p2o5_da, 2) as "P2O5 (kg/дка)",
  round(k.av_k2o_da, 2) as "K2O (kg/дка)",
  round(k.av_s_da, 2) as "S (kg/дка)",
  round(k.av_n_total, 0) as "N общо (kg)",
  round(k.av_p2o5_total, 0) as "P2O5 общо (kg)",
  round(k.av_k2o_total, 0) as "K2O общо (kg)",
  round(k.av_s_total, 0) as "S общо (kg)",
  c.season_label as "Стопанска година",
  k.period_from as "Период от",
  k.period_to as "Период до"
from public.v_fert_plan_calc k
join public.v_planting_context c on c.planting_id = k.planting_id
join public.fertilization_stage fs on fs.stage_id = k.stage_id
left join public.cnp_assignment ca on ca.assignment_id = k.assignment_id
left join public.cnp cn on cn.cnp_id = ca.cnp_id;
comment on view public.v_fert_plan_flat is 'Стабилни български заглавия, числа като числа, без слети клетки: готов за Excel Pivot и Power BI.';

-- ---------- F8: потребност от продукти ----------
create or replace view public.v_fert_demand with (security_invoker = true) as
select
  c.organization_id, c.season_id, k.product_id, k.product_name, k.form,
  c.farm_base_id, c.farm_base_name,
  date_trunc('month', k.period_from)::date as month,
  sum(k.quantity_kg) as quantity_kg,
  sum(k.quantity_t) as quantity_t,
  sum(case when k.form = 'liquid' then k.quantity_native end) as quantity_l
from public.v_fert_plan_calc k
join public.v_planting_context c on c.planting_id = k.planting_id
group by c.organization_id, c.season_id, k.product_id, k.product_name, k.form,
         c.farm_base_id, c.farm_base_name, date_trunc('month', k.period_from);

-- ---------- F2: библиотека с CNP ----------
create or replace view public.v_cnp_library with (security_invoker = true) as
select
  c.cnp_id, c.organization_id, c.name, c.status, c.crop_id, cr.name_bg as crop_name,
  c.season_id, s.label as season_label, c.company_id, c.farm_base_id, c.target_yield_kg_da,
  (select count(*) from public.cnp_stage st where st.cnp_id = c.cnp_id) as stages_count,
  coalesce(r.n_da, 0) as n_da, coalesce(r.p2o5_da, 0) as p2o5_da, coalesce(r.k2o_da, 0) as k2o_da,
  coalesce(a.periods, 0) as assigned_periods, coalesce(a.area_da, 0) as assigned_area_da
from public.cnp c
join public.crop cr on cr.crop_id = c.crop_id
join public.season s on s.season_id = c.season_id
left join lateral (
  select sum(sp.rate_per_da * rho.v * coalesce(p.n_pct, 0) / 100)    as n_da,
         sum(sp.rate_per_da * rho.v * coalesce(p.p2o5_pct, 0) / 100) as p2o5_da,
         sum(sp.rate_per_da * rho.v * coalesce(p.k2o_pct, 0) / 100)  as k2o_da
    from public.cnp_stage st
    join public.cnp_stage_product sp on sp.cnp_stage_id = st.cnp_stage_id
    join public.fertilizer_product p on p.product_id = sp.product_id
    cross join lateral (select case when p.form = 'solid' then 1::numeric else p.density_kg_l end as v) rho
   where st.cnp_id = c.cnp_id
) r on true
left join lateral (
  select count(*) as periods, sum(fp.planted_area_da) as area_da
    from public.cnp_assignment ca join public.field_planting fp on fp.planting_id = ca.planting_id
   where ca.cnp_id = c.cnp_id and ca.is_active
) a on true;

-- ---------- Почвени анализи: последен по поле ----------
create or replace view public.v_soil_latest with (security_invoker = true) as
select distinct on (field_id) *
  from public.soil_analysis
 order by field_id, sampled_on desc;

-- ---------- Предходна култура и "преди 2 сезона" ----------
create or replace view public.v_rotation_history with (security_invoker = true) as
select
  c.planting_id, c.organization_id, c.field_id, c.season_id, c.season_label, c.crop_id, c.crop_name,
  lag(c.crop_id, 1) over w as prev_crop_id, lag(c.crop_name, 1) over w as prev_crop_name,
  lag(c.crop_id, 2) over w as prev2_crop_id, lag(c.crop_name, 2) over w as prev2_crop_name
from public.v_planting_context c
where c.role = 'main'
window w as (partition by c.field_id order by c.season_year_end);
comment on view public.v_rotation_history is 'Извежда се от историята на периодите. Веригите на делене/сливане (field_lineage) засега не се следват.';

-- ---------- Семена: изчисление на ред (F-семена) ----------
create or replace view public.v_seed_calc with (security_invoker = true) as
with base as (
  select
    ps.planting_seed_id, ps.organization_id, ps.planting_id, ps.variety_id, ps.batch_id,
    ps.area_da, ps.target_rate,
    ctx.season_id, ctx.farm_base_id, ctx.crop_id, ctx.crop_name,
    cr.seeding_method, cr.rate_basis, cr.convert_to_kg, cr.order_unit,
    coalesce(ps.overage_pct, cr.seed_overage_pct, 0) as overage_pct,
    b.tkw_g, b.germination_pct,
    coalesce(b.seeds_per_pack, cr.default_seeds_per_pack) as seeds_per_pack,
    coalesce(cr.rate_rounding_step, app.setting_num(ps.organization_id, 'seed_rate_rounding_step', 1)) as step
  from public.planting_seed ps
  join public.v_planting_context ctx on ctx.planting_id = ps.planting_id
  join public.crop cr on cr.crop_id = ctx.crop_id
  left join public.seed_batch b on b.batch_id = ps.batch_id
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

create or replace view public.v_seed_need with (security_invoker = true) as
select
  organization_id, season_id, crop_id, crop_name, variety_id, batch_id, farm_base_id, order_unit,
  sum(area_da) as area_da,
  sum(need_kg) as need_kg,
  sum(need_t) as need_t,
  ceil(sum(packs)) as packs,
  bool_or(missing_batch_data) as missing_batch_data
from public.v_seed_calc
group by organization_id, season_id, crop_id, crop_name, variety_id, batch_id, farm_base_id, order_unit;
comment on view public.v_seed_need is 'Потребност за поръчка; торбите се закръглят нагоре на ниво култура + сорт + партида + база.';

-- ---------- Диверсификация (ДЗЕС / ЕКОРОК) ----------
create or replace view public.v_diversification with (security_invoker = true) as
with base as (
  select c.organization_id, c.season_id, c.company_id, r.rule_set,
         coalesce(c.subsidy_crop_id, c.crop_id) as group_crop_id,
         sum(c.planted_area_da) as area_da
    from public.v_planting_context c
    cross join (select distinct rule_set from public.diversification_rule) r
   where c.role = 'main'
     and exists (select 1 from public.diversification_rule_crop rc
                  where rc.rule_set = r.rule_set and rc.crop_id = coalesce(c.subsidy_crop_id, c.crop_id))
   group by c.organization_id, c.season_id, c.company_id, r.rule_set, coalesce(c.subsidy_crop_id, c.crop_id)
),
ranked as (
  select b.*,
         b.area_da / sum(b.area_da) over w_all as share,
         row_number() over (partition by b.organization_id, b.season_id, b.company_id, b.rule_set
                            order by b.area_da desc, cr.name_bg) as rn
    from base b join public.crop cr on cr.crop_id = b.group_crop_id
  window w_all as (partition by b.organization_id, b.season_id, b.company_id, b.rule_set)
),
cum as (
  select ranked.*,
         sum(share) over (partition by organization_id, season_id, company_id, rule_set order by rn) as cum_share
    from ranked
),
groups as (
  select distinct organization_id, season_id, company_id, rule_set from cum
)
select
  g.organization_id, g.season_id, g.company_id, g.rule_set,
  ru.rule_id, ru.check_type, ru.n, ru.threshold_pct,
  v.value_pct,
  case ru.check_type when 'top_n_max' then v.value_pct >= ru.threshold_pct
                     else v.value_pct <= ru.threshold_pct end as is_violation,
  ru.message_bg
from groups g
join public.diversification_rule ru on ru.rule_set = g.rule_set
cross join lateral (
  select round(100 * case ru.check_type
           when 'top_n_max' then coalesce((select max(cum_share) from cum x
                                            where x.organization_id = g.organization_id and x.season_id = g.season_id
                                              and x.company_id is not distinct from g.company_id and x.rule_set = g.rule_set
                                              and x.rn <= ru.n), 0)
           else coalesce((select max(share) from cum x
                           where x.organization_id = g.organization_id and x.season_id = g.season_id
                             and x.company_id is not distinct from g.company_id and x.rule_set = g.rule_set
                             and x.rn = ru.n), 0)
         end, 2) as value_pct
) v
where (ru.valid_from_season_id is null
       or (select year_end from public.season where season_id = ru.valid_from_season_id)
          <= (select year_end from public.season where season_id = g.season_id))
  and (ru.valid_to_season_id is null
       or (select year_end from public.season where season_id = ru.valid_to_season_id)
          >= (select year_end from public.season where season_id = g.season_id));
comment on view public.v_diversification is 'Проверка на правилата по фирма и стопанска година. Нарушение: top_n_max при стойност >= праг; nth_min при стойност <= праг (както в BI на AgroVIR).';

grant select on all tables in schema public to authenticated;
revoke all on all tables in schema public from anon;
