-- СУХА ПРОБА (ROLLBACK) на 20261125120000_seed_quality_offers.sql.
-- Пуска се от корена на проекта:
--   psql "$(cat supabase/.temp/pooler-url)" -f supabase/pending/20261125120000_seed_quality_offers_dry.sql
-- Спира при първата грешка; при успех накрая пише „ПРОБАТА Е УСПЕШНА“ и връща всичко (ROLLBACK).
\set ON_ERROR_STOP on
begin;

-- ---------- Преди миграцията ----------
create temp table _need_before as select * from public.v_seed_need;
create temp table _calc_before as
  select planting_seed_id, rate_kg_da, need_kg, need_t, packs, seeds_total, missing_batch_data from public.v_seed_calc;
create temp table _cols_before as
  select table_name, ordinal_position, column_name, data_type, numeric_precision, numeric_scale
    from information_schema.columns
   where table_schema = 'public' and table_name in ('v_seed_calc', 'v_seed_need', 'v_product_price_effective');

-- ---------- Миграцията ----------
\ir 20261125120000_seed_quality_offers.sql

-- ---------- 1. v_seed_need е същият като преди (Сеитбооборот не се променя) ----------
\echo
\echo '== v_seed_need по култура: ПРЕДИ | СЛЕД =='
select b.crop_name,
       b.n  as n_before,  a.n  as n_after,
       b.dka as dka_before, a.dka as dka_after,
       round(b.t, 3) as t_before, round(a.t, 3) as t_after,
       b.packs as packs_before, a.packs as packs_after
  from (select crop_name, count(*) n, sum(area_da) dka, sum(need_t) t, sum(packs) packs from _need_before group by 1) b
  full join (select crop_name, count(*) n, sum(area_da) dka, sum(need_t) t, sum(packs) packs from public.v_seed_need group by 1) a using (crop_name)
 order by 1;

do $$
declare d1 int; d2 int;
begin
  select count(*) into d1 from (select * from _need_before except select * from public.v_seed_need) x;
  select count(*) into d2 from (select * from public.v_seed_need except select * from _need_before) x;
  if d1 + d2 > 0 then raise exception 'v_seed_need се различава: % реда изчезнали, % нови/променени', d1, d2; end if;
  raise notice 'OK: v_seed_need е идентичен ред по ред';
end $$;

-- ---------- 2. v_seed_calc: старите колони са същите за всеки ред ----------
do $$
declare d int;
begin
  select count(*) into d from (
    select * from _calc_before
    except
    select planting_seed_id, rate_kg_da, need_kg, need_t, packs, seeds_total, missing_batch_data from public.v_seed_calc) x;
  if d > 0 then raise exception 'v_seed_calc: % реда със сменени стойности', d; end if;
  raise notice 'OK: v_seed_calc – кг/дка, количества и „липсват данни“ са непроменени за всички редове';
end $$;

-- ---------- 3. Колоните на изгледите: старите са на място, със същите типове ----------
do $$
declare d int;
begin
  select count(*) into d from (
    select * from _cols_before
    except
    select table_name, ordinal_position, column_name, data_type, numeric_precision, numeric_scale
      from information_schema.columns
     where table_schema = 'public' and table_name in ('v_seed_calc', 'v_seed_need', 'v_product_price_effective')) x;
  if d > 0 then raise exception 'Сменени колони в изгледите: %', d; end if;
  raise notice 'OK: колоните на изгледите са запазени (новите са добавени накрая)';
end $$;

-- ---------- 4. Нужда / С преразход по култура (нови колони) ----------
\echo
\echo '== Нужда / С преразход по култура (текущ сезон) =='
select crop_name, count(*) n,
       round(sum(need_t_base), 2) t_need, round(sum(need_t), 2) t_with_ov,
       round(sum(packs_base), 1) packs_need, round(sum(packs), 1) packs_with_ov,
       count(*) filter (where missing_batch_data) missing
  from public.v_seed_calc where season_id = (select season_id from public.season where is_current)
 group by 1 order by 1;

-- ---------- 5. Оферти за семена: избраната е една за сорт и не засяга други сортове ----------
do $$
declare
  v_org uuid; v_season smallint; v_sup uuid; v_off uuid; v1 uuid; v2 uuid; l1 uuid; l2 uuid; l3 uuid; n int;
begin
  select organization_id into v_org from public.organization limit 1;
  select season_id into v_season from public.season where is_current;
  select count(*) into n from public.supplier where is_own_production;
  if n <> (select count(*) from public.organization) then raise exception '„Собствено производство“: % вместо по 1 за организация', n; end if;

  select v.variety_id into v1 from public.variety v join public.crop c using (crop_id) where c.name_bg = 'СЛЪНЧОГЛЕД' order by v.name limit 1;
  select v.variety_id into v2 from public.variety v join public.crop c using (crop_id) where c.name_bg = 'СЛЪНЧОГЛЕД' order by v.name offset 1 limit 1;
  insert into public.supplier (organization_id, name) values (v_org, '__проба доставчик__') returning supplier_id into v_sup;
  insert into public.offer (organization_id, season_id, module, supplier_id) values (v_org, v_season, 'seed', v_sup) returning offer_id into v_off;
  insert into public.offer_line (offer_id, variety_id, price, price_unit, is_preferred, min_qty) values (v_off, v1, 165, 'pack', true, 50) returning offer_line_id into l1;
  insert into public.offer_line (offer_id, variety_id, price, price_unit, is_preferred) values (v_off, v2, 182, 'pack', true) returning offer_line_id into l2;
  -- втора оферта за v1 от собствено производство, отбелязана като избрана → снема избора от l1, не пипа l2
  insert into public.offer (organization_id, season_id, module, supplier_id)
    select v_org, v_season, 'seed', supplier_id from public.supplier where organization_id = v_org and is_own_production returning offer_id into v_off;
  insert into public.offer_line (offer_id, variety_id, price, price_unit, is_preferred) values (v_off, v1, 0.32, 'kg', true) returning offer_line_id into l3;
  if (select is_preferred from public.offer_line where offer_line_id = l1) then raise exception 'l1 трябваше да загуби „избрана“'; end if;
  if not (select is_preferred from public.offer_line where offer_line_id = l2) then raise exception 'l2 (друг сорт) загуби „избрана“'; end if;
  select count(*) into n from public.v_seed_price_selected where variety_id in (v1, v2);
  if n <> 2 then raise exception 'v_seed_price_selected: % реда вместо 2', n; end if;
  select count(*) into n from public.v_product_price_effective where variety_id in (v1, v2);
  if n <> 2 then raise exception 'v_product_price_effective слива сортовете: % реда вместо 2', n; end if;

  -- забранени комбинации
  begin
    insert into public.offer_line (offer_id, variety_id, price, price_unit) values (v_off, v2, 1, 'l');
    raise exception 'мерна единица „l“ за семена беше приета';
  exception when check_violation then null; end;
  begin
    insert into public.offer_line (offer_id, fertilizer_product_id, price, price_unit)
      select v_off, product_id, 1, 't' from public.fertilizer_product limit 1;
    raise exception 'тор в оферта за семена беше приет';
  exception when raise_exception then
    if sqlerrm not like 'Оферта за семена%' then raise; end if;
  end;
  raise notice 'OK: оферти за семена – избрана по сорт, изгледите по сорт, забранените комбинации се отказват';
end $$;

-- ---------- 6. Качество по БЗС и ръчна норма ----------
do $$
declare r record; c record;
begin
  select ps.* into r from public.planting_seed ps join public.v_seed_calc v using (planting_seed_id)
   where v.order_unit = 'kg' and v.rate_kg_da is not null limit 1;
  update public.planting_seed set tkw_g = 42.5, germination_pct = 95, target_rate = 500 where planting_seed_id = r.planting_seed_id;
  select * into c from public.v_seed_calc where planting_seed_id = r.planting_seed_id;
  if c.total_seeds_m2 <> 527 or c.rate_kg_da <> 22 or c.tkw_source <> 'bzs' then
    raise exception 'Тестов ред 42,5 / 95 / 500: % сем./м², % кг/дка (очаквано 527 / 22)', c.total_seeds_m2, c.rate_kg_da;
  end if;
  update public.planting_seed set rate_kg_da_manual = 18.3 where planting_seed_id = r.planting_seed_id;
  select * into c from public.v_seed_calc where planting_seed_id = r.planting_seed_id;
  if c.rate_kg_da <> 18.3 or not c.rate_is_manual or c.rate_kg_da_calc <> 22 then raise exception 'Ръчната норма не се прилага'; end if;
  raise notice 'OK: качество по БЗС (527 сем./м², 22 кг/дка) и ръчна норма 18,3';
end $$;

\echo
\echo 'ПРОБАТА Е УСПЕШНА – връщам всичко (ROLLBACK)'
rollback;
