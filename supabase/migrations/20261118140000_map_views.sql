-- Карта и Геометрии: изглед с границите (GeoJSON), изглед по сезон (без геометрия) и функция за записване на граница.
-- Геометриите се зареждат веднъж, а данните по сезон (култури, БЗС, площи) - отделно и леко; екранът ги свързва по work_field_id.

create or replace view public.v_work_field_geojson with (security_invoker = true) as
select w.work_field_id, w.organization_id, w.name, w.name_bg, w.jd_field_id, w.geom_updated_at,
       extensions.ST_AsGeoJSON(w.geom, 6)::json as geojson,
       round((extensions.ST_Area(w.geom::extensions.geography) / 1000.0)::numeric, 2) as polygon_area_da
  from public.work_field w
 where w.geom is not null;
comment on view public.v_work_field_geojson is 'Граници на обработваемите полета като GeoJSON (WGS 84) + площ на полигона в дка.';

create or replace view public.v_work_field_season with (security_invoker = true) as
with base as (
  select x.organization_id, f.work_field_id, x.season_id, x.field_id, x.field_name, x.farm_base_name,
         x.crop_name, coalesce(x.planted_area_da, 0) as crop_area_da,
         coalesce(c.isak_area_da, x.planted_area_da, 0) as bzs_area_da
    from public.v_planting_context x
    join public.field f on f.field_id = x.field_id
    left join public.field_crop_year c on c.fcy_id = x.fcy_id
   where x.role = 'main' and f.work_field_id is not null
)
select b.organization_id, b.work_field_id, b.season_id,
       count(distinct b.field_id)::int as bzs_count,
       round(sum(b.bzs_area_da), 2) as bzs_area_da,
       (array_agg(b.crop_name order by b.crop_area_da desc nulls last))[1] as main_crop,
       array_remove(array_agg(distinct b.crop_name), null) as crops,
       (array_agg(b.farm_base_name order by b.bzs_area_da desc nulls last))[1] as farm_base,
       jsonb_agg(jsonb_build_object('field_id', b.field_id, 'field_name', b.field_name, 'crop', b.crop_name,
                                    'area_da', b.bzs_area_da) order by b.field_name) as bzs
  from base b
 group by b.organization_id, b.work_field_id, b.season_id;
comment on view public.v_work_field_season is 'Обработваемо поле по сезон: брой БЗС, площ, основна култура, база и списък на БЗС (без геометрия).';

-- Записва граница на обработваемо поле. Приема GeoJSON (Polygon/MultiPolygon/GeometryCollection); няколко полигона се обединяват.
-- Работи с правата на потребителя (RLS на work_field): без право за редакция връща грешка.
create or replace function public.set_work_field_geom(p_work_field_id uuid, p_geojson jsonb, p_jd_field_id text default null)
returns void language plpgsql security invoker set search_path = public as $$
declare v_geom extensions.geometry; n int;
begin
  if p_geojson is null then
    update public.work_field set geom = null, geom_updated_at = now() where work_field_id = p_work_field_id;
  else
    v_geom := extensions.ST_Multi(extensions.ST_CollectionExtract(extensions.ST_MakeValid(
                extensions.ST_Union(extensions.ST_SetSRID(extensions.ST_GeomFromGeoJSON(p_geojson::text), 4326))), 3));
    if v_geom is null or extensions.ST_IsEmpty(v_geom) then raise exception 'Геометрията е празна или невалидна'; end if;
    update public.work_field
       set geom = v_geom, geom_updated_at = now(), jd_field_id = coalesce(p_jd_field_id, jd_field_id)
     where work_field_id = p_work_field_id;
  end if;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'Няма такова обработваемо поле или нямаш право да го редактираш'; end if;
end $$;
comment on function public.set_work_field_geom(uuid, jsonb, text) is 'Записва (обединява) граница на work_field от GeoJSON; null изтрива границата.';
revoke all on function public.set_work_field_geom(uuid, jsonb, text) from anon, public;
grant execute on function public.set_work_field_geom(uuid, jsonb, text) to authenticated;

grant select on public.v_work_field_geojson, public.v_work_field_season to authenticated;
