-- Геометрия (PostGIS). Отделен файл: изисква разширението postgis (в Supabase е достъпно в Database -> Extensions).
create extension if not exists postgis with schema extensions;

alter table public.field
  add column geom extensions.geometry(MultiPolygon, 4326);
comment on column public.field.geom is 'Физическа граница на парцела (WGS84).';

alter table public.field_crop_year
  add column isak_geom extensions.geometry(MultiPolygon, 4326);
comment on column public.field_crop_year.isak_geom is 'Граница по ИСАК за годината (променя се при преизмерване и деление).';

create index field_geom_gix on public.field using gist (geom);
create index fcy_isak_geom_gix on public.field_crop_year using gist (isak_geom);
