-- Геометрия на обработваемото поле (JD Operations Center граници) вместо на отделното БЗС.
-- Едно обработваемо поле държи едно или повече БЗС и има един (Multi)полигон.
-- ВАЖНО: типът geometry да е със същата схема като в 20261118120000_postgis.sql (public или extensions).

alter table public.work_field add column geom extensions.geometry(MultiPolygon, 4326);
alter table public.work_field add column jd_field_id text;
alter table public.work_field add column geom_updated_at timestamptz;

comment on column public.work_field.geom is 'Граница на обработваемото поле (MultiPolygon, WGS 84), от JD Operations Center. Повече полигони на едно поле се обединяват.';
comment on column public.work_field.jd_field_id is 'GUID на полето в John Deere Operations Center (FIELD_ID от експорта на границите). Ключ за бъдещи импорти и интеграции.';
comment on column public.work_field.geom_updated_at is 'Кога е записана/сменена границата.';

create index work_field_geom_gix on public.work_field using gist (geom);
create unique index work_field_jd_field_id_unique on public.work_field (organization_id, jd_field_id) where jd_field_id is not null;

-- Празните колони от предишната миграция (никога не са били пълнени) се махат.
alter table public.field drop column if exists geom;
alter table public.field_crop_year drop column if exists isak_geom;
