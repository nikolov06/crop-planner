-- Рекапитулация по фирми и култури с проверка за ДЗЕС и ЕКОРОК (екран Сеитбооборот → Рекапитулация).
-- Старите diversification_rule / v_diversification остават непроменени.

-- ---------- 1. Фирми в холдинга ----------
alter table public.company add column in_holding boolean not null default true;
comment on column public.company.in_holding is 'Фирмата е в холдинга (Рекапитулация: „В холдинга“ / „Извън холдинга“).';
update public.company set in_holding = false where name in ('АГРИКОРН СТАР ЕАД', 'ЕКО ХЕРБС ЕАД');

-- ---------- 2. Групи на културите за рекапитулацията ----------
create table public.recap_crop_group (
  crop_id      uuid primary key references public.crop(crop_id) on delete cascade,
  recap_group  text not null check (btrim(recap_group) <> ''),
  in_total     boolean not null default true,
  ranks        boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
comment on table public.recap_crop_group is 'Култура → група в рекапитулацията. Култура без запис не участва и се показва като предупреждение.';
comment on column public.recap_crop_group.recap_group is 'Група (напр. ПОЛИВНА ЦАРЕВИЦА → ЦАРЕВИЦА; НПП, ЛЮЦЕРНА, ГРАХ → ЕНП РЕАЛНО).';
comment on column public.recap_crop_group.in_total is 'Влиза в общата площ на фирмата (знаменателя на дяловете).';
comment on column public.recap_crop_group.ranks is 'Класира се като култура за ДЗЕС/ЕКОРОК (I, II, III, IV).';
create trigger recap_crop_group_touch before update on public.recap_crop_group for each row execute function app.touch_updated_at();

insert into public.recap_crop_group (crop_id, recap_group, in_total, ranks)
select c.crop_id, v.grp, v.in_total, v.ranks
  from (values
    ('ЕЧЕМИК', 'ЕЧЕМИК', true, true),
    ('ПШЕНИЦА', 'ПШЕНИЦА', true, true),
    ('РАПИЦА', 'РАПИЦА', true, true),
    ('СЛЪНЧОГЛЕД', 'СЛЪНЧОГЛЕД', true, true),
    ('ЦАРЕВИЦА', 'ЦАРЕВИЦА', true, true),
    ('ПОЛИВНА ЦАРЕВИЦА', 'ЦАРЕВИЦА', true, true),
    ('СОРГО', 'СОРГО', true, true),
    ('НПП', 'ЕНП РЕАЛНО', true, true),
    ('ЛЮЦЕРНА', 'ЕНП РЕАЛНО', true, true),
    ('ГРАХ', 'ЕНП РЕАЛНО', true, true),
    ('ЛОЗЯ', 'ЛОЗЯ', false, false)
  ) as v(crop, grp, in_total, ranks)
  join public.crop c on c.name_bg = v.crop;

-- ---------- 3. Прагове за ДЗЕС / ЕКОРОК по стопанска година ----------
create table public.eco_scheme_rule (
  season_id               smallint primary key references public.season(season_id) on delete cascade,
  dzes_first_max          numeric(5,4) not null default 0.75 check (dzes_first_max between 0 and 1),
  dzes_first_two_max      numeric(5,4) not null default 0.95 check (dzes_first_two_max between 0 and 1),
  dzes_third_min          numeric(5,4) not null default 0.05 check (dzes_third_min between 0 and 1),
  ekorok_first_max        numeric(5,4) not null default 0.75 check (ekorok_first_max between 0 and 1),
  ekorok_first_three_max  numeric(5,4) not null default 0.95 check (ekorok_first_three_max between 0 and 1),
  ekorok_fourth_min       numeric(5,4) not null default 0.05 check (ekorok_fourth_min between 0 and 1),
  enp_min                 numeric(5,4) not null default 0.04 check (enp_min between 0 and 1),
  dzes_min_crops          smallint not null default 3 check (dzes_min_crops >= 0),
  ekorok_min_crops        smallint not null default 4 check (ekorok_min_crops >= 0),
  min_crops_from_dka      numeric(12,3) not null default 300 check (min_crops_from_dka >= 0),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
comment on table public.eco_scheme_rule is 'Прагове за ДЗЕС и ЕКОРОК (дялове 0–1). Не покрива при: I ≥ max, I+II ≥ max, I+II+III ≥ max, III < min, IV < min; брой култури < dzes_min_crops / ekorok_min_crops при обща площ > min_crops_from_dka.';
comment on column public.eco_scheme_rule.enp_min is 'Минимален дял ЕНП от общата площ (справочно).';
create trigger eco_scheme_rule_touch before update on public.eco_scheme_rule for each row execute function app.touch_updated_at();
insert into public.eco_scheme_rule (season_id) select season_id from public.season;

-- RLS за новите таблици: като останалите глобални справочници (crop, season) – четене за всички влезли, промяна само от администратор.
alter table public.recap_crop_group enable row level security;
create policy recap_crop_group_select on public.recap_crop_group for select to authenticated using (true);
create policy recap_crop_group_insert on public.recap_crop_group for insert to authenticated with check (app.is_any_admin());
create policy recap_crop_group_update on public.recap_crop_group for update to authenticated using (app.is_any_admin()) with check (app.is_any_admin());
create policy recap_crop_group_delete on public.recap_crop_group for delete to authenticated using (app.is_any_admin());
alter table public.eco_scheme_rule enable row level security;
create policy eco_scheme_rule_select on public.eco_scheme_rule for select to authenticated using (true);
create policy eco_scheme_rule_insert on public.eco_scheme_rule for insert to authenticated with check (app.is_any_admin());
create policy eco_scheme_rule_update on public.eco_scheme_rule for update to authenticated using (app.is_any_admin()) with check (app.is_any_admin());
create policy eco_scheme_rule_delete on public.eco_scheme_rule for delete to authenticated using (app.is_any_admin());
grant select, insert, update, delete on public.recap_crop_group, public.eco_scheme_rule to authenticated;

-- ---------- 4. Площи по фирма и култура ----------
-- Основна култура: площ по правно основание (field_crop_year), при NULL – засятата (has_fallback).
-- Втора култура: засятата площ на втората култура (не взима от правното основание).
create or replace view public.v_recap_company_crop with (security_invoker = true) as
select
  y.organization_id, y.season_id, s.label as season_label,
  y.company_id, co.name as company_name, coalesce(co.in_holding, true) as in_holding,
  p.role, p.crop_id, c.name_bg as crop_name,
  g.recap_group, coalesce(g.in_total, false) as in_total, coalesce(g.ranks, false) as ranks,
  sum(case when p.role = 'main' then coalesce(y.legal_area_dka, p.planted_area_da) else p.planted_area_da end) as area_dka,
  sum(p.planted_area_da) as planted_area_dka,
  count(*) as n_bzs,
  bool_or(p.role = 'main' and y.legal_area_dka is null) as has_fallback,
  coalesce(array_agg(y.field_name order by y.field_name) filter (where p.role = 'main' and y.legal_area_dka is null), '{}') as fallback_bzs
from public.field_planting p
join public.field_crop_year y on y.fcy_id = p.fcy_id
join public.season s on s.season_id = y.season_id
join public.crop c on c.crop_id = p.crop_id
left join public.company co on co.company_id = y.company_id
left join public.recap_crop_group g on g.crop_id = p.crop_id
group by y.organization_id, y.season_id, s.label, y.company_id, co.name, co.in_holding, p.role, p.crop_id, c.name_bg, g.recap_group, g.in_total, g.ranks;
comment on view public.v_recap_company_crop is 'Рекапитулация: площ по сезон, фирма, роля и култура (с групата). Основна: правно основание или засята при липса (has_fallback); втора: засята.';
grant select on public.v_recap_company_crop to authenticated;

-- ---------- 5. Засята площ по стопанска база и култура ----------
create or replace view public.v_recap_base_crop with (security_invoker = true) as
select organization_id, season_id, farm_base_id, farm_base_name, crop_id, crop_name,
       sum(planted_area_da) as planted_area_dka, count(*) as n_bzs
  from public.v_planting_context
 where role = 'main'
 group by organization_id, season_id, farm_base_id, farm_base_name, crop_id, crop_name;
comment on view public.v_recap_base_crop is 'Рекапитулация: засята площ на основната култура по стопанска база (валидна за годината) и култура.';
grant select on public.v_recap_base_crop to authenticated;
