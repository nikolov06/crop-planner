-- Произход на семената като свободен текст (напр. "Б/Ташоолу 1-1": стопанска база / БЗС, от което са семената).
alter table public.planting_seed add column if not exists seed_origin text;
comment on column public.planting_seed.seed_origin is 'Произход на семената – свободен текст (стопанска база / БЗС), както е в Excel.';
