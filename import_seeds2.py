#!/usr/bin/env python3
"""Импорт на семена 26/27 от таблицата „Сеитбооборот/Семена“ (с МХЗ, кълняемост, произход).
Партидата е по сорт + размножение + произход + МХЗ + кълняемост. Прескача (заменя) предишен импорт на семена за сезона.
Употреба: python3 import_seeds2.py seeds.xlsx --org KristeraAgro [--rapeseed-from стар_експорт.xlsx] [--apply] [--out f.sql]"""
import argparse, re, openpyxl

ap = argparse.ArgumentParser()
ap.add_argument('xlsx'); ap.add_argument('--org', required=True)
ap.add_argument('--rapeseed-from', help='стария експорт „Управление на блокове“, откъдето се вземат само редовете на рапицата (без МХЗ/кълняемост)')
ap.add_argument('--season', type=int, default=2027); ap.add_argument('--apply', action='store_true')
ap.add_argument('--out', default='import_seeds2.sql')
a = ap.parse_args()

def q(v):
    if v is None: return 'null'
    if isinstance(v, (int, float)): return repr(round(float(v), 4))
    return "'" + str(v).replace("'", "''") + "'"

def norm_origin(s):
    if s is None: return None
    s = re.sub(r'\s+', ' ', str(s).replace('\n', ' ')).strip(' ;/.')
    if s.startswith('T/'): s = 'Т/' + s[2:]          # латинско T -> кирилско Т
    return s or None

out, bad = [], []
ws = openpyxl.load_workbook(a.xlsx, read_only=True, data_only=True).worksheets[0]
hdr = None
for r in ws.iter_rows(values_only=True):
    if hdr is None: hdr = r; continue
    if not r[3]: continue
    name, crop = str(r[3]).strip(), str(r[11]).strip()
    var, area_da, rep_raw, origin = r[17], r[18], r[19], norm_origin(r[20])
    tkw, germ, rate = r[21], r[22], r[24]
    if not var or not area_da or not rate:
        bad.append((name, 'липсва сорт/площ/норма')); continue
    rep_raw = str(rep_raw or '').upper()
    vra = 'VRA' in rep_raw
    m = re.match(r'^\s*([CС][12])', rep_raw)
    rep = 'C' + m.group(1)[1] if m else ('Б' if rep_raw.strip().startswith('Б') else None)
    if '[Б]' in rep_raw and rep == 'C1': pass
    out.append((name, crop, re.sub(r'\s+', ' ', str(var)).strip(), rep, float(area_da), float(rate),
                origin, float(tkw) if tkw else None, float(germ) if germ else None, 'VRA' if vra else None))

if a.rapeseed_from:   # рапица: от стария експорт, без качествени показатели
    w2 = openpyxl.load_workbook(a.rapeseed_from, read_only=True, data_only=True).worksheets[0]
    RATE = re.compile(r'(\d+(?:[.,]\d+)?)\s*(?:кс|к\.\s*с)', re.I)
    for r in list(w2.iter_rows(min_row=3, values_only=True)):
        if not r[0] or (r[7] or '').strip() != 'РАПИЦА' or not r[8]: continue
        m = RATE.search(r[10] or '')
        if not m: bad.append((r[0], 'рапица без норма')); continue
        out.append((r[0].strip(), 'РАПИЦА', re.sub(r'\s+', ' ', r[8]).strip(), None, round(float(r[6]) * 10, 2),
                    float(m.group(1).replace(',', '.')), None, None, None, None))

with open(a.out, 'w', encoding='utf-8') as f:
    w = f.write
    w(f"-- Генерирано от import_seeds2.py. {'ПРИЛАГАНЕ (COMMIT)' if a.apply else 'СУХА ПРОБА (ROLLBACK)'}\n\\set ON_ERROR_STOP on\nbegin;\n\n")
    w(f"create temp table _p as select {q(a.org)}::text as org_name, {a.season}::int as ye;\n")
    w("create temp table s_seed (name text, crop text, variety text, repro text, area_da numeric, rate numeric, origin text, tkw numeric, germ numeric, note text, planting_id uuid, variety_id uuid, batch_id uuid);\n")
    w("insert into s_seed (name, crop, variety, repro, area_da, rate, origin, tkw, germ, note) values\n")
    w(',\n'.join('(' + ', '.join(q(x) for x in row) + ')' for row in out) + ';\n')
    w(r"""
create temp table _org as select organization_id as id from public.organization, _p where name = _p.org_name;
do $$ begin
  if not exists (select 1 from _org) then raise exception 'Няма такава организация'; end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='planting_seed' and column_name='seed_origin')
    then raise exception 'Липсва колоната planting_seed.seed_origin – първо приложи миграция 20261108115000.'; end if;
end $$;

-- 0) замяна на предишен импорт на семена за сезона (ако има)
create temp table _old as
select ps.planting_seed_id from public.planting_seed ps
  join public.field_planting p on p.planting_id = ps.planting_id
  join public.field_crop_year y on y.fcy_id = p.fcy_id
  join public.season se on se.season_id = y.season_id and se.year_end = (select ye from _p), _org
 where ps.organization_id = _org.id;
delete from public.planting_seed where planting_seed_id in (select planting_seed_id from _old);
delete from public.seed_batch b using _org
 where b.organization_id = _org.id and not exists (select 1 from public.planting_seed ps where ps.batch_id = b.batch_id);

-- 1) към кой период принадлежи редът
update s_seed s set planting_id = x.planting_id
  from (select distinct on (upper(trim(a.alias_name)), c.name_bg) upper(trim(a.alias_name)) as nm, c.name_bg as crop, p.planting_id
          from public.field_alias a
          join _org on a.organization_id = _org.id
          join public.field_crop_year y on y.field_id = a.field_id
          join public.season se on se.season_id = y.season_id and se.year_end = (select ye from _p)
          join public.field_planting p on p.fcy_id = y.fcy_id and p.role = 'main'
          join public.crop c on c.crop_id = p.crop_id) x
 where upper(trim(s.name)) = x.nm and s.crop = x.crop;

-- 2) сортове
insert into public.variety (crop_id, name)
select distinct c.crop_id, s.variety from s_seed s join public.crop c on c.name_bg = s.crop
on conflict (crop_id, name) do nothing;
update s_seed s set variety_id = v.variety_id
  from public.variety v join public.crop c on c.crop_id = v.crop_id
 where c.name_bg = s.crop and v.name = s.variety;

-- 3) партиди: сорт + размножение + произход + МХЗ + кълняемост; с БЗС за произход = собствено производство
create temp table _b as
select gen_random_uuid() as batch_id, variety_id, repro, origin, tkw, germ,
       (origin ~ '^[БТПЯО]/') as own
  from (select distinct variety_id, repro, origin, tkw, germ from s_seed where planting_id is not null) z;
insert into public.seed_batch (batch_id, organization_id, variety_id, source_type, reproduction_id, tkw_g, germination_pct, analysis_source)
select b.batch_id, _org.id, b.variety_id, case when b.own then 'own_production' else 'purchased' end,
       (select reproduction_id from public.reproduction r where r.name = b.repro), b.tkw, b.germ, 'producer'
  from _b b, _org;
update s_seed s set batch_id = b.batch_id from _b b
 where b.variety_id = s.variety_id and b.repro is not distinct from s.repro and b.origin is not distinct from s.origin
   and b.tkw is not distinct from s.tkw and b.germ is not distinct from s.germ;

-- 4) редове семена по период
insert into public.planting_seed (organization_id, planting_id, variety_id, batch_id, area_da, target_rate, seed_origin, note)
select _org.id, s.planting_id, s.variety_id, s.batch_id, s.area_da, s.rate, s.origin, s.note
  from s_seed s, _org where s.planting_id is not null;

\echo --- резултат
select 'изтрити стари редове семена' as показател, count(*)::text as стойност from _old
union all select 'редове за внасяне', count(*)::text from s_seed
union all select 'свързани с период', count(*)::text from s_seed where planting_id is not null
union all select 'несвързани (не са внесени)', count(*)::text from s_seed where planting_id is null
union all select 'партиди', count(*)::text from public.seed_batch b, _org where b.organization_id = _org.id
union all select 'редове семена', count(*)::text from public.planting_seed p, _org where p.organization_id = _org.id
union all select 'редове без МХЗ/кълняемост', count(*)::text from public.planting_seed p join public.seed_batch b on b.batch_id = p.batch_id, _org
   where p.organization_id = _org.id and (b.tkw_g is null or b.germination_pct is null)
union all select 'сметка: общо тона (слети с данни)', round(sum(need_t)::numeric, 1)::text from public.v_seed_calc v, _org where v.organization_id = _org.id;

\echo --- по култура и сорт: площ дка, ср. норма, тона
select crop_name as култура, v.name as сорт, count(*) as реда, round(sum(c.area_da)) as дка, round(avg(c.target_rate), 1) as ср_норма, round(sum(c.need_t)::numeric, 1) as тона
  from public.v_seed_calc c join public.variety v on v.variety_id = c.variety_id, _org
 where c.organization_id = _org.id group by 1, 2 order by 1, 2;
""")
    w('\ncommit;\n' if a.apply else '\nrollback;\n')
print(f'редове: {len(out)}; проблемни: {len(bad)} -> {a.out}')
for b in bad: print('  ', b)
