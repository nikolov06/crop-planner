-- Добиви (факт) по култивационен период. Един ред на период (1:1 с field_planting).
-- Датите на сеитба/прибиране остават във field_planting (sowing_date_actual / harvest_date_actual).

create table public.planting_yield (
  planting_id        uuid primary key references public.field_planting(planting_id) on delete cascade,
  organization_id    uuid not null references public.organization(organization_id) on delete cascade,
  yield_kg_da        numeric(8,1) not null check (yield_kg_da >= 0),
  harvested_area_da  numeric(10,2) check (harvested_area_da > 0),
  quantity_t         numeric(12,3) check (quantity_t >= 0),
  source             text not null default 'manual' check (source in ('agrovir_export','history_file','manual')),
  note               text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
comment on table public.planting_yield is 'Добив (факт) на култивационния период. yield_kg_da е основната стойност; площта и количеството може да липсват за стари години (история само с добив).';
comment on column public.planting_yield.yield_kg_da is 'kg/дка. Ако са известни прибрана площ и количество, трябва да е около quantity_t*1000/harvested_area_da (виж v_yield_history.yield_mismatch).';
comment on column public.planting_yield.source is 'agrovir_export = от AgroVIR/агро анализи; history_file = от архивен файл; manual = въведено ръчно.';
create index planting_yield_org on public.planting_yield (organization_id);

create trigger aa_planting_yield_org before insert or update on public.planting_yield
  for each row execute function app.inherit_org('field_planting', 'planting_id', 'planting_id');
create trigger planting_yield_touch before update on public.planting_yield
  for each row execute function app.touch_updated_at();
create trigger planting_yield_audit after insert or update or delete on public.planting_yield
  for each row execute function app.audit_row('planting_id');

alter table public.planting_yield enable row level security;
create policy planting_yield_select on public.planting_yield for select to authenticated using (organization_id in (select app.user_org_ids()));
create policy planting_yield_insert on public.planting_yield for insert to authenticated with check (app.can_edit(organization_id, app.planting_farm(planting_id)));
create policy planting_yield_update on public.planting_yield for update to authenticated using (app.can_edit(organization_id, app.planting_farm(planting_id))) with check (app.can_edit(organization_id, app.planting_farm(planting_id)));
create policy planting_yield_delete on public.planting_yield for delete to authenticated using (app.can_edit(organization_id, app.planting_farm(planting_id)));

revoke all on public.planting_yield from anon;
grant select, insert, update, delete on public.planting_yield to authenticated;

-- История на добивите за анализ: поле × година × култура.
create or replace view public.v_yield_history with (security_invoker = true) as
select
  c.planting_id, c.organization_id, c.field_id, c.season_id, c.season_label, c.season_year_end,
  c.farm_base_id, c.farm_base_name, c.settlement_name, c.field_name, c.isak_number,
  c.crop_id, c.crop_name, c.role, c.planted_area_da,
  y.yield_kg_da, y.harvested_area_da, y.quantity_t, y.source,
  p.sowing_date_actual, p.harvest_date_actual,
  case when y.harvested_area_da is not null and y.quantity_t is not null
        and abs(y.quantity_t * 1000 / y.harvested_area_da - y.yield_kg_da) > greatest(1, y.yield_kg_da * 0.02)
       then true else false end as yield_mismatch
from public.v_planting_context c
join public.field_planting p on p.planting_id = c.planting_id
join public.planting_yield y on y.planting_id = c.planting_id;
comment on view public.v_yield_history is 'Добиви по поле/година/култура. yield_mismatch = true, когато записаният kg/дка се различава с >2% от количество/площ.';
grant select on public.v_yield_history to authenticated;
