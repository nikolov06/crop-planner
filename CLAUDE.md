# Crop Planner

## Проект

Crop Planner е уеб приложение за планиране на земеделските дейности на Kristera Agro, която обработва приблизително 131 000 дка. Приложението и интерфейсът са на български.

## Технологии

- Supabase за Postgres, Row Level Security (RLS) и Auth; проектът в Supabase се казва „Crop-planner“.
- Vite, React и TypeScript в `web/`.
- Хостинг във Vercel.

## Структура и важни файлове

- `web/src/pages/` — страниците на приложението, включително планирането на семена, сеитбооборотът и номенклатурите.
- `web/src/lib/` — общи помощни функции и връзката със Supabase.
- `web/src/App.tsx`, `web/src/Login.tsx` — основно приложение и вход.
- `supabase/migrations/` — миграциите на схемата и данните.
- `supabase/pending/` — миграции, които не се прилагат автоматично.
- `import/` — SQL файлове за пробен и реален внос на данни.
- `supabase/tests/` — SQL тестове за базата.

## Състояние на базата

Приложените миграции са:

- `20261029120100_helpers.sql`
- `20261029120200_lookups.sql`
- `20261029120300_tenancy.sql`
- `20261029120400_fields.sql`
- `20261029120500_seeds.sql`
- `20261029120600_fertilization.sql`
- `20261029120700_soil_audit.sql`
- `20261029120800_logic.sql`
- `20261029120900_rls.sql`
- `20261029121000_views.sql`
- `20261029121100_seed_data.sql`
- `20261030120000_planting_yield.sql`
- `20261031120000_field_code_alias.sql`
- `20261108115000_planting_seed_origin.sql`
- `20261108120000_v_rotation_list.sql`
- `20261109120000_variety_seeds_per_pack.sql`
- `20261114180000_prz_catalog_and_fertilizer_ext.sql`
- `20261116120000_planting_prz.sql`
- `20261116130000_planting_tillage2.sql`
- `20261117120000_product_prices.sql`
- `20261118120000_postgis.sql` (разширение PostGIS в схема `extensions`)
- `20261118130000_work_field_geom.sql` (`work_field.geom`, `jd_field_id`, `geom_updated_at`; махнати `field.geom` и `field_crop_year.isak_geom`)

Типът за геометрия е `extensions.geometry`.

Границите на обработваемите полета са импортирани от John Deere Operations Center на 18.11.2026 в `work_field.geom` (заедно с `jd_field_id`): 548 от 559 полета имат граница, 11 са без. Изходните файлове са в `geom/` (не се комитва).

Не изпълнявай `supabase db push` без изрично съгласие на собственика на проекта.

## Локална разработка

От директория `web/`:

```sh
npm run dev
npm run typecheck
npm run build
```

## Деплой

- GitHub хранилище: частно.
- Vercel проект: `crop-planner`.
- Root Directory: `web`.
- Build Command: `npm run build`.
- Output Directory: `dist`.
- Имена на променливите за средата: `VITE_SUPABASE_URL` и `VITE_SUPABASE_ANON_KEY`. Не записвай тук стойности от `.env`.

- Продукционен адрес: `crop-planner-eta.vercel.app` (работи, входът и данните са потвърдени).
- Vite вгражда променливите при build, затова след промяна във Vercel е нужен Redeploy.
- При липсващи или невалидни променливи `web/src/lib/supabase.ts` не създава реална връзка и приложението показва обяснение вместо бял екран.

## Supabase Auth

- Регистрацията на нови потребители („Allow new users to sign up“) е изключена. Потребителите се добавят ръчно.

## Отворени неща

- Липсват данни за рапица (МХЗ и кълняемост), както и сортове за слънчоглед, царевица и сорго.
- „Планиране“ остава отворена тема.
