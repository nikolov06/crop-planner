# Crop Planner – уеб интерфейс

Vite + React + TypeScript + Supabase.

## Стартиране
1. `cd web && npm install`
2. Копирай `.env.example` като `.env.local` и попълни `VITE_SUPABASE_URL` и `VITE_SUPABASE_ANON_KEY` (само публичния anon/publishable ключ – никога service_role или паролата на базата).
3. `npm run dev`

## Менюта
Сеитбооборот · Планиране семена (в процес) · Планиране торове (в процес) · ПРЗ (в процес) · Номенклатури.

Сеитбооборотът чете изгледа `public.v_rotation_list` (миграция `20261108120000_v_rotation_list.sql`).
Нужен е потребител в Supabase Auth с ред в `app_user_role`.
