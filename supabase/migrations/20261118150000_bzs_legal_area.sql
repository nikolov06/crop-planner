-- Площ по правно основание и буферни ивици на ниво БЗС за стопанска година (field_crop_year).
-- buffer_area_da вече съществуваше (numeric(10,2), default 0) – преименува се на buffer_strip_dka,
-- за да няма две колони за едно и също; стойностите се запазват.

alter table public.field_crop_year rename column buffer_area_da to buffer_strip_dka;
alter table public.field_crop_year drop constraint if exists field_crop_year_buffer_area_da_check;
alter table public.field_crop_year alter column buffer_strip_dka type numeric(12,3);
alter table public.field_crop_year alter column buffer_strip_dka set default 0;
alter table public.field_crop_year alter column buffer_strip_dka set not null;
alter table public.field_crop_year
  add constraint fcy_buffer_strip_nonneg check (buffer_strip_dka >= 0);

alter table public.field_crop_year
  add column legal_area_dka numeric(12,3) null,
  add constraint fcy_legal_area_nonneg check (legal_area_dka >= 0),
  add constraint fcy_buffer_le_legal check (legal_area_dka is null or buffer_strip_dka <= legal_area_dka);

alter table public.field_crop_year
  add column area_wo_buffer_dka numeric(12,3) generated always as (legal_area_dka - buffer_strip_dka) stored;

comment on column public.field_crop_year.legal_area_dka is 'ПЛОЩ ПРАВНО ОСНОВАНИЕ, дка';
comment on column public.field_crop_year.buffer_strip_dka is 'ПЛОЩ БУФЕРНА ИВИЦА, дка';
comment on column public.field_crop_year.area_wo_buffer_dka is 'ПЛОЩ БЕЗ БУФЕРНА ИВИЦА, дка (за дневник РЗ)';

-- Сеитбооборот: fcy_id и трите площи за текущия сезон (новите колони са в края на изгледа).
create or replace view public.v_rotation_list with (security_invoker = true) as
with cur as (select season_id, year_end, label from public.season where is_current limit 1)
select
  f.organization_id, f.field_id, f.code,
  y0.field_name, y0.isak_number,
  co.name as company_name, fb.name as farm_base_name, st.name as settlement_name,
  wf.name as work_field_name,
  cur.label as season_label,
  p0.planted_area_da as area_da, p0.planting_id,
  c0.name_bg as crop,
  c1.name_bg as crop_prev1, c2.name_bg as crop_prev2, c3.name_bg as crop_prev3, c4.name_bg as crop_prev4,
  s1.label as season_prev1, s2.label as season_prev2, s3.label as season_prev3, s4.label as season_prev4,
  (select count(*) from public.field_planting x where x.fcy_id = y0.fcy_id and x.role = 'second') as n_second_crops,
  coalesce((
    select jsonb_agg(jsonb_build_object(
             'variety', v.name, 'reproduction', r.name, 'area_da', ps.area_da,
             'rate', ps.target_rate, 'rate_basis', c0.rate_basis, 'origin', ps.seed_origin) order by ps.area_da desc, v.name)
      from public.planting_seed ps
      join public.variety v on v.variety_id = ps.variety_id
      left join public.seed_batch sb on sb.batch_id = ps.batch_id
      left join public.reproduction r on r.reproduction_id = sb.reproduction_id
     where ps.planting_id = p0.planting_id), '[]'::jsonb) as seeds,
  coalesce((
    select jsonb_agg(jsonb_build_object('name', a.alias_name, 'isak_number', a.isak_number, 'area_da', a.area_da) order by a.alias_name)
      from public.field_alias a where a.field_id = f.field_id), '[]'::jsonb) as aliases,
  y0.fcy_id,
  y0.legal_area_dka, y0.buffer_strip_dka, y0.area_wo_buffer_dka
from public.field f
cross join cur
left join public.farm_base fb on fb.farm_base_id = f.current_farm_base_id
left join public.settlement st on st.settlement_id = f.settlement_id
left join public.work_field wf on wf.work_field_id = f.work_field_id
left join public.season s0 on s0.year_end = cur.year_end - 0
left join public.field_crop_year y0 on y0.field_id = f.field_id and y0.season_id = s0.season_id
left join public.field_planting p0 on p0.fcy_id = y0.fcy_id and p0.role = 'main'
left join public.crop c0 on c0.crop_id = p0.crop_id
left join public.season s1 on s1.year_end = cur.year_end - 1
left join public.field_crop_year y1 on y1.field_id = f.field_id and y1.season_id = s1.season_id
left join public.field_planting p1 on p1.fcy_id = y1.fcy_id and p1.role = 'main'
left join public.crop c1 on c1.crop_id = p1.crop_id
left join public.season s2 on s2.year_end = cur.year_end - 2
left join public.field_crop_year y2 on y2.field_id = f.field_id and y2.season_id = s2.season_id
left join public.field_planting p2 on p2.fcy_id = y2.fcy_id and p2.role = 'main'
left join public.crop c2 on c2.crop_id = p2.crop_id
left join public.season s3 on s3.year_end = cur.year_end - 3
left join public.field_crop_year y3 on y3.field_id = f.field_id and y3.season_id = s3.season_id
left join public.field_planting p3 on p3.fcy_id = y3.fcy_id and p3.role = 'main'
left join public.crop c3 on c3.crop_id = p3.crop_id
left join public.season s4 on s4.year_end = cur.year_end - 4
left join public.field_crop_year y4 on y4.field_id = f.field_id and y4.season_id = s4.season_id
left join public.field_planting p4 on p4.fcy_id = y4.fcy_id and p4.role = 'main'
left join public.crop c4 on c4.crop_id = p4.crop_id
left join public.company co on co.company_id = y0.company_id;
comment on view public.v_rotation_list is 'Екран „Сеитбооборот“: поле, фирма, БЗС, площ и култура за текущата година и четири предходни, сортове с размножение и норма, площи по правно основание и буферни ивици.';
grant select on public.v_rotation_list to authenticated;

-- Групов запис на площите (импорт и групово задаване) в една транзакция.
-- p_rows: [{ "fcy_id": uuid, "legal": число|null, "buffer": число|null(=0) }]
-- security invoker: важат RLS политиките на field_crop_year; ако някой ред не се запише, нищо не се записва.
create or replace function public.set_bzs_legal_areas(p_rows jsonb)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_expected integer := jsonb_array_length(coalesce(p_rows, '[]'::jsonb));
  v_distinct integer;
  v_done integer;
begin
  select count(distinct (x->>'fcy_id')) into v_distinct from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x;
  if v_distinct <> v_expected then
    raise exception 'Едно БЗС присъства повече от веднъж в заявката. Нищо не е записано.';
  end if;

  update public.field_crop_year y
     set legal_area_dka = r.legal,
         buffer_strip_dka = coalesce(r.buffer, 0)
    from jsonb_to_recordset(p_rows) as r(fcy_id uuid, legal numeric, buffer numeric)
   where y.fcy_id = r.fcy_id;
  get diagnostics v_done = row_count;

  if v_done <> v_expected then
    raise exception 'Записани биха били % от % БЗС (липсват права или БЗС не съществува). Нищо не е записано.', v_done, v_expected;
  end if;
  return v_done;
end $$;
comment on function public.set_bzs_legal_areas(jsonb) is 'Записва площ по правно основание и буферна ивица за списък БЗС (fcy_id) в една транзакция; всичко или нищо.';
revoke all on function public.set_bzs_legal_areas(jsonb) from public, anon;
grant execute on function public.set_bzs_legal_areas(jsonb) to authenticated;
