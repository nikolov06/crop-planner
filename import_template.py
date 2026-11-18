#!/usr/bin/env python3
"""
Генерира import.sql от шаблона CROP_PLANNER_import_template_v8.xlsx.

Употреба:
  python3 import_template.py CROP_PLANNER_import_template_v8.xlsx --org "Кристера Агро" [--admin-email you@example.com] [--apply]

Без --apply SQL-ът завършва с ROLLBACK (суха проба: брои и проверява, нищо не се записва).
С --apply завършва с COMMIT.

Пускане (паролата е в .env.local, който е в .gitignore – не я пиши в чата):
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f import.sql

Изисква: openpyxl (pip install openpyxl). Базата вече има миграциите до 20261118150000_bzs_legal_area.sql (буферът е в buffer_strip_dka).
"""
import argparse, datetime, re, sys
import openpyxl

ap = argparse.ArgumentParser()
ap.add_argument('xlsx'); ap.add_argument('--org', required=True)
ap.add_argument('--admin-email'); ap.add_argument('--apply', action='store_true')
ap.add_argument('--out', default='import.sql')
a = ap.parse_args()

def q(v):
    if v is None: return 'null'
    if isinstance(v, bool): return 'true' if v else 'false'
    if isinstance(v, (int, float)): return repr(round(float(v), 4)) if isinstance(v, float) else str(v)
    if isinstance(v, (datetime.datetime, datetime.date)): return "'" + v.strftime('%Y-%m-%d') + "'"
    return "'" + str(v).replace("'", "''") + "'"
def t(v):
    if v is None: return None
    v = str(v).strip(); return v or None

wb = openpyxl.load_workbook(a.xlsx, read_only=True, data_only=True)
def table(name):
    rows = list(wb[name].iter_rows(values_only=True))
    h = [str(c).strip() if c is not None else '' for c in rows[0]]
    return h, [r for r in rows[1:] if any(c is not None for c in r)]
def col(h, name):
    if name not in h: sys.exit(f'Липсва колона „{name}“ в листа')
    return h.index(name)

# --- Полета
h, fr = table('Полета')
F = [(t(r[col(h,'Код')]), t(r[col(h,'Наименование')]), t(r[col(h,'Землище')]), t(r[col(h,'Стопанска база')]),
      t(r[col(h,'Поливно')]), r[col(h,'Наклон %')],
      (t(r[h.index('Обработваемо поле (латиница)')]) if 'Обработваемо поле (латиница)' in h else None)) for r in fr if r[0]]
# --- Сезони
h, sr = table('Полета_по_сезони')
c = {n: col(h, n) for n in h if n}
S = []
for i, r in enumerate(sr, 1):
    if not r[c['Код']]: continue
    ye = int(str(r[c['Сезон']])[-4:])
    S.append((i, t(r[c['Код']]), ye, t(r[c['Фирма']]), t(r[c['БЗС №']]), r[c['Площ ИСАК (дка)']], r[c['Буфер (дка)']],
              t(r[c['Потенциал']]), t(r[c['Култура']]), r[c['Засята площ (дка)']], t(r[c['Обработка']]),
              r[c['Добив (кг/дка)']], r[c['Прибрана площ (дка)']], r[c['Общо (т)']],
              r[c['Сеитба (факт)']], r[c['Прибиране (факт)']], t(r[c['Бележка']])))
# --- Имена
h, nr = table('Имена')
A = [(t(r[col(h,'Код')]), t(r[col(h,'Разширено име (АгроВИР)')]), t(r[col(h,'БЗС №')]), r[col(h,'Площ ИСАК (дка)')])
     for r in nr if r[0]]

def values(rows, fmt):
    return ',\n'.join('(' + ', '.join(fmt(x)) + ')' for x in rows)

out = []
w = out.append
w("-- Генерирано от import_template.py. " + ('COMMIT' if a.apply else 'СУХА ПРОБА (ROLLBACK)'))
w('\\set ON_ERROR_STOP on\nbegin;\n')
w(f"create temp table _p as select {q(a.org)}::text as org_name, {q(a.admin_email)}::text as admin_email;")
w("""
create temp table s_field (code text, name text, settlement text, base text, irrigated text, slope numeric, work_field text);
create temp table s_row (rn int, code text, ye int, firm text, isak text, isak_da numeric, buffer_da numeric, potential text,
  crop text, area_da numeric, tillage text, yield_kg_da numeric, harv_da numeric, qty_t numeric, sow date, harv date, note text,
  pid uuid default gen_random_uuid());
create temp table s_alias (code text, alias text, isak text, area_da numeric);
""")
w('insert into s_field values\n' + values(F, lambda x: [q(x[0]), q(x[1]), q(x[2]), q(x[3]), q(x[4]), q(x[5]), q(x[6])]) + ';')
for k in range(0, len(S), 500):
    w('insert into s_row (rn, code, ye, firm, isak, isak_da, buffer_da, potential, crop, area_da, tillage, yield_kg_da, harv_da, qty_t, sow, harv, note) values\n'
      + values(S[k:k+500], lambda x: [q(v) for v in x]) + ';')
w('insert into s_alias values\n' + values(A, lambda x: [q(x[0]), q(x[1]), q(x[2]), q(x[3])]) + ';')

w(r"""
-- ---------- организация ----------
insert into public.organization (name) select org_name from _p
 where not exists (select 1 from public.organization o, _p where o.name = _p.org_name);
create temp table _org as select o.organization_id as id from public.organization o, _p where o.name = _p.org_name limit 1;

do $$ begin
  if exists (select 1 from public.field f, _org where f.organization_id = _org.id) then
    raise exception 'Организацията вече има полета. Импортът е еднократен; за повторен внос първо изчисти данните.';
  end if;
end $$;

-- администратор (ако има такъв потребител в auth.users)
insert into public.app_user_role (user_id, organization_id, role)
select u.id, _org.id, 'admin' from auth.users u, _org, _p where lower(u.email) = lower(_p.admin_email)
on conflict do nothing;

-- ---------- справочници ----------
insert into public.season (year_end, start_date, end_date, is_current)
select y, make_date(y - 1, 10, 1), make_date(y, 9, 30), false
  from (select distinct ye as y from s_row) x where not exists (select 1 from public.season s where s.year_end = x.y);
update public.season set is_current = true
 where year_end = (select max(year_end) from public.season) and not exists (select 1 from public.season where is_current);

insert into public.company (organization_id, name)
select _org.id, f from _org, (select distinct firm f from s_row where firm is not null) x
 on conflict (organization_id, name) do nothing;
insert into public.farm_base (organization_id, name)
select _org.id, b from _org, (select distinct base b from s_field where base is not null) x
 on conflict (organization_id, name) do nothing;
insert into public.settlement (name)
select z from (select distinct settlement z from s_field where settlement is not null) x
 where not exists (select 1 from public.settlement s where s.name = x.z);
insert into public.tillage_type (name_bg)
select distinct tillage from s_row where tillage is not null on conflict (name_bg) do nothing;
-- култури извън основния списък (зелени площи, замяна, грах…): вписват се без настройки за семена
insert into public.crop (name_bg, short_name, crop_group)
select distinct crop, initcap(lower(crop)), 'друго' from s_row
 where crop is not null and not exists (select 1 from public.crop c where c.name_bg = s_row.crop);

-- ---------- обработваеми полета (Основен масив в АгроВИР) ----------
insert into public.work_field (organization_id, name)
select _org.id, w from _org, (select distinct work_field w from s_field where work_field is not null) x;

-- ---------- полета ----------
insert into public.field (organization_id, code, settlement_id, current_farm_base_id, is_irrigated, slope_pct, work_field_id)
select _org.id, f.code,
       (select min(s.settlement_id::text)::uuid from public.settlement s where s.name = f.settlement),
       (select b.farm_base_id from public.farm_base b where b.organization_id = _org.id and b.name = f.base),
       case f.irrigated when 'да' then true when 'не' then false end,
       least(f.slope, 999.99),
       (select w.work_field_id from public.work_field w where w.organization_id = _org.id and w.name = f.work_field)
  from s_field f, _org;

insert into public.field_base (organization_id, field_id, farm_base_id, valid_from)
select _org.id, fd.field_id, fd.current_farm_base_id,
       (select min(se.start_date) from s_row r join public.season se on se.year_end = r.ye where r.code = fd.code)
  from public.field fd, _org
 where fd.organization_id = _org.id and fd.current_farm_base_id is not null
   and exists (select 1 from s_row r where r.code = fd.code);

-- ---------- годишна регистрация (един ред на поле и сезон) ----------
create temp table _fcy as
select distinct on (r.code, r.ye) r.code, r.ye, r.firm, r.isak, r.isak_da, r.buffer_da, r.potential
  from s_row r order by r.code, r.ye, (r.isak_da is not null) desc, r.area_da desc nulls last, r.rn;

insert into public.field_crop_year (organization_id, field_id, season_id, company_id, field_name, isak_number, isak_area_da, buffer_strip_dka, potential_id)
select _org.id, fd.field_id, se.season_id,
       (select c.company_id from public.company c where c.organization_id = _org.id and c.name = x.firm),
       f.name,
       case when x.isak ~ '^[0-9]+(-[0-9]+)+$' then x.isak end,
       x.isak_da, coalesce(x.buffer_da, 0),
       (select p.potential_id from public.potential_class p where p.name_bg = x.potential)
  from _fcy x
  join s_field f on f.code = x.code
  join public.field fd on fd.code = x.code and fd.organization_id = (select id from _org)
  join public.season se on se.year_end = x.ye, _org;

-- ---------- култивационни периоди ----------
-- площ: засята; ако липсва – ИСАК площта на сезона, иначе ИСАК от последната година
-- реално засети площи по поле / сезон / култура (само където шаблонът има засята площ)
create temp table _real as
select code, ye, crop, sum(area_da) a from s_row where area_da > 0 and crop is not null group by 1, 2, 3;
create temp table _tot as select code, ye, sum(a) a from _real group by 1, 2;

create temp table _pl0 as
select r.*, fcy.fcy_id,
       coalesce(fcy.isak_area_da, (select max(f2.isak_area_da) from public.field_crop_year f2 where f2.field_id = fcy.field_id)) as base_isak,
       (r.area_da is null or r.area_da = 0) as area_fallback,
       (select t.ye from _tot t where t.code = r.code and t.ye <> r.ye order by abs(t.ye - r.ye), t.ye desc limit 1) as near_ye
  from s_row r
  join public.field fd on fd.code = r.code and fd.organization_id = (select id from _org)
  join public.season se on se.year_end = r.ye
  join public.field_crop_year fcy on fcy.field_id = fd.field_id and fcy.season_id = se.season_id
 where r.crop is not null;

create temp table _pl1 as
select p.*,
       (select t.a from _tot t where t.code = p.code and t.ye = p.near_ye) as near_tot,
       (select x.a from _real x where x.code = p.code and x.ye = p.near_ye and x.crop = p.crop) as near_same
  from _pl0 p;

-- без засята площ: от най-близкия сезон със засята площ (при равно разстояние – по-новия);
-- същата култура там -> нейната площ; иначе общата засята площ на полето там, разделена поравно между културите без площ;
-- ако полето няма никаква засята площ в друг сезон -> ИСАК площта
create temp table _pl as
select p.*,
       case when not p.area_fallback then p.area_da
            when p.near_same is not null and count(*) filter (where p.area_fallback) over w = 1 then p.near_same
            else greatest(coalesce(p.near_tot, p.base_isak) - coalesce(sum(case when not p.area_fallback then p.area_da end) over w, 0),
                          coalesce(p.near_tot, p.base_isak) * 0.01)
                 / nullif(count(*) filter (where p.area_fallback) over w, 0)
       end as use_area,
       row_number() over (partition by p.code, p.ye
                          order by (coalesce(p.note,'') like '%основна култура%') desc, coalesce(p.area_da, 0) desc, p.rn) as ord,
       count(*) filter (where p.area_fallback) over w as n_fallback
  from _pl1 p
window w as (partition by p.code, p.ye);

insert into public.field_planting (planting_id, organization_id, fcy_id, role, crop_id, planted_area_da, tillage_id,
                                   sowing_date_actual, harvest_date_actual, note)
select p.pid, _org.id, p.fcy_id, case when p.ord = 1 then 'main' else 'second' end,
       (select c.crop_id from public.crop c where c.name_bg = p.crop), p.use_area,
       (select t.tillage_id from public.tillage_type t where t.name_bg = p.tillage),
       p.sow, case when p.sow is null or p.harv >= p.sow then p.harv end,
       nullif(concat_ws('; ',
         case when p.area_fallback and p.near_ye is not null then 'площ от най-близкия сезон със засята площ (' || (p.near_ye - 1) || '/' || p.near_ye || ')'
                   || case when p.n_fallback > 1 then ', разделена поравно между културите' else '' end
              when p.area_fallback and p.n_fallback > 1 then 'площ неизвестна – ИСАК площта е разделена поравно между културите'
              when p.area_fallback then 'площ по ИСАК (няма засята площ в шаблона)' end, p.note), '')
  from _pl p, _org
 where p.use_area is not null and p.use_area > 0;

insert into public.planting_yield (planting_id, organization_id, yield_kg_da, harvested_area_da, quantity_t, source)
select p.pid, _org.id, p.yield_kg_da, nullif(p.harv_da, 0), p.qty_t, 'history_file'
  from _pl p, _org
 where p.yield_kg_da is not null and p.use_area is not null and p.use_area > 0;

-- ---------- разширени имена ----------
insert into public.field_alias (organization_id, field_id, alias_name, source, isak_number, area_da)
select _org.id, fd.field_id, s.alias, 'agrovir',
       case when s.isak ~ '^[0-9]+(-[0-9]+)+$' then s.isak end, s.area_da
  from s_alias s join public.field fd on fd.code = s.code and fd.organization_id = (select id from _org), _org;

-- ---------- отчет ----------
\echo ===== ОТЧЕТ =====
select 'шаблон: полета' as показател, count(*)::text as стойност from s_field
union all select 'шаблон: редове по сезони', count(*)::text from s_row
union all select 'шаблон: имена', count(*)::text from s_alias
union all select 'в базата: полета', count(*)::text from public.field f, _org where f.organization_id = _org.id
union all select 'в базата: годишни регистрации', count(*)::text from public.field_crop_year f, _org where f.organization_id = _org.id
union all select 'в базата: култивационни периоди', count(*)::text from public.field_planting f, _org where f.organization_id = _org.id
union all select '   от тях основни / вторични', (select count(*) from public.field_planting where role='main' and organization_id=(select id from _org))::text || ' / ' || (select count(*) from public.field_planting where role='second' and organization_id=(select id from _org))::text
union all select 'в базата: добиви', count(*)::text from public.planting_yield f, _org where f.organization_id = _org.id
union all select 'в базата: обработваеми полета', count(*)::text from public.work_field f, _org where f.organization_id = _org.id
union all select '   от тях с повече от едно поле', count(*)::text from (select work_field_id from public.field f, _org where f.organization_id = _org.id and work_field_id is not null group by 1 having count(*) > 1) z
union all select 'полета без обработваемо поле', count(*)::text from public.field f, _org where f.organization_id = _org.id and f.work_field_id is null
union all select 'в базата: разширени имена', count(*)::text from public.field_alias f, _org where f.organization_id = _org.id
union all select 'пропуснати редове (няма площ)', count(*)::text from _pl where use_area is null or use_area <= 0
union all select 'периоди с площ от най-близкия сезон', count(*)::text from _pl where area_fallback and use_area > 0 and near_ye is not null
union all select 'периоди с площ по ИСАК (няма засята в друг сезон)', count(*)::text from _pl where area_fallback and use_area > 0 and near_ye is null
union all select 'редове без култура (не са внесени)', count(*)::text from s_row where crop is null
union all select 'добиви с несъответствие количество/площ', count(*)::text from public.v_yield_history v, _org where v.organization_id = _org.id and v.yield_mismatch
union all select 'нови култури извън списъка', count(*)::text from public.crop where crop_group = 'друго'
union all select 'администратор записан', count(*)::text from public.app_user_role r, _org where r.organization_id = _org.id;

\echo --- по сезони: периоди и засята площ (дка)
select se.label, count(*) as периоди, round(sum(p.planted_area_da)) as дка
  from public.field_planting p
  join public.field_crop_year f on f.fcy_id = p.fcy_id
  join public.season se on se.season_id = f.season_id, _org
 where p.organization_id = _org.id and p.role = 'main'
 group by se.label order by se.label;
""")
w('\n' + ('commit;' if a.apply else 'rollback;'))
open(a.out, 'w', encoding='utf-8').write('\n'.join(out))
print(f'Записах {a.out}: {len(F)} полета, {len(S)} реда по сезони, {len(A)} имена. Режим: {"COMMIT" if a.apply else "суха проба (ROLLBACK)"}')
