-- Доставчици, оферти (ПРЗ и торове по сезон) и разходи към плановете.
-- Изисква 20261114180000 и 20261116120000. Не променя съществуващи таблици и изгледи.
-- Цените са в евро. Единица: l, kg или t (t само за торове).

create table public.supplier (
  supplier_id      uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organization(organization_id) on delete cascade,
  name             text not null check (length(btrim(name)) > 0),
  eik              text,
  note             text,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint supplier_unique unique (organization_id, name)
);
comment on table public.supplier is 'Доставчици на ПРЗ и торове (по организация).';

create table public.offer (
  offer_id         uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organization(organization_id) on delete cascade,
  season_id        smallint not null references public.season(season_id),
  module           text not null check (module in ('prz','fert')),
  supplier_id      uuid not null references public.supplier(supplier_id),
  offer_no         text,
  offer_date       date not null default current_date,
  valid_until      date,
  status           text not null default 'received' check (status in ('received','accepted','rejected')),
  note             text,
  created_by       uuid default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint offer_dates check (valid_until is null or valid_until >= offer_date)
);
comment on table public.offer is 'Оферта от доставчик за модул ПРЗ или торове и сезон. Редовете са цени по продукт (евро).';
create index offer_season on public.offer (organization_id, season_id, module);

create table public.offer_line (
  offer_line_id         uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organization(organization_id) on delete cascade,
  offer_id              uuid not null references public.offer(offer_id) on delete cascade,
  season_id             smallint not null references public.season(season_id),
  prz_product_id        uuid references public.prz_product(prz_product_id),
  fertilizer_product_id uuid references public.fertilizer_product(product_id),
  price                 numeric(12,4) not null check (price > 0),
  price_unit            text not null check (price_unit in ('l','kg','t')),
  is_preferred          boolean not null default false,
  note                  text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint offer_line_one_product check ((prz_product_id is null) <> (fertilizer_product_id is null)),
  constraint offer_line_prz_unit check (prz_product_id is null or price_unit in ('l','kg'))
);
comment on table public.offer_line is 'Ред от оферта: цена на продукт в евро за единицата price_unit. Основна (is_preferred) е най-много една за продукт и сезон; ако няма основна, се ползва най-ниската от неотхвърлените оферти.';
create unique index offer_line_prz_uq on public.offer_line (offer_id, prz_product_id) where prz_product_id is not null;
create unique index offer_line_fert_uq on public.offer_line (offer_id, fertilizer_product_id) where fertilizer_product_id is not null;
create unique index offer_line_prz_pref on public.offer_line (season_id, prz_product_id) where is_preferred and prz_product_id is not null;
create unique index offer_line_fert_pref on public.offer_line (season_id, fertilizer_product_id) where is_preferred and fertilizer_product_id is not null;
create index offer_line_offer on public.offer_line (offer_id);

-- организацията и сезонът на реда идват от офертата; офертата и доставчикът са от една организация
create or replace function app.offer_line_defaults() returns trigger
language plpgsql as $$
declare o public.offer%rowtype;
begin
  select * into o from public.offer where offer_id = new.offer_id;
  if not found then raise exception 'Офертата не е намерена'; end if;
  new.organization_id := o.organization_id;
  new.season_id := o.season_id;
  if o.module = 'prz' and new.prz_product_id is null then raise exception 'Оферта за ПРЗ приема само ПРЗ продукти'; end if;
  if o.module = 'fert' and new.fertilizer_product_id is null then raise exception 'Оферта за торове приема само торове'; end if;
  return new;
end $$;
create or replace function app.offer_check_supplier() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from public.supplier s where s.supplier_id = new.supplier_id and s.organization_id = new.organization_id) then
    raise exception 'Доставчикът е от друга организация';
  end if;
  return new;
end $$;
create trigger offer_supplier before insert or update on public.offer for each row execute function app.offer_check_supplier();
create trigger aa_offer_line_defaults before insert or update on public.offer_line for each row execute function app.offer_line_defaults();
create trigger supplier_touch before update on public.supplier for each row execute function app.touch_updated_at();
create trigger offer_touch before update on public.offer for each row execute function app.touch_updated_at();
create trigger offer_line_touch before update on public.offer_line for each row execute function app.touch_updated_at();
create trigger supplier_audit after insert or update or delete on public.supplier for each row execute function app.audit_row('supplier_id');
create trigger offer_audit after insert or update or delete on public.offer for each row execute function app.audit_row('offer_id');
create trigger offer_line_audit after insert or update or delete on public.offer_line for each row execute function app.audit_row('offer_line_id');

-- „основна“ цена: при отбелязване се снема от останалите за същия продукт и сезон
create or replace function app.price_single_preferred() returns trigger
language plpgsql as $$
begin
  if new.is_preferred then
    update public.offer_line p set is_preferred = false
     where p.offer_line_id <> new.offer_line_id and p.is_preferred and p.season_id = new.season_id
       and p.prz_product_id is not distinct from new.prz_product_id
       and p.fertilizer_product_id is not distinct from new.fertilizer_product_id;
  end if;
  return new;
end $$;
create trigger offer_line_pref before insert or update of is_preferred on public.offer_line
  for each row execute function app.price_single_preferred();

alter table public.supplier enable row level security;
alter table public.offer enable row level security;
alter table public.offer_line enable row level security;
create policy supplier_select on public.supplier for select to authenticated using (organization_id in (select app.user_org_ids()));
create policy supplier_insert on public.supplier for insert to authenticated with check (app.can_edit(organization_id));
create policy supplier_update on public.supplier for update to authenticated using (app.can_edit(organization_id)) with check (app.can_edit(organization_id));
create policy supplier_delete on public.supplier for delete to authenticated using (app.can_edit(organization_id));
create policy offer_select on public.offer for select to authenticated using (organization_id in (select app.user_org_ids()));
create policy offer_insert on public.offer for insert to authenticated with check (app.can_edit(organization_id));
create policy offer_update on public.offer for update to authenticated using (app.can_edit(organization_id)) with check (app.can_edit(organization_id));
create policy offer_delete on public.offer for delete to authenticated using (app.can_edit(organization_id));
create policy offer_line_select on public.offer_line for select to authenticated using (organization_id in (select app.user_org_ids()));
create policy offer_line_insert on public.offer_line for insert to authenticated with check (app.can_edit(organization_id));
create policy offer_line_update on public.offer_line for update to authenticated using (app.can_edit(organization_id)) with check (app.can_edit(organization_id));
create policy offer_line_delete on public.offer_line for delete to authenticated using (app.can_edit(organization_id));

-- ефективна цена: основната, иначе от приета оферта, иначе най-ниската (по нормализирана цена на кг/л); отхвърлените оферти не се броят
create or replace view public.v_product_price_effective with (security_invoker = true) as
select distinct on (l.organization_id, l.season_id, l.prz_product_id, l.fertilizer_product_id)
       l.organization_id, l.season_id, l.prz_product_id, l.fertilizer_product_id,
       l.offer_line_id, o.offer_id, o.offer_no, o.supplier_id, s.name as supplier_name, l.price, l.price_unit, l.is_preferred,
       count(*) over (partition by l.organization_id, l.season_id, l.prz_product_id, l.fertilizer_product_id) as n_offers
  from public.offer_line l
  join public.offer o on o.offer_id = l.offer_id and o.status <> 'rejected'
  join public.supplier s on s.supplier_id = o.supplier_id
 order by l.organization_id, l.season_id, l.prz_product_id, l.fertilizer_product_id,
          l.is_preferred desc, (o.status = 'accepted') desc, (l.price / case l.price_unit when 't' then 1000 else 1 end), l.offer_line_id;

-- разход по ПРЗ (един ред = един назначен продукт на БЗС)
create or replace view public.v_prz_cost with (security_invoker = true) as
select c.planting_prz_id, c.organization_id, c.season_id, c.planting_id, c.field_id, c.field_name, c.crop_id, c.crop_name,
       c.farm_base_id, c.farm_base_name, c.company_id, c.company_name, c.stage, c.prz_product_id, c.trade_name,
       c.dose_per_da, c.dose_unit, c.area_da, c.qty_total, c.qty_unit,
       e.supplier_name, e.price, e.price_unit,
       case when e.price is null then null when e.price_unit = c.qty_unit then round(c.qty_total * e.price, 2) end as cost_eur,
       case when e.price is null then null else round(case when e.price_unit = c.qty_unit then c.qty_total * e.price end / nullif(c.area_da, 0), 2) end as cost_eur_da,
       (e.price is not null and e.price_unit <> c.qty_unit) as price_unit_mismatch
  from public.v_prz_calc c
  left join public.v_product_price_effective e
    on e.organization_id = c.organization_id and e.season_id = c.season_id and e.prz_product_id = c.prz_product_id;

-- разход по торове (един ред = един ред от плана за торене)
create or replace view public.v_fert_cost with (security_invoker = true) as
select k.line_id, k.organization_id, x.season_id, k.planting_id, x.field_id, x.field_name, x.crop_id, x.crop_name,
       x.farm_base_id, x.farm_base_name, x.company_id, x.company_name, k.stage_id, k.product_id, k.product_name, k.form,
       k.rate_per_da, k.unit, k.treated_area_da, k.quantity_kg, k.quantity_t, k.quantity_native,
       e.supplier_name, e.price, e.price_unit,
       case e.price_unit
         when 't'  then round(k.quantity_t * e.price, 2)
         when 'kg' then round(k.quantity_kg * e.price, 2)
         when 'l'  then case when k.form = 'liquid' then round(k.quantity_native * e.price, 2) end
       end as cost_eur,
       (e.price is not null and e.price_unit = 'l' and k.form <> 'liquid') as price_unit_mismatch
  from public.v_fert_plan_calc k
  join public.v_planting_context x on x.planting_id = k.planting_id
  left join public.v_product_price_effective e
    on e.organization_id = k.organization_id and e.season_id = x.season_id and e.fertilizer_product_id = k.product_id;
