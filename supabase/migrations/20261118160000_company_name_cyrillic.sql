-- Имена на фирми: латинските букви, които приличат на кирилски, стават кирилски (напр. „ЕAД“ → „ЕАД“).
-- Към 18.11.2026 засяга 2 записа: АГРИКОРН СТАР ЕAД и ЕКО ХЕРБС ЕAД. Връзките са по company_id и не се променят.

update public.company
   set name = translate(name, 'AEOKMHPCTXBaeokmhpctxb', 'АЕОКМНРСТХВаеокмнрстхв')
 where name ~ '[AEOKMHPCTXBaeokmhpctxb]';

do $chk$
declare v_latin int; v_dup int;
begin
  select count(*) into v_latin from public.company where name ~ '[A-Za-z]';
  if v_latin > 0 then raise exception 'Остават % фирми с латински букви – оправи ги ръчно.', v_latin; end if;
  select count(*) into v_dup from (
    select organization_id, upper(btrim(regexp_replace(name, '\s+', ' ', 'g'))) from public.company group by 1, 2 having count(*) > 1) d;
  if v_dup > 0 then raise exception 'След поправката има % дублирани фирми.', v_dup; end if;
end $chk$;
