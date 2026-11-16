-- Планиране на ПРЗ по БЗС: продукт по продукт, с етап (Т1, Т2, коригиращо, тотален хербицид преди поникване).
-- Изисква 20261114180000_prz_catalog_and_fertilizer_ext.sql.

create table public.planting_prz (
  planting_prz_id  uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organization(organization_id) on delete cascade,
  planting_id      uuid not null references public.field_planting(planting_id) on delete cascade,
  prz_product_id   uuid not null references public.prz_product(prz_product_id),
  stage            text not null check (stage in ('t1','t2','corrective','total_herbicide_pre')),
  dose_per_da      numeric(12,4) not null check (dose_per_da > 0),
  dose_unit        text not null check (dose_unit in ('ml_da','g_da','l_da','kg_da')),
  area_da          numeric(10,2) not null check (area_da > 0),
  note             text,
  created_by       uuid default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint planting_prz_unique unique (planting_id, stage, prz_product_id)
);
comment on table public.planting_prz is 'Назначен ПРЗ продукт за БЗС (период) в даден етап. Един ред = един продукт; коктейлът е сборът от редовете в етапа.';
comment on column public.planting_prz.dose_per_da is 'Доза на декар в единицата dose_unit (мл/г или л/кг на декар).';
comment on column public.planting_prz.area_da is 'Третирана площ, дка (по подразбиране цялата засята площ).';
create index planting_prz_planting on public.planting_prz (planting_id);
create index planting_prz_product on public.planting_prz (prz_product_id);

create trigger aa_planting_prz_org before insert or update on public.planting_prz
  for each row execute function app.inherit_org('field_planting', 'planting_id', 'planting_id');
create trigger planting_prz_lock before insert or update or delete on public.planting_prz
  for each row execute function app.block_if_locked();
create trigger planting_prz_touch before update on public.planting_prz
  for each row execute function app.touch_updated_at();
create trigger planting_prz_audit after insert or update or delete on public.planting_prz
  for each row execute function app.audit_row('planting_prz_id');

-- третираната площ не надвишава засетата
create or replace function app.check_prz_area() returns trigger
language plpgsql as $$
declare v_area numeric;
begin
  select planted_area_da into v_area from public.field_planting where planting_id = new.planting_id;
  if v_area is not null and new.area_da > v_area + 0.005 then
    raise exception 'Третираната площ (% дка) надвишава засетата площ на периода (% дка)', new.area_da, v_area;
  end if;
  return new;
end $$;
create trigger planting_prz_area before insert or update of area_da, planting_id on public.planting_prz
  for each row execute function app.check_prz_area();

alter table public.planting_prz enable row level security;
create policy planting_prz_select on public.planting_prz for select to authenticated
  using (organization_id in (select app.user_org_ids()));
create policy planting_prz_insert on public.planting_prz for insert to authenticated
  with check (app.can_edit(organization_id, app.planting_farm(planting_id)));
create policy planting_prz_update on public.planting_prz for update to authenticated
  using (app.can_edit(organization_id, app.planting_farm(planting_id)))
  with check (app.can_edit(organization_id, app.planting_farm(planting_id)));
create policy planting_prz_delete on public.planting_prz for delete to authenticated
  using (app.can_edit(organization_id, app.planting_farm(planting_id)));

-- ---------------------------------------------------------------------------
-- Изчисления: количества и проверка спрямо регистъра на БАБХ.
-- Дозите се нормализират до мл или г на декар. Регистърът се сравнява само ако е в същото
-- семейство единици (мл/л с мл/л; г/кг с г/кг). При няколко употреби за културата се взема
-- най-разрешителната (макс. доза, макс. брой третирания, макс. карантинен срок).
-- ---------------------------------------------------------------------------
create or replace view public.v_prz_calc with (security_invoker = true) as
with a as (
  select
    pr.*,
    pr.dose_per_da * case pr.dose_unit when 'l_da' then 1000 when 'kg_da' then 1000 else 1 end as dose_norm,
    case when pr.dose_unit in ('ml_da','l_da') then 'vol' else 'mass' end as dose_family
  from public.planting_prz pr
),
reg as (
  select u.prz_product_id, u.crop_id,
         case when u.dose_unit in ('ml_da','l_da') then 'vol' else 'mass' end as family,
         max(u.dose_max * case u.dose_unit when 'l_da' then 1000 when 'kg_da' then 1000 else 1 end) as reg_dose_max_norm,
         min(u.dose_min * case u.dose_unit when 'l_da' then 1000 when 'kg_da' then 1000 else 1 end) as reg_dose_min_norm,
         max(u.phi_days) as reg_phi_days,
         max(u.max_applications) as reg_max_applications,
         count(*) as reg_uses
    from public.prz_use u
   where u.crop_id is not null and u.dose_unit in ('ml_da','g_da','l_da','kg_da')
   group by 1, 2, 3
),
anyuse as (
  select distinct prz_product_id, crop_id from public.prz_use where crop_id is not null
)
select
  a.planting_prz_id, a.organization_id, a.planting_id, a.prz_product_id, a.stage,
  a.dose_per_da, a.dose_unit, a.area_da, a.note,
  c.season_id, c.season_label, c.crop_id, c.crop_name, c.farm_base_id, c.farm_base_name, c.company_id, c.company_name,
  c.field_id, c.field_name, c.planted_area_da,
  p.trade_name, p.function_groups, p.active_substances, p.source,
  -- количество за поръчка: л или кг
  round(a.dose_norm * a.area_da / 1000.0, 3) as qty_total,
  case when a.dose_family = 'vol' then 'l' else 'kg' end as qty_unit,
  -- проверка спрямо регистъра
  (au.prz_product_id is not null) as registered_for_crop,
  round(r.reg_dose_min_norm / case when a.dose_unit in ('l_da','kg_da') then 1000.0 else 1 end, 4) as reg_dose_min,
  round(r.reg_dose_max_norm / case when a.dose_unit in ('l_da','kg_da') then 1000.0 else 1 end, 4) as reg_dose_max,
  (r.reg_dose_max_norm is not null and a.dose_norm > r.reg_dose_max_norm + 0.0001) as dose_over_max,
  r.reg_phi_days, r.reg_max_applications,
  (r.reg_max_applications is not null and
    count(*) over (partition by a.planting_id, a.prz_product_id) > r.reg_max_applications) as applications_over_max
from a
join public.v_planting_context c on c.planting_id = a.planting_id
join public.prz_product p on p.prz_product_id = a.prz_product_id
left join anyuse au on au.prz_product_id = a.prz_product_id and au.crop_id = c.crop_id
left join reg r on r.prz_product_id = a.prz_product_id and r.crop_id = c.crop_id and r.family = a.dose_family;
comment on view public.v_prz_calc is 'Назначен ПРЗ по БЗС с количества и проверки спрямо БАБХ: registered_for_crop, dose_over_max, applications_over_max.';

-- Потребност за поръчка: сума по култура, база, етап и продукт.
create or replace view public.v_prz_need with (security_invoker = true) as
select organization_id, season_id, crop_id, crop_name, farm_base_id, farm_base_name,
       stage, prz_product_id, trade_name, qty_unit,
       sum(area_da) as area_da,
       sum(qty_total) as qty_total,
       bool_or(not registered_for_crop) as not_registered_for_crop,
       bool_or(coalesce(dose_over_max, false)) as dose_over_max
from public.v_prz_calc
group by organization_id, season_id, crop_id, crop_name, farm_base_id, farm_base_name,
         stage, prz_product_id, trade_name, qty_unit;
comment on view public.v_prz_need is 'Потребност от ПРЗ за поръчка по култура, стопанска база, етап и продукт.';
