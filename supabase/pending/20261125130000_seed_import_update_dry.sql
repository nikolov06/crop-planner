-- СУХА ПРОБА (ROLLBACK) на pending/20261125130000_seed_import_update.sql.
-- Пуска се от корена на проекта:
--   psql "$(cat supabase/.temp/pooler-url)" -f supabase/pending/20261125130000_seed_import_update_dry.sql
-- Спира при първата грешка; при успех накрая пише „ПРОБАТА Е УСПЕШНА“ и връща всичко (ROLLBACK).
\set ON_ERROR_STOP on
begin;

-- ---------- Преди миграцията ----------
create temp table _calc_before as select * from public.v_seed_calc;
create temp table _need_before as select * from public.v_seed_need;
create temp table _cols_before as
  select table_name, ordinal_position, column_name, data_type, numeric_precision, numeric_scale
    from information_schema.columns
   where table_schema = 'public' and table_name in ('v_seed_calc', 'v_seed_need');

-- ---------- Миграцията ----------
\ir 20261125130000_seed_import_update.sql

-- ---------- 1. Колоните на изгледите са същите ----------
do $$
declare d int;
begin
  select count(*) into d from (
    (select * from _cols_before except
     select table_name, ordinal_position, column_name, data_type, numeric_precision, numeric_scale
       from information_schema.columns where table_schema = 'public' and table_name in ('v_seed_calc', 'v_seed_need'))
    union all
    (select table_name, ordinal_position, column_name, data_type, numeric_precision, numeric_scale
       from information_schema.columns where table_schema = 'public' and table_name in ('v_seed_calc', 'v_seed_need')
     except select * from _cols_before)) x;
  if d > 0 then raise exception 'Колоните на v_seed_calc / v_seed_need са променени (% разлики)', d; end if;
  raise notice 'OK: колоните на v_seed_calc и v_seed_need са същите';
end $$;

-- ---------- 2. Без рапицата v_seed_calc е същият ред по ред ----------
do $$
declare d1 int; d2 int;
begin
  select count(*) into d1 from (select * from _calc_before where crop_name <> 'РАПИЦА' except select * from public.v_seed_calc where crop_name <> 'РАПИЦА') x;
  select count(*) into d2 from (select * from public.v_seed_calc where crop_name <> 'РАПИЦА' except select * from _calc_before where crop_name <> 'РАПИЦА') x;
  if d1 + d2 > 0 then raise exception 'v_seed_calc (без рапица) се различава: % / % реда', d1, d2; end if;
  raise notice 'OK: v_seed_calc без рапицата е идентичен ред по ред';
end $$;

\echo
\echo '== v_seed_need по култура: ПРЕДИ | СЛЕД =='
select b.crop_name, b.n n_before, a.n n_after, round(b.t, 3) t_before, round(a.t, 3) t_after, round(b.packs, 1) packs_before, round(a.packs, 1) packs_after
  from (select crop_name, count(*) n, sum(need_t) t, sum(packs) packs from _need_before group by 1) b
  full join (select crop_name, count(*) n, sum(need_t) t, sum(packs) packs from public.v_seed_need group by 1) a using (crop_name)
 order by 1;

-- ---------- 3. Рапица: торби без МХЗ ----------
do $$
declare r record; c record; v_spp numeric; v_exp numeric;
begin
  if round(55 / (90 / 100.0) * 1000 * 907 / 1500000, 1) <> 37.0 then raise exception 'Формулата не дава 37,0 торби'; end if;
  select ps.* into r from public.planting_seed ps join public.v_seed_calc v using (planting_seed_id)
   where v.crop_name = 'РАПИЦА' limit 1;
  if not found then raise exception 'Няма ред за рапица'; end if;
  update public.planting_seed set germination_pct = 90, target_rate = 55, tkw_g = null where planting_seed_id = r.planting_seed_id;
  select * into c from public.v_seed_calc where planting_seed_id = r.planting_seed_id;
  v_exp := 55 / 0.9 * 1000 * c.area_da / c.seeds_per_pack;
  if c.tkw_g is not null then
    raise notice 'МХЗ идва от партида/сорт (%), проверката без МХЗ е по формулата', c.tkw_g;
  end if;
  if c.missing_batch_data or c.packs_base is null or abs(c.packs_base - v_exp) > 1e-6 then
    raise exception 'Рапица %: дка %, торби без преразход % (очаквано %), липсващи данни %', r.planting_seed_id, c.area_da, c.packs_base, v_exp, c.missing_batch_data;
  end if;
  if abs(c.packs - v_exp * (1 + c.overage_pct / 100)) > 1e-6 then raise exception 'Рапица: торбите с преразход са грешни'; end if;
  raise notice 'OK: рапица 55 к.с./м², 90 %%, % дка → % торби без преразход (без МХЗ); 907 дка → 37,0', c.area_da, round(c.packs_base, 1);
end $$;

-- ---------- 4. Повторен импорт: UPDATE, запазва качеството ----------
-- Вход като администратор на организацията (RLS важи – role authenticated).
select u.user_id as admin_uid, ps.planting_seed_id as ps_id, ps.planting_id as pl_id, ps.variety_id as var_id
  from public.planting_seed ps
  join public.v_seed_calc v using (planting_seed_id)
  join public.app_user_role u on u.organization_id = ps.organization_id and u.role = 'admin'
 where v.order_unit = 'kg'
   and v.season_id = (select season_id from public.season where is_current)
   and (select count(*) from public.planting_seed x where x.planting_id = ps.planting_id) = 1
   and exists (select 1 from public.seed_batch b where b.variety_id = ps.variety_id)
   and exists (select 1 from public.variety v2 where v2.crop_id = v.crop_id and v2.variety_id <> ps.variety_id)
 order by ps.planting_seed_id limit 1 \gset

-- подготовка (като postgres): качество по БЗС, ръчна норма, партида, произход
update public.planting_seed
   set tkw_g = 41.7, germination_pct = 93, rate_kg_da_manual = 21.5, overage_pct = 4,
       seed_origin = coalesce(seed_origin, 'Б/проба'),
       batch_id = (select batch_id from public.seed_batch b where b.variety_id = :'var_id'::uuid order by batch_id limit 1)
 where planting_seed_id = :'ps_id'::uuid;
create temp table _before_ps as select * from public.planting_seed where planting_seed_id = :'ps_id'::uuid;
select set_config('request.jwt.claims', json_build_object('sub', :'admin_uid', 'role', 'authenticated')::text, true);
\echo 'Импортът и отмяната се пускат като authenticated (RLS), проверките – като postgres.'

-- 4а. същият сорт, нова норма
set local role authenticated;
select public.apply_seed_import(
  (select season_id from public.season where is_current), '{}'::jsonb, 'проба_1.xlsx', 1, true,
  jsonb_build_array(jsonb_build_object('planting_id', :'pl_id', 'variety_id', :'var_id', 'target_rate', 444, 'addon', '', 'source_name', 'проба'))
) as import1 \gset
reset role;

do $$
declare n int; s record; b record;
begin
  select * into b from _before_ps;
  select count(*) into n from public.planting_seed where planting_id = b.planting_id;
  select * into s from public.planting_seed where planting_id = b.planting_id;
  if n <> 1 or s.planting_seed_id <> b.planting_seed_id then raise exception 'Редът е пресъздаден (нов id) или са станали % реда', n; end if;
  if s.target_rate <> 444 then raise exception 'Нормата не е обновена: %', s.target_rate; end if;
  if s.tkw_g is distinct from b.tkw_g or s.germination_pct is distinct from b.germination_pct or s.rate_kg_da_manual is distinct from b.rate_kg_da_manual then
    raise exception 'Загубени са МХЗ / кълняемост / ръчна норма: % / % / %', s.tkw_g, s.germination_pct, s.rate_kg_da_manual;
  end if;
  if s.batch_id is distinct from b.batch_id or s.seed_origin is distinct from b.seed_origin or s.overage_pct is distinct from b.overage_pct then
    raise exception 'При същия сорт са загубени партида / произход / преразход';
  end if;
  raise notice 'OK: повторен импорт със същия сорт – същият ред, нормата е 444, МХЗ 41,7, кълняемост 93, ръчна 21,5, партидата остава';
end $$;

-- 4б. отмяна → всичко както преди
set local role authenticated;
select public.undo_seed_import(:'import1'::uuid) as undone1;
reset role;
do $$
declare s record; b record;
begin
  select * into b from _before_ps;
  select * into s from public.planting_seed where planting_id = b.planting_id;
  if s.planting_seed_id <> b.planting_seed_id or s.target_rate <> b.target_rate or s.tkw_g is distinct from b.tkw_g
     or s.batch_id is distinct from b.batch_id or s.rate_kg_da_manual is distinct from b.rate_kg_da_manual then
    raise exception 'Отмяната не върна реда както беше';
  end if;
  raise notice 'OK: отмяната връща предишния ред (норма %)', s.target_rate;
end $$;

-- 4в. друг сорт → партидата се маха, качеството и ръчната норма остават
set local role authenticated;
select public.apply_seed_import(
  (select season_id from public.season where is_current), '{}'::jsonb, 'проба_2.xlsx', 1, true,
  jsonb_build_array(jsonb_build_object('planting_id', :'pl_id',
    'variety_id', (select v2.variety_id from public.variety v2 join public.variety v1 on v1.crop_id = v2.crop_id
                    where v1.variety_id = :'var_id'::uuid and v2.variety_id <> v1.variety_id order by v2.name limit 1),
    'target_rate', 450, 'addon', 'Артемид', 'source_name', 'проба'))
) as import2 \gset
reset role;

do $$
declare s record; b record;
begin
  select * into b from _before_ps;
  select * into s from public.planting_seed where planting_id = b.planting_id;
  if s.planting_seed_id <> b.planting_seed_id then raise exception 'Редът е пресъздаден при смяна на сорта'; end if;
  if s.variety_id = b.variety_id then raise exception 'Сортът не е сменен'; end if;
  if s.batch_id is not null then raise exception 'Партидата не е махната при смяна на сорта'; end if;
  if s.tkw_g is distinct from b.tkw_g or s.germination_pct is distinct from b.germination_pct or s.rate_kg_da_manual is distinct from b.rate_kg_da_manual then
    raise exception 'При смяна на сорта са загубени МХЗ / кълняемост / ръчна норма';
  end if;
  if s.addon is distinct from 'Артемид' then raise exception 'Добавката не е записана'; end if;
  raise notice 'OK: смяна на сорта – същият ред, партидата е махната, МХЗ / кълняемост / ръчна норма остават';
end $$;

-- 4г. редакция след импорта → отмяната се спира
-- В една транзакция now() не се мени, затова тук updated_at се мести ръчно (само в пробата, с изключен тригер).
alter table public.planting_seed disable trigger planting_seed_touch;
update public.planting_seed set note = 'ръчна промяна', updated_at = updated_at + interval '1 minute' where planting_id = :'pl_id'::uuid;
alter table public.planting_seed enable trigger planting_seed_touch;
select set_config('proba.import2', :'import2', true);
set local role authenticated;
do $$
begin
  begin
    perform public.undo_seed_import(current_setting('proba.import2')::uuid);
    raise exception 'отмяната мина след ръчна промяна';
  exception when raise_exception then
    if sqlerrm not like '%променяни след импорта%' then raise; end if;
  end;
  raise notice 'OK: след ръчна промяна отмяната се спира';
end $$;
reset role;

-- 4д. БЗС без семена → нов ред (както досега)
select ps.planting_id as pl2, ps.variety_id as var2 from public.planting_seed ps
 join public.v_seed_calc v using (planting_seed_id)
 where v.season_id = (select season_id from public.season where is_current) and ps.organization_id = (select organization_id from public.planting_seed where planting_id = :'pl_id'::uuid)
   and ps.planting_id <> :'pl_id'::uuid
   and (select count(*) from public.planting_seed x where x.planting_id = ps.planting_id) = 1
 order by ps.planting_seed_id limit 1 \gset
delete from public.planting_seed where planting_id = :'pl2'::uuid;
set local role authenticated;
select public.apply_seed_import(
  (select season_id from public.season where is_current), '{}'::jsonb, 'проба_3.xlsx', 1, false,
  jsonb_build_array(jsonb_build_object('planting_id', :'pl2', 'variety_id', :'var2', 'target_rate', 500, 'source_name', 'проба'))
) as import3 \gset
reset role;
select set_config('proba.import3', :'import3', true);
do $$
declare n int;
begin
  select count(*) into n from public.planting_seed s join public.seed_import_item i on i.new_seed_id = s.planting_seed_id
   where i.import_id = current_setting('proba.import3')::uuid and s.updated_at = i.new_updated_at;
  if n <> 1 then raise exception 'Новият ред за БЗС без семена не е записан (%)', n; end if;
  raise notice 'OK: БЗС без семена получава нов ред';
end $$;

\echo
\echo 'ПРОБАТА Е УСПЕШНА – връщам всичко (ROLLBACK)'
rollback;
