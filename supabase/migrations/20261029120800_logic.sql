-- Бизнес правила: проверки, тригери, функции за CNP.

-- ---------- Единицата трябва да съвпада с формата на продукта ----------
create or replace function app.enforce_unit_matches_form() returns trigger
language plpgsql as $$
declare v_form text;
begin
  select form into v_form from public.fertilizer_product where product_id = new.product_id;
  if v_form is null then
    raise exception '%: продуктът не е намерен', tg_table_name;
  end if;
  if (v_form = 'solid' and new.unit <> 'kg_da') or (v_form = 'liquid' and new.unit <> 'l_da') then
    raise exception '%: единицата % не съвпада с формата на продукта (%): твърд = kg_da, течен = l_da',
      tg_table_name, new.unit, v_form;
  end if;
  return new;
end $$;
create trigger stage_product_unit before insert or update on public.stage_product
  for each row execute function app.enforce_unit_matches_form();
create trigger cnp_stage_product_unit before insert or update on public.cnp_stage_product
  for each row execute function app.enforce_unit_matches_form();
create trigger fert_plan_line_unit before insert or update on public.fert_plan_line
  for each row execute function app.enforce_unit_matches_form();

-- ---------- Продуктът трябва да е допустим за етапа (stage_product) ----------
create or replace function app.enforce_product_allowed_cnp() returns trigger
language plpgsql as $$
declare v_stage smallint; v_farm uuid; v_ok boolean;
begin
  select s.stage_id, c.farm_base_id into v_stage, v_farm
    from public.cnp_stage s join public.cnp c on c.cnp_id = s.cnp_id
   where s.cnp_stage_id = new.cnp_stage_id;
  select exists (select 1 from public.stage_product sp
                  where sp.organization_id = new.organization_id and sp.stage_id = v_stage
                    and sp.product_id = new.product_id and sp.is_active
                    and (v_farm is null or sp.farm_base_id is null or sp.farm_base_id = v_farm))
    into v_ok;
  if not v_ok then
    raise exception 'Продуктът не е допустим за този етап (добави го в stage_product)';
  end if;
  return new;
end $$;
create trigger cnp_stage_product_allowed before insert or update of product_id on public.cnp_stage_product
  for each row execute function app.enforce_product_allowed_cnp();

create or replace function app.enforce_product_allowed_line() returns trigger
language plpgsql as $$
declare v_farm uuid; v_ok boolean;
begin
  select f.current_farm_base_id into v_farm
    from public.field_planting p
    join public.field_crop_year y on y.fcy_id = p.fcy_id
    join public.field f on f.field_id = y.field_id
   where p.planting_id = new.planting_id;
  select exists (select 1 from public.stage_product sp
                  where sp.organization_id = new.organization_id and sp.stage_id = new.stage_id
                    and sp.product_id = new.product_id and sp.is_active
                    and (v_farm is null or sp.farm_base_id is null or sp.farm_base_id = v_farm))
    into v_ok;
  if not v_ok then
    raise exception 'Продуктът не е допустим за този етап и стопанска база (добави го в stage_product)';
  end if;
  return new;
end $$;
create trigger fert_plan_line_allowed before insert or update of product_id, stage_id on public.fert_plan_line
  for each row execute function app.enforce_product_allowed_line();

-- ---------- Ред от плана: площ по подразбиране и флаг "отклонение" ----------
create or replace function app.fert_plan_line_defaults() returns trigger
language plpgsql as $$
begin
  if new.treated_area_da is null then
    select planted_area_da into new.treated_area_da
      from public.field_planting where planting_id = new.planting_id;
  end if;
  if new.source = 'cnp' then
    new.is_deviation := new.rate_per_da is distinct from new.cnp_rate_per_da;
  else
    new.is_deviation := false;
  end if;
  if tg_op = 'UPDATE' then
    new.updated_by := auth.uid();
    new.updated_at := now();
  end if;
  return new;
end $$;
create trigger fert_plan_line_defaults before insert or update on public.fert_plan_line
  for each row execute function app.fert_plan_line_defaults();

-- ---------- CNP се задава само на период със същата култура и година ----------
create or replace function app.enforce_assignment_match() returns trigger
language plpgsql as $$
declare v_pl_crop uuid; v_pl_season smallint; v_cnp_crop uuid; v_cnp_season smallint;
begin
  select p.crop_id, y.season_id into v_pl_crop, v_pl_season
    from public.field_planting p join public.field_crop_year y on y.fcy_id = p.fcy_id
   where p.planting_id = new.planting_id;
  select crop_id, season_id into v_cnp_crop, v_cnp_season from public.cnp where cnp_id = new.cnp_id;
  if v_pl_crop is distinct from v_cnp_crop then
    raise exception 'CNP е за друга култура от тази на периода';
  end if;
  if v_pl_season is distinct from v_cnp_season then
    raise exception 'CNP е за друга стопанска година от тази на периода';
  end if;
  return new;
end $$;
create trigger cnp_assignment_match before insert on public.cnp_assignment
  for each row execute function app.enforce_assignment_match();

-- ---------- Заключен период: без промени по него и по зависимите му редове ----------
create or replace function app.block_if_locked() returns trigger
language plpgsql as $$
declare v_pid uuid; v_locked boolean;
begin
  v_pid := (to_jsonb(case when tg_op = 'DELETE' then old else new end) ->> 'planting_id')::uuid;
  if tg_table_name = 'field_planting' and tg_op = 'UPDATE' then
    if old.is_locked then
      if not new.is_locked and app.is_admin(old.organization_id) then
        return new;  -- администратор отключва
      end if;
      raise exception 'Периодът е заключен';
    end if;
    return new;
  end if;
  select is_locked into v_locked from public.field_planting where planting_id = v_pid;
  if coalesce(v_locked, false) then
    raise exception 'Периодът е заключен';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger planting_lock before update or delete on public.field_planting
  for each row execute function app.block_if_locked();
create trigger planting_seed_lock before insert or update or delete on public.planting_seed
  for each row execute function app.block_if_locked();
create trigger fert_plan_line_lock before insert or update or delete on public.fert_plan_line
  for each row execute function app.block_if_locked();
create trigger cnp_assignment_lock before insert or update or delete on public.cnp_assignment
  for each row execute function app.block_if_locked();

-- ---------- Семена: сортът е на културата на периода ----------
create or replace function app.enforce_seed_crop() returns trigger
language plpgsql as $$
declare v_pl_crop uuid; v_var_crop uuid;
begin
  select crop_id into v_pl_crop from public.field_planting where planting_id = new.planting_id;
  select crop_id into v_var_crop from public.variety where variety_id = new.variety_id;
  if v_pl_crop is distinct from v_var_crop then
    raise exception 'Сортът е от друга култура от тази на периода';
  end if;
  return new;
end $$;
create trigger planting_seed_crop before insert or update of variety_id, planting_id on public.planting_seed
  for each row execute function app.enforce_seed_crop();

-- Сборът на площите по сортове не надвишава засетата площ (проверка в края на транзакцията).
create or replace function app.check_seed_area() returns trigger
language plpgsql as $$
declare v_pid uuid := new.planting_id; v_sum numeric; v_area numeric;
begin
  select coalesce(sum(area_da), 0) into v_sum from public.planting_seed where planting_id = v_pid;
  select planted_area_da into v_area from public.field_planting where planting_id = v_pid;
  if v_area is not null and v_sum > v_area + 0.005 then
    raise exception 'Сборът на площите по сортове (% дка) надвишава площта на периода (% дка)', v_sum, v_area;
  end if;
  return null;
end $$;
create constraint trigger planting_seed_area after insert or update on public.planting_seed
  deferrable initially deferred for each row execute function app.check_seed_area();
create constraint trigger planting_area_vs_seed after update of planted_area_da on public.field_planting
  deferrable initially deferred for each row execute function app.check_seed_area();

-- ---------- Одит ----------
create or replace function app.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_row jsonb := to_jsonb(case when tg_op = 'DELETE' then old else new end);
begin
  if tg_op = 'UPDATE' and (to_jsonb(old) - 'updated_at' - 'updated_by') = (to_jsonb(new) - 'updated_at' - 'updated_by') then
    return null;
  end if;
  insert into public.audit_log (organization_id, table_name, record_id, action, changed_by, old_values, new_values)
  values ((v_row ->> 'organization_id')::uuid, tg_table_name, (v_row ->> tg_argv[0])::uuid, lower(tg_op), auth.uid(),
          case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
          case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end);
  return null;
end $$;
create trigger cnp_audit after insert or update or delete on public.cnp
  for each row execute function app.audit_row('cnp_id');
create trigger cnp_stage_audit after insert or update or delete on public.cnp_stage
  for each row execute function app.audit_row('cnp_stage_id');
create trigger cnp_stage_product_audit after insert or update or delete on public.cnp_stage_product
  for each row execute function app.audit_row('cnp_stage_product_id');
create trigger cnp_assignment_audit after insert or update or delete on public.cnp_assignment
  for each row execute function app.audit_row('assignment_id');
create trigger fert_plan_line_audit after insert or update or delete on public.fert_plan_line
  for each row execute function app.audit_row('line_id');
create trigger stage_product_audit after insert or update or delete on public.stage_product
  for each row execute function app.audit_row('stage_product_id');
create trigger planting_seed_audit after insert or update or delete on public.planting_seed
  for each row execute function app.audit_row('planting_seed_id');
create trigger field_planting_audit after insert or update or delete on public.field_planting
  for each row execute function app.audit_row('planting_id');
create trigger fertilizer_product_audit after insert or update or delete on public.fertilizer_product
  for each row execute function app.audit_row('product_id');

-- ---------- CNP -> редове от плана ----------
-- Синхронизира редовете на един период с активното му задаване.
-- Ръчно променените редове (is_deviation) и ръчно добавените (source = manual) не се презаписват.
create or replace function app.sync_assignment(p_assignment_id uuid)
returns table (created int, kept_deviation int)
language plpgsql as $$
declare v_planting uuid; v_cnp uuid; v_created int := 0; v_kept int := 0;
begin
  select a.planting_id, a.cnp_id into v_planting, v_cnp
    from public.cnp_assignment a where a.assignment_id = p_assignment_id and a.is_active;
  if v_planting is null then
    raise exception 'Активно задаване % не е намерено', p_assignment_id;
  end if;

  delete from public.fert_plan_line l
   where l.planting_id = v_planting and l.source = 'cnp' and not l.is_deviation
     and not exists (select 1 from public.cnp_stage s
                       join public.cnp_stage_product sp on sp.cnp_stage_id = s.cnp_stage_id
                      where s.cnp_id = v_cnp and s.stage_id = l.stage_id and sp.product_id = l.product_id);

  with up as (
    insert into public.fert_plan_line as l
      (planting_id, stage_id, product_id, rate_per_da, unit, period_from, period_to,
       source, assignment_id, cnp_stage_product_id, cnp_rate_per_da)
    select v_planting, s.stage_id, sp.product_id, sp.rate_per_da, sp.unit, s.period_from, s.period_to,
           'cnp', p_assignment_id, sp.cnp_stage_product_id, sp.rate_per_da
      from public.cnp_stage s
      join public.cnp_stage_product sp on sp.cnp_stage_id = s.cnp_stage_id
     where s.cnp_id = v_cnp
    on conflict (planting_id, stage_id, product_id) do update set
      rate_per_da          = case when l.is_deviation then l.rate_per_da else excluded.rate_per_da end,
      unit                 = excluded.unit,
      period_from          = excluded.period_from,
      period_to            = excluded.period_to,
      assignment_id        = excluded.assignment_id,
      cnp_stage_product_id = excluded.cnp_stage_product_id,
      cnp_rate_per_da      = excluded.cnp_rate_per_da
    where l.source = 'cnp'
    returning (l.xmax = 0) as inserted, l.is_deviation
  )
  select count(*) filter (where inserted)::int, count(*) filter (where is_deviation)::int
    into v_created, v_kept from up;

  return query select v_created, v_kept;
end $$;

-- F4: масово задаване на CNP към периоди (замества активното задаване).
create or replace function public.assign_cnp(p_planting_ids uuid[], p_cnp_id uuid)
returns table (out_planting_id uuid, out_assignment_id uuid, lines_created int, lines_kept_deviation int)
language plpgsql as $$
declare v_status text; v_planting uuid; v_assignment uuid; r record;
begin
  select status into v_status from public.cnp where cnp_id = p_cnp_id;
  if v_status is null then
    raise exception 'CNP не е намерена или нямаш достъп';
  end if;
  if v_status <> 'active' then
    raise exception 'CNP не е активна (статус: %)', v_status;
  end if;
  foreach v_planting in array p_planting_ids loop
    update public.cnp_assignment a set is_active = false, replaced_at = now()
     where a.planting_id = v_planting and a.is_active;
    insert into public.cnp_assignment (planting_id, cnp_id) values (v_planting, p_cnp_id)
      returning cnp_assignment.assignment_id into v_assignment;
    select * into r from app.sync_assignment(v_assignment);
    out_planting_id := v_planting; out_assignment_id := v_assignment;
    lines_created := r.created; lines_kept_deviation := r.kept_deviation;
    return next;
  end loop;
end $$;

-- Прилага промените в CNP към всички периоди, на които е зададена (след потвърждение в интерфейса).
create or replace function public.sync_cnp(p_cnp_id uuid)
returns table (periods int, lines_created int, lines_kept_deviation int)
language plpgsql as $$
declare a record; r record; v_p int := 0; v_c int := 0; v_k int := 0;
begin
  for a in select assignment_id from public.cnp_assignment where cnp_id = p_cnp_id and is_active loop
    select * into r from app.sync_assignment(a.assignment_id);
    v_p := v_p + 1; v_c := v_c + r.created; v_k := v_k + r.kept_deviation;
  end loop;
  return query select v_p, v_c, v_k;
end $$;

-- Връща ред към нормата от CNP.
create or replace function public.revert_line_to_cnp(p_line_id uuid) returns void
language plpgsql as $$
begin
  update public.fert_plan_line set rate_per_da = cnp_rate_per_da
   where line_id = p_line_id and source = 'cnp' and cnp_rate_per_da is not null;
  if not found then
    raise exception 'Редът не е от CNP или няма норма за връщане';
  end if;
end $$;

-- F2: копиране на CNP (напр. към следваща стопанска година). Датите на етапите се изместват с разликата в годините.
create or replace function public.copy_cnp(p_cnp_id uuid, p_target_season_id smallint, p_name text default null)
returns uuid
language plpgsql as $$
declare v_new uuid; v_shift int; v_src_year smallint; v_dst_year smallint; v_stage record; v_new_stage uuid;
begin
  select s.year_end into v_src_year from public.cnp c join public.season s on s.season_id = c.season_id where c.cnp_id = p_cnp_id;
  select year_end into v_dst_year from public.season where season_id = p_target_season_id;
  if v_src_year is null or v_dst_year is null then
    raise exception 'CNP или целевата стопанска година не са намерени';
  end if;
  v_shift := v_dst_year - v_src_year;

  insert into public.cnp (organization_id, name, crop_id, season_id, company_id, farm_base_id,
                          target_yield_kg_da, status, copied_from_cnp_id, note)
  select organization_id, coalesce(p_name, name), crop_id, p_target_season_id, company_id, farm_base_id,
         target_yield_kg_da, 'draft', cnp_id, note
    from public.cnp where cnp_id = p_cnp_id
  returning cnp_id into v_new;

  for v_stage in select * from public.cnp_stage where cnp_id = p_cnp_id order by seq_no loop
    insert into public.cnp_stage (cnp_id, stage_id, seq_no, period_from, period_to, bbch_from, bbch_to)
    values (v_new, v_stage.stage_id, v_stage.seq_no,
            (v_stage.period_from + make_interval(years => v_shift))::date,
            (v_stage.period_to + make_interval(years => v_shift))::date,
            v_stage.bbch_from, v_stage.bbch_to)
    returning cnp_stage_id into v_new_stage;
    insert into public.cnp_stage_product (cnp_stage_id, product_id, rate_per_da, unit)
    select v_new_stage, product_id, rate_per_da, unit
      from public.cnp_stage_product where cnp_stage_id = v_stage.cnp_stage_id;
  end loop;
  return v_new;
end $$;
