BEGIN;

-- Keep the 0042 eligible RPCs used by Web repositories and the 0047 event
-- wrappers used by WhatsApp. These channels still share service_role; this
-- migration closes legacy entry points but does not create credential isolation.
-- The SECURITY DEFINER owner can call these SECURITY INVOKER implementations.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE
  public.tb_expenses,
  public.tb_expense_items,
  public.tb_expense_distributions,
  public.tb_incomes
FROM PUBLIC, anon, authenticated, service_role;

-- Table-level REVOKE does not remove column-level INSERT/UPDATE grants. Remove
-- any such ACLs too, including ACLs inherited from the historical setup.
DO $column_acl$
DECLARE
  target_column RECORD;
BEGIN
  FOR target_column IN
    SELECT n.nspname, c.relname, a.attname
      FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.oid
     WHERE c.oid = ANY (ARRAY[
       'public.tb_expenses'::REGCLASS,
       'public.tb_expense_items'::REGCLASS,
       'public.tb_expense_distributions'::REGCLASS,
       'public.tb_incomes'::REGCLASS
     ])
       AND a.attnum > 0
       AND NOT a.attisdropped
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE INSERT (%1$I), UPDATE (%1$I) ON TABLE %2$I.%3$I FROM PUBLIC, anon, authenticated, service_role',
      target_column.attname,
      target_column.nspname,
      target_column.relname
    );
  END LOOP;
END;
$column_acl$;

-- These historical implementation RPCs were granted directly to service_role
-- by 0003–0005 and 0018–0021. Keep them owner-callable for the approved wrappers,
-- but remove every API-role execution path to the raw implementations.
REVOKE ALL ON FUNCTION public.fn_create_expense(
  UUID, UUID, UUID, UUID, UUID, TEXT, NUMERIC, DATE, TEXT,
  public.expense_source, JSONB, JSONB
) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.fn_update_expense(
  UUID, UUID, BOOLEAN, TEXT, BOOLEAN, TEXT, NUMERIC, DATE, UUID,
  BOOLEAN, UUID, JSONB, JSONB
) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.fn_delete_expense(UUID, UUID)
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.fn_confirm_pending_expense(
  UUID, UUID, TEXT, UUID, public.expense_source, UUID, UUID, UUID, UUID,
  TEXT, NUMERIC, DATE, TEXT, public.expense_source, JSONB, JSONB
) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.fn_confirm_pending_income(
  UUID, UUID, TEXT, UUID, public.expense_source, UUID, UUID, NUMERIC,
  DATE, TEXT, UUID
) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.fn_confirm_pending_expense_consistent(
  UUID, UUID, TEXT, UUID, public.expense_source, TIMESTAMPTZ,
  UUID, UUID, UUID, UUID, TEXT, NUMERIC, DATE, TEXT,
  public.expense_source, JSONB, JSONB, UUID, UUID, BIGINT
) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.fn_confirm_pending_income_consistent(
  UUID, UUID, TEXT, UUID, public.expense_source, TIMESTAMPTZ,
  UUID, UUID, NUMERIC, DATE, TEXT, UUID, UUID, UUID, BIGINT
) FROM PUBLIC, anon, authenticated, service_role;

-- Fail closed if role inheritance, ownership, or an unexpected ACL leaves an
-- effective bypass. This deliberately does not change pg_default_acl.
DO $assert_legacy_financial_acl$
DECLARE
  role_name TEXT;
  relation_oid REGCLASS;
  privilege_name TEXT;
  target_column RECORD;
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
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS c
     WHERE c.oid = ANY (ARRAY[
       'public.tb_expenses'::REGCLASS,
       'public.tb_expense_items'::REGCLASS,
       'public.tb_expense_distributions'::REGCLASS,
       'public.tb_incomes'::REGCLASS
     ])
       AND c.relowner <> 'postgres'::REGROLE
  ) THEN
    RAISE EXCEPTION 'Financial write tables must remain owned by postgres';
  END IF;

  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    FOREACH relation_oid IN ARRAY ARRAY[
      'public.tb_expenses'::REGCLASS,
      'public.tb_expense_items'::REGCLASS,
      'public.tb_expense_distributions'::REGCLASS,
      'public.tb_incomes'::REGCLASS
    ] LOOP
      FOREACH privilege_name IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
        IF pg_catalog.has_table_privilege(role_name, relation_oid, privilege_name) THEN
          RAISE EXCEPTION 'Role % retains effective % on %', role_name, privilege_name, relation_oid;
        END IF;
      END LOOP;

      FOR target_column IN
        SELECT a.attname
          FROM pg_catalog.pg_attribute AS a
         WHERE a.attrelid = relation_oid
           AND a.attnum > 0
           AND NOT a.attisdropped
      LOOP
        IF pg_catalog.has_column_privilege(role_name, relation_oid, target_column.attname, 'INSERT')
           OR pg_catalog.has_column_privilege(role_name, relation_oid, target_column.attname, 'UPDATE') THEN
          RAISE EXCEPTION 'Role % retains effective column write privilege on %.%',
            role_name, relation_oid, target_column.attname;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  FOREACH relation_oid IN ARRAY ARRAY[
    'public.tb_expenses'::REGCLASS,
    'public.tb_expense_items'::REGCLASS,
    'public.tb_expense_distributions'::REGCLASS,
    'public.tb_incomes'::REGCLASS
  ] LOOP
    IF NOT pg_catalog.has_table_privilege('service_role', relation_oid, 'SELECT') THEN
      RAISE EXCEPTION 'service_role must retain SELECT on %', relation_oid;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS p
     WHERE p.oid = ANY (legacy_functions)
       AND p.proowner <> 'postgres'::REGROLE
  ) THEN
    RAISE EXCEPTION 'Legacy financial implementation functions must remain owned by postgres';
  END IF;

  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    FOREACH function_oid IN ARRAY legacy_functions LOOP
      IF pg_catalog.has_function_privilege(role_name, function_oid, 'EXECUTE') THEN
        RAISE EXCEPTION 'Role % retains effective EXECUTE on %', role_name, function_oid::REGPROCEDURE;
      END IF;
    END LOOP;
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
    RAISE EXCEPTION 'PUBLIC retains EXECUTE on a legacy financial function';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.fn_create_expense_eligible(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,numeric,date,text,public.expense_source,jsonb,jsonb)'::REGPROCEDURE,
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.fn_update_expense_eligible(uuid,uuid,uuid,uuid,boolean,text,boolean,text,numeric,date,uuid,boolean,uuid,jsonb,jsonb)'::REGPROCEDURE,
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.fn_delete_expense_eligible(uuid,uuid,uuid,uuid)'::REGPROCEDURE,
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.fn_create_income_eligible(uuid,uuid,uuid,uuid,numeric,date,text,uuid)'::REGPROCEDURE,
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.fn_update_income_eligible(uuid,uuid,uuid,uuid,jsonb)'::REGPROCEDURE,
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.fn_delete_income_eligible(uuid,uuid,uuid,uuid)'::REGPROCEDURE,
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.fn_confirm_pending_expense_eligible(uuid,uuid,uuid,text,uuid,public.expense_source,timestamp with time zone,uuid,uuid,uuid,uuid,text,numeric,date,text,public.expense_source,jsonb,jsonb,uuid,uuid,bigint)'::REGPROCEDURE,
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.fn_confirm_pending_income_eligible(uuid,uuid,uuid,text,uuid,public.expense_source,timestamp with time zone,uuid,uuid,numeric,date,text,uuid,uuid,uuid,bigint)'::REGPROCEDURE,
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.fn_confirm_whatsapp_expense_event(text,uuid,bigint,uuid,text,timestamp with time zone,uuid,uuid,uuid,text,numeric,date,text,jsonb,jsonb)'::REGPROCEDURE,
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.fn_confirm_whatsapp_income_event(text,uuid,bigint,uuid,text,timestamp with time zone,uuid,numeric,date,text,uuid)'::REGPROCEDURE,
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Approved Web or WhatsApp financial entry point lost service_role EXECUTE';
  END IF;
END;
$assert_legacy_financial_acl$;

COMMIT;
