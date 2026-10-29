\set ON_ERROR_STOP 1
\set QUIET 1
\pset format unaligned
\pset tuples_only on

-- ---------- настройка като суперпотребител ----------
insert into auth.users values
 ('aaaaaaaa-0000-0000-0000-000000000001'),  -- A администратор
 ('aaaaaaaa-0000-0000-0000-000000000002'),  -- B чужд (без роля)
 ('aaaaaaaa-0000-0000-0000-000000000003'),  -- C viewer
 ('aaaaaaaa-0000-0000-0000-000000000004');  -- D агроном само за база F1
insert into public.season (year_end, start_date, end_date, is_current) values
 (2026,'2025-08-01','2026-07-31',false), (2027,'2026-08-01','2027-07-31',true), (2028,'2027-08-01','2028-07-31',false);

set role authenticated;
select set_config('request.jwt.claim.sub','aaaaaaaa-0000-0000-0000-000000000001', false);
select public.create_organization('Kristera Agro') as org \gset

insert into public.company (organization_id, name) values (:'org', 'БД АГРИ ЕООД') returning company_id as co \gset
insert into public.farm_base (organization_id, name) values (:'org', 'Дермен') returning farm_base_id as f1 \gset
insert into public.farm_base (organization_id, name) values (:'org', 'Провадия') returning farm_base_id as f2 \gset

insert into public.app_user_role (user_id, organization_id, role) values ('aaaaaaaa-0000-0000-0000-000000000003', :'org', 'viewer');
insert into public.app_user_role (user_id, organization_id, farm_base_id, role) values ('aaaaaaaa-0000-0000-0000-000000000004', :'org', :'f1', 'agronomist');

-- продукти (контролните от заданието)
insert into public.fertilizer_product (code, name, category, form, density_kg_l, n_pct, p2o5_pct) values ('T-DAP','DAP 18-46','mineral','solid',null,18,46);
insert into public.fertilizer_product (code, name, category, form, density_kg_l, n_pct) values ('T-UAN','УАН 32%','mineral','liquid',1.32,32);
insert into public.fertilizer_product (code, name, category, form, density_kg_l, n_pct) values ('T-AN','АН 34%','mineral','solid',null,34);

-- допустими продукти по етап
insert into public.stage_product (organization_id, stage_id, product_id, unit)
select :'org', s.stage_id, p.product_id, case p.form when 'solid' then 'kg_da' else 'l_da' end
  from (values ('Предсеитбено','T-DAP'),('Основно','T-UAN'),('Вегетационно 1','T-AN'),('Коригиращо','T-AN')) v(st,pc)
  join public.fertilization_stage s on s.name_bg = v.st join public.fertilizer_product p on p.code = v.pc;

-- полета: f1 (пшеница 173, база F1), f2 (пшеница 91, база F2), f3 (рапица 907, F1), f4 (царевица 100, F1)
create temp table ids (k text primary key, id uuid);
select set_config('t.co', :'co', false) as _u \gset
select set_config('t.f1', :'f1', false) as _u \gset
select set_config('t.f2', :'f2', false) as _u \gset
select set_config('t.org', :'org', false) as _u \gset
do $$
declare v_org uuid := current_setting('t.org'); v_co uuid := current_setting('t.co'); r record; v_f uuid; v_y uuid; v_p uuid;
begin
  for r in select * from (values ('w1','ПШЕНИЦА',173::numeric,current_setting('t.f1')::uuid),('w2','ПШЕНИЦА',91,current_setting('t.f2')::uuid),('r1','РАПИЦА',907,current_setting('t.f1')::uuid),('m1','ЦАРЕВИЦА',100,current_setting('t.f1')::uuid)) t(k,crop,area,fb) loop
    insert into public.field (organization_id) values (v_org) returning field_id into v_f;
    insert into public.field_base (field_id, farm_base_id, valid_from) values (v_f, r.fb, '2020-01-01');
    insert into public.field_crop_year (field_id, season_id, company_id, isak_number, field_name)
      values (v_f, (select season_id from public.season where year_end = 2027), v_co, 'БЗС-'||r.k, 'Поле '||r.k) returning fcy_id into v_y;
    insert into public.field_planting (fcy_id, crop_id, planted_area_da)
      values (v_y, (select crop_id from public.crop where name_bg = r.crop), r.area) returning planting_id into v_p;
    insert into ids values (r.k, v_p), (r.k||'_field', v_f);
  end loop;
end $$;
select id as w1 from ids where k = 'w1' \gset
select id as w2 from ids where k = 'w2' \gset
select id as r1 from ids where k = 'r1' \gset
select id as m1 from ids where k = 'm1' \gset

select set_config('t.f1', :'f1', false) as _u \gset
do $$ begin
  assert (select current_farm_base_id from public.field where field_id = (select id from ids where k='w1_field')) = current_setting('t.f1')::uuid, 'current_farm_base_id не се синхронизира';
end $$;

-- CNP за пшеница 2027
insert into public.cnp (organization_id, name, crop_id, season_id, status)
 values (:'org','Пшеница 2027 стандарт',(select crop_id from public.crop where name_bg='ПШЕНИЦА'),(select season_id from public.season where year_end=2027),'active')
 returning cnp_id as cnp \gset
insert into public.cnp_stage (cnp_id, stage_id, seq_no, period_from, period_to)
select :'cnp', s.stage_id, v.seq, v.pf::date, v.pt::date
  from (values ('Предсеитбено',1,'2026-10-01','2026-10-31'),('Основно',2,'2027-02-15','2027-03-15'),('Вегетационно 1',3,'2027-03-20','2027-04-10'),('Коригиращо',4,'2027-04-15','2027-05-10')) v(st,seq,pf,pt)
  join public.fertilization_stage s on s.name_bg = v.st;
insert into public.cnp_stage_product (cnp_stage_id, product_id, rate_per_da, unit)
select cs.cnp_stage_id, p.product_id, v.rate, case p.form when 'solid' then 'kg_da' else 'l_da' end
  from (values ('Предсеитбено','T-DAP',8),('Основно','T-UAN',18.3),('Вегетационно 1','T-AN',9),('Коригиращо','T-AN',5)) v(st,pc,rate)
  join public.fertilization_stage s on s.name_bg = v.st
  join public.cnp_stage cs on cs.stage_id = s.stage_id and cs.cnp_id = :'cnp'
  join public.fertilizer_product p on p.code = v.pc;

-- ---------- Т1: масово задаване и контролни числа ----------
select count(*) as assigned from public.assign_cnp(array[:'w1'::uuid], :'cnp'::uuid) \gset
select set_config('t.w1', :'w1', false) as _u \gset
do $$
declare n numeric; p numeric; qt numeric;
begin
  select round(av_n_da,2), round(av_p2o5_da,2) into n, p from public.v_fert_plan_period_sum where planting_id = current_setting('t.w1')::uuid;
  assert n = 13.93, format('N очаквано 13.93, получено %s', n);
  assert p = 3.68, format('P2O5 очаквано 3.68, получено %s', p);
  select round(quantity_t,3) into qt from public.v_fert_plan_calc c join public.fertilizer_product pr using (product_id) where c.planting_id = current_setting('t.w1')::uuid and pr.code='T-UAN';
  assert qt = 4.179, format('УАН t очаквано 4.179, получено %s', qt);
  assert (select count(*) from public.fert_plan_line where planting_id = current_setting('t.w1')::uuid and source='cnp') = 4, 'очаквани 4 реда';
  raise notice 'T1 OK: N=% P2O5=% УАН=% t', n, p, qt;
end $$;

-- ---------- Т2: отклонение, sync, revert ----------
update public.fert_plan_line l set rate_per_da = 10
 from public.fertilizer_product pr, public.fertilization_stage s
 where l.product_id = pr.product_id and pr.code='T-AN' and l.stage_id = s.stage_id and s.name_bg='Вегетационно 1' and l.planting_id = :'w1'::uuid;
select set_config('t.w1', :'w1', false) as _u \gset
do $$ begin
  assert (select is_deviation from public.fert_plan_line l join public.fertilization_stage s using (stage_id) where s.name_bg='Вегетационно 1' and planting_id=current_setting('t.w1')::uuid) , 'очаквано отклонение';
end $$;
update public.cnp_stage_product set rate_per_da = 9.5
 where cnp_stage_id = (select cs.cnp_stage_id from public.cnp_stage cs join public.fertilization_stage s using (stage_id) where cs.cnp_id=:'cnp' and s.name_bg='Вегетационно 1');
update public.cnp_stage_product set rate_per_da = 6
 where cnp_stage_id = (select cs.cnp_stage_id from public.cnp_stage cs join public.fertilization_stage s using (stage_id) where cs.cnp_id=:'cnp' and s.name_bg='Коригиращо');
select * from public.sync_cnp(:'cnp'::uuid) \gset
select set_config('t.w1', :'w1', false) as _u \gset
do $$
declare dev numeric; corr numeric;
begin
  select rate_per_da into dev from public.fert_plan_line l join public.fertilization_stage s using (stage_id) where s.name_bg='Вегетационно 1' and planting_id=current_setting('t.w1')::uuid;
  select rate_per_da into corr from public.fert_plan_line l join public.fertilization_stage s using (stage_id) where s.name_bg='Коригиращо' and planting_id=current_setting('t.w1')::uuid;
  assert dev = 10, 'отклонението не трябва да се презаписва';
  assert corr = 6, 'неотклонен ред трябва да се обнови от CNP';
  raise notice 'T2a OK: отклонение запазено (%), коригиращо обновено (%)', dev, corr;
end $$;
select public.revert_line_to_cnp(l.line_id) from public.fert_plan_line l join public.fertilization_stage s using (stage_id) where s.name_bg='Вегетационно 1' and planting_id=:'w1'::uuid;
select set_config('t.w1', :'w1', false) as _u \gset
do $$ begin
  assert (select rate_per_da from public.fert_plan_line l join public.fertilization_stage s using (stage_id) where s.name_bg='Вегетационно 1' and planting_id=current_setting('t.w1')::uuid) = 9.5, 'revert';
  assert not (select is_deviation from public.fert_plan_line l join public.fertilization_stage s using (stage_id) where s.name_bg='Вегетационно 1' and planting_id=current_setting('t.w1')::uuid), 'revert флаг';
  raise notice 'T2b OK: revert';
end $$;

-- ---------- Т3: правила, които трябва да хвърлят грешка ----------
create temp table failures (name text, ok boolean);
create or replace function pg_temp.expect_fail(p_name text, p_sql text) returns void language plpgsql as $f$
begin
  begin execute p_sql; insert into failures values (p_name, false);
  exception when others then insert into failures values (p_name, true); end;
end $f$;
select pg_temp.expect_fail('грешна единица', format($q$insert into public.fert_plan_line (planting_id, stage_id, product_id, rate_per_da, unit, source) select %L, stage_id, (select product_id from public.fertilizer_product where code='T-UAN'), 5, 'kg_da', 'manual' from public.fertilization_stage where name_bg='Основно'$q$, :'w2'));
select pg_temp.expect_fail('продукт недопустим за етап', format($q$insert into public.fert_plan_line (planting_id, stage_id, product_id, rate_per_da, unit, source) select %L, stage_id, (select product_id from public.fertilizer_product where code='T-DAP'), 5, 'kg_da', 'manual' from public.fertilization_stage where name_bg='Листно'$q$, :'w2'));
select pg_temp.expect_fail('CNP за друга култура', format($q$select * from public.assign_cnp(array[%L::uuid], %L::uuid)$q$, :'r1', :'cnp'));
select pg_temp.expect_fail('течен без плътност', $q$insert into public.fertilizer_product (code,name,category,form) values ('X','x','mineral','liquid')$q$);
select pg_temp.expect_fail('NPK над 100', $q$insert into public.fertilizer_product (code,name,category,form,n_pct,p2o5_pct,k2o_pct) values ('X2','x','mineral','solid',50,40,20)$q$);
select pg_temp.expect_fail('две основни култури на поле', format($q$insert into public.field_planting (fcy_id, crop_id, planted_area_da) select fcy_id, crop_id, 5 from public.field_planting where planting_id = %L$q$, :'w1'));
select pg_temp.expect_fail('draft CNP не се задава', format($q$do $d$ begin update public.cnp set status='draft' where cnp_id=%L; perform * from public.assign_cnp(array[%L::uuid], %L::uuid); end $d$$q$, :'cnp', :'w2', :'cnp'));
update public.cnp set status='active' where cnp_id = :'cnp';
select pg_temp.expect_fail('припокриване на база', format($q$insert into public.field_base (field_id, farm_base_id, valid_from) values (%L, %L, '2021-01-01')$q$, (select id from ids where k='w1_field'), :'f2'));
do $$ begin
  assert (select bool_and(ok) from failures), (select string_agg(name, ', ') from failures where not ok);
  raise notice 'T3 OK: % правила хвърлят грешка', (select count(*) from failures);
end $$;

-- ---------- Т4: семена ----------
insert into public.variety (crop_id, name) values ((select crop_id from public.crop where name_bg='ПШЕНИЦА'),'Авеню') returning variety_id as v_w \gset
insert into public.variety (crop_id, name) values ((select crop_id from public.crop where name_bg='РАПИЦА'),'LG Амбасадор') returning variety_id as v_r \gset
insert into public.variety (crop_id, name) values ((select crop_id from public.crop where name_bg='ЦАРЕВИЦА'),'Хибрид М') returning variety_id as v_m \gset
insert into public.seed_batch (organization_id, variety_id, source_type, origin_farm_base_id, tkw_g, germination_pct, analysis_source)
 values (:'org', :'v_w', 'own_production', :'f1', 35.6, 97, 'lab') returning batch_id as b_w \gset
insert into public.seed_batch (organization_id, variety_id, source_type, supplier, tkw_g, germination_pct, analysis_source)
 values (:'org', :'v_r', 'purchased', 'Limagrain', 8.4, 99, 'producer') returning batch_id as b_r \gset
insert into public.planting_seed (planting_id, variety_id, batch_id, area_da, target_rate) values (:'w2', :'v_w', :'b_w', 91, 475);
insert into public.planting_seed (planting_id, variety_id, batch_id, area_da, target_rate) values (:'r1', :'v_r', :'b_r', 907, 55);
insert into public.planting_seed (planting_id, variety_id, area_da, target_rate, overage_pct) values (:'m1', :'v_m', 100, 6500, 2);
select set_config('t.m1', :'m1', false) as _u \gset
select set_config('t.r1', :'r1', false) as _u \gset
select set_config('t.w2', :'w2', false) as _u \gset
do $$
declare w record; r record; m record;
begin
  select * into w from public.v_seed_calc where planting_id = current_setting('t.w2')::uuid;
  assert w.total_seeds_m2 = 490 and w.rate_kg_da = 17 and round(w.need_t,4) = 1.5934, format('пшеница: %s / %s / %s', w.total_seeds_m2, w.rate_kg_da, w.need_t);
  select * into r from public.v_seed_calc where planting_id = current_setting('t.r1')::uuid;
  assert r.total_seeds_m2 = 56 and r.rate_kg_da = 0.5 and round(r.packs,3) = 34.369, format('рапица: %s / %s / %s', r.total_seeds_m2, r.rate_kg_da, r.packs);
  select * into m from public.v_seed_calc where planting_id = current_setting('t.m1')::uuid;
  assert round(m.packs,4) = 8.2875 and m.overage_pct = 2, format('царевица: %s', m.packs);
  assert (select ceil(packs) from public.v_seed_need where crop_name='РАПИЦА') = 35, 'торби рапица закръглено нагоре';
  raise notice 'T4 OK: пшеница % kg/дка, % t; рапица % kg/дка, % торби; царевица % торби (преразход 2%%)', w.rate_kg_da, round(w.need_t,3), r.rate_kg_da, round(r.packs,2), round(m.packs,2);
end $$;
-- сорт от друга култура и надвишена площ
create temp table f2 (name text, ok boolean);
select set_config('t.v_r', :'v_r', false) as _u \gset
select set_config('t.v_w', :'v_w', false) as _u \gset
select set_config('t.w2', :'w2', false) as _u \gset
do $$ begin
  begin insert into public.planting_seed (planting_id, variety_id, area_da, target_rate) values (current_setting('t.w2')::uuid, current_setting('t.v_r')::uuid, 10, 400); insert into f2 values ('сорт от друга култура', false);
  exception when others then insert into f2 values ('сорт от друга култура', true); end;
  begin
    insert into public.planting_seed (planting_id, variety_id, area_da, target_rate) values (current_setting('t.w2')::uuid, current_setting('t.v_w')::uuid, 50, 400);
    set constraints all immediate;
    insert into f2 values ('надвишена площ', false);
  exception when others then insert into f2 values ('надвишена площ', true); end;
  assert (select bool_and(ok) from f2), 'проверките за семена не хвърлят грешка';
  raise notice 'T4b OK: сорт от друга култура и надвишена площ са блокирани';
end $$;

-- ---------- Т5: заключване ----------
update public.field_planting set is_locked = true where planting_id = :'w1'::uuid;
select set_config('t.w1', :'w1', false) as _u \gset
do $$ declare ok boolean := false; begin
  begin update public.fert_plan_line set rate_per_da = 1 where planting_id = current_setting('t.w1')::uuid; exception when others then ok := true; end;
  assert ok, 'заключеният период позволява промяна';
  ok := false;
  begin delete from public.field_planting where planting_id = current_setting('t.w1')::uuid; exception when others then ok := true; end;
  assert ok, 'заключеният период позволява изтриване';
  raise notice 'T5 OK: заключването блокира промени';
end $$;
update public.field_planting set is_locked = false where planting_id = :'w1'::uuid;

-- ---------- Т6: RLS ----------
-- чужд потребител
select set_config('request.jwt.claim.sub','aaaaaaaa-0000-0000-0000-000000000002', false);
select set_config('t.org', :'org', false) as _u \gset
do $$ declare ok boolean := false; begin
  assert (select count(*) from public.field) = 0 and (select count(*) from public.fert_plan_line) = 0 and (select count(*) from public.v_fert_plan_calc) = 0 and (select count(*) from public.audit_log) = 0, 'чужд потребител вижда данни';
  begin insert into public.field (organization_id) values (current_setting('t.org')::uuid); exception when others then ok := true; end;
  assert ok, 'чужд потребител може да вмъква';
  raise notice 'T6a OK: чужда организация е изолирана';
end $$;
-- viewer
select set_config('request.jwt.claim.sub','aaaaaaaa-0000-0000-0000-000000000003', false);
select set_config('t.org', :'org', false) as _u \gset
do $$ declare ok boolean := false; n int; begin
  assert (select count(*) from public.v_fert_plan_calc) = 4, 'viewer трябва да чете';
  begin insert into public.field (organization_id) values (current_setting('t.org')::uuid); exception when others then ok := true; end;
  assert ok, 'viewer може да вмъква';
  update public.fert_plan_line set rate_per_da = 1; get diagnostics n = row_count;
  assert n = 0, 'viewer може да променя';
  assert (select count(*) from public.audit_log) = 0, 'viewer вижда одита';
  raise notice 'T6b OK: viewer само чете';
end $$;
-- агроном само за F1
select set_config('request.jwt.claim.sub','aaaaaaaa-0000-0000-0000-000000000004', false);
select set_config('t.m1', :'m1', false) as _u \gset
select set_config('t.w2', :'w2', false) as _u \gset
do $$ declare n1 int; n2 int; ok boolean := false; begin
  update public.planting_seed set overage_pct = 4 where planting_id = current_setting('t.m1')::uuid; get diagnostics n1 = row_count;   -- поле от F1
  update public.planting_seed set overage_pct = 4 where planting_id = current_setting('t.w2')::uuid; get diagnostics n2 = row_count;   -- поле от F2
  assert n1 = 1 and n2 = 0, format('агроном F1: F1=%s F2=%s', n1, n2);
  begin insert into public.fert_plan_line (planting_id, stage_id, product_id, rate_per_da, unit, source)
    select current_setting('t.w2')::uuid, stage_id, (select product_id from public.fertilizer_product where code='T-DAP'), 5, 'kg_da', 'manual' from public.fertilization_stage where name_bg='Предсеитбено';
  exception when others then ok := true; end;
  assert ok, 'агрономът на F1 добавя ред на поле от F2';
  raise notice 'T6c OK: агрономът на база F1 не може да пипа F2';
end $$;
-- администратор: одит
select set_config('request.jwt.claim.sub','aaaaaaaa-0000-0000-0000-000000000001', false);
do $$ begin
  assert (select count(*) from public.audit_log where table_name='fert_plan_line') >= 4, 'няма одит на плана';
  assert (select count(*) from public.audit_log where table_name='cnp') >= 1, 'няма одит на CNP';
  raise notice 'T6d OK: одит редове = %', (select count(*) from public.audit_log);
end $$;

-- ---------- Т7: плосък експорт, диверсификация, копиране ----------
do $$
declare f record; d record;
begin
  select * into f from public.v_fert_plan_flat where "Продукт" = 'DAP 18-46' limit 1;
  assert f."Норма (kg или l/дка)" = 8 and f."Количество (kg или l)" = 1384 and f."N общо (kg)" = 249 and f."P2O5 общо (kg)" = 637, 'плосък експорт';
  assert f."Стопанска база" = 'Дермен' and f."Източник (План/Факт)" = 'План', 'контекст на експорта';
  raise notice 'T7a OK: експорт ред: % | % | % kg | N % kg', f."БЗС", f."Етап", f."Количество (kg или l)", f."N общо (kg)";
  select value_pct into d from public.v_diversification where rule_set='ДЗЕС' and check_type='top_n_max' and n=1;
  assert round(d.value_pct,1) = 71.4, format('диверсификация top1: %s', d.value_pct);
  assert not exists (select 1 from public.v_diversification where rule_set='ДЗЕС' and is_violation), 'ДЗЕС не трябва да има нарушения';
  assert (select count(*) from public.v_diversification where rule_set='ЕКОРОК' and is_violation) = 2, 'ЕКОРОК с 3 култури нарушава 2 правила';
  raise notice 'T7b OK: ДЗЕС I култура = %%%', d.value_pct;
end $$;
select public.copy_cnp(:'cnp'::uuid, (select season_id from public.season where year_end=2028), 'Пшеница 2028') as cnp2 \gset
select set_config('t.cnp2', :'cnp2', false) as _u \gset
do $$ begin
  assert (select count(*) from public.cnp_stage where cnp_id = current_setting('t.cnp2')::uuid) = 4, 'етапи при копиране';
  assert (select count(*) from public.cnp_stage_product sp join public.cnp_stage s using (cnp_stage_id) where s.cnp_id = current_setting('t.cnp2')::uuid) = 4, 'продукти при копиране';
  assert (select min(period_from) from public.cnp_stage where cnp_id = current_setting('t.cnp2')::uuid) = '2027-10-01', 'датите не са изместени';
  raise notice 'T7c OK: копиране към 2028 (датите +1 година)';
end $$;
select * from public.v_cnp_library where cnp_id = :'cnp' \gx
