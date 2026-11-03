-- Supplemental integration ACL checks for migrations 0047 and 0048.
-- Run this only when both prerequisite migrations are present in the local
-- isolated database. The default SQL runner reads top-level test files only,
-- so migration 0049 remains independently testable from a clean checkout.
BEGIN;

DO $$
DECLARE
  wrapper_signature TEXT;
  wrapper_oid OID;
BEGIN
  FOREACH wrapper_signature IN ARRAY ARRAY[
    'public.fn_create_whatsapp_draft_event(text,uuid,bigint,uuid,text,public.pending_operation_type,jsonb,public.agent_category_draft_status)',
    'public.fn_update_whatsapp_draft_event(text,uuid,bigint,uuid,text,public.pending_operation_type,jsonb,public.agent_category_draft_status,timestamptz)',
    'public.fn_delete_whatsapp_draft_event(text,uuid,bigint,uuid,text,timestamptz)'
  ] LOOP
    wrapper_oid := to_regprocedure(wrapper_signature)::oid;
    IF wrapper_oid IS NULL
       OR NOT has_function_privilege('service_role', wrapper_oid, 'EXECUTE')
       OR has_function_privilege('anon', wrapper_oid, 'EXECUTE')
       OR has_function_privilege('authenticated', wrapper_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'WhatsApp draft event wrapper access changed';
    END IF;
  END LOOP;

  IF NOT has_function_privilege(
       'authenticated',
       'public.fn_create_web_agent_draft(uuid,uuid,uuid,text,public.pending_operation_type,jsonb,public.agent_category_draft_status)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.fn_create_web_agent_draft(uuid,uuid,uuid,text,public.pending_operation_type,jsonb,public.agent_category_draft_status)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.fn_create_web_agent_draft(uuid,uuid,uuid,text,public.pending_operation_type,jsonb,public.agent_category_draft_status)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Guarded Web draft entry access changed';
  END IF;
END;
$$;

ROLLBACK;
