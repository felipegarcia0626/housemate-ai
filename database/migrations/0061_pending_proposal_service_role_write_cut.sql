BEGIN;

-- Keep service_role SELECT on tb_pending_proposals and revoke direct INSERT,
-- UPDATE, DELETE and TRUNCATE, including column-level INSERT and UPDATE grants.
-- Revoke direct EXECUTE on the four proposal delegates listed below.
-- The eligible expense and income confirmation RPCs are outside this cut and
-- retain their own authorization checks.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON TABLE public.tb_pending_proposals
  FROM service_role;
GRANT SELECT
  ON TABLE public.tb_pending_proposals
  TO service_role;

DO $revoke_pending_proposal_column_writes$
DECLARE
  target_column RECORD;
BEGIN
  FOR target_column IN
    SELECT attribute.attname
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid = 'public.tb_pending_proposals'::regclass
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE INSERT (%I) ON TABLE public.tb_pending_proposals FROM service_role',
      target_column.attname
    );
    EXECUTE pg_catalog.format(
      'REVOKE UPDATE (%I) ON TABLE public.tb_pending_proposals FROM service_role',
      target_column.attname
    );
  END LOOP;
END;
$revoke_pending_proposal_column_writes$;

-- These SECURITY INVOKER helpers remain as internal delegates. The Web and
-- WhatsApp SECURITY DEFINER wrappers are postgres-owned, so their calls run
-- with the owner's rights; service_role must not call the helpers directly.
REVOKE EXECUTE ON FUNCTION public.fn_reject_pending_proposal(
  UUID, UUID, TEXT, UUID, public.expense_source, public.pending_operation_type
) FROM service_role;
REVOKE EXECUTE ON FUNCTION public.fn_create_whatsapp_pending_proposal(
  UUID, UUID, TEXT, UUID, public.pending_operation_type, JSONB, UUID, UUID, BIGINT
) FROM service_role;
REVOKE EXECUTE ON FUNCTION public.fn_update_whatsapp_pending_proposal(
  UUID, UUID, TEXT, UUID, public.pending_operation_type, JSONB, TIMESTAMPTZ,
  UUID, UUID, BIGINT
) FROM service_role;
REVOKE EXECUTE ON FUNCTION public.fn_reject_whatsapp_pending_proposal(
  UUID, UUID, TEXT, UUID, public.pending_operation_type, UUID, UUID, BIGINT
) FROM service_role;

DO $assert_pending_proposal_service_role_cut$
DECLARE
  target_column RECORD;
  target_function REGPROCEDURE;
  restricted_functions REGPROCEDURE[] := ARRAY[
    'public.fn_reject_pending_proposal(uuid,uuid,text,uuid,public.expense_source,public.pending_operation_type)'::REGPROCEDURE,
    'public.fn_create_whatsapp_pending_proposal(uuid,uuid,text,uuid,public.pending_operation_type,jsonb,uuid,uuid,bigint)'::REGPROCEDURE,
    'public.fn_update_whatsapp_pending_proposal(uuid,uuid,text,uuid,public.pending_operation_type,jsonb,timestamp with time zone,uuid,uuid,bigint)'::REGPROCEDURE,
    'public.fn_reject_whatsapp_pending_proposal(uuid,uuid,text,uuid,public.pending_operation_type,uuid,uuid,bigint)'::REGPROCEDURE
  ];
BEGIN
  IF NOT pg_catalog.has_table_privilege(
       'service_role', 'public.tb_pending_proposals', 'SELECT'
     ) THEN
    RAISE EXCEPTION 'service_role must retain proposal SELECT';
  END IF;

  IF pg_catalog.has_table_privilege(
       'service_role', 'public.tb_pending_proposals', 'INSERT'
     )
     OR pg_catalog.has_table_privilege(
       'service_role', 'public.tb_pending_proposals', 'UPDATE'
     )
     OR pg_catalog.has_table_privilege(
       'service_role', 'public.tb_pending_proposals', 'DELETE'
     )
     OR pg_catalog.has_table_privilege(
       'service_role', 'public.tb_pending_proposals', 'TRUNCATE'
     ) THEN
    RAISE EXCEPTION 'service_role retains effective proposal table write access';
  END IF;

  FOR target_column IN
    SELECT attribute.attname
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid = 'public.tb_pending_proposals'::regclass
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
  LOOP
    IF pg_catalog.has_column_privilege(
         'service_role', 'public.tb_pending_proposals', target_column.attname, 'INSERT'
       )
       OR pg_catalog.has_column_privilege(
         'service_role', 'public.tb_pending_proposals', target_column.attname, 'UPDATE'
       ) THEN
      RAISE EXCEPTION 'service_role retains effective proposal column write access: %',
        target_column.attname;
    END IF;
  END LOOP;

  FOREACH target_function IN ARRAY restricted_functions LOOP
    IF pg_catalog.has_function_privilege('service_role', target_function, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role retains effective direct execution of %', target_function;
    END IF;
  END LOOP;
END;
$assert_pending_proposal_service_role_cut$;

COMMIT;
