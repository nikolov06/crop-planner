-- Row Level Security.
-- Модел: данните са по организация (tenant). admin и agronomist редактират; viewer чете.
-- Агрономът може да е стеснен до една стопанска база (app_user_role.farm_base_id).

-- ---------- Помощни функции за базата на реда ----------
create or replace function app.field_farm(p_field uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select current_farm_base_id from public.field where field_id = p_field
$$;
create or replace function app.fcy_farm(p_fcy uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select f.current_farm_base_id from public.field_crop_year y join public.field f on f.field_id = y.field_id
   where y.fcy_id = p_fcy
$$;
create or replace function app.planting_farm(p_planting uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select f.current_farm_base_id
    from public.field_planting p
    join public.field_crop_year y on y.fcy_id = p.fcy_id
    join public.field f on f.field_id = y.field_id
   where p.planting_id = p_planting
$$;
create or replace function app.cnp_farm(p_cnp uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select farm_base_id from public.cnp where cnp_id = p_cnp
$$;
create or replace function app.cnp_stage_farm(p_stage uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select c.farm_base_id from public.cnp_stage s join public.cnp c on c.cnp_id = s.cnp_id where s.cnp_stage_id = p_stage
$$;

-- ---------- Глобални справочници: четене за всички вписани; запис само за администратори ----------
alter table public.crop enable row level security;
create policy crop_select on public.crop for select to authenticated using (true);
create policy crop_insert on public.crop for insert to authenticated with check (app.is_any_admin());
create policy crop_update on public.crop for update to authenticated using (app.is_any_admin()) with check (app.is_any_admin());
create policy crop_delete on public.crop for delete to authenticated using (app.is_any_admin());
alter table public.season enable row level security;
create policy season_select on public.season for select to authenticated using (true);
create policy season_insert on public.season for insert to authenticated with check (app.is_any_admin());
create policy season_update on public.season for update to authenticated using (app.is_any_admin()) with check (app.is_any_admin());
create policy season_delete on public.season for delete to authenticated using (app.is_any_admin());
alter table public.settlement enable row level security;
create policy settlement_select on public.settlement for select to authenticated using (true);
create policy settlement_insert on public.settlement for insert to authenticated with check (app.is_any_admin());
create policy settlement_update on public.settlement for update to authenticated using (app.is_any_admin()) with check (app.is_any_admin());
create policy settlement_delete on public.settlement for delete to authenticated using (app.is_any_admin());
alter table public.potential_class enable row level security;
create policy potential_class_select on public.potential_class for select to authenticated using (true);
create policy potential_class_insert on public.potential_class for insert to authenticated with check (app.is_any_admin());
create policy potential_class_update on public.potential_class for update to authenticated using (app.is_any_admin()) with check (app.is_any_admin());
create policy potential_class_delete on public.potential_class for delete to authenticated using (app.is_any_admin());
alter table public.tillage_type enable row level security;
create policy tillage_type_select on public.tillage_type for select to authenticated using (true);
create policy tillage_type_insert on public.tillage_type for insert to authenticated with check (app.is_any_admin());
create policy tillage_type_update on public.tillage_type for update to authenticated using (app.is_any_admin()) with check (app.is_any_admin());
create policy tillage_type_delete on public.tillage_type for delete to authenticated using (app.is_any_admin());
alter table public.reproduction enable row level security;
create policy reproduction_select on public.reproduction for select to authenticated using (true);
create policy reproduction_insert on public.reproduction for insert to authenticated with check (app.is_any_admin());
create policy reproduction_update on public.reproduction for update to authenticated using (app.is_any_admin()) with check (app.is_any_admin());
create policy reproduction_delete on public.reproduction for delete to authenticated using (app.is_any_admin());
alter table public.variety enable row level security;
create policy variety_select on public.variety for select to authenticated using (true);
create policy variety_insert on public.variety for insert to authenticated with check (app.is_any_admin());
create policy variety_update on public.variety for update to authenticated using (app.is_any_admin()) with check (app.is_any_admin());
create policy variety_delete on public.variety for delete to authenticated using (app.is_any_admin());
alter table public.fertilization_stage enable row level security;
create policy fertilization_stage_select on public.fertilization_stage for select to authenticated using (true);
create policy fertilization_stage_insert on public.fertilization_stage for insert to authenticated with check (app.is_any_admin());
create policy fertilization_stage_update on public.fertilization_stage for update to authenticated using (app.is_any_admin()) with check (app.is_any_admin());
create policy fertilization_stage_delete on public.fertilization_stage for delete to authenticated using (app.is_any_admin());
alter table public.fertilizer_product enable row level security;
create policy fertilizer_product_select on public.fertilizer_product for select to authenticated using (true);
create policy fertilizer_product_insert on public.fertilizer_product for insert to authenticated with check (app.is_any_admin());
create policy fertilizer_product_update on public.fertilizer_product for update to authenticated using (app.is_any_admin()) with check (app.is_any_admin());
create policy fertilizer_product_delete on public.fertilizer_product for delete to authenticated using (app.is_any_admin());
alter table public.diversification_rule enable row level security;
create policy diversification_rule_select on public.diversification_rule for select to authenticated using (true);
create policy diversification_rule_insert on public.diversification_rule for insert to authenticated with check (app.is_any_admin());
create policy diversification_rule_update on public.diversification_rule for update to authenticated using (app.is_any_admin()) with check (app.is_any_admin());
create policy diversification_rule_delete on public.diversification_rule for delete to authenticated using (app.is_any_admin());
alter table public.diversification_rule_crop enable row level security;
create policy diversification_rule_crop_select on public.diversification_rule_crop for select to authenticated using (true);
create policy diversification_rule_crop_insert on public.diversification_rule_crop for insert to authenticated with check (app.is_any_admin());
create policy diversification_rule_crop_update on public.diversification_rule_crop for update to authenticated using (app.is_any_admin()) with check (app.is_any_admin());
create policy diversification_rule_crop_delete on public.diversification_rule_crop for delete to authenticated using (app.is_any_admin());

-- ---------- Организации ----------
alter table public.organization enable row level security;
create policy organization_select on public.organization for select to authenticated
  using (organization_id in (select app.user_org_ids()));
create policy organization_update on public.organization for update to authenticated
  using (app.is_admin(organization_id)) with check (app.is_admin(organization_id));
create policy organization_delete on public.organization for delete to authenticated
  using (app.is_admin(organization_id));

alter table public.company enable row level security;
create policy company_select on public.company for select to authenticated using (organization_id in (select app.user_org_ids()));
create policy company_insert on public.company for insert to authenticated with check (app.is_admin(organization_id));
create policy company_update on public.company for update to authenticated using (app.is_admin(organization_id)) with check (app.is_admin(organization_id));
create policy company_delete on public.company for delete to authenticated using (app.is_admin(organization_id));
alter table public.farm_base enable row level security;
create policy farm_base_select on public.farm_base for select to authenticated using (organization_id in (select app.user_org_ids()));
create policy farm_base_insert on public.farm_base for insert to authenticated with check (app.is_admin(organization_id));
create policy farm_base_update on public.farm_base for update to authenticated using (app.is_admin(organization_id)) with check (app.is_admin(organization_id));
create policy farm_base_delete on public.farm_base for delete to authenticated using (app.is_admin(organization_id));

alter table public.app_user_role enable row level security;
create policy app_user_role_select on public.app_user_role for select to authenticated
  using (user_id = auth.uid() or app.is_admin(organization_id));
create policy app_user_role_insert on public.app_user_role for insert to authenticated
  with check (app.is_admin(organization_id));
create policy app_user_role_update on public.app_user_role for update to authenticated
  using (app.is_admin(organization_id)) with check (app.is_admin(organization_id));
create policy app_user_role_delete on public.app_user_role for delete to authenticated
  using (app.is_admin(organization_id));

alter table public.app_setting enable row level security;
create policy app_setting_select on public.app_setting for select to authenticated
  using (organization_id is null or organization_id in (select app.user_org_ids()));
create policy app_setting_insert on public.app_setting for insert to authenticated
  with check ((organization_id is not null and app.is_admin(organization_id)) or (organization_id is null and app.is_any_admin()));
create policy app_setting_update on public.app_setting for update to authenticated
  using ((organization_id is not null and app.is_admin(organization_id)) or (organization_id is null and app.is_any_admin()))
  with check ((organization_id is not null and app.is_admin(organization_id)) or (organization_id is null and app.is_any_admin()));
create policy app_setting_delete on public.app_setting for delete to authenticated
  using ((organization_id is not null and app.is_admin(organization_id)) or (organization_id is null and app.is_any_admin()));

-- ---------- Данни на организацията ----------
alter table public.field enable row level security;
create policy field_select on public.field for select to authenticated using (organization_id in (select app.user_org_ids()));
create policy field_insert on public.field for insert to authenticated with check (app.can_edit(organization_id, current_farm_base_id));
create policy field_update on public.field for update to authenticated using (app.can_edit(organization_id, current_farm_base_id)) with check (app.can_edit(organization_id, current_farm_base_id));
create policy field_delete on public.field for delete to authenticated using (app.can_edit(organization_id, current_farm_base_id));
alter table public.field_lineage enable row level security;
create policy field_lineage_select on public.field_lineage for select to authenticated using (organization_id in (select app.user_org_ids()));
create policy field_lineage_insert on public.field_lineage for insert to authenticated with check (app.can_edit(organization_id, app.field_farm(child_field_id)));
create policy field_lineage_update on public.field_lineage for update to authenticated using (app.can_edit(organization_id, app.field_farm(child_field_id))) with check (app.can_edit(organization_id, app.field_farm(child_field_id)));
create policy field_lineage_delete on public.field_lineage for delete to authenticated using (app.can_edit(organization_id, app.field_farm(child_field_id)));
alter table public.field_base enable row level security;
create policy field_base_select on public.field_base for select to authenticated using (organization_id in (select app.user_org_ids()));
create policy field_base_insert on public.field_base for insert to authenticated with check (app.can_edit(organization_id, farm_base_id));
create policy field_base_update on public.field_base for update to authenticated using (app.can_edit(organization_id, farm_base_id)) with check (app.can_edit(organization_id, farm_base_id));
create policy field_base_delete on public.field_base for delete to authenticated using (app.can_edit(organization_id, farm_base_id));
alter table public.field_crop_year enable row level security;
create policy field_crop_year_select on public.field_crop_year for select to authenticated using (organization_id in (select app.user_org_ids()));
create policy field_crop_year_insert on public.field_crop_year for insert to authenticated with check (app.can_edit(organization_id, app.field_farm(field_id)));
create policy field_crop_year_update on public.field_crop_year for update to authenticated using (app.can_edit(organization_id, app.field_farm(field_id))) with check (app.can_edit(organization_id, app.field_farm(field_id)));
create policy field_crop_year_delete on public.field_crop_year for delete to authenticated using (app.can_edit(organization_id, app.field_farm(field_id)));
alter table public.field_planting enable row level security;
create policy field_planting_select on public.field_planting for select to authenticated using (organization_id in (select app.user_org_ids()));
create policy field_planting_insert on public.field_planting for insert to authenticated with check (app.can_edit(organization_id, app.fcy_farm(fcy_id)));
create policy field_planting_update on public.field_planting for update to authenticated using (app.can_edit(organization_id, app.fcy_farm(fcy_id))) with check (app.can_edit(organization_id, app.fcy_farm(fcy_id)));
create policy field_planting_delete on public.field_planting for delete to authenticated using (app.can_edit(organization_id, app.fcy_farm(fcy_id)));
alter table public.seed_batch enable row level security;
create policy seed_batch_select on public.seed_batch for select to authenticated using (organization_id in (select app.user_org_ids()));
create policy seed_batch_insert on public.seed_batch for insert to authenticated with check (app.can_edit(organization_id, origin_farm_base_id));
create policy seed_batch_update on public.seed_batch for update to authenticated using (app.can_edit(organization_id, origin_farm_base_id)) with check (app.can_edit(organization_id, origin_farm_base_id));
create policy seed_batch_delete on public.seed_batch for delete to authenticated using (app.can_edit(organization_id, origin_farm_base_id));
alter table public.planting_seed enable row level security;
create policy planting_seed_select on public.planting_seed for select to authenticated using (organization_id in (select app.user_org_ids()));
create policy planting_seed_insert on public.planting_seed for insert to authenticated with check (app.can_edit(organization_id, app.planting_farm(planting_id)));
create policy planting_seed_update on public.planting_seed for update to authenticated using (app.can_edit(organization_id, app.planting_farm(planting_id))) with check (app.can_edit(organization_id, app.planting_farm(planting_id)));
create policy planting_seed_delete on public.planting_seed for delete to authenticated using (app.can_edit(organization_id, app.planting_farm(planting_id)));
alter table public.stage_product enable row level security;
create policy stage_product_select on public.stage_product for select to authenticated using (organization_id in (select app.user_org_ids()));
create policy stage_product_insert on public.stage_product for insert to authenticated with check (app.can_edit(organization_id, farm_base_id));
create policy stage_product_update on public.stage_product for update to authenticated using (app.can_edit(organization_id, farm_base_id)) with check (app.can_edit(organization_id, farm_base_id));
create policy stage_product_delete on public.stage_product for delete to authenticated using (app.can_edit(organization_id, farm_base_id));
alter table public.cnp enable row level security;
create policy cnp_select on public.cnp for select to authenticated using (organization_id in (select app.user_org_ids()));
create policy cnp_insert on public.cnp for insert to authenticated with check (app.can_edit(organization_id, farm_base_id));
create policy cnp_update on public.cnp for update to authenticated using (app.can_edit(organization_id, farm_base_id)) with check (app.can_edit(organization_id, farm_base_id));
create policy cnp_delete on public.cnp for delete to authenticated using (app.can_edit(organization_id, farm_base_id));
alter table public.cnp_stage enable row level security;
create policy cnp_stage_select on public.cnp_stage for select to authenticated using (organization_id in (select app.user_org_ids()));
create policy cnp_stage_insert on public.cnp_stage for insert to authenticated with check (app.can_edit(organization_id, app.cnp_farm(cnp_id)));
create policy cnp_stage_update on public.cnp_stage for update to authenticated using (app.can_edit(organization_id, app.cnp_farm(cnp_id))) with check (app.can_edit(organization_id, app.cnp_farm(cnp_id)));
create policy cnp_stage_delete on public.cnp_stage for delete to authenticated using (app.can_edit(organization_id, app.cnp_farm(cnp_id)));
alter table public.cnp_stage_product enable row level security;
create policy cnp_stage_product_select on public.cnp_stage_product for select to authenticated using (organization_id in (select app.user_org_ids()));
create policy cnp_stage_product_insert on public.cnp_stage_product for insert to authenticated with check (app.can_edit(organization_id, app.cnp_stage_farm(cnp_stage_id)));
create policy cnp_stage_product_update on public.cnp_stage_product for update to authenticated using (app.can_edit(organization_id, app.cnp_stage_farm(cnp_stage_id))) with check (app.can_edit(organization_id, app.cnp_stage_farm(cnp_stage_id)));
create policy cnp_stage_product_delete on public.cnp_stage_product for delete to authenticated using (app.can_edit(organization_id, app.cnp_stage_farm(cnp_stage_id)));
alter table public.cnp_assignment enable row level security;
create policy cnp_assignment_select on public.cnp_assignment for select to authenticated using (organization_id in (select app.user_org_ids()));
create policy cnp_assignment_insert on public.cnp_assignment for insert to authenticated with check (app.can_edit(organization_id, app.planting_farm(planting_id)));
create policy cnp_assignment_update on public.cnp_assignment for update to authenticated using (app.can_edit(organization_id, app.planting_farm(planting_id))) with check (app.can_edit(organization_id, app.planting_farm(planting_id)));
create policy cnp_assignment_delete on public.cnp_assignment for delete to authenticated using (app.can_edit(organization_id, app.planting_farm(planting_id)));
alter table public.fert_plan_line enable row level security;
create policy fert_plan_line_select on public.fert_plan_line for select to authenticated using (organization_id in (select app.user_org_ids()));
create policy fert_plan_line_insert on public.fert_plan_line for insert to authenticated with check (app.can_edit(organization_id, app.planting_farm(planting_id)));
create policy fert_plan_line_update on public.fert_plan_line for update to authenticated using (app.can_edit(organization_id, app.planting_farm(planting_id))) with check (app.can_edit(organization_id, app.planting_farm(planting_id)));
create policy fert_plan_line_delete on public.fert_plan_line for delete to authenticated using (app.can_edit(organization_id, app.planting_farm(planting_id)));
alter table public.soil_analysis enable row level security;
create policy soil_analysis_select on public.soil_analysis for select to authenticated using (organization_id in (select app.user_org_ids()));
create policy soil_analysis_insert on public.soil_analysis for insert to authenticated with check (app.can_edit(organization_id, app.field_farm(field_id)));
create policy soil_analysis_update on public.soil_analysis for update to authenticated using (app.can_edit(organization_id, app.field_farm(field_id))) with check (app.can_edit(organization_id, app.field_farm(field_id)));
create policy soil_analysis_delete on public.soil_analysis for delete to authenticated using (app.can_edit(organization_id, app.field_farm(field_id)));

-- ---------- Одит: чете се от администраторите; пише се само от тригери ----------
alter table public.audit_log enable row level security;
create policy audit_log_select on public.audit_log for select to authenticated
  using ((organization_id is not null and app.is_admin(organization_id)) or (organization_id is null and app.is_any_admin()));

-- ---------- Права ----------
revoke all on all tables in schema public from anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
revoke insert, update, delete, truncate on public.audit_log from authenticated;

grant usage on schema app to authenticated;
revoke execute on all functions in schema app from public, anon;
grant execute on all functions in schema app to authenticated;
revoke execute on function public.create_organization(text) from public, anon;
revoke execute on function public.assign_cnp(uuid[], uuid) from public, anon;
revoke execute on function public.sync_cnp(uuid) from public, anon;
revoke execute on function public.revert_line_to_cnp(uuid) from public, anon;
revoke execute on function public.copy_cnp(uuid, smallint, text) from public, anon;
grant execute on function public.create_organization(text) to authenticated;
grant execute on function public.assign_cnp(uuid[], uuid) to authenticated;
grant execute on function public.sync_cnp(uuid) to authenticated;
grant execute on function public.revert_line_to_cnp(uuid) to authenticated;
grant execute on function public.copy_cnp(uuid, smallint, text) to authenticated;
