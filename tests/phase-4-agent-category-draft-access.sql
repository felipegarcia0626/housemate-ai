BEGIN;

DO $$
DECLARE
  draft_table OID := 'public.tb_agent_category_drafts'::regclass;
  role_name TEXT;
  signature TEXT;
  function_oid OID;
  public_grant BOOLEAN;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class c
     WHERE c.oid = draft_table
       AND c.relrowsecurity
       AND NOT c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'Draft RLS must be enabled without FORCE';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_policies p
     WHERE p.schemaname = 'public'
       AND p.tablename = 'tb_agent_category_drafts'
  ) THEN
    RAISE EXCEPTION 'Draft table must not have client policies';
  END IF;

  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_table_privilege(role_name, draft_table, 'SELECT')
       OR has_table_privilege(role_name, draft_table, 'INSERT')
       OR has_table_privilege(role_name, draft_table, 'UPDATE')
       OR has_table_privilege(role_name, draft_table, 'DELETE')
       OR has_table_privilege(role_name, draft_table, 'TRUNCATE')
       OR has_table_privilege(role_name, draft_table, 'REFERENCES')
       OR has_table_privilege(role_name, draft_table, 'TRIGGER')
       OR has_table_privilege(role_name, draft_table, 'MAINTAIN') THEN
      RAISE EXCEPTION 'Client role retains an effective table privilege';
    END IF;

    IF EXISTS (
      SELECT 1
        FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = draft_table
         AND a.attnum > 0
         AND NOT a.attisdropped
         AND (
           has_column_privilege(role_name, a.attrelid, a.attnum, 'SELECT')
           OR has_column_privilege(role_name, a.attrelid, a.attnum, 'INSERT')
           OR has_column_privilege(role_name, a.attrelid, a.attnum, 'UPDATE')
           OR has_column_privilege(role_name, a.attrelid, a.attnum, 'REFERENCES')
         )
    ) THEN
      RAISE EXCEPTION 'Client role retains an effective column privilege';
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class c
      CROSS JOIN LATERAL aclexplode(
        COALESCE(c.relacl, acldefault('r', c.relowner))
      ) a
     WHERE c.oid = draft_table
       AND a.grantee = 0
  ) THEN
    RAISE EXCEPTION 'PUBLIC retains a direct draft-table privilege';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute a
      CROSS JOIN LATERAL aclexplode(a.attacl) acl
     WHERE a.attrelid = draft_table
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND acl.grantee = 0
  ) THEN
    RAISE EXCEPTION 'PUBLIC retains a direct draft-column privilege';
  END IF;

  IF NOT (
    has_table_privilege('service_role', draft_table, 'SELECT')
    AND has_table_privilege('service_role', draft_table, 'INSERT')
    AND has_table_privilege('service_role', draft_table, 'UPDATE')
    AND has_table_privilege('service_role', draft_table, 'DELETE')
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles r
     WHERE r.rolname = 'service_role' AND r.rolbypassrls
  ) THEN
    RAISE EXCEPTION 'service_role draft access was not preserved';
  END IF;

  FOREACH signature IN ARRAY ARRAY[
    'public.fn_create_whatsapp_agent_draft(uuid,uuid,uuid,text,public.pending_operation_type,jsonb,public.agent_category_draft_status,uuid,uuid,bigint)',
    'public.fn_update_whatsapp_agent_draft(uuid,uuid,uuid,text,public.pending_operation_type,jsonb,public.agent_category_draft_status,timestamptz,uuid,uuid,bigint)',
    'public.fn_delete_whatsapp_agent_draft(uuid,uuid,uuid,text,timestamptz,uuid,uuid,bigint)'
  ] LOOP
    function_oid := to_regprocedure(signature)::oid;
    IF function_oid IS NULL THEN
      RAISE EXCEPTION 'Expected legacy draft RPC is absent';
    END IF;
    IF has_function_privilege('anon', function_oid, 'EXECUTE')
       OR has_function_privilege('authenticated', function_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'Client role retains effective EXECUTE on a legacy draft RPC';
    END IF;
    IF NOT has_function_privilege('service_role', function_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role lost a legacy draft RPC required by wrappers';
    END IF;
    SELECT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_proc p
        CROSS JOIN LATERAL aclexplode(
          COALESCE(p.proacl, acldefault('f', p.proowner))
        ) a
       WHERE p.oid = function_oid
         AND a.grantee = 0
         AND a.privilege_type = 'EXECUTE'
    ) INTO public_grant;
    IF public_grant THEN
      RAISE EXCEPTION 'PUBLIC retains EXECUTE on a legacy draft RPC';
    END IF;
  END LOOP;

END;
$$;

SET LOCAL ROLE service_role;
DO $$
DECLARE
  affected INTEGER;
BEGIN
  INSERT INTO public.tb_agent_category_drafts
    (id, household_id, actor_member_id, conversation_key, source,
     operation_type, payload, status)
  VALUES
    ('49000000-0049-4000-8000-000000000003',
     '00000000-0000-4000-8000-000000000001',
     '00000000-0000-4000-8000-000000000021',
     'service-role-access-test', 'WEB', 'CREATE_EXPENSE', '{}', 'AWAITING_CATEGORY');

  IF NOT EXISTS (
    SELECT 1 FROM public.tb_agent_category_drafts
     WHERE id = '49000000-0049-4000-8000-000000000003'
  ) THEN
    RAISE EXCEPTION 'service_role could not read a draft directly';
  END IF;

  UPDATE public.tb_agent_category_drafts
     SET payload = '{"updated":true}'
   WHERE id = '49000000-0049-4000-8000-000000000003';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'service_role could not update a draft directly'; END IF;

  DELETE FROM public.tb_agent_category_drafts
   WHERE id = '49000000-0049-4000-8000-000000000003';
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> 1 THEN RAISE EXCEPTION 'service_role could not delete a draft directly'; END IF;
END;
$$;
RESET ROLE;

SET LOCAL ROLE anon;
DO $$
DECLARE
  denied BOOLEAN;
  statement TEXT;
  expected_name TEXT;
  actual_message TEXT;
  test_call TEXT[];
BEGIN
  denied := FALSE;
  BEGIN
    PERFORM 1 FROM public.tb_agent_category_drafts
     WHERE id = '49000000-0049-4000-8000-000000000003';
  EXCEPTION WHEN insufficient_privilege THEN
    denied := TRUE;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'anon selected drafts directly'; END IF;

  denied := FALSE;
  BEGIN
    INSERT INTO public.tb_agent_category_drafts
      (id, household_id, actor_member_id, conversation_key, operation_type, payload, status)
    VALUES
      ('49000000-0049-4000-8000-000000000001',
       '00000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-000000000021',
       'anon-direct-access-test', 'CREATE_EXPENSE', '{}', 'AWAITING_CATEGORY');
  EXCEPTION WHEN insufficient_privilege THEN
    denied := TRUE;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'anon inserted a draft directly'; END IF;

  denied := FALSE;
  BEGIN
    UPDATE public.tb_agent_category_drafts SET payload = '{}'
     WHERE id = '49000000-0049-4000-8000-000000000003';
  EXCEPTION WHEN insufficient_privilege THEN
    denied := TRUE;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'anon updated drafts directly'; END IF;

  denied := FALSE;
  BEGIN
    DELETE FROM public.tb_agent_category_drafts
     WHERE id = '49000000-0049-4000-8000-000000000003';
  EXCEPTION WHEN insufficient_privilege THEN
    denied := TRUE;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'anon deleted drafts directly'; END IF;

  FOREACH test_call SLICE 1 IN ARRAY ARRAY[
    ARRAY[$call$SELECT public.fn_create_whatsapp_agent_draft(
      '49000000-0049-4000-8000-000000000010'::uuid,
      '00000000-0000-4000-8000-000000000001'::uuid,
      '00000000-0000-4000-8000-000000000021'::uuid,
      'legacy-rpc-access-test', 'CREATE_EXPENSE', '{}'::jsonb,
      'AWAITING_CATEGORY', '00000000-0000-4000-8000-000000000011'::uuid,
      '00000000-0000-4000-8000-000000000011'::uuid, 1::bigint)$call$, 'fn_create_whatsapp_agent_draft'],
    ARRAY[$call$SELECT public.fn_update_whatsapp_agent_draft(
      '49000000-0049-4000-8000-000000000010'::uuid,
      '00000000-0000-4000-8000-000000000001'::uuid,
      '00000000-0000-4000-8000-000000000021'::uuid,
      'legacy-rpc-access-test', 'CREATE_EXPENSE', '{}'::jsonb,
      'AWAITING_CATEGORY', NULL::timestamptz,
      '00000000-0000-4000-8000-000000000011'::uuid,
      '00000000-0000-4000-8000-000000000011'::uuid, 1::bigint)$call$, 'fn_update_whatsapp_agent_draft'],
    ARRAY[$call$SELECT public.fn_delete_whatsapp_agent_draft(
      '49000000-0049-4000-8000-000000000010'::uuid,
      '00000000-0000-4000-8000-000000000001'::uuid,
      '00000000-0000-4000-8000-000000000021'::uuid,
      'legacy-rpc-access-test', NULL::timestamptz,
      '00000000-0000-4000-8000-000000000011'::uuid,
      '00000000-0000-4000-8000-000000000011'::uuid, 1::bigint)$call$, 'fn_delete_whatsapp_agent_draft']
  ] LOOP
    statement := test_call[1];
    expected_name := test_call[2];
    denied := FALSE;
    BEGIN
      EXECUTE statement;
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS actual_message = MESSAGE_TEXT;
      IF actual_message <> 'permission denied for function ' || expected_name THEN
        RAISE EXCEPTION 'anon reached a legacy draft RPC body';
      END IF;
      denied := TRUE;
    END;
    IF NOT denied THEN RAISE EXCEPTION 'anon executed a legacy draft RPC'; END IF;
  END LOOP;
END;
$$;

RESET ROLE;
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  denied BOOLEAN;
  statement TEXT;
  expected_name TEXT;
  actual_message TEXT;
  test_call TEXT[];
BEGIN
  denied := FALSE;
  BEGIN
    PERFORM 1 FROM public.tb_agent_category_drafts
     WHERE id = '49000000-0049-4000-8000-000000000003';
  EXCEPTION WHEN insufficient_privilege THEN
    denied := TRUE;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'authenticated selected drafts directly'; END IF;

  denied := FALSE;
  BEGIN
    INSERT INTO public.tb_agent_category_drafts
      (id, household_id, actor_member_id, conversation_key, operation_type, payload, status)
    VALUES
      ('49000000-0049-4000-8000-000000000002',
       '00000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-000000000021',
       'authenticated-direct-access-test', 'CREATE_EXPENSE', '{}', 'AWAITING_CATEGORY');
  EXCEPTION WHEN insufficient_privilege THEN
    denied := TRUE;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'authenticated inserted a draft directly'; END IF;

  denied := FALSE;
  BEGIN
    UPDATE public.tb_agent_category_drafts SET payload = '{}'
     WHERE id = '49000000-0049-4000-8000-000000000003';
  EXCEPTION WHEN insufficient_privilege THEN
    denied := TRUE;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'authenticated updated drafts directly'; END IF;

  denied := FALSE;
  BEGIN
    DELETE FROM public.tb_agent_category_drafts
     WHERE id = '49000000-0049-4000-8000-000000000003';
  EXCEPTION WHEN insufficient_privilege THEN
    denied := TRUE;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'authenticated deleted drafts directly'; END IF;

  FOREACH test_call SLICE 1 IN ARRAY ARRAY[
    ARRAY[$call$SELECT public.fn_create_whatsapp_agent_draft(
      '49000000-0049-4000-8000-000000000020'::uuid,
      '00000000-0000-4000-8000-000000000001'::uuid,
      '00000000-0000-4000-8000-000000000021'::uuid,
      'legacy-rpc-access-test', 'CREATE_EXPENSE', '{}'::jsonb,
      'AWAITING_CATEGORY', '00000000-0000-4000-8000-000000000011'::uuid,
      '00000000-0000-4000-8000-000000000011'::uuid, 1::bigint)$call$, 'fn_create_whatsapp_agent_draft'],
    ARRAY[$call$SELECT public.fn_update_whatsapp_agent_draft(
      '49000000-0049-4000-8000-000000000020'::uuid,
      '00000000-0000-4000-8000-000000000001'::uuid,
      '00000000-0000-4000-8000-000000000021'::uuid,
      'legacy-rpc-access-test', 'CREATE_EXPENSE', '{}'::jsonb,
      'AWAITING_CATEGORY', NULL::timestamptz,
      '00000000-0000-4000-8000-000000000011'::uuid,
      '00000000-0000-4000-8000-000000000011'::uuid, 1::bigint)$call$, 'fn_update_whatsapp_agent_draft'],
    ARRAY[$call$SELECT public.fn_delete_whatsapp_agent_draft(
      '49000000-0049-4000-8000-000000000020'::uuid,
      '00000000-0000-4000-8000-000000000001'::uuid,
      '00000000-0000-4000-8000-000000000021'::uuid,
      'legacy-rpc-access-test', NULL::timestamptz,
      '00000000-0000-4000-8000-000000000011'::uuid,
      '00000000-0000-4000-8000-000000000011'::uuid, 1::bigint)$call$, 'fn_delete_whatsapp_agent_draft']
  ] LOOP
    statement := test_call[1];
    expected_name := test_call[2];
    denied := FALSE;
    BEGIN
      EXECUTE statement;
    EXCEPTION WHEN insufficient_privilege THEN
      GET STACKED DIAGNOSTICS actual_message = MESSAGE_TEXT;
      IF actual_message <> 'permission denied for function ' || expected_name THEN
        RAISE EXCEPTION 'authenticated reached a legacy draft RPC body';
      END IF;
      denied := TRUE;
    END;
    IF NOT denied THEN RAISE EXCEPTION 'authenticated executed a legacy draft RPC'; END IF;
  END LOOP;
END;
$$;

RESET ROLE;

ROLLBACK;
