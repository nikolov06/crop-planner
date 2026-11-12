-- Стабилен код на полето и разширени имена (имена в АгроВИР, Excel, ИСАК), за мачване с външни системи.

alter table public.field add column code text;
comment on column public.field.code is 'Стабилен вътрешен код (P0001…) от импорта. Един код = едно поле във всички години; БЗС номерът се сменя при деление, кодът не.';
create unique index field_code_unique on public.field (organization_id, code) where code is not null;

create table public.field_alias (
  alias_id         uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organization(organization_id) on delete cascade,
  field_id         uuid not null references public.field(field_id) on delete cascade,
  alias_name       text not null,
  source           text not null default 'agrovir' check (source in ('agrovir','excel','isak','other')),
  isak_number      text,
  area_da          numeric(10,2) check (area_da >= 0),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, source, alias_name)
);
comment on table public.field_alias is 'Разширено име на полето във външна система (напр. КЕТЕЛНИКА 1-3 в АгроВИР). Едно поле може да има няколко имена, когато парчета са слети в едно поле.';
comment on column public.field_alias.area_da is 'Площ на парчето под това име (дка), ако е известна.';
create index field_alias_field on public.field_alias (field_id);
create trigger aa_field_alias_org before insert or update on public.field_alias
  for each row execute function app.inherit_org('field', 'field_id', 'field_id');
create trigger field_alias_touch before update on public.field_alias
  for each row execute function app.touch_updated_at();
create trigger field_alias_audit after insert or update or delete on public.field_alias
  for each row execute function app.audit_row('alias_id');

alter table public.field_alias enable row level security;
create policy field_alias_select on public.field_alias for select to authenticated using (organization_id in (select app.user_org_ids()));
create policy field_alias_insert on public.field_alias for insert to authenticated with check (app.can_edit(organization_id, app.field_farm(field_id)));
create policy field_alias_update on public.field_alias for update to authenticated using (app.can_edit(organization_id, app.field_farm(field_id))) with check (app.can_edit(organization_id, app.field_farm(field_id)));
create policy field_alias_delete on public.field_alias for delete to authenticated using (app.can_edit(organization_id, app.field_farm(field_id)));

revoke all on public.field_alias from anon;
grant select, insert, update, delete on public.field_alias to authenticated;

-- Обработваемо поле (в АгроВИР: „Основен масив“): група от едно или повече полета/БЗС, които се обработват като един масив.
-- Името е на латиница, както е в АгроВИР, за John Deere Operations Center и други платформи.
create table public.work_field (
  work_field_id    uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organization(organization_id) on delete cascade,
  name             text not null,
  name_bg          text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, name)
);
comment on table public.work_field is 'Обработваемо поле (АгроВИР „Основен масив“). Съдържа едно или повече полета (field), всяко със своя БЗС номер. Името е на латиница за външни платформи.';
comment on column public.work_field.name is 'Име на латиница, точно както е в АгроВИР / John Deere OC (напр. „Topchalyka 1 i 2“).';
comment on column public.work_field.name_bg is 'Име на кирилица, по избор.';
create trigger work_field_touch before update on public.work_field
  for each row execute function app.touch_updated_at();
create trigger work_field_audit after insert or update or delete on public.work_field
  for each row execute function app.audit_row('work_field_id');

alter table public.field add column work_field_id uuid references public.work_field(work_field_id) on delete set null;
comment on column public.field.work_field_id is 'Към кое обработваемо поле принадлежи полето. Едно обработваемо поле може да съдържа няколко полета/БЗС.';
create index field_work_field on public.field (work_field_id);

alter table public.work_field enable row level security;
create policy work_field_select on public.work_field for select to authenticated using (organization_id in (select app.user_org_ids()));
create policy work_field_insert on public.work_field for insert to authenticated with check (app.can_edit(organization_id));
create policy work_field_update on public.work_field for update to authenticated using (app.can_edit(organization_id)) with check (app.can_edit(organization_id));
create policy work_field_delete on public.work_field for delete to authenticated using (app.can_edit(organization_id));
revoke all on public.work_field from anon;
grant select, insert, update, delete on public.work_field to authenticated;
