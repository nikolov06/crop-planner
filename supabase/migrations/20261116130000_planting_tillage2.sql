-- Втора почвообработка за период (напр. дълбока оран + продълбочаване).
-- Първата остава в tillage_id; втората е по избор, различна от първата и не може да има без първа.
alter table public.field_planting
  add column tillage2_id smallint references public.tillage_type(tillage_id);

alter table public.field_planting
  add constraint planting_tillage2_valid
  check (tillage2_id is null or (tillage_id is not null and tillage2_id <> tillage_id));

comment on column public.field_planting.tillage2_id is 'Втора почвообработка (по избор). Изисква първа (tillage_id) и е различна от нея.';
