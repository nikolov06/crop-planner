-- Бърз импорт на сортове в „Планиране семена“:
-- добавка към сорта, норма по подразбиране за сорт, псевдоними на сортове,
-- лог на импортите с предишните стойности и RPC за запис/отмяна в една транзакция.

-- ---------- Нови полета ----------
alter table public.planting_seed add column if not exists addon text;
comment on column public.planting_seed.addon is 'Добавка/технология към сорта (напр. „Артемид“ от „P64 LE 162 + Артемид“).';

alter table public.variety add column if not exists default_rate numeric(12,2) check (default_rate > 0);
comment on column public.variety.default_rate is 'Норма по подразбиране за сорта в мерната единица на културата (crop.rate_basis: кълняеми семена/м² или семена/дка).';

-- ---------- Помощна функция: има ли потребителят право да редактира в някоя организация ----------
create or replace function app.is_any_editor() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_user_role r where r.user_id = auth.uid() and r.role in ('admin','agronomist'))
$$;

-- ---------- Псевдоними на сортове ----------
create table public.variety_alias (
  alias_id         uuid primary key default gen_random_uuid(),
  crop_id          uuid not null references public.crop(crop_id),
  alias_normalized text not null,
  alias_raw        text not null,
  variety_id       uuid not null references public.variety(variety_id) on delete cascade,
  created_by       uuid default auth.uid() references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  unique (crop_id, alias_normalized)
);
comment on table public.variety_alias is 'Друго изписване на сорт/хибрид (от Excel, ChatGPT), потвърдено ръчно при импорт. alias_normalized: главни букви, без интервали, точки и тирета.';
create index variety_alias_variety on public.variety_alias (variety_id);

create or replace function app.variety_alias_check() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from public.variety v where v.variety_id = new.variety_id and v.crop_id = new.crop_id) then
    raise exception 'Псевдонимът „%“ е за друга култура от сорта', new.alias_raw;
  end if;
  return new;
end $$;
create trigger variety_alias_check before insert or update on public.variety_alias
  for each row execute function app.variety_alias_check();

alter table public.variety_alias enable row level security;
create policy variety_alias_select on public.variety_alias for select to authenticated using (true);
create policy variety_alias_insert on public.variety_alias for insert to authenticated with check (app.is_any_editor());
create policy variety_alias_update on public.variety_alias for update to authenticated using (app.is_any_editor()) with check (app.is_any_editor());
create policy variety_alias_delete on public.variety_alias for delete to authenticated using (app.is_any_admin());
revoke all on public.variety_alias from anon;
grant select, insert, update, delete on public.variety_alias to authenticated;

-- ---------- Лог на импортите ----------
create table public.seed_import (
  import_id        uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organization(organization_id) on delete cascade,
  season_id        smallint not null references public.season(season_id),
  scope            jsonb not null default '{}'::jsonb,
  file_name        text,
  rows_in_file     integer not null default 0,
  rows_applied     integer not null default 0,
  overwrite        boolean not null default false,
  created_by       uuid default auth.uid() references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  undone_at        timestamptz,
  undone_by        uuid references auth.users(id) on delete set null
);
comment on table public.seed_import is 'Масов импорт на сортове от таблица: кой, кога, сезон, обхват (култура/фирма/база), брой редове.';
create index seed_import_org_season on public.seed_import (organization_id, season_id, created_at desc);

create table public.seed_import_item (
  item_id          uuid primary key default gen_random_uuid(),
  import_id        uuid not null references public.seed_import(import_id) on delete cascade,
  organization_id  uuid not null references public.organization(organization_id) on delete cascade,
  planting_id      uuid not null references public.field_planting(planting_id) on delete cascade,
  source_name      text,
  variety_id       uuid not null references public.variety(variety_id),
  target_rate      numeric(12,2) not null,
  addon            text,
  new_seed_id      uuid not null,
  prev_rows        jsonb not null default '[]'::jsonb,
  unique (import_id, planting_id)
);
comment on table public.seed_import_item is 'Ред от импорта: какво е записано за периода и какви са били предишните редове в planting_seed (за отмяна).';
create index seed_import_item_import on public.seed_import_item (import_id);

alter table public.seed_import enable row level security;
create policy seed_import_select on public.seed_import for select to authenticated using (organization_id in (select app.user_org_ids()));
create policy seed_import_insert on public.seed_import for insert to authenticated with check (app.can_edit(organization_id));
create policy seed_import_update on public.seed_import for update to authenticated using (app.can_edit(organization_id)) with check (app.can_edit(organization_id));
alter table public.seed_import_item enable row level security;
create policy seed_import_item_select on public.seed_import_item for select to authenticated using (organization_id in (select app.user_org_ids()));
create policy seed_import_item_insert on public.seed_import_item for insert to authenticated with check (app.can_edit(organization_id, app.planting_farm(planting_id)));
revoke all on public.seed_import, public.seed_import_item from anon;
grant select, insert, update on public.seed_import to authenticated;
grant select, insert on public.seed_import_item to authenticated;

-- ---------- Норма по подразбиране за сорт („Запомни за хибрида“) ----------
-- security definer: variety_update по RLS е само за администратор, а нормата от импорта може да запише и агроном.
-- Проверява ролята (admin/agronomist) в организацията на импорта и променя САМО variety.default_rate.
-- search_path = '' (както всички функции в app): всички имена са с пълна схема, нищо не се търси в public.
create or replace function app.set_variety_default_rates(p_org uuid, p_rates jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  r   jsonb;
  v_n integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Нужен е вход в системата';
  end if;
  if not exists (select 1 from public.app_user_role u
                  where u.user_id = auth.uid() and u.organization_id = p_org and u.role in ('admin', 'agronomist')) then
    raise exception 'Нямаш право за редакция в тази организация';
  end if;
  for r in select * from jsonb_array_elements(coalesce(p_rates, '[]'::jsonb)) loop
    if coalesce((r->>'rate')::numeric, 0) <= 0 then
      raise exception 'Невалидна норма за сорт %', r->>'variety_id';
    end if;
    update public.variety set default_rate = (r->>'rate')::numeric
     where variety_id = (r->>'variety_id')::uuid;
    if not found then
      raise exception 'Сортът % не съществува', r->>'variety_id';
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
revoke all on function app.set_variety_default_rates(uuid, jsonb) from public, anon;
grant execute on function app.set_variety_default_rates(uuid, jsonb) to authenticated;

-- ---------- Запис на импорта (всичко или нищо) ----------
-- security invoker: изтриването и записът в planting_seed минават през текущите RLS правила.
-- p_items: [{planting_id, variety_id, target_rate, addon, source_name}]
-- p_aliases: [{alias_normalized, alias_raw, variety_id}], p_rates: [{variety_id, rate}]
create or replace function public.apply_seed_import(
  p_season_id smallint, p_scope jsonb, p_file_name text, p_rows_in_file integer, p_overwrite boolean,
  p_items jsonb, p_aliases jsonb default '[]'::jsonb, p_rates jsonb default '[]'::jsonb
) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  v_import uuid;
  v_org    uuid;
  v_orgs   integer;
  it       jsonb;
  v_pl     record;
  v_var    record;
  v_prev   jsonb;
  v_batch  uuid;
  v_origin text;
  v_over   numeric;
  v_note   text;
  v_new    uuid;
  v_n      integer := 0;
begin
  if auth.uid() is null then raise exception 'Нужен е вход в системата'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Няма редове за запис'; end if;

  if (select count(*) from jsonb_array_elements(p_items) e) <>
     (select count(distinct e->>'planting_id') from jsonb_array_elements(p_items) e) then
    raise exception 'Едно и също БЗС се среща повече от веднъж в импорта';
  end if;

  select count(distinct p.organization_id), min(p.organization_id::text)::uuid into v_orgs, v_org
    from jsonb_array_elements(p_items) e
    join public.field_planting p on p.planting_id = (e->>'planting_id')::uuid;
  if v_orgs <> 1 then raise exception 'Импортът трябва да е в рамките на една организация'; end if;

  -- норми само за сортове, които са в самия импорт
  if exists (select 1 from jsonb_array_elements(coalesce(p_rates, '[]'::jsonb)) r
              where not exists (select 1 from jsonb_array_elements(p_items) e where e->>'variety_id' = r->>'variety_id')) then
    raise exception 'Норма за хибрид, който не е в импорта';
  end if;
  perform app.set_variety_default_rates(v_org, p_rates);

  -- псевдоними: през RLS на variety_alias (всеки с право за редакция)
  insert into public.variety_alias (crop_id, alias_normalized, alias_raw, variety_id)
  select v.crop_id, a->>'alias_normalized', a->>'alias_raw', v.variety_id
    from jsonb_array_elements(coalesce(p_aliases, '[]'::jsonb)) a
    join public.variety v on v.variety_id = (a->>'variety_id')::uuid
  on conflict (crop_id, alias_normalized)
    do update set variety_id = excluded.variety_id, alias_raw = excluded.alias_raw, created_by = auth.uid(), created_at = now();

  insert into public.seed_import (organization_id, season_id, scope, file_name, rows_in_file, overwrite)
  values (v_org, p_season_id, coalesce(p_scope, '{}'::jsonb), p_file_name, coalesce(p_rows_in_file, 0), coalesce(p_overwrite, false))
  returning import_id into v_import;

  for it in select * from jsonb_array_elements(p_items) loop
    select p.planting_id, p.organization_id, p.crop_id, p.role, p.planted_area_da, y.season_id, y.field_name
      into v_pl
      from public.field_planting p join public.field_crop_year y on y.fcy_id = p.fcy_id
     where p.planting_id = (it->>'planting_id')::uuid
     for update of p;
    if not found then raise exception 'БЗС (%) не е намерено или няма достъп', it->>'source_name'; end if;
    if v_pl.season_id <> p_season_id then raise exception '„%“ не е от избрания сезон', v_pl.field_name; end if;
    if v_pl.role <> 'main' then raise exception '„%“: импортът е само за основната култура', v_pl.field_name; end if;
    if coalesce(v_pl.planted_area_da, 0) <= 0 then raise exception '„%“ няма засята площ', v_pl.field_name; end if;

    select v.variety_id, v.crop_id, v.name into v_var from public.variety v where v.variety_id = (it->>'variety_id')::uuid;
    if not found then raise exception '„%“: сортът не е намерен', v_pl.field_name; end if;
    if v_var.crop_id <> v_pl.crop_id then raise exception '„%“: сортът „%“ е от друга култура', v_pl.field_name, v_var.name; end if;
    if coalesce((it->>'target_rate')::numeric, 0) <= 0 then raise exception '„%“: липсва норма', v_pl.field_name; end if;

    select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at), '[]'::jsonb) into v_prev
      from public.planting_seed s where s.planting_id = v_pl.planting_id;
    if jsonb_array_length(v_prev) > 0 and not coalesce(p_overwrite, false) then
      raise exception '„%“ вече има назначен сорт (не е отметнато „Презапиши вече назначените“)', v_pl.field_name;
    end if;

    -- партидата, произходът и преразходът се запазват само ако сортът е същият и редът е един
    v_batch := null; v_origin := null; v_over := null; v_note := null;
    if jsonb_array_length(v_prev) = 1 and (v_prev->0->>'variety_id')::uuid = v_var.variety_id then
      v_batch  := (v_prev->0->>'batch_id')::uuid;
      v_origin := v_prev->0->>'seed_origin';
      v_over   := (v_prev->0->>'overage_pct')::numeric;
      v_note   := v_prev->0->>'note';
    end if;

    delete from public.planting_seed where planting_id = v_pl.planting_id;
    insert into public.planting_seed (organization_id, planting_id, variety_id, batch_id, area_da, target_rate,
                                      overage_pct, seed_origin, note, addon)
    values (v_pl.organization_id, v_pl.planting_id, v_var.variety_id, v_batch, v_pl.planted_area_da,
            (it->>'target_rate')::numeric, v_over, v_origin, v_note, nullif(trim(it->>'addon'), ''))
    returning planting_seed_id into v_new;

    insert into public.seed_import_item (import_id, organization_id, planting_id, source_name, variety_id, target_rate, addon, new_seed_id, prev_rows)
    values (v_import, v_pl.organization_id, v_pl.planting_id, it->>'source_name', v_var.variety_id,
            (it->>'target_rate')::numeric, nullif(trim(it->>'addon'), ''), v_new, v_prev);
    v_n := v_n + 1;
  end loop;

  update public.seed_import set rows_applied = v_n where import_id = v_import;
  return v_import;
end $$;
revoke all on function public.apply_seed_import(smallint, jsonb, text, integer, boolean, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.apply_seed_import(smallint, jsonb, text, integer, boolean, jsonb, jsonb, jsonb) to authenticated;

-- ---------- Отмяна на последния импорт ----------
-- Отменя се само последният неотменен импорт за организацията и сезона, и само ако
-- записаното от него не е променяно след това.
create or replace function public.undo_seed_import(p_import_id uuid) returns integer
language plpgsql security invoker set search_path = '' as $$
declare
  v_imp  record;
  it     record;
  v_n    integer := 0;
begin
  if auth.uid() is null then raise exception 'Нужен е вход в системата'; end if;
  select * into v_imp from public.seed_import where import_id = p_import_id for update;
  if not found then raise exception 'Импортът не е намерен'; end if;
  if v_imp.undone_at is not null then raise exception 'Импортът вече е отменен'; end if;
  if exists (select 1 from public.seed_import i
              where i.organization_id = v_imp.organization_id and i.season_id = v_imp.season_id
                and i.undone_at is null and i.created_at > v_imp.created_at) then
    raise exception 'Може да се отмени само последният импорт за сезона';
  end if;

  for it in select * from public.seed_import_item where import_id = p_import_id loop
    if (select count(*) from public.planting_seed s where s.planting_id = it.planting_id) <> 1
       or not exists (select 1 from public.planting_seed s
                       where s.planting_seed_id = it.new_seed_id and s.updated_at = s.created_at) then
      raise exception 'Семената за „%“ са променяни след импорта – отмяната е спряна', coalesce(it.source_name, it.planting_id::text);
    end if;
    delete from public.planting_seed where planting_id = it.planting_id;
    insert into public.planting_seed
    select * from jsonb_populate_recordset(null::public.planting_seed, it.prev_rows);
    v_n := v_n + 1;
  end loop;

  update public.seed_import set undone_at = now(), undone_by = auth.uid() where import_id = p_import_id;
  return v_n;
end $$;
revoke all on function public.undo_seed_import(uuid) from public, anon;
grant execute on function public.undo_seed_import(uuid) to authenticated;
