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
- `20261118140000_map_views.sql` (изгледи `v_work_field_geojson`, `v_work_field_season`; функция `set_work_field_geom`)
- `20261118150000_bzs_legal_area.sql` (`field_crop_year.legal_area_dka`, `buffer_strip_dka` – преименувана от `buffer_area_da`, `area_wo_buffer_dka` GENERATED; `v_rotation_list` с площите; функция `set_bzs_legal_areas`)
- `20261118160000_company_name_cyrillic.sql` (латински букви в имената на фирмите → кирилица)
- `20261118170000_recap_eco_schemes.sql` (`company.in_holding`; номенклатури `recap_crop_group` и `eco_scheme_rule` с RLS като `crop`/`season`; изгледи `v_recap_company_crop`, `v_recap_base_crop`)
- `20261124120000_seed_import.sql` (импорт на сортове: `planting_seed.addon`, `variety.default_rate`, `variety_alias`, лог `seed_import`/`seed_import_item`, RPC `apply_seed_import` и `undo_seed_import`)
- `20261125120000_seed_quality_offers.sql` (МХЗ и кълняемост в `variety` и `planting_seed`; `planting_seed.rate_kg_da_manual`; `v_seed_calc` с нови колони накрая – `need_t_base`, `packs_base`, `rate_kg_da_info` и др.; `supplier.is_own_production` с „Собствено производство“; оферти за семена – `offer.module = 'seed'`, `offer_line.variety_id`, `min_qty`, мерна единица `pack`; изглед `v_seed_price_selected`)
- `20261125130000_seed_import_update.sql` (повторният импорт обновява реда в `planting_seed` – пази МХЗ, кълняемост, ръчна норма; партидата се маха само при смяна на сорта; `seed_import_item.new_updated_at` за отмяната; рапица във `v_seed_calc` – торби без МХЗ и без CEILING)

Типът за геометрия е `extensions.geometry`.

Границите на обработваемите полета са импортирани от John Deere Operations Center на 18.11.2026 в `work_field.geom` (заедно с `jd_field_id`): 548 от 559 полета имат граница, 11 са без. Изходните файлове са в `geom/` (не се комитва).

Площите по правно основание и буферните ивици за 2026/2027 са импортирани на 18.11.2026 от `supabase/imports/plosht_pravno_osnovanie_2026-2027.csv` (не се комитва): 647 от 648 БЗС, 130 693 дка правно основание, 265 дка буфер. Части на БЗС от файла (разширени имена в `field_alias`) се сумират към БЗС.

Не изпълнявай `supabase db push` без изрично съгласие на собственика на проекта.

## Git: клонове и main

- Никога push или merge в `main` без изричното „да, merge“ на собственика в чата. Друго „да“ (за commit, push на клон, db push) не важи за `main`.
- Работи се само в клонове. Към `main` се стига само през Pull Request; PR-ът не се мърджва без „да, merge“.

Рекапитулацията (Сеитбооборот → Рекапитулация) смята ДЗЕС/ЕКОРОК в `web/src/lib/recap.ts`; тестовете са в `recap.test.ts` (`npm test` от `web/`). Старите `diversification_rule` / `v_diversification` не се ползват от екрана.

Планиране семена (Планиране | Оферти | Рекапитулация): формулите са в `web/src/lib/seedcalc.ts` (МХЗ и кълняемост БЗС → партида → сорт; ръчна норма; нужда и с преразход; рапица в торби през кълняемостта, без МХЗ и без CEILING; липсващи данни – празно + червен маркер, никога 0), групирането и закръглянето на заявката – в `seedrecap.ts` (торби нагоре до цяла торба за Сорт × База, фирмата е само филтър), зареждането – в `seeddata.ts`; тестове в `seedcalc.test.ts`. Цените на семената са само от избраната оферта (`v_seed_price_selected`), без резервна най-ниска цена.

## Локална разработка

От директория `web/`:

```sh
npm run dev
npm run typecheck
npm run build
npm test
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
