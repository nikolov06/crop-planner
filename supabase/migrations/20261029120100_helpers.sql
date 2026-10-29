-- Crop planner: общи помощни функции.
-- Ред на прилагане: файловете се изпълняват по име (Supabase го прави автоматично).

create extension if not exists btree_gist;

create schema if not exists app;
comment on schema app is 'Вътрешни помощни функции и тригери. Не се излага през API.';

-- Обновява updated_at при всяка промяна на реда.
create or replace function app.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Копира organization_id от родителския ред (и проверява, че не противоречи).
-- Аргументи на тригера: родителска таблица, колона-външен ключ, първичен ключ на родителя.
create or replace function app.inherit_org() returns trigger
language plpgsql as $$
declare
  v_parent text := tg_argv[0];
  v_fk     text := tg_argv[1];
  v_pk     text := tg_argv[2];
  v_fk_val uuid;
  v_org    uuid;
begin
  v_fk_val := (to_jsonb(new) ->> v_fk)::uuid;
  execute format('select organization_id from public.%I where %I = $1', v_parent, v_pk)
    into v_org using v_fk_val;
  if v_org is null then
    raise exception '%: родителският запис (%.%) не е намерен или няма достъп', tg_table_name, v_parent, v_pk;
  end if;
  if new.organization_id is null then
    new.organization_id := v_org;
  elsif new.organization_id <> v_org then
    raise exception '%: organization_id не съвпада с родителския запис', tg_table_name;
  end if;
  return new;
end $$;
