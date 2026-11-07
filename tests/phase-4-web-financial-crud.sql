BEGIN;

-- These request settings model claims that PostgREST attaches after JWT
-- verification. They are not a cryptographic JWT or HTTP/PostgREST test.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY,
  email text,
  email_confirmed_at timestamptz
);
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.role', true), '')
$$;
GRANT USAGE ON SCHEMA auth TO authenticated;

INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
  ('53000000-0053-4000-8000-000000000001','web-crud-a@example.test',now()),
  ('53000000-0053-4000-8000-000000000002','web-crud-b@example.test',now())
ON CONFLICT (id) DO UPDATE
  SET email=EXCLUDED.email,email_confirmed_at=EXCLUDED.email_confirmed_at;
UPDATE public.tb_users SET auth_user_id='53000000-0053-4000-8000-000000000001'
 WHERE id='00000000-0000-4000-8000-000000000011';
UPDATE public.tb_users SET auth_user_id='53000000-0053-4000-8000-000000000002'
 WHERE id='00000000-0000-4000-8000-000000000012';
UPDATE public.tb_household_members SET role='MEMBER',status='ACTIVE'
 WHERE id IN ('00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000022');

INSERT INTO public.tb_households(id,name)
VALUES ('53000000-0053-4000-8000-000000000010','Web CRUD foreign household');
INSERT INTO public.tb_household_members(id,household_id,user_id,display_name,role,status)
VALUES ('53000000-0053-4000-8000-000000000020',
        '53000000-0053-4000-8000-000000000010',
        '00000000-0000-4000-8000-000000000012',
        'Web CRUD B','OWNER','ACTIVE');
INSERT INTO public.tb_incomes(household_id,created_by,member_id,amount,income_date,description)
VALUES ('53000000-0053-4000-8000-000000000010',
        '53000000-0053-4000-8000-000000000020',
        '53000000-0053-4000-8000-000000000020',90,current_date,'foreign Web CRUD fixture');

INSERT INTO public.tb_receipts(
  id,household_id,conversation_key,storage_path,original_filename,mime_type,
  processing_status,analysis_payload
) VALUES (
  '53000000-0053-4000-8000-000000000030',
  '00000000-0000-4000-8000-000000000001',
  'web-crud-receipt','receipts/web-crud.jpg','web-crud.jpg','image/jpeg',
  'PROCESSED','{}'::jsonb
), (
  '53000000-0053-4000-8000-000000000031',
  '00000000-0000-4000-8000-000000000001',
  'web-crud-rejection','receipts/web-crud-rejection.jpg',
  'web-crud-rejection.jpg','image/jpeg','PROCESSED','{}'::jsonb
);

INSERT INTO public.tb_categories(id,name,movement_type,level,parent_id,is_active)
VALUES
  ('53000000-0053-4000-8000-000000000041','0053 Expense macro','EXPENSE','MACRO',NULL,true),
  ('53000000-0053-4000-8000-000000000042','0053 Expense micro','EXPENSE','MICRO','53000000-0053-4000-8000-000000000041',true),
  ('53000000-0053-4000-8000-000000000043','0053 Income macro','INCOME','MACRO',NULL,true),
  ('53000000-0053-4000-8000-000000000044','0053 Income micro','INCOME','MICRO','53000000-0053-4000-8000-000000000043',true),
  ('53000000-0053-4000-8000-000000000045','0053 Inactive income macro','INCOME','MACRO',NULL,true),
  ('53000000-0053-4000-8000-000000000046','0053 Inactive income micro','INCOME','MICRO','53000000-0053-4000-8000-000000000045',false),
  ('53000000-0053-4000-8000-000000000047','0053 Inactive expense macro','EXPENSE','MACRO',NULL,false),
  ('53000000-0053-4000-8000-000000000048','0053 Active expense micro under inactive macro','EXPENSE','MICRO','53000000-0053-4000-8000-000000000047',true);

DO $category_fixture$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.tb_categories AS child
      JOIN public.tb_categories AS parent ON parent.id=child.parent_id
     WHERE child.id='53000000-0053-4000-8000-000000000048'
       AND child.level='MICRO' AND child.movement_type='EXPENSE'
       AND child.is_active
       AND parent.id='53000000-0053-4000-8000-000000000047'
       AND parent.level='MACRO' AND parent.movement_type='EXPENSE'
       AND NOT parent.is_active
  ) THEN
    RAISE EXCEPTION 'Inactive-parent Expense category fixture is invalid';
  END IF;
END;
$category_fixture$;

DO $acl$
DECLARE
  web_entry regprocedure;
  helper regprocedure := 'public.fn_require_web_financial_actor(uuid)'::regprocedure;
  expense_text_helper regprocedure := 'public.fn_assert_web_expense_texts(text,boolean,jsonb)'::regprocedure;
  web_entries regprocedure[] := ARRAY[
    'public.fn_create_web_expense(uuid,uuid,uuid,uuid,text,numeric,date,text,jsonb,jsonb)'::regprocedure,
    'public.fn_update_web_expense(uuid,uuid,boolean,text,boolean,text,numeric,date,uuid,boolean,uuid,jsonb,jsonb)'::regprocedure,
    'public.fn_delete_web_expense(uuid,uuid)'::regprocedure,
    'public.fn_create_web_income(uuid,uuid,numeric,date,text,uuid)'::regprocedure,
    'public.fn_update_web_income(uuid,uuid,jsonb)'::regprocedure,
    'public.fn_delete_web_income(uuid,uuid)'::regprocedure
  ];
  old_crud regprocedure[] := ARRAY[
    'public.fn_create_expense_eligible(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,numeric,date,text,public.expense_source,jsonb,jsonb)'::regprocedure,
    'public.fn_update_expense_eligible(uuid,uuid,uuid,uuid,boolean,text,boolean,text,numeric,date,uuid,boolean,uuid,jsonb,jsonb)'::regprocedure,
    'public.fn_delete_expense_eligible(uuid,uuid,uuid,uuid)'::regprocedure,
    'public.fn_create_income_eligible(uuid,uuid,uuid,uuid,numeric,date,text,uuid)'::regprocedure,
    'public.fn_update_income_eligible(uuid,uuid,uuid,uuid,jsonb)'::regprocedure,
    'public.fn_delete_income_eligible(uuid,uuid,uuid,uuid)'::regprocedure
  ];
  role_name text;
BEGIN
  IF has_function_privilege('authenticated',helper,'EXECUTE')
     OR has_function_privilege('anon',helper,'EXECUTE')
     OR has_function_privilege('service_role',helper,'EXECUTE')
     OR EXISTS (
       SELECT 1 FROM pg_catalog.aclexplode(
         coalesce((SELECT proacl FROM pg_catalog.pg_proc WHERE oid=helper),
                  pg_catalog.acldefault('f',(SELECT proowner FROM pg_catalog.pg_proc WHERE oid=helper)))
       ) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Web actor helper is directly executable';
  END IF;
  IF (SELECT proowner FROM pg_catalog.pg_proc WHERE oid=helper) <> 'postgres'::regrole
     OR NOT (SELECT prosecdef FROM pg_catalog.pg_proc WHERE oid=helper)
     OR (SELECT proconfig FROM pg_catalog.pg_proc WHERE oid=helper)
          IS DISTINCT FROM ARRAY['search_path=pg_catalog'] THEN
    RAISE EXCEPTION 'Unsafe Web actor helper configuration';
  END IF;
  IF has_function_privilege('authenticated',expense_text_helper,'EXECUTE')
     OR has_function_privilege('anon',expense_text_helper,'EXECUTE')
     OR has_function_privilege('service_role',expense_text_helper,'EXECUTE')
     OR EXISTS (
       SELECT 1 FROM pg_catalog.aclexplode(
         coalesce((SELECT proacl FROM pg_catalog.pg_proc WHERE oid=expense_text_helper),
                  pg_catalog.acldefault('f',(SELECT proowner FROM pg_catalog.pg_proc WHERE oid=expense_text_helper)))
       ) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Web Expense text helper is directly executable';
  END IF;
  IF (SELECT proowner FROM pg_catalog.pg_proc WHERE oid=expense_text_helper) <> 'postgres'::regrole
     OR (SELECT prosecdef FROM pg_catalog.pg_proc WHERE oid=expense_text_helper)
     OR (SELECT proconfig FROM pg_catalog.pg_proc WHERE oid=expense_text_helper)
           IS DISTINCT FROM ARRAY['search_path=pg_catalog'] THEN
    RAISE EXCEPTION 'Unsafe Web Expense text helper configuration';
  END IF;

  FOREACH web_entry IN ARRAY web_entries LOOP
    IF NOT has_function_privilege('authenticated',web_entry,'EXECUTE')
       OR has_function_privilege('anon',web_entry,'EXECUTE')
       OR has_function_privilege('service_role',web_entry,'EXECUTE')
       OR EXISTS (
         SELECT 1 FROM pg_catalog.aclexplode(
           coalesce((SELECT proacl FROM pg_catalog.pg_proc WHERE oid=web_entry),
                    pg_catalog.acldefault('f',(SELECT proowner FROM pg_catalog.pg_proc WHERE oid=web_entry)))
         ) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
       ) THEN
      RAISE EXCEPTION 'Unexpected Web entry ACL: %',web_entry;
    END IF;
    IF (SELECT proowner FROM pg_catalog.pg_proc WHERE oid=web_entry) <> 'postgres'::regrole
       OR NOT (SELECT prosecdef FROM pg_catalog.pg_proc WHERE oid=web_entry)
       OR (SELECT proconfig FROM pg_catalog.pg_proc WHERE oid=web_entry)
            IS DISTINCT FROM ARRAY['search_path=pg_catalog'] THEN
      RAISE EXCEPTION 'Unsafe Web entry configuration: %',web_entry;
    END IF;
  END LOOP;

  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    FOREACH web_entry IN ARRAY old_crud LOOP
      IF has_function_privilege(role_name,web_entry,'EXECUTE') THEN
        RAISE EXCEPTION '% can still call generic CRUD RPC %',role_name,web_entry;
      END IF;
    END LOOP;
  END LOOP;

  IF NOT has_function_privilege(
      'service_role',
      'public.fn_confirm_pending_expense_eligible(uuid,uuid,uuid,text,uuid,public.expense_source,timestamp with time zone,uuid,uuid,uuid,uuid,text,numeric,date,text,public.expense_source,jsonb,jsonb,uuid,uuid,bigint)'::regprocedure,
      'EXECUTE'
    ) OR NOT has_function_privilege(
      'service_role',
      'public.fn_confirm_pending_income_eligible(uuid,uuid,uuid,text,uuid,public.expense_source,timestamp with time zone,uuid,uuid,numeric,date,text,uuid,uuid,uuid,bigint)'::regprocedure,
      'EXECUTE'
    ) THEN
    RAISE EXCEPTION 'Proposal confirmation permissions changed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM unnest(web_entries) AS entry(oid)
    JOIN pg_catalog.pg_proc p ON p.oid=entry.oid
    WHERE p.proargnames && ARRAY['p_auth_user_id','p_actor_member_id','p_user_id','p_source']
  ) THEN
    RAISE EXCEPTION 'Web CRUD entry accepts caller-supplied identity or source';
  END IF;
END;
$acl$;

-- A real SQL role plus request claims checks the function contract and actor
-- derivation. The claims remain simulated by this embedded PostgreSQL runner.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','53000000-0053-4000-8000-000000000001',true);

DO $valid_crud$
DECLARE
  income_result jsonb;
  income_id uuid;
  expense_id uuid;
  denied boolean;
BEGIN
  IF auth.uid() IS DISTINCT FROM '53000000-0053-4000-8000-000000000001'::uuid
     OR auth.role() IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION 'SQL request identity fixture is inconsistent';
  END IF;

  denied := false;
  BEGIN
    PERFORM public.fn_create_web_income(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000022',1,current_date,'wrong category denied',
      '53000000-0053-4000-8000-000000000042'
    );
    RAISE EXCEPTION 'Income accepted an Expense category';
  EXCEPTION WHEN check_violation THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Income accepted an Expense category'; END IF;

  denied := false;
  BEGIN
    PERFORM public.fn_create_web_income(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000022',1,current_date,'inactive category denied',
      '53000000-0053-4000-8000-000000000046'
    );
    RAISE EXCEPTION 'Income accepted an inactive category';
  EXCEPTION WHEN check_violation THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Income accepted an inactive category'; END IF;

  income_result := public.fn_create_web_income(
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000022',
    23.50,current_date,'0053 Web income',
    '53000000-0053-4000-8000-000000000044'
  );
  income_id := (income_result->>'id')::uuid;
  IF income_id IS NULL OR income_result->>'created_by' IS DISTINCT FROM '00000000-0000-4000-8000-000000000021' THEN
    RAISE EXCEPTION 'Web Income actor was not derived from auth.uid()';
  END IF;
  denied := false;
  BEGIN
    PERFORM public.fn_update_web_income(
      '00000000-0000-4000-8000-000000000001',income_id,
      '{"category_id":"53000000-0053-4000-8000-000000000042"}'::jsonb
    );
    RAISE EXCEPTION 'Income update accepted an Expense category';
  EXCEPTION WHEN check_violation THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Income update accepted an Expense category'; END IF;

  income_result := public.fn_update_web_income(
    '00000000-0000-4000-8000-000000000001',income_id,
    '{"amount":"24.75","description":"0053 updated Web income"}'::jsonb
  );
  IF income_result->>'amount' <> '24.75'
     OR income_result->>'description' <> '0053 updated Web income'
     OR income_result->>'category_id' <> '53000000-0053-4000-8000-000000000044' THEN
    RAISE EXCEPTION 'Web Income update failed';
  END IF;
  denied := false;
  BEGIN
    PERFORM public.fn_create_web_expense(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000021',
      '53000000-0053-4000-8000-000000000044',NULL,
      'wrong category denied',1,current_date,NULL,'[]'::jsonb,
      '[{"householdMemberId":"00000000-0000-4000-8000-000000000021","amount":1,"percentage":100}]'::jsonb
    );
    RAISE EXCEPTION 'Expense accepted an Income category';
  EXCEPTION WHEN check_violation THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Expense accepted an Income category'; END IF;

  expense_id := public.fn_create_web_expense(
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000021',
    '53000000-0053-4000-8000-000000000042',
    '53000000-0053-4000-8000-000000000030',
    '0053 Web receipt expense',31.25,current_date,'Web JWT CRUD',
    '[{"name":"Receipt item","quantity":1.125,"unitPrice":31.25,"totalAmount":31.25,"categoryId":"53000000-0053-4000-8000-000000000042"}]'::jsonb,
    '[{"householdMemberId":"00000000-0000-4000-8000-000000000021","amount":15.70,"percentage":50.25},{"householdMemberId":"00000000-0000-4000-8000-000000000022","amount":15.55,"percentage":49.75}]'::jsonb
  );
  IF expense_id IS NULL THEN RAISE EXCEPTION 'Web Expense create returned no id'; END IF;
  PERFORM public.fn_update_web_expense(
    '00000000-0000-4000-8000-000000000001',expense_id,
    true,U&'Cafe\00A0House',false,NULL,NULL,NULL,NULL,false,NULL,NULL,NULL
  );
  denied := false;
  BEGIN
    PERFORM public.fn_update_web_expense(
      '00000000-0000-4000-8000-000000000001',expense_id,
      false,NULL,false,NULL,NULL,NULL,NULL,false,NULL,
      '[{"name":"wrong category","totalAmount":31.25,"categoryId":"53000000-0053-4000-8000-000000000044"}]'::jsonb,
      NULL
    );
    RAISE EXCEPTION 'Expense item update accepted an Income category';
  EXCEPTION WHEN check_violation THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Expense item update accepted an Income category'; END IF;
  PERFORM public.fn_update_web_expense(
    '00000000-0000-4000-8000-000000000001',expense_id,
    true,NULL,false,NULL,NULL,NULL,NULL,false,NULL,NULL,NULL
  );

  PERFORM set_config('test.web_crud_income_id',income_id::text,true);
  PERFORM set_config('test.web_crud_expense_id',expense_id::text,true);
END;
$valid_crud$;
RESET ROLE;

-- Run invalid input cases by invoking the authenticated SQL entry points
-- directly. Claims are simulated by this embedded PostgreSQL fixture; this is
-- not evidence of signed JWT transport through PostgREST.
SELECT set_config('test.web_crud_expenses_before',
                  (SELECT count(*)::text FROM public.tb_expenses),true);
SELECT set_config('test.web_crud_items_before',
                  (SELECT count(*)::text FROM public.tb_expense_items),true);
SELECT set_config('test.web_crud_distributions_before',
                  (SELECT count(*)::text FROM public.tb_expense_distributions),true);
SELECT set_config('test.web_crud_incomes_before',
                  (SELECT count(*)::text FROM public.tb_incomes),true);
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','53000000-0053-4000-8000-000000000001',true);
DO $invalid_expense_inputs$
DECLARE
  denied boolean;
  expense_id uuid := current_setting('test.web_crud_expense_id')::uuid;
  distributions jsonb :=
    '[{"householdMemberId":"00000000-0000-4000-8000-000000000021","amount":12.50,"percentage":100}]'::jsonb;
  unicode_whitespace text;
BEGIN
  IF pg_catalog.getdatabaseencoding() = 'UTF8' THEN
    unicode_whitespace := pg_catalog.chr(9) || pg_catalog.chr(10)
      || pg_catalog.chr(11) || pg_catalog.chr(12) || pg_catalog.chr(13)
      || pg_catalog.chr(32) || pg_catalog.chr(160) || pg_catalog.chr(5760)
      || pg_catalog.chr(8192) || pg_catalog.chr(8193) || pg_catalog.chr(8194)
      || pg_catalog.chr(8195) || pg_catalog.chr(8196) || pg_catalog.chr(8197)
      || pg_catalog.chr(8198) || pg_catalog.chr(8199) || pg_catalog.chr(8200)
      || pg_catalog.chr(8201) || pg_catalog.chr(8202) || pg_catalog.chr(8232)
      || pg_catalog.chr(8233) || pg_catalog.chr(8239) || pg_catalog.chr(8287)
      || pg_catalog.chr(12288) || pg_catalog.chr(65279);
    denied := false;
    BEGIN
      PERFORM public.fn_create_web_expense(
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000021',
        '53000000-0053-4000-8000-000000000042',NULL,
        unicode_whitespace,12.50,current_date,'0053 reject JS whitespace set',
        '[]'::jsonb,distributions
      );
      RAISE EXCEPTION 'JavaScript trim whitespace-only merchant was accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN denied := true;
    END;
    IF NOT denied THEN RAISE EXCEPTION 'JavaScript trim whitespace set was not rejected'; END IF;
  END IF;

  denied := false;
  BEGIN
    PERFORM public.fn_create_web_income(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000021',10.129,current_date,
      '0053 reject Income create precision','53000000-0053-4000-8000-000000000044'
    );
    RAISE EXCEPTION 'Income create accepted amount with three decimals';
  EXCEPTION WHEN SQLSTATE '22023' THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Income create precision error was not controlled'; END IF;

  denied := false;
  BEGIN
    PERFORM public.fn_update_web_income(
      '00000000-0000-4000-8000-000000000001',
      current_setting('test.web_crud_income_id')::uuid,
      '{"amount":10.129}'::jsonb
    );
    RAISE EXCEPTION 'Income update accepted amount with three decimals';
  EXCEPTION WHEN SQLSTATE '22023' THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Income update precision error was not controlled'; END IF;

  denied := false;
  BEGIN
    PERFORM public.fn_create_web_income(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000021','NaN'::numeric,current_date,
      '0053 reject Income create NaN','53000000-0053-4000-8000-000000000044'
    );
    RAISE EXCEPTION 'Income create accepted NaN';
  EXCEPTION WHEN SQLSTATE '22023' THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Income create NaN error was not controlled'; END IF;

  denied := false;
  BEGIN
    PERFORM public.fn_create_web_income(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000021','Infinity'::numeric,current_date,
      '0053 reject Income create Infinity','53000000-0053-4000-8000-000000000044'
    );
    RAISE EXCEPTION 'Income create accepted Infinity';
  EXCEPTION WHEN SQLSTATE '22023' THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Income create Infinity error was not controlled'; END IF;

  denied := false;
  BEGIN
    PERFORM public.fn_create_web_income(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000021','-Infinity'::numeric,current_date,
      '0053 reject Income create -Infinity','53000000-0053-4000-8000-000000000044'
    );
    RAISE EXCEPTION 'Income create accepted -Infinity';
  EXCEPTION WHEN SQLSTATE '22023' THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Income create -Infinity error was not controlled'; END IF;

  denied := false;
  BEGIN
    PERFORM public.fn_update_web_income(
      '00000000-0000-4000-8000-000000000001',
      current_setting('test.web_crud_income_id')::uuid,
      '{"amount":"NaN"}'::jsonb
    );
    RAISE EXCEPTION 'Income update accepted NaN';
  EXCEPTION WHEN SQLSTATE '22023' THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Income update NaN error was not controlled'; END IF;

  denied := false;
  BEGIN
    PERFORM public.fn_update_web_income(
      '00000000-0000-4000-8000-000000000001',
      current_setting('test.web_crud_income_id')::uuid,
      '{"amount":"Infinity"}'::jsonb
    );
    RAISE EXCEPTION 'Income update accepted Infinity';
  EXCEPTION WHEN SQLSTATE '22023' THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Income update Infinity error was not controlled'; END IF;

  denied := false;
  BEGIN
    PERFORM public.fn_update_web_income(
      '00000000-0000-4000-8000-000000000001',
      current_setting('test.web_crud_income_id')::uuid,
      '{"amount":"-Infinity"}'::jsonb
    );
    RAISE EXCEPTION 'Income update accepted -Infinity';
  EXCEPTION WHEN SQLSTATE '22023' THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Income update -Infinity error was not controlled'; END IF;

  denied := false;
  BEGIN
    PERFORM public.fn_create_web_expense(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000021',
      '53000000-0053-4000-8000-000000000042',NULL,
      'Valid merchant',12.501,current_date,'0053 reject Expense total precision',
      '[]'::jsonb,distributions
    );
    RAISE EXCEPTION 'Expense create accepted total with three decimals';
  EXCEPTION WHEN SQLSTATE '22023' THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Expense total precision error was not controlled'; END IF;

  denied := false;
  BEGIN
    PERFORM public.fn_create_web_expense(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000021',
      '53000000-0053-4000-8000-000000000042',
      '53000000-0053-4000-8000-000000000031',
      'Valid merchant',12.50,current_date,'0053 reject item total precision',
      '[{"name":"Precision item","totalAmount":12.499,"unitPrice":12.50,"quantity":1.000}]'::jsonb,
      distributions
    );
    RAISE EXCEPTION 'Expense item total accepted three decimals';
  EXCEPTION WHEN SQLSTATE '22023' THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Expense item total precision error was not controlled'; END IF;

  denied := false;
  BEGIN
    PERFORM public.fn_create_web_expense(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000021',
      '53000000-0053-4000-8000-000000000042',
      '53000000-0053-4000-8000-000000000031',
      'Valid merchant',12.50,current_date,'0053 reject item unit price precision',
      '[{"name":"Precision item","totalAmount":12.50,"unitPrice":10.129,"quantity":1.000}]'::jsonb,
      distributions
    );
    RAISE EXCEPTION 'Expense item unitPrice accepted three decimals';
  EXCEPTION WHEN SQLSTATE '22023' THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Expense item unitPrice precision error was not controlled'; END IF;

  denied := false;
  BEGIN
    PERFORM public.fn_create_web_expense(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000021',
      '53000000-0053-4000-8000-000000000042',
      '53000000-0053-4000-8000-000000000031',
      'Valid merchant',12.50,current_date,'0053 reject item quantity precision',
      '[{"name":"Precision item","totalAmount":12.50,"unitPrice":12.50,"quantity":1.2345}]'::jsonb,
      distributions
    );
    RAISE EXCEPTION 'Expense item quantity accepted four decimals';
  EXCEPTION WHEN SQLSTATE '22023' THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Expense item quantity precision error was not controlled'; END IF;

  denied := false;
  BEGIN
    PERFORM public.fn_create_web_expense(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000021',
      '53000000-0053-4000-8000-000000000042',
      '53000000-0053-4000-8000-000000000031',
      'Valid merchant',12.50,current_date,'0053 reject distribution amount precision',
      '[]'::jsonb,
      '[{"householdMemberId":"00000000-0000-4000-8000-000000000021","amount":6.259,"percentage":50.00},{"householdMemberId":"00000000-0000-4000-8000-000000000022","amount":6.24,"percentage":50.00}]'::jsonb
    );
    RAISE EXCEPTION 'Expense distribution amount accepted three decimals';
  EXCEPTION WHEN SQLSTATE '22023' THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Distribution amount precision error was not controlled'; END IF;

  denied := false;
  BEGIN
    PERFORM public.fn_create_web_expense(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000021',
      '53000000-0053-4000-8000-000000000042',
      '53000000-0053-4000-8000-000000000031',
      'Valid merchant',12.50,current_date,'0053 reject distribution percentage precision',
      '[]'::jsonb,
      '[{"householdMemberId":"00000000-0000-4000-8000-000000000021","amount":6.25,"percentage":50.001},{"householdMemberId":"00000000-0000-4000-8000-000000000022","amount":6.25,"percentage":49.999}]'::jsonb
    );
    RAISE EXCEPTION 'Expense distribution percentage accepted extra decimals';
  EXCEPTION WHEN SQLSTATE '22023' THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Distribution percentage precision error was not controlled'; END IF;

  denied := false;
  BEGIN
    PERFORM public.fn_create_web_expense(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000021',
      '53000000-0053-4000-8000-000000000042',NULL,
      U&'\00A0',12.50,current_date,'0053 reject merchant NBSP','[]'::jsonb,distributions
    );
    RAISE EXCEPTION 'NBSP-only merchant was accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'NBSP-only merchant did not return SQLSTATE 22023'; END IF;

  denied := false;
  BEGIN
    PERFORM public.fn_create_web_expense(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000021',
      '53000000-0053-4000-8000-000000000042',NULL,
      'Valid merchant',12.50,current_date,'0053 reject item NBSP',
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'name',U&'\00A0','totalAmount',12.50
      )),distributions
    );
    RAISE EXCEPTION 'NBSP-only item name was accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'NBSP-only item name did not return SQLSTATE 22023'; END IF;

  denied := false;
  BEGIN
    PERFORM public.fn_update_web_expense(
      '00000000-0000-4000-8000-000000000001',expense_id,
      true,U&'\00A0',false,NULL,NULL,NULL,NULL,false,NULL,NULL,NULL
    );
    RAISE EXCEPTION 'NBSP-only merchant was accepted on update';
  EXCEPTION WHEN SQLSTATE '22023' THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'NBSP-only merchant update did not return SQLSTATE 22023'; END IF;

  denied := false;
  BEGIN
    PERFORM public.fn_update_web_expense(
      '00000000-0000-4000-8000-000000000001',expense_id,
      false,NULL,false,NULL,NULL,NULL,NULL,false,NULL,
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'name',U&'\00A0','totalAmount',31.25
      )),NULL
    );
    RAISE EXCEPTION 'NBSP-only item name was accepted on replacement';
  EXCEPTION WHEN SQLSTATE '22023' THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'NBSP-only item replacement did not return SQLSTATE 22023'; END IF;

  denied := false;
  BEGIN
    PERFORM public.fn_update_web_expense(
      '00000000-0000-4000-8000-000000000001',expense_id,
      false,NULL,false,NULL,31.259,NULL,NULL,false,NULL,NULL,
      '[{"householdMemberId":"00000000-0000-4000-8000-000000000021","amount":15.71,"percentage":50.25},{"householdMemberId":"00000000-0000-4000-8000-000000000022","amount":15.55,"percentage":49.75}]'::jsonb
    );
    RAISE EXCEPTION 'Expense update accepted total with three decimals';
  EXCEPTION WHEN SQLSTATE '22023' THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Expense update total precision error was not controlled'; END IF;

  denied := false;
  BEGIN
    PERFORM public.fn_update_web_expense(
      '00000000-0000-4000-8000-000000000001',expense_id,
      false,NULL,false,NULL,NULL,NULL,NULL,false,NULL,
      '[{"name":"Precision replacement","totalAmount":31.25,"unitPrice":31.25,"quantity":1.2345,"categoryId":"53000000-0053-4000-8000-000000000042"}]'::jsonb,
      NULL
    );
    RAISE EXCEPTION 'Expense replacement accepted quantity with four decimals';
  EXCEPTION WHEN SQLSTATE '22023' THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Expense replacement quantity precision error was not controlled'; END IF;

  denied := false;
  BEGIN
    PERFORM public.fn_update_web_expense(
      '00000000-0000-4000-8000-000000000001',expense_id,
      false,NULL,false,NULL,NULL,NULL,NULL,false,NULL,NULL,
      '[{"householdMemberId":"00000000-0000-4000-8000-000000000021","amount":15.699,"percentage":50.25},{"householdMemberId":"00000000-0000-4000-8000-000000000022","amount":15.551,"percentage":49.75}]'::jsonb
    );
    RAISE EXCEPTION 'Expense update accepted distribution amount with three decimals';
  EXCEPTION WHEN SQLSTATE '22023' THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Expense update distribution precision error was not controlled'; END IF;

  denied := false;
  BEGIN
    PERFORM public.fn_create_web_expense(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000021',
      '53000000-0053-4000-8000-000000000042',
      '53000000-0053-4000-8000-000000000031',
      '',12.50,current_date,'0053 reject merchant empty','[]'::jsonb,distributions
    );
    RAISE EXCEPTION 'Empty merchant was accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Empty merchant did not return SQLSTATE 22023'; END IF;

  denied := false;
  BEGIN
    PERFORM public.fn_create_web_expense(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000021',
      '53000000-0053-4000-8000-000000000042',
      '53000000-0053-4000-8000-000000000031',
      E' \t\n',12.50,current_date,'0053 reject merchant whitespace','[]'::jsonb,distributions
    );
    RAISE EXCEPTION 'Whitespace-only merchant was accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Whitespace-only merchant did not return SQLSTATE 22023'; END IF;

  denied := false;
  BEGIN
    PERFORM public.fn_create_web_expense(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000021',
      '53000000-0053-4000-8000-000000000042',
      '53000000-0053-4000-8000-000000000031',
      'Valid merchant',12.50,current_date,'0053 reject item empty',
      '[{"name":"","totalAmount":12.50}]'::jsonb,distributions
    );
    RAISE EXCEPTION 'Empty item name was accepted on create';
  EXCEPTION WHEN SQLSTATE '22023' THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Empty item name on create did not return SQLSTATE 22023'; END IF;

  denied := false;
  BEGIN
    PERFORM public.fn_create_web_expense(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000021',
      '53000000-0053-4000-8000-000000000042',
      '53000000-0053-4000-8000-000000000031',
      'Valid merchant',12.50,current_date,'0053 reject item whitespace',
      '[{"name":" \t\n","totalAmount":12.50}]'::jsonb,distributions
    );
    RAISE EXCEPTION 'Whitespace-only item name was accepted on create';
  EXCEPTION WHEN SQLSTATE '22023' THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Whitespace-only item name on create did not return SQLSTATE 22023'; END IF;

  denied := false;
  BEGIN
    PERFORM public.fn_update_web_expense(
      '00000000-0000-4000-8000-000000000001',expense_id,
      true,'',false,NULL,NULL,NULL,NULL,false,NULL,NULL,NULL
    );
    RAISE EXCEPTION 'Empty merchant was accepted on update';
  EXCEPTION WHEN SQLSTATE '22023' THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Empty merchant on update did not return SQLSTATE 22023'; END IF;

  denied := false;
  BEGIN
    PERFORM public.fn_update_web_expense(
      '00000000-0000-4000-8000-000000000001',expense_id,
      true,E' \t\n',false,NULL,NULL,NULL,NULL,false,NULL,NULL,NULL
    );
    RAISE EXCEPTION 'Whitespace-only merchant was accepted on update';
  EXCEPTION WHEN SQLSTATE '22023' THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Whitespace-only merchant on update did not return SQLSTATE 22023'; END IF;

  denied := false;
  BEGIN
    PERFORM public.fn_update_web_expense(
      '00000000-0000-4000-8000-000000000001',expense_id,
      false,NULL,false,NULL,NULL,NULL,NULL,false,NULL,
      '[{"name":" \t\n","totalAmount":31.25,"categoryId":"53000000-0053-4000-8000-000000000042"}]'::jsonb,
      NULL
    );
    RAISE EXCEPTION 'Whitespace-only item name was accepted on replacement';
  EXCEPTION WHEN SQLSTATE '22023' THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Whitespace-only item replacement did not return SQLSTATE 22023'; END IF;

  denied := false;
  BEGIN
    PERFORM public.fn_create_web_expense(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000021',
      '53000000-0053-4000-8000-000000000048',
      '53000000-0053-4000-8000-000000000031',
      'Valid merchant',12.50,current_date,'0053 reject inactive parent',
      '[]'::jsonb,distributions
    );
    RAISE EXCEPTION 'Active MICRO under inactive MACRO was accepted';
  EXCEPTION WHEN SQLSTATE '23514' THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Inactive category parent did not return SQLSTATE 23514'; END IF;
END;
$invalid_expense_inputs$;
RESET ROLE;

DO $invalid_expense_state$
DECLARE
  v_expense_id uuid := current_setting('test.web_crud_expense_id')::uuid;
  v_income_id uuid := current_setting('test.web_crud_income_id')::uuid;
BEGIN
  IF (SELECT count(*)::text FROM public.tb_expenses)
       IS DISTINCT FROM current_setting('test.web_crud_expenses_before')
     OR (SELECT count(*)::text FROM public.tb_expense_items)
       IS DISTINCT FROM current_setting('test.web_crud_items_before')
     OR (SELECT count(*)::text FROM public.tb_expense_distributions)
       IS DISTINCT FROM current_setting('test.web_crud_distributions_before')
     OR (SELECT count(*)::text FROM public.tb_incomes)
       IS DISTINCT FROM current_setting('test.web_crud_incomes_before') THEN
    RAISE EXCEPTION 'Rejected Expense RPC left a partial or changed financial row';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tb_expenses
     WHERE description IN (
       '0053 reject merchant empty',
       '0053 reject merchant whitespace',
       '0053 reject item empty',
       '0053 reject item whitespace',
       '0053 reject inactive parent',
       '0053 reject Expense total precision',
       '0053 reject item total precision',
       '0053 reject item unit price precision',
       '0053 reject item quantity precision',
       '0053 reject distribution amount precision',
       '0053 reject distribution percentage precision',
       '0053 reject merchant NBSP',
       '0053 reject item NBSP'
     )
  ) THEN
    RAISE EXCEPTION 'A rejected create persisted an Expense';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tb_incomes
      WHERE description IN (
        '0053 reject Income create precision',
        '0053 reject Income create NaN',
        '0053 reject Income create Infinity',
        '0053 reject Income create -Infinity'
      )
  ) OR NOT EXISTS (
    SELECT 1 FROM public.tb_incomes
     WHERE id=v_income_id AND amount=24.75
       AND description='0053 updated Web income'
       AND category_id='53000000-0053-4000-8000-000000000044'
  ) THEN
    RAISE EXCEPTION 'Rejected Income precision operation changed Income state';
  END IF;
  IF (SELECT expense_id FROM public.tb_receipts
       WHERE id='53000000-0053-4000-8000-000000000031') IS NOT NULL THEN
    RAISE EXCEPTION 'A rejected create associated its Receipt';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.tb_expenses
     WHERE id=v_expense_id AND status='CONFIRMED' AND merchant IS NULL
       AND total_amount=31.25
  ) OR (SELECT count(*) FROM public.tb_expense_items AS item
         WHERE item.expense_id=v_expense_id) <> 1
    OR (SELECT count(*) FROM public.tb_expense_distributions AS distribution
         WHERE distribution.expense_id=v_expense_id) <> 2
    OR NOT EXISTS (
         SELECT 1 FROM public.tb_expense_items AS item
          WHERE item.expense_id=v_expense_id AND item.name='Receipt item'
            AND item.quantity=1.125 AND item.unit_price=31.25
            AND item.total_amount=31.25
       )
    OR NOT EXISTS (
         SELECT 1 FROM public.tb_expense_distributions AS distribution
          WHERE distribution.expense_id=v_expense_id
            AND distribution.household_member_id='00000000-0000-4000-8000-000000000021'
            AND distribution.amount=15.70 AND distribution.percentage=50.25
       )
    OR NOT EXISTS (
         SELECT 1 FROM public.tb_expense_distributions AS distribution
          WHERE distribution.expense_id=v_expense_id
            AND distribution.household_member_id='00000000-0000-4000-8000-000000000022'
            AND distribution.amount=15.55 AND distribution.percentage=49.75
       )
    OR (SELECT expense_id FROM public.tb_receipts
         WHERE id='53000000-0053-4000-8000-000000000030') IS DISTINCT FROM v_expense_id THEN
    RAISE EXCEPTION 'Rejected item replacement changed Expense, items, distributions or Receipt association';
  END IF;
END;
$invalid_expense_state$;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','53000000-0053-4000-8000-000000000001',true);
DO $optional_item_numeric_values$
DECLARE
  expense_id uuid := current_setting('test.web_crud_expense_id')::uuid;
BEGIN
  PERFORM public.fn_update_web_expense(
    '00000000-0000-4000-8000-000000000001',expense_id,
    false,NULL,false,NULL,NULL,NULL,NULL,false,NULL,
    '[{"name":"Nullable numeric fields","totalAmount":31.25,"quantity":null,"unitPrice":null}]'::jsonb,
    NULL
  );
  PERFORM public.fn_update_web_expense(
    '00000000-0000-4000-8000-000000000001',expense_id,
    false,NULL,false,NULL,NULL,NULL,NULL,false,NULL,
    '[{"name":"Absent numeric fields","totalAmount":31.25}]'::jsonb,
    NULL
  );
END;
$optional_item_numeric_values$;
RESET ROLE;
DO $optional_item_numeric_state$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.tb_expense_items
     WHERE expense_id=current_setting('test.web_crud_expense_id')::uuid
       AND name='Absent numeric fields'
       AND quantity IS NULL AND unit_price IS NULL
       AND total_amount=31.25
  ) THEN
    RAISE EXCEPTION 'Absent or JSON null optional item numerics changed semantics';
  END IF;
END;
$optional_item_numeric_state$;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','53000000-0053-4000-8000-000000000001',true);
DO $expense_delete$
DECLARE
  expense_delete_result text;
BEGIN
  IF public.fn_delete_web_income(
      '00000000-0000-4000-8000-000000000001',
      current_setting('test.web_crud_income_id')::uuid
    ) IS DISTINCT FROM current_setting('test.web_crud_income_id')::uuid THEN
    RAISE EXCEPTION 'Web Income delete failed';
  END IF;
  expense_delete_result := public.fn_delete_web_expense(
    '00000000-0000-4000-8000-000000000001',
    current_setting('test.web_crud_expense_id')::uuid
  );
  IF expense_delete_result IS DISTINCT FROM 'CANCELLED' THEN
    RAISE EXCEPTION 'Web Expense delete did not preserve confirmed cancellation';
  END IF;
END;
$expense_delete$;
RESET ROLE;

DO $post_write$
DECLARE
  v_income uuid := current_setting('test.web_crud_income_id')::uuid;
  v_expense uuid := current_setting('test.web_crud_expense_id')::uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.tb_incomes WHERE id=v_income) THEN
    RAISE EXCEPTION 'Web Income delete left a row';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.tb_expenses
     WHERE id=v_expense AND status='CANCELLED' AND source='WEB'
       AND created_by='00000000-0000-4000-8000-000000000021'
       AND category_id='53000000-0053-4000-8000-000000000042'
  ) THEN
    RAISE EXCEPTION 'Web Expense origin/actor/cancellation was not preserved';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tb_expense_items WHERE expense_id=v_expense)
     OR NOT EXISTS (SELECT 1 FROM public.tb_expense_distributions WHERE expense_id=v_expense)
     OR NOT EXISTS (
       SELECT 1 FROM public.tb_receipts
        WHERE id='53000000-0053-4000-8000-000000000030' AND expense_id=v_expense
     ) THEN
    RAISE EXCEPTION 'Web Expense items, distributions or receipt association were not atomic';
  END IF;
END;
$post_write$;

-- A different authenticated user with no membership in the requested house
-- cannot use the route's household argument to access the foreign row.
SELECT set_config(
  'test.web_crud_foreign_income_id',
  (SELECT id::text FROM public.tb_incomes
    WHERE household_id='53000000-0053-4000-8000-000000000010'
      AND description='foreign Web CRUD fixture'),
  true
);
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','53000000-0053-4000-8000-000000000001',true);
DO $foreign_household$
DECLARE
  denied boolean := false;
  foreign_income_id uuid := current_setting('test.web_crud_foreign_income_id')::uuid;
BEGIN
  IF foreign_income_id IS NULL THEN
    RAISE EXCEPTION 'Foreign income fixture is missing';
  END IF;

  BEGIN
    PERFORM public.fn_create_web_income(
      '53000000-0053-4000-8000-000000000010',
      '53000000-0053-4000-8000-000000000020',1,current_date,'foreign denied',NULL
    );
  EXCEPTION WHEN insufficient_privilege THEN
    denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Foreign household operation was admitted'; END IF;

  denied := false;
  BEGIN
    PERFORM public.fn_update_web_income(
      '53000000-0053-4000-8000-000000000010',foreign_income_id,
      '{"amount":99}'::jsonb
    );
    RAISE EXCEPTION 'Foreign household income update was admitted';
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Foreign household income update was admitted'; END IF;

  denied := false;
  BEGIN
    PERFORM public.fn_delete_web_income(
      '53000000-0053-4000-8000-000000000010',foreign_income_id
    );
    RAISE EXCEPTION 'Foreign household income delete was admitted';
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Foreign household income delete was admitted'; END IF;

END;
$foreign_household$;
RESET ROLE;
DO $foreign_household_unchanged$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.tb_incomes
     WHERE id=current_setting('test.web_crud_foreign_income_id')::uuid
       AND amount=90
  ) THEN
    RAISE EXCEPTION 'Foreign income was changed by a denied request';
  END IF;
END;
$foreign_household_unchanged$;

UPDATE public.tb_household_members SET status='LEFT'
 WHERE id='00000000-0000-4000-8000-000000000021';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','53000000-0053-4000-8000-000000000001',true);
DO $inactive_membership$
DECLARE denied boolean := false;
BEGIN
  BEGIN
    PERFORM public.fn_create_web_income(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000021',1,current_date,'inactive denied',NULL
    );
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Inactive membership was admitted'; END IF;
END;
$inactive_membership$;
RESET ROLE;
UPDATE public.tb_household_members SET status='ACTIVE'
 WHERE id='00000000-0000-4000-8000-000000000021';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','',true);
DO $no_session$
DECLARE denied boolean := false;
BEGIN
  BEGIN
    PERFORM public.fn_delete_web_income(
      '00000000-0000-4000-8000-000000000001',
      '53000000-0053-4000-8000-000000000099'
    );
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'A missing session was admitted'; END IF;
END;
$no_session$;
RESET ROLE;

SET LOCAL ROLE anon;
DO $anon_denied$
DECLARE denied boolean := false;
BEGIN
  BEGIN
    PERFORM public.fn_delete_web_income(
      '00000000-0000-4000-8000-000000000001',
      '53000000-0053-4000-8000-000000000099'
    );
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'anon invoked a Web CRUD entry'; END IF;
END;
$anon_denied$;
RESET ROLE;

SET LOCAL ROLE service_role;
DO $service_denied$
DECLARE denied boolean := false;
BEGIN
  BEGIN
    PERFORM public.fn_create_web_income(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000021',1,current_date,'service denied',NULL
    );
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'service_role invoked a Web CRUD entry'; END IF;
  denied := false;
  BEGIN
    PERFORM public.fn_create_income_eligible(NULL,NULL,NULL,NULL,1,current_date,'legacy denied',NULL);
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'service_role invoked generic eligible Income CRUD'; END IF;
END;
$service_denied$;
RESET ROLE;

ROLLBACK;
