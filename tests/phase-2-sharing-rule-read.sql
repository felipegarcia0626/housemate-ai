BEGIN;

CREATE FUNCTION pg_temp.expect_sqlstate(test_name TEXT, statement TEXT, expected TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE actual TEXT;
BEGIN
  BEGIN EXECUTE statement; EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS actual = RETURNED_SQLSTATE; IF actual <> expected THEN RAISE EXCEPTION 'FAIL % expected %, got %', test_name, expected, actual; END IF; RAISE NOTICE 'PASS % SQLSTATE %', test_name, actual; RETURN; END;
  RAISE EXCEPTION 'FAIL % succeeded', test_name;
END; $$;

INSERT INTO public.tb_households (id,name) VALUES ('31000000-0000-4000-8000-000000000001','Sharing A'),('31000000-0000-4000-8000-000000000002','Sharing B');
INSERT INTO public.tb_users (id,display_name,external_identifier) VALUES ('31000000-0000-4000-8000-000000000011','A1','sharing-a1'),('31000000-0000-4000-8000-000000000012','A2','sharing-a2'),('31000000-0000-4000-8000-000000000013','B1','sharing-b1');
INSERT INTO public.tb_household_members (id,household_id,user_id,display_name) VALUES
('31000000-0000-4000-8000-000000000021','31000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000011','A1'),
('31000000-0000-4000-8000-000000000022','31000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000012','A2'),
('31000000-0000-4000-8000-000000000023','31000000-0000-4000-8000-000000000002','31000000-0000-4000-8000-000000000013','B1');
INSERT INTO public.tb_sharing_rules (id,household_id,name) VALUES ('31000000-0000-4000-8000-000000000041','31000000-0000-4000-8000-000000000001','60 / 40'),('31000000-0000-4000-8000-000000000042','31000000-0000-4000-8000-000000000002','100');
INSERT INTO public.tb_sharing_rule_members (id,sharing_rule_id,household_member_id,percentage) VALUES
('31000000-0000-4000-8000-000000000051','31000000-0000-4000-8000-000000000041','31000000-0000-4000-8000-000000000021',60),
('31000000-0000-4000-8000-000000000052','31000000-0000-4000-8000-000000000041','31000000-0000-4000-8000-000000000022',40),
('31000000-0000-4000-8000-000000000053','31000000-0000-4000-8000-000000000042','31000000-0000-4000-8000-000000000023',100);
SET CONSTRAINTS ALL IMMEDIATE;

DO $$ BEGIN
 IF NOT has_table_privilege('service_role','public.tb_sharing_rules','SELECT') OR NOT has_table_privilege('service_role','public.tb_sharing_rule_members','SELECT') THEN RAISE EXCEPTION 'FAIL SELECT grants'; END IF;
 IF has_table_privilege('service_role','public.tb_sharing_rules','INSERT,UPDATE,DELETE') OR has_table_privilege('service_role','public.tb_sharing_rule_members','INSERT,UPDATE,DELETE') THEN RAISE EXCEPTION 'FAIL write grants'; END IF;
 RAISE NOTICE 'PASS minimum read grants';
END $$;
SET LOCAL ROLE service_role;
DO $$ DECLARE count_a INTEGER; total NUMERIC; BEGIN
 SELECT COUNT(*),SUM(m.percentage) INTO count_a,total FROM public.tb_sharing_rules r JOIN public.tb_sharing_rule_members m ON m.sharing_rule_id=r.id WHERE r.household_id='31000000-0000-4000-8000-000000000001';
 IF count_a<>2 OR total<>100 THEN RAISE EXCEPTION 'FAIL household read'; END IF;
 IF EXISTS(SELECT 1 FROM public.tb_sharing_rules WHERE household_id='31000000-0000-4000-8000-000000000001' AND id='31000000-0000-4000-8000-000000000042') THEN RAISE EXCEPTION 'FAIL isolation'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tb_sharing_rules r JOIN public.tb_sharing_rule_members m ON m.sharing_rule_id=r.id WHERE r.id='00000000-0000-4000-8000-000000000041' GROUP BY r.id HAVING SUM(m.percentage)=100) THEN RAISE EXCEPTION 'FAIL seed'; END IF;
 RAISE NOTICE 'PASS read, percentages, isolation and seed';
END $$;
RESET ROLE;

SELECT pg_temp.expect_sqlstate('percentage range',$q$INSERT INTO public.tb_sharing_rule_members(sharing_rule_id,household_member_id,percentage) VALUES('31000000-0000-4000-8000-000000000041','31000000-0000-4000-8000-000000000023',101)$q$,'23514');
SELECT pg_temp.expect_sqlstate('duplicate member',$q$INSERT INTO public.tb_sharing_rule_members(sharing_rule_id,household_member_id,percentage) VALUES('31000000-0000-4000-8000-000000000041','31000000-0000-4000-8000-000000000021',0)$q$,'23505');
SELECT pg_temp.expect_sqlstate('foreign member',$q$INSERT INTO public.tb_sharing_rule_members(sharing_rule_id,household_member_id,percentage) VALUES('31000000-0000-4000-8000-000000000041','31000000-0000-4000-8000-000000000023',0); SET CONSTRAINTS ALL IMMEDIATE$q$,'23514');
SELECT pg_temp.expect_sqlstate('invalid sum',$q$UPDATE public.tb_sharing_rule_members SET percentage=50 WHERE id='31000000-0000-4000-8000-000000000051'; SET CONSTRAINTS ALL IMMEDIATE$q$,'23514');
SELECT 'PASS Phase 2 Sharing Rule read SQL checks completed' AS result;
ROLLBACK;
