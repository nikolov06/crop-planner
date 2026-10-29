-- Начални данни: етапи на торене, справочници и култури от сеитбооборота 2026/2027.

insert into public.fertilization_stage (name_bg, name_en, method, sort_order) values
  ('Предсеитбено',   'Pre-sowing',     'soil',        1),
  ('Основно',        'Basic',          'soil',        2),
  ('Вегетационно 1', 'Vegetation 1',   'soil',        3),
  ('Вегетационно 2', 'Vegetation 2',   'soil',        4),
  ('Коригиращо',     'Corrective',     'soil',        5),
  ('Листно',         'Foliar',         'foliar',      6),
  ('Фертигация',     'Fertigation',    'fertigation', 7);

-- Потенциал: четирите стойности от Excel. Номерата са предположение (по-голямо = по-добър); да се сверят със справочника "Потенциал".
insert into public.potential_class (potential_id, name_bg, sort_order) values
  (1, 'лоша', 1), (2, 'средна', 2), (3, 'добра', 3), (4, 'много добра', 4);

insert into public.reproduction (name, sort_order) values ('Б', 1), ('C1', 2), ('C2', 3);

-- Култури. Настройки за семена:
--   слети (пшеница, ечемик, рапица): кълняеми семена/м2 -> kg/дка; преразход 3% (житни), 1,5% (рапица)
--   редови (царевица, слънчоглед, сорго): семена/дка -> торби; преразход 1,5%
insert into public.crop (name_bg, short_name, seeding_method, rate_basis, convert_to_kg, order_unit,
                         default_seeds_per_pack, seed_overage_pct, rate_rounding_step) values
  ('ПШЕНИЦА',   'Пшеница',   'solid', 'germ_seeds_m2', true,  'kg',    null,    3.0, null),
  ('ЕЧЕМИК',    'Ечемик',    'solid', 'germ_seeds_m2', true,  'kg',    null,    3.0, null),
  ('РАПИЦА',    'Рапица',    'solid', 'germ_seeds_m2', true,  'packs', 1500000, 1.5, 0.1),
  ('СЛЪНЧОГЛЕД','Слънчоглед','row',   'seeds_da',      false, 'packs', 150000,  1.5, null),
  ('ЦАРЕВИЦА',  'Царевица',  'row',   'seeds_da',      false, 'packs', 80000,   1.5, null),
  ('СОРГО',     'Сорго',     'row',   'seeds_da',      false, 'packs', 300000,  1.5, null);
insert into public.crop (name_bg, short_name) values ('ЛЮЦЕРНА','Люцерна'), ('НПП','НПП'), ('ЛОЗЯ','Лозя');
insert into public.crop (name_bg, short_name, subsidy_crop_id, seeding_method, rate_basis, convert_to_kg, order_unit,
                         default_seeds_per_pack, seed_overage_pct)
select 'ПОЛИВНА ЦАРЕВИЦА', 'Поливна царевица', crop_id, 'row', 'seeds_da', false, 'packs', 80000, 1.5
  from public.crop where name_bg = 'ЦАРЕВИЦА';

insert into public.app_setting (setting_key, organization_id, value, description) values
  ('seed_rate_rounding_step', null, '1', 'Обща стъпка на закръгляне на нормата на слетите култури, kg/дка (1 или 0.5)');

-- Правила за диверсификация, пренесени от BI на AgroVIR. Да се сверят със закона за съответната година.
insert into public.diversification_rule (rule_set, check_type, n, threshold_pct, message_bg) values
  ('ДЗЕС',   'top_n_max', 1, 75, 'I култура над 75%'),
  ('ДЗЕС',   'top_n_max', 2, 95, 'I+II култура над 95%'),
  ('ДЗЕС',   'nth_min',   3,  5, 'III култура под 5%'),
  ('ЕКОРОК', 'top_n_max', 1, 75, 'I култура над 75%'),
  ('ЕКОРОК', 'top_n_max', 3, 95, 'I+II+III култура над 95%'),
  ('ЕКОРОК', 'nth_min',   4,  5, 'IV култура под 5%');
insert into public.diversification_rule_crop (rule_set, crop_id)
select 'ДЗЕС', crop_id from public.crop
 where name_bg in ('ЕЧЕМИК','ПШЕНИЦА','РАПИЦА','СЛЪНЧОГЛЕД','ЦАРЕВИЦА','СОРГО','НПП','ЛЮЦЕРНА');
insert into public.diversification_rule_crop (rule_set, crop_id)
select 'ЕКОРОК', crop_id from public.crop
 where name_bg in ('ЕЧЕМИК','ПШЕНИЦА','РАПИЦА','СЛЪНЧОГЛЕД','ЦАРЕВИЦА','СОРГО','НПП');
