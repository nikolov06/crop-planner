-- Организации, фирми, стопански бази, роли, настройки.
-- Организацията е границата между клиентите (tenant). Фирмите (юридически лица) са в нея.

create table public.organization (
  organization_id uuid primary key default gen_random_uuid(),
  name            text not null,
  created_at      timestamptz not null default now()
);

create table public.company (
  company_id      uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organization(organization_id) on delete cascade,
  name            text not null,
  is_active       boolean not null default true,
  unique (organization_id, name)
);
comment on table public.company is 'Фирма (юридическо лице) в организацията.';

create table public.farm_base (
  farm_base_id    uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organization(organization_id) on delete cascade,
  name            text not null,
  settlement_id   uuid references public.settlement(settlement_id),
  is_active       boolean not null default true,
  unique (organization_id, name)
);
comment on table public.farm_base is 'Стопанска база.';

create table public.app_user_role (
  role_id         uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organization(organization_id) on delete cascade,
  company_id      uuid references public.company(company_id) on delete cascade,
  farm_base_id    uuid references public.farm_base(farm_base_id) on delete cascade,
  role            text not null check (role in ('admin','agronomist','viewer')),
  created_at      timestamptz not null default now()
);
comment on table public.app_user_role is 'admin и agronomist редактират; viewer само чете. farm_base_id стеснява агронома до една стопанска база. company_id е запазено за бъдеща употреба.';
create unique index app_user_role_unique on public.app_user_role
  (user_id, organization_id, coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid),
   coalesce(farm_base_id, '00000000-0000-0000-0000-000000000000'::uuid), role);
create index app_user_role_user on public.app_user_role (user_id);

create table public.app_setting (
  setting_id      uuid primary key default gen_random_uuid(),
  setting_key     text not null,
  organization_id uuid references public.organization(organization_id) on delete cascade,
  value           text not null,
  description     text
);
comment on table public.app_setting is 'Настройки; ред с organization_id има предимство пред глобалния (null).';
create unique index app_setting_unique on public.app_setting
  (setting_key, coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ---------- Функции за достъп (security definer, за да не зациклят RLS политиките) ----------
create or replace function app.user_org_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select organization_id from public.app_user_role where user_id = auth.uid()
$$;

create or replace function app.is_admin(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_user_role r
                 where r.user_id = auth.uid() and r.organization_id = p_org and r.role = 'admin')
$$;

create or replace function app.is_any_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_user_role r where r.user_id = auth.uid() and r.role = 'admin')
$$;

-- Може ли потребителят да редактира данни на организацията (и, ако е зададена, на стопанската база).
create or replace function app.can_edit(p_org uuid, p_farm uuid default null) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.app_user_role r
    where r.user_id = auth.uid() and r.organization_id = p_org
      and (r.role = 'admin'
           or (r.role = 'agronomist' and (r.farm_base_id is null or r.farm_base_id = p_farm)))
  )
$$;

create or replace function app.setting_num(p_org uuid, p_key text, p_default numeric) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select s.value::numeric from public.app_setting s
      where s.setting_key = p_key and (s.organization_id = p_org or s.organization_id is null)
      order by s.organization_id nulls last limit 1),
    p_default)
$$;

-- Създава организация и прави повикващия неин администратор.
create or replace function public.create_organization(p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  if auth.uid() is null then
    raise exception 'Нужен е вход в системата';
  end if;
  insert into public.organization (name) values (p_name) returning organization_id into v_org;
  insert into public.app_user_role (user_id, organization_id, role) values (auth.uid(), v_org, 'admin');
  return v_org;
end $$;
