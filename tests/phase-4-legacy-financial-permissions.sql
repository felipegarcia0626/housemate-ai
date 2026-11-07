BEGIN;

CREATE FUNCTION pg_temp.expect_permission_denied(
  test_name TEXT,
  statement TEXT,
  expected_message TEXT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  actual_message TEXT;
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS actual_message = MESSAGE_TEXT;
    IF actual_message IS DISTINCT FROM expected_message THEN
      RAISE EXCEPTION 'FAIL %: expected %, received %',
        test_name, expected_message, actual_message;
    END IF;
    RAISE NOTICE 'PASS %', test_name;
    RETURN;
  END;

  RAISE EXCEPTION 'FAIL %: statement unexpectedly succeeded', test_name;
END;
$$;

DO $$
DECLARE
  role_name TEXT;
  relation_oid REGCLASS;
  privilege_name TEXT;
  column_name TEXT;
  function_oid OID;
  legacy_functions OID[] := ARRAY[
    'public.fn_create_expense(uuid,uuid,uuid,uuid,uuid,text,numeric,date,text,public.expense_source,jsonb,jsonb)'::REGPROCEDURE::OID,
    'public.fn_update_expense(uuid,uuid,boolean,text,boolean,text,numeric,date,uuid,boolean,uuid,jsonb,jsonb)'::REGPROCEDURE::OID,
    'public.fn_delete_expense(uuid,uuid)'::REGPROCEDURE::OID,
    'public.fn_confirm_pending_expense(uuid,uuid,text,uuid,public.expense_source,uuid,uuid,uuid,uuid,text,numeric,date,text,public.expense_source,jsonb,jsonb)'::REGPROCEDURE::OID,
    'public.fn_confirm_pending_income(uuid,uuid,text,uuid,public.expense_source,uuid,uuid,numeric,date,text,uuid)'::REGPROCEDURE::OID,
    'public.fn_confirm_pending_expense_consistent(uuid,uuid,text,uuid,public.expense_source,timestamp with time zone,uuid,uuid,uuid,uuid,text,numeric,date,text,public.expense_source,jsonb,jsonb,uuid,uuid,bigint)'::REGPROCEDURE::OID,
    'public.fn_confirm_pending_income_consistent(uuid,uuid,text,uuid,public.expense_source,timestamp with time zone,uuid,uuid,numeric,date,text,uuid,uuid,uuid,bigint)'::REGPROCEDURE::OID
  ];
  approved_functions OID[] := ARRAY[
    'public.fn_create_expense_eligible(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,numeric,date,text,public.expense_source,jsonb,jsonb)'::REGPROCEDURE::OID,
    'public.fn_update_expense_eligible(uuid,uuid,uuid,uuid,boolean,text,boolean,text,numeric,date,uuid,boolean,uuid,jsonb,jsonb)'::REGPROCEDURE::OID,
    'public.fn_delete_expense_eligible(uuid,uuid,uuid,uuid)'::REGPROCEDURE::OID,
    'public.fn_create_income_eligible(uuid,uuid,uuid,uuid,numeric,date,text,uuid)'::REGPROCEDURE::OID,
    'public.fn_update_income_eligible(uuid,uuid,uuid,uuid,jsonb)'::REGPROCEDURE::OID,
    'public.fn_delete_income_eligible(uuid,uuid,uuid,uuid)'::REGPROCEDURE::OID,
    'public.fn_confirm_pending_expense_eligible(uuid,uuid,uuid,text,uuid,public.expense_source,timestamp with time zone,uuid,uuid,uuid,uuid,text,numeric,date,text,public.expense_source,jsonb,jsonb,uuid,uuid,bigint)'::REGPROCEDURE::OID,
    'public.fn_confirm_pending_income_eligible(uuid,uuid,uuid,text,uuid,public.expense_source,timestamp with time zone,uuid,uuid,numeric,date,text,uuid,uuid,uuid,bigint)'::REGPROCEDURE::OID,
    'public.fn_confirm_whatsapp_expense_event(text,uuid,bigint,uuid,text,timestamp with time zone,uuid,uuid,uuid,text,numeric,date,text,jsonb,jsonb)'::REGPROCEDURE::OID,
    'public.fn_confirm_whatsapp_income_event(text,uuid,bigint,uuid,text,timestamp with time zone,uuid,numeric,date,text,uuid)'::REGPROCEDURE::OID
  ];
  function_record RECORD;
BEGIN
  IF (SELECT count(*) FROM pg_catalog.pg_proc AS p
       JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN (
          'fn_create_expense', 'fn_update_expense', 'fn_delete_expense',
          'fn_confirm_pending_expense', 'fn_confirm_pending_income',
          'fn_confirm_pending_expense_consistent', 'fn_confirm_pending_income_consistent'
        )) <> 7 THEN
    RAISE EXCEPTION 'FAIL unexpected overload or missing legacy financial function';
  END IF;

  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    FOREACH relation_oid IN ARRAY ARRAY[
      'public.tb_expenses'::REGCLASS,
      'public.tb_expense_items'::REGCLASS,
      'public.tb_expense_distributions'::REGCLASS,
      'public.tb_incomes'::REGCLASS
    ] LOOP
      FOREACH privilege_name IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
        IF has_table_privilege(role_name, relation_oid, privilege_name) THEN
          RAISE EXCEPTION 'FAIL % retains effective % on %', role_name, privilege_name, relation_oid;
        END IF;
      END LOOP;

      FOR column_name IN
        SELECT a.attname::TEXT
          FROM pg_catalog.pg_attribute AS a
         WHERE a.attrelid = relation_oid
           AND a.attnum > 0
           AND NOT a.attisdropped
      LOOP
        IF has_column_privilege(role_name, relation_oid, column_name, 'INSERT')
           OR has_column_privilege(role_name, relation_oid, column_name, 'UPDATE') THEN
          RAISE EXCEPTION 'FAIL % retains effective write privilege on %.%',
            role_name, relation_oid, column_name;
        END IF;
      END LOOP;
    END LOOP;

    FOREACH function_oid IN ARRAY legacy_functions LOOP
      IF has_function_privilege(role_name, function_oid, 'EXECUTE') THEN
        RAISE EXCEPTION 'FAIL % retains effective EXECUTE on %', role_name, function_oid::REGPROCEDURE;
      END IF;
    END LOOP;

    FOREACH function_oid IN ARRAY approved_functions LOOP
      IF has_function_privilege(role_name, function_oid, 'EXECUTE')
         IS DISTINCT FROM (role_name = 'service_role') THEN
        RAISE EXCEPTION 'FAIL unexpected approved-entry EXECUTE for % on %',
          role_name, function_oid::REGPROCEDURE;
      END IF;
    END LOOP;
  END LOOP;

  FOREACH relation_oid IN ARRAY ARRAY[
    'public.tb_expenses'::REGCLASS,
    'public.tb_expense_items'::REGCLASS,
    'public.tb_expense_distributions'::REGCLASS,
    'public.tb_incomes'::REGCLASS
  ] LOOP
    IF NOT has_table_privilege('service_role', relation_oid, 'SELECT') THEN
      RAISE EXCEPTION 'FAIL service_role lost required SELECT on %', relation_oid;
    END IF;
  END LOOP;

  FOR function_record IN
    SELECT p.oid, p.proname, p.prosecdef, p.proconfig, p.proowner
      FROM pg_catalog.pg_proc AS p
     WHERE p.oid = ANY (legacy_functions)
  LOOP
    IF function_record.proowner <> 'postgres'::REGROLE THEN
      RAISE EXCEPTION 'FAIL % owner is not postgres', function_record.proname;
    END IF;
    IF function_record.proname IN (
      'fn_confirm_pending_expense_consistent',
      'fn_confirm_pending_income_consistent'
    ) THEN
      IF NOT function_record.prosecdef
         OR function_record.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog'] THEN
        RAISE EXCEPTION 'FAIL % lost its SECURITY DEFINER configuration', function_record.proname;
      END IF;
    ELSIF function_record.prosecdef THEN
      RAISE EXCEPTION 'FAIL base implementation % unexpectedly became SECURITY DEFINER', function_record.proname;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS p
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
      ) AS acl
     WHERE p.oid = ANY (legacy_functions)
       AND acl.grantee = 0
       AND acl.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'FAIL PUBLIC has EXECUTE on a legacy financial RPC';
  END IF;

  RAISE NOTICE 'PASS inherited/effective ACL, table ownership, legacy RPC signatures, and approved service_role entries';
END;
$$;

-- Failed statements are transactional test probes. INSERT SELECT/UPDATE/DELETE
-- use false predicates so a mistakenly retained grant cannot leave fixture data.
SET LOCAL ROLE service_role;

SELECT pg_temp.expect_permission_denied(
  'legacy direct expense INSERT',
  $sql$INSERT INTO public.tb_expenses SELECT * FROM public.tb_expenses WHERE FALSE$sql$,
  'permission denied for table tb_expenses'
);
SELECT pg_temp.expect_permission_denied(
  'legacy direct expense-item INSERT',
  $sql$INSERT INTO public.tb_expense_items SELECT * FROM public.tb_expense_items WHERE FALSE$sql$,
  'permission denied for table tb_expense_items'
);
SELECT pg_temp.expect_permission_denied(
  'legacy direct expense-distribution INSERT',
  $sql$INSERT INTO public.tb_expense_distributions SELECT * FROM public.tb_expense_distributions WHERE FALSE$sql$,
  'permission denied for table tb_expense_distributions'
);
SELECT pg_temp.expect_permission_denied(
  'legacy direct income INSERT',
  $sql$INSERT INTO public.tb_incomes SELECT * FROM public.tb_incomes WHERE FALSE$sql$,
  'permission denied for table tb_incomes'
);
SELECT pg_temp.expect_permission_denied(
  'legacy direct expense UPDATE',
  $sql$UPDATE public.tb_expenses SET id = id WHERE FALSE$sql$,
  'permission denied for table tb_expenses'
);
SELECT pg_temp.expect_permission_denied(
  'legacy direct expense-item UPDATE',
  $sql$UPDATE public.tb_expense_items SET id = id WHERE FALSE$sql$,
  'permission denied for table tb_expense_items'
);
SELECT pg_temp.expect_permission_denied(
  'legacy direct expense-distribution UPDATE',
  $sql$UPDATE public.tb_expense_distributions SET id = id WHERE FALSE$sql$,
  'permission denied for table tb_expense_distributions'
);
SELECT pg_temp.expect_permission_denied(
  'legacy direct income UPDATE',
  $sql$UPDATE public.tb_incomes SET id = id WHERE FALSE$sql$,
  'permission denied for table tb_incomes'
);
SELECT pg_temp.expect_permission_denied(
  'legacy direct expense DELETE',
  $sql$DELETE FROM public.tb_expenses WHERE FALSE$sql$,
  'permission denied for table tb_expenses'
);
SELECT pg_temp.expect_permission_denied(
  'legacy direct expense-item DELETE',
  $sql$DELETE FROM public.tb_expense_items WHERE FALSE$sql$,
  'permission denied for table tb_expense_items'
);
SELECT pg_temp.expect_permission_denied(
  'legacy direct expense-distribution DELETE',
  $sql$DELETE FROM public.tb_expense_distributions WHERE FALSE$sql$,
  'permission denied for table tb_expense_distributions'
);
SELECT pg_temp.expect_permission_denied(
  'legacy direct income DELETE',
  $sql$DELETE FROM public.tb_incomes WHERE FALSE$sql$,
  'permission denied for table tb_incomes'
);

SELECT pg_temp.expect_permission_denied(
  'legacy fn_create_expense RPC',
  $sql$SELECT public.fn_create_expense(
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000021',
    '00000000-0000-4000-8000-000000000021', NULL, NULL,
    '0052 legacy path probe', 1, current_date, NULL, 'WEB', '[]',
    '[{"householdMemberId":"00000000-0000-4000-8000-000000000021","amount":1,"percentage":100}]'
  )$sql$,
  'permission denied for function fn_create_expense'
);
SELECT pg_temp.expect_permission_denied(
  'legacy fn_update_expense RPC',
  $sql$SELECT public.fn_update_expense(
    '00000000-0000-4000-8000-000000000001',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    FALSE, NULL, FALSE, NULL, NULL, NULL, NULL, FALSE, NULL, '[]', '[]'
  )$sql$,
  'permission denied for function fn_update_expense'
);
SELECT pg_temp.expect_permission_denied(
  'legacy fn_delete_expense RPC',
  $sql$SELECT public.fn_delete_expense(
    '00000000-0000-4000-8000-000000000001',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  )$sql$,
  'permission denied for function fn_delete_expense'
);
SELECT pg_temp.expect_permission_denied(
  'legacy fn_confirm_pending_expense RPC',
  $sql$SELECT public.fn_confirm_pending_expense(
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    '00000000-0000-4000-8000-000000000001', '0052-legacy'
  )$sql$,
  'permission denied for function fn_confirm_pending_expense'
);
SELECT pg_temp.expect_permission_denied(
  'legacy fn_confirm_pending_income RPC',
  $sql$SELECT public.fn_confirm_pending_income(
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    '00000000-0000-4000-8000-000000000001', '0052-legacy'
  )$sql$,
  'permission denied for function fn_confirm_pending_income'
);
SELECT pg_temp.expect_permission_denied(
  'legacy fn_confirm_pending_expense_consistent RPC',
  $sql$SELECT public.fn_confirm_pending_expense_consistent(
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    '00000000-0000-4000-8000-000000000001', '0052-legacy'
  )$sql$,
  'permission denied for function fn_confirm_pending_expense_consistent'
);
SELECT pg_temp.expect_permission_denied(
  'legacy fn_confirm_pending_income_consistent RPC',
  $sql$SELECT public.fn_confirm_pending_income_consistent(
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    '00000000-0000-4000-8000-000000000001', '0052-legacy'
  )$sql$,
  'permission denied for function fn_confirm_pending_income_consistent'
);

RESET ROLE;

-- Exercise current service_role-authorized CRUD entries after raw table grants
-- are removed. Confirmation positives remain covered by phase-4 financial and
-- WhatsApp event tests.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users(id UUID PRIMARY KEY, email TEXT);
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_confirmed_at TIMESTAMPTZ;
INSERT INTO auth.users(id, email, email_confirmed_at)
VALUES ('52000000-0052-4000-8000-000000000099', 'financial-0052@example.test', now());
UPDATE public.tb_users
   SET auth_user_id = '52000000-0052-4000-8000-000000000099'
 WHERE id = '00000000-0000-4000-8000-000000000011';

SET LOCAL ROLE service_role;

DO $$
DECLARE
  income_result JSONB;
  income_id UUID;
  expense_id UUID;
  update_result UUID;
  delete_result TEXT;
BEGIN
  income_result := public.fn_create_income_eligible(
    '52000000-0052-4000-8000-000000000099',
    '00000000-0000-4000-8000-000000000021',
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000021',
    8.25, current_date, '0052 service_role eligible income', NULL
  );
  income_id := (income_result ->> 'id')::UUID;
  IF income_id IS NULL THEN RAISE EXCEPTION 'FAIL eligible Income create returned no id'; END IF;

  income_result := public.fn_update_income_eligible(
    '52000000-0052-4000-8000-000000000099',
    '00000000-0000-4000-8000-000000000021',
    '00000000-0000-4000-8000-000000000001',
    income_id,
    '{"description":"0052 eligible income updated"}'::JSONB
  );
  IF income_result ->> 'description' IS DISTINCT FROM '0052 eligible income updated' THEN
    RAISE EXCEPTION 'FAIL eligible Income update did not persist';
  END IF;
  delete_result := public.fn_delete_income_eligible(
    '52000000-0052-4000-8000-000000000099',
    '00000000-0000-4000-8000-000000000021',
    '00000000-0000-4000-8000-000000000001',
    income_id
  );
  IF delete_result IS DISTINCT FROM income_id::TEXT THEN
    RAISE EXCEPTION 'FAIL eligible Income delete failed';
  END IF;

  expense_id := public.fn_create_expense_eligible(
    '52000000-0052-4000-8000-000000000099',
    '00000000-0000-4000-8000-000000000021',
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000021',
    '00000000-0000-4000-8000-000000000021',
    NULL, NULL, '0052 eligible expense', 8.25, current_date,
    '0052 service_role eligible expense', 'WEB', '[]'::JSONB,
    '[{"householdMemberId":"00000000-0000-4000-8000-000000000021","amount":8.25,"percentage":100}]'::JSONB
  );
  IF expense_id IS NULL THEN RAISE EXCEPTION 'FAIL eligible Expense create returned no id'; END IF;

  update_result := public.fn_update_expense_eligible(
    '52000000-0052-4000-8000-000000000099',
    '00000000-0000-4000-8000-000000000021',
    '00000000-0000-4000-8000-000000000001',
    expense_id, TRUE, '0052 updated merchant', FALSE, NULL,
    NULL, NULL, NULL, FALSE, NULL, NULL, NULL
  );
  IF update_result IS DISTINCT FROM expense_id THEN
    RAISE EXCEPTION 'FAIL eligible Expense update failed';
  END IF;
  delete_result := public.fn_delete_expense_eligible(
    '52000000-0052-4000-8000-000000000099',
    '00000000-0000-4000-8000-000000000021',
    '00000000-0000-4000-8000-000000000001',
    expense_id
  );
  IF delete_result IS NULL THEN RAISE EXCEPTION 'FAIL eligible Expense delete failed'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.tb_expenses WHERE id = expense_id AND status = 'CANCELLED'
  ) THEN
    RAISE EXCEPTION 'FAIL eligible Expense delete did not preserve cancellation semantics';
  END IF;

  RAISE NOTICE 'PASS service_role eligible Expense and Income create/update/delete remain usable';
END;
$$;

RESET ROLE;

ROLLBACK;
