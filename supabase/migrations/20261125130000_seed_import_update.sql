-- Импорт на сортове: повторният импорт обновява реда в planting_seed, вместо да го трие и създава наново.
-- Запазват се МХЗ, кълняемостта, ръчната норма, преразходът, произходът и бележката.
-- Партидата се маха само при смяна на сорта.
-- Рапица във v_seed_calc: торбите без МХЗ и без закръгляне нагоре на семената (както в приложението).
-- Изисква 20261124120000_seed_import и 20261125120000_seed_quality_offers.

-- =====================================================================
-- 1. Отмяна: помни се updated_at на реда след импорта (при UPDATE вече не е равен на created_at)
-- =====================================================================
alter table public.seed_import_item add column if not exists new_updated_at timestamptz;
comment on column public.seed_import_item.new_updated_at is 'updated_at на реда в planting_seed веднага след импорта – по него отмяната разпознава, че редът не е променян след това. Празно за импортите преди 25.11.2026 (тогава се проверява updated_at = created_at).';

-- =====================================================================
-- 2. Запис на импорта (всичко или нищо)
-- =====================================================================
-- security invoker: записът в planting_seed минава през текущите RLS правила.
-- p_items: [{planting_id, variety_id, target_rate, addon, source_name}]
-- p_aliases: [{alias_normalized, alias_raw, variety_id}], p_rates: [{variety_id, rate}]
-- Ако БЗС вече има ред: обновява се редът със същия сорт (иначе най-старият), останалите се трият.
create or replace function public.apply_seed_import(
  p_season_id smallint, p_scope jsonb, p_file_name text, p_rows_in_file integer, p_overwrite boolean,
  p_items jsonb, p_aliases jsonb default '[]'::jsonb, p_rates jsonb default '[]'::jsonb
) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  v_import  uuid;
  v_org     uuid;
  v_orgs    integer;
  it        jsonb;
  v_pl      record;
  v_var     record;
  v_prev    jsonb;
  v_keep    uuid;
  v_keepvar uuid;
  v_new     uuid;
  v_upd     timestamptz;
  v_n       integer := 0;
begin
  if auth.uid() is null then raise exception 'Нужен е вход в системата'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Няма редове за запис'; end if;

  if (select count(*) from jsonb_array_elements(p_items) e) <>
     (select count(distinct e->>'planting_id') from jsonb_array_elements(p_items) e) then
    raise exception 'Едно и също БЗС се среща повече от веднъж в импорта';
  end if;

  select count(distinct p.organization_id), min(p.organization_id::text)::uuid into v_orgs, v_org
    from jsonb_array_elements(p_items) e
    join public.field_planting p on p.planting_id = (e->>'planting_id')::uuid;
  if v_orgs <> 1 then raise exception 'Импортът трябва да е в рамките на една организация'; end if;

  -- норми само за сортове, които са в самия импорт
  if exists (select 1 from jsonb_array_elements(coalesce(p_rates, '[]'::jsonb)) r
              where not exists (select 1 from jsonb_array_elements(p_items) e where e->>'variety_id' = r->>'variety_id')) then
    raise exception 'Норма за хибрид, който не е в импорта';
  end if;
  perform app.set_variety_default_rates(v_org, p_rates);

  -- псевдоними: през RLS на variety_alias (всеки с право за редакция)
  insert into public.variety_alias (crop_id, alias_normalized, alias_raw, variety_id)
  select v.crop_id, a->>'alias_normalized', a->>'alias_raw', v.variety_id
    from jsonb_array_elements(coalesce(p_aliases, '[]'::jsonb)) a
    join public.variety v on v.variety_id = (a->>'variety_id')::uuid
  on conflict (crop_id, alias_normalized)
    do update set variety_id = excluded.variety_id, alias_raw = excluded.alias_raw, created_by = auth.uid(), created_at = now();

  insert into public.seed_import (organization_id, season_id, scope, file_name, rows_in_file, overwrite)
  values (v_org, p_season_id, coalesce(p_scope, '{}'::jsonb), p_file_name, coalesce(p_rows_in_file, 0), coalesce(p_overwrite, false))
  returning import_id into v_import;

  for it in select * from jsonb_array_elements(p_items) loop
    select p.planting_id, p.organization_id, p.crop_id, p.role, p.planted_area_da, y.season_id, y.field_name
      into v_pl
      from public.field_planting p join public.field_crop_year y on y.fcy_id = p.fcy_id
     where p.planting_id = (it->>'planting_id')::uuid
     for update of p;
    if not found then raise exception 'БЗС (%) не е намерено или няма достъп', it->>'source_name'; end if;
    if v_pl.season_id <> p_season_id then raise exception '„%“ не е от избрания сезон', v_pl.field_name; end if;
    if v_pl.role <> 'main' then raise exception '„%“: импортът е само за основната култура', v_pl.field_name; end if;
    if coalesce(v_pl.planted_area_da, 0) <= 0 then raise exception '„%“ няма засята площ', v_pl.field_name; end if;

    select v.variety_id, v.crop_id, v.name into v_var from public.variety v where v.variety_id = (it->>'variety_id')::uuid;
    if not found then raise exception '„%“: сортът не е намерен', v_pl.field_name; end if;
    if v_var.crop_id <> v_pl.crop_id then raise exception '„%“: сортът „%“ е от друга култура', v_pl.field_name, v_var.name; end if;
    if coalesce((it->>'target_rate')::numeric, 0) <= 0 then raise exception '„%“: липсва норма', v_pl.field_name; end if;

    select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at), '[]'::jsonb) into v_prev
      from public.planting_seed s where s.planting_id = v_pl.planting_id;
    if jsonb_array_length(v_prev) > 0 and not coalesce(p_overwrite, false) then
      raise exception '„%“ вече има назначен сорт (не е отметнато „Презапиши вече назначените“)', v_pl.field_name;
    end if;

    -- кой ред остава: със същия сорт, иначе най-старият
    v_keep := null; v_keepvar := null;
    select s.planting_seed_id, s.variety_id into v_keep, v_keepvar
      from public.planting_seed s
     where s.planting_id = v_pl.planting_id
     order by (s.variety_id = v_var.variety_id) desc, s.created_at, s.planting_seed_id
     limit 1;

    if v_keep is null then
      insert into public.planting_seed (organization_id, planting_id, variety_id, area_da, target_rate, addon)
      values (v_pl.organization_id, v_pl.planting_id, v_var.variety_id, v_pl.planted_area_da,
              (it->>'target_rate')::numeric, nullif(trim(it->>'addon'), ''))
      returning planting_seed_id, updated_at into v_new, v_upd;
    else
      -- първо останалите редове (сумата на площите не бива да надхвърля засятата)
      delete from public.planting_seed where planting_id = v_pl.planting_id and planting_seed_id <> v_keep;
      update public.planting_seed
         set variety_id  = v_var.variety_id,
             batch_id    = case when v_keepvar = v_var.variety_id then batch_id end,
             area_da     = v_pl.planted_area_da,
             target_rate = (it->>'target_rate')::numeric,
             addon       = nullif(trim(it->>'addon'), '')
       where planting_seed_id = v_keep
      returning planting_seed_id, updated_at into v_new, v_upd;
    end if;

    insert into public.seed_import_item (import_id, organization_id, planting_id, source_name, variety_id, target_rate, addon, new_seed_id, new_updated_at, prev_rows)
    values (v_import, v_pl.organization_id, v_pl.planting_id, it->>'source_name', v_var.variety_id,
            (it->>'target_rate')::numeric, nullif(trim(it->>'addon'), ''), v_new, v_upd, v_prev);
    v_n := v_n + 1;
  end loop;

  update public.seed_import set rows_applied = v_n where import_id = v_import;
  return v_import;
end $$;
revoke all on function public.apply_seed_import(smallint, jsonb, text, integer, boolean, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.apply_seed_import(smallint, jsonb, text, integer, boolean, jsonb, jsonb, jsonb) to authenticated;

-- =====================================================================
-- 3. Отмяна на последния импорт
-- =====================================================================
-- Отменя се само последният неотменен импорт за организацията и сезона, и само ако
-- записаното от него не е променяно след това. Предишните редове се връщат такива, каквито бяха.
create or replace function public.undo_seed_import(p_import_id uuid) returns integer
language plpgsql security invoker set search_path = '' as $$
declare
  v_imp  record;
  it     record;
  v_n    integer := 0;
begin
  if auth.uid() is null then raise exception 'Нужен е вход в системата'; end if;
  select * into v_imp from public.seed_import where import_id = p_import_id for update;
  if not found then raise exception 'Импортът не е намерен'; end if;
  if v_imp.undone_at is not null then raise exception 'Импортът вече е отменен'; end if;
  if exists (select 1 from public.seed_import i
              where i.organization_id = v_imp.organization_id and i.season_id = v_imp.season_id
                and i.undone_at is null and i.created_at > v_imp.created_at) then
    raise exception 'Може да се отмени само последният импорт за сезона';
  end if;

  for it in select * from public.seed_import_item where import_id = p_import_id loop
    if (select count(*) from public.planting_seed s where s.planting_id = it.planting_id) <> 1
       or not exists (select 1 from public.planting_seed s
                       where s.planting_seed_id = it.new_seed_id
                         and (case when it.new_updated_at is null then s.updated_at = s.created_at
                                   else s.updated_at = it.new_updated_at end)) then
      raise exception 'Семената за „%“ са променяни след импорта – отмяната е спряна', coalesce(it.source_name, it.planting_id::text);
    end if;
    delete from public.planting_seed where planting_id = it.planting_id;
    insert into public.planting_seed
    select * from jsonb_populate_recordset(null::public.planting_seed, it.prev_rows);
    v_n := v_n + 1;
  end loop;

  update public.seed_import set undone_at = now(), undone_by = auth.uid() where import_id = p_import_id;
  return v_n;
end $$;
revoke all on function public.undo_seed_import(uuid) from public, anon;
grant execute on function public.undo_seed_import(uuid) to authenticated;

-- =====================================================================
-- 4. v_seed_calc: рапица – торби без МХЗ (същите колони в същия ред)
--    сем./дка = кълняеми/м² ÷ кълняемост × 1000;  торби = сем./дка × дка ÷ семена в торба
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
         then ceil(target_rate / (germination_pct / 100.0)) end as total_seeds_m2,
    -- рапица (слята, поръчка в торби): семената без закръгляне нагоре; МХЗ не е нужна за торбите
    case when seeding_method = 'solid' and order_unit = 'packs' and germination_pct is not null
         then target_rate / (germination_pct / 100.0) end as seeds_m2_exact
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
    when 'packs' then seeds_per_pack is null or (seeding_method = 'solid' and seeds_m2_exact is null)
  end, false) as missing_batch_data,
  case when order_unit = 'kg' and rate_kg_da is not null then rate_kg_da * area_da * (1 + overage_pct / 100) end as need_kg,
  case when order_unit = 'kg' and rate_kg_da is not null then rate_kg_da * area_da * (1 + overage_pct / 100) / 1000 end as need_t,
  case seeding_method
    when 'solid' then coalesce(seeds_m2_exact, total_seeds_m2) * 1000 * area_da * (1 + overage_pct / 100)
    when 'row'   then target_rate * area_da * (1 + overage_pct / 100)
  end as seeds_total,
  case when order_unit = 'packs' and seeds_per_pack is not null then
    (case seeding_method
       when 'solid' then seeds_m2_exact * 1000 * area_da
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
       when 'solid' then seeds_m2_exact * 1000 * area_da
       when 'row'   then target_rate * area_da
     end) / seeds_per_pack
  end as packs_base,
  case when order_unit = 'packs' and seeds_m2_exact is not null and tkw_g is not null then round(seeds_m2_exact * tkw_g / 1000, 2) end as rate_kg_da_info
from calc4;
comment on view public.v_seed_calc is 'Качество: БЗС → партида → сорт. Слети: брой семена/м² = CEILING(кълняеми / кълняемост); кг/дка = ROUND(брой × МХЗ / 1000) или ръчната. need_t/packs са С преразход (за заявка); need_t_base/packs_base – без. Редови: торби = сем./дка × дка / семена в торба. Рапица: сем./дка = кълняеми / кълняемост × 1000 (без закръгляне), торби = сем./дка × дка / семена в торба – нужна е само кълняемостта; кг/дка само информативно (rate_kg_da_info, иска МХЗ).';
