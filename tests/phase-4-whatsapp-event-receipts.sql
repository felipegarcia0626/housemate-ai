BEGIN;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users(id UUID PRIMARY KEY,email TEXT,email_confirmed_at TIMESTAMPTZ);
DO $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END;
$$;

INSERT INTO auth.users(id,email,email_confirmed_at)
VALUES('46000000-0046-4000-8000-000000000001','receipt@example.test',now());
INSERT INTO public.tb_users(id,auth_user_id,display_name,external_identifier)
VALUES('46000000-0046-4000-8000-000000000001','46000000-0046-4000-8000-000000000001','Receipt fixture','19990000461');

CREATE FUNCTION pg_temp.receipt_status(r JSONB,s TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF r->>'status' IS DISTINCT FROM s THEN RAISE EXCEPTION 'Unexpected receipt status: %, expected %',r->>'status',s; END IF;
END;
$$;

SET LOCAL ROLE service_role;
DO $$
DECLARE t UUID:='46000000-0046-4000-8000-000000000002'; r JSONB;
BEGIN
  r:=public.fn_claim_whatsapp_event('receipt-one','19990000461','123456',repeat('a',64),t);
  PERFORM pg_temp.receipt_status(r,'CLAIMED');
  PERFORM pg_temp.receipt_status(public.fn_begin_whatsapp_event('receipt-one',t,1),'STARTED');
  PERFORM pg_temp.receipt_status(public.fn_begin_whatsapp_event('receipt-one',t,1),'ALREADY_STARTED');
  PERFORM pg_temp.receipt_status(public.fn_claim_whatsapp_event('receipt-one','19990000461','123456',repeat('a',64),t),'BUSY');
  PERFORM pg_temp.receipt_status(public.fn_claim_whatsapp_event('receipt-one','19990000461','123456',repeat('b',64),t),'CONFLICT');
  IF NOT public.fn_renew_whatsapp_event('receipt-one',t,1) THEN RAISE EXCEPTION 'Valid renewal failed'; END IF;
  BEGIN
    PERFORM public.fn_assert_whatsapp_event('receipt-one',NULL,1);
    RAISE EXCEPTION 'NULL fence accepted';
  EXCEPTION WHEN serialization_failure THEN
    IF SQLERRM<>'WhatsApp event is no longer current' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.fn_assert_whatsapp_event('receipt-one',t,2);
    RAISE EXCEPTION 'Wrong epoch accepted';
  EXCEPTION WHEN serialization_failure THEN
    IF SQLERRM<>'WhatsApp event is no longer current' THEN RAISE; END IF;
  END;
END;
$$;
RESET ROLE;

-- Known pre-HTTP failure can retry the persisted reply, without begin/agent.
DO $$
DECLARE t UUID:=gen_random_uuid(); d UUID:=gen_random_uuid(); r JSONB; before_state JSONB;
BEGIN
  PERFORM public.fn_release_whatsapp_context_lease(user_id,context_lease_id,context_epoch) FROM public.tb_whatsapp_event_receipts WHERE external_event_id='receipt-one';
  r:=public.fn_claim_whatsapp_event('receipt-delivery','19990000461','123456',repeat('c',64),t);
  PERFORM pg_temp.receipt_status(r,'CLAIMED');
  PERFORM pg_temp.receipt_status(public.fn_begin_whatsapp_event('receipt-delivery',t,1),'STARTED');
  PERFORM pg_temp.receipt_status(public.fn_finish_whatsapp_event('receipt-delivery',t,1,'GENERIC_V1','Respuesta de prueba','{}'),'COMPLETED');
  PERFORM public.fn_release_whatsapp_context_lease(user_id,context_lease_id,context_epoch) FROM public.tb_whatsapp_event_receipts WHERE external_event_id='receipt-delivery';
  r:=public.fn_prepare_whatsapp_delivery('receipt-delivery','19990000461','123456',repeat('c',64),d);
  PERFORM pg_temp.receipt_status(r,'SEND');
  IF r->>'text'<>'Respuesta de prueba' THEN RAISE EXCEPTION 'Stored reply lost'; END IF;
  PERFORM pg_temp.receipt_status(public.fn_prepare_whatsapp_delivery('receipt-delivery','19990000461','123456',repeat('c',64),gen_random_uuid()),'BUSY');
  PERFORM pg_temp.receipt_status(public.fn_finish_whatsapp_delivery('receipt-delivery',d,1,'RETRYABLE',NULL,NULL),'RETRYABLE');
  d:=gen_random_uuid();
  PERFORM pg_temp.receipt_status(public.fn_prepare_whatsapp_delivery('receipt-delivery','19990000461','123456',repeat('c',64),d),'SEND');
  PERFORM pg_temp.receipt_status(public.fn_finish_whatsapp_delivery('receipt-delivery',d,2,'UNKNOWN',NULL,NULL),'UNKNOWN');
  SELECT to_jsonb(x) INTO before_state FROM public.tb_whatsapp_event_receipts x WHERE external_event_id='receipt-delivery';
  PERFORM pg_temp.receipt_status(public.fn_prepare_whatsapp_delivery('receipt-delivery','19990000461','123456',repeat('c',64),gen_random_uuid()),'UNKNOWN');
  IF before_state IS DISTINCT FROM (SELECT to_jsonb(x) FROM public.tb_whatsapp_event_receipts x WHERE external_event_id='receipt-delivery') THEN RAISE EXCEPTION 'UNKNOWN delivery changed'; END IF;
END;
$$;

DO $$
DECLARE before_state JSONB; after_state JSONB; role_name TEXT; f RECORD;
BEGIN
  UPDATE public.tb_whatsapp_event_receipts SET event_expires_at=clock_timestamp()-interval '1 second' WHERE external_event_id='receipt-one';
  PERFORM pg_temp.receipt_status(public.fn_claim_whatsapp_event('receipt-one','19990000461','123456',repeat('a',64),gen_random_uuid()),'UNCERTAIN');
  SELECT to_jsonb(r) INTO before_state FROM public.tb_whatsapp_event_receipts r WHERE external_event_id='receipt-one';
  PERFORM pg_temp.receipt_status(public.fn_claim_whatsapp_event('receipt-one','19990000461','123456',repeat('a',64),gen_random_uuid()),'UNCERTAIN');
  SELECT to_jsonb(r) INTO after_state FROM public.tb_whatsapp_event_receipts r WHERE external_event_id='receipt-one';
  IF before_state IS DISTINCT FROM after_state THEN RAISE EXCEPTION 'UNCERTAIN was changed'; END IF;
  INSERT INTO public.tb_processed_whatsapp_events(external_event_id) VALUES('receipt-historical');
  PERFORM pg_temp.receipt_status(public.fn_claim_whatsapp_event('receipt-historical','19990000461','123456',repeat('a',64),gen_random_uuid()),'HISTORICAL');
  IF EXISTS(SELECT 1 FROM public.tb_whatsapp_event_receipts WHERE external_event_id='receipt-historical') THEN RAISE EXCEPTION 'Historical event reconstructed'; END IF;
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF has_table_privilege(role_name,'public.tb_whatsapp_event_receipts','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
      RAISE EXCEPTION 'Receipt direct access granted';
    END IF;
    IF has_function_privilege(role_name,'public.fn_require_whatsapp_event(text,uuid,bigint,boolean)','EXECUTE')
       OR has_function_privilege(role_name,'public.fn_purge_whatsapp_event_payloads(integer)','EXECUTE') THEN
      RAISE EXCEPTION 'Receipt private helper exposed';
    END IF;
  END LOOP;
  FOR f IN SELECT p.* FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('fn_require_whatsapp_event','fn_claim_whatsapp_event','fn_begin_whatsapp_event',
      'fn_assert_whatsapp_event','fn_bind_whatsapp_event_context','fn_renew_whatsapp_event','fn_finish_whatsapp_event','fn_fail_whatsapp_event',
      'fn_prepare_whatsapp_delivery','fn_finish_whatsapp_delivery','fn_complete_whatsapp_link_event','fn_require_whatsapp_event_conversation',
      'fn_create_whatsapp_proposal_event','fn_update_whatsapp_proposal_event','fn_reject_whatsapp_proposal_event','fn_compensate_whatsapp_proposal_event',
      'fn_create_whatsapp_draft_event','fn_update_whatsapp_draft_event','fn_delete_whatsapp_draft_event','fn_confirm_whatsapp_expense_event',
      'fn_confirm_whatsapp_income_event','fn_transition_whatsapp_event_context','fn_insert_whatsapp_category_event') LOOP
    IF NOT f.prosecdef OR pg_get_userbyid(f.proowner)<>'postgres' OR f.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog'] THEN
      RAISE EXCEPTION 'Unsafe receipt function';
    END IF;
    IF EXISTS(SELECT 1 FROM aclexplode(COALESCE(f.proacl,acldefault('f',f.proowner))) WHERE grantee=0) THEN RAISE EXCEPTION 'PUBLIC receipt function access'; END IF;
    IF has_function_privilege('anon',f.oid,'EXECUTE') OR has_function_privilege('authenticated',f.oid,'EXECUTE') THEN RAISE EXCEPTION 'Client receipt function access'; END IF;
    IF has_function_privilege('service_role',f.oid,'EXECUTE') IS DISTINCT FROM (f.proname NOT IN ('fn_require_whatsapp_event','fn_require_whatsapp_event_conversation')) THEN RAISE EXCEPTION 'Unexpected service receipt function privilege'; END IF;
  END LOOP;
END;
$$;

ROLLBACK;
