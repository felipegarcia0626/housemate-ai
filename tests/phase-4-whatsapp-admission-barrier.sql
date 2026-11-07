BEGIN;

-- An old ledger row outside the active drain window is historical, not live work.
INSERT INTO public.tb_processed_whatsapp_events(external_event_id)
VALUES('gate-preexisting-legacy-event');

DO $$
DECLARE role_name TEXT; status JSONB;
BEGIN
  IF (SELECT mode FROM public.tb_whatsapp_admission_gate WHERE singleton) <> 'OPEN' THEN
    RAISE EXCEPTION 'Disposable test database must begin with an open WhatsApp gate';
  END IF;
  IF has_table_privilege('service_role','public.tb_processed_whatsapp_events','INSERT') THEN
    RAISE EXCEPTION 'service_role must not reserve WhatsApp events directly';
  END IF;
  IF has_function_privilege('service_role','public.fn_start_whatsapp_drain()','EXECUTE')
     OR has_function_privilege('service_role','public.fn_reap_whatsapp_drain()','EXECUTE')
     OR has_function_privilege('service_role','public.fn_enter_whatsapp_link_only()','EXECUTE')
     OR has_function_privilege('service_role','public.fn_resume_whatsapp_admissions()','EXECUTE') THEN
    RAISE EXCEPTION 'Runtime role must not control the WhatsApp admission gate';
  END IF;
  IF has_function_privilege('anon','public.fn_start_whatsapp_drain()','EXECUTE')
     OR has_function_privilege('authenticated','public.fn_start_whatsapp_drain()','EXECUTE')
     OR has_function_privilege('anon','public.fn_resume_whatsapp_admissions()','EXECUTE')
     OR has_function_privilege('authenticated','public.fn_resume_whatsapp_admissions()','EXECUTE')
     OR has_function_privilege('anon','public.fn_get_whatsapp_admission_status()','EXECUTE')
     OR has_function_privilege('authenticated','public.fn_get_whatsapp_admission_status()','EXECUTE') THEN
    RAISE EXCEPTION 'Client roles must not inspect or control the admission gate';
  END IF;
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF has_table_privilege(role_name,'public.tb_whatsapp_admission_gate','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
      RAISE EXCEPTION 'Role % has direct gate-table privileges',role_name;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role','public.fn_claim_whatsapp_event(text,text,text,text,uuid)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.fn_complete_whatsapp_link_event(text,text,text,text,uuid,text)','EXECUTE') THEN
    RAISE EXCEPTION 'Runtime role lost an authorized WhatsApp entry point';
  END IF;
  status:=public.fn_get_whatsapp_admission_status();
  IF (status->'databaseBlockers'->>'legacy_unreceipted')::bigint<>0 THEN
    RAISE EXCEPTION 'Historical ledger rows outside DRAINING were counted as active work: %',status;
  END IF;
END;
$$;

SELECT public.fn_start_whatsapp_drain();

-- A receiptless legacy reservation written during the drain window is a blocker.
INSERT INTO public.tb_processed_whatsapp_events(external_event_id)
VALUES('gate-during-drain-legacy-event');
-- This SQL test runs inside one transaction; force statement time to model a
-- separate legacy request that reaches PostgreSQL after the drain began.
UPDATE public.tb_processed_whatsapp_events
   SET processed_at=pg_catalog.clock_timestamp()
 WHERE external_event_id='gate-during-drain-legacy-event';
DO $$
DECLARE status JSONB;
BEGIN
  status:=public.fn_get_whatsapp_admission_status();
  IF (status->'databaseBlockers'->>'legacy_unreceipted')::bigint<>1 THEN
    RAISE EXCEPTION 'Receiptless work admitted during DRAINING was not counted: %',status;
  END IF;
END;
$$;
DELETE FROM public.tb_processed_whatsapp_events WHERE external_event_id='gate-during-drain-legacy-event';

SET LOCAL ROLE service_role;

DO $$
DECLARE result JSONB;
BEGIN
  result:=public.fn_claim_whatsapp_event(
    'gate-paused-message','19995550001','123456',repeat('a',64),'51000000-0051-4000-8000-000000000001'
  );
  IF result->>'status'<>'PAUSED' THEN RAISE EXCEPTION 'Message claim was not paused: %',result; END IF;

  result:=public.fn_complete_whatsapp_link_event(
    'gate-paused-link','19995550001','123456',repeat('b',64),NULL,NULL
  );
  IF result->>'status'<>'PAUSED' THEN RAISE EXCEPTION 'Link command was admitted before link-only mode: %',result; END IF;

  result:=public.fn_acquire_whatsapp_context_lease(
    '51000000-0051-4000-8000-000000000001','51000000-0051-4000-8000-000000000002',120
  );
  IF COALESCE((result->>'acquired')::boolean,true) THEN RAISE EXCEPTION 'Legacy lease admission remained open'; END IF;

  result:=public.fn_admit_whatsapp_sender(
    '19995550001','51000000-0051-4000-8000-000000000003',120
  );
  IF result->>'status'<>'PAUSED' THEN RAISE EXCEPTION 'Legacy sender admission remained open: %',result; END IF;

  BEGIN
    INSERT INTO public.tb_processed_whatsapp_events(external_event_id) VALUES('gate-direct-legacy-insert');
    RAISE EXCEPTION 'Direct service_role ledger INSERT unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$$;

RESET ROLE;
DO $$
DECLARE result JSONB; receipt public.tb_whatsapp_event_receipts;
BEGIN
  SELECT * INTO receipt FROM public.tb_whatsapp_event_receipts WHERE external_event_id='gate-paused-message';
  IF NOT FOUND OR receipt.processing_state<>'PAUSED' OR receipt.user_id IS NOT NULL
     OR receipt.context_lease_id IS NOT NULL OR receipt.event_token IS NOT NULL THEN
    RAISE EXCEPTION 'Paused message did not persist as a non-admitted tombstone';
  END IF;
  IF receipt.admission_generation IS DISTINCT FROM (SELECT draining_generation FROM public.tb_whatsapp_admission_gate WHERE singleton) THEN
    RAISE EXCEPTION 'Paused tombstone was not attributed to the draining generation';
  END IF;
  result:=public.fn_enter_whatsapp_link_only();
  IF result->>'status'<>'LINK_ONLY' THEN RAISE EXCEPTION 'Database-clear gate did not enter link-only mode: %',result; END IF;
END;
$$;

SET LOCAL ROLE service_role;
DO $$
DECLARE result JSONB; token UUID:='51000000-0051-4000-8000-000000000004';
BEGIN
  result:=public.fn_claim_whatsapp_event(
    'gate-paused-message','19995550001','123456',repeat('a',64),'51000000-0051-4000-8000-000000000005'
  );
  IF result->>'status'<>'PAUSED' THEN RAISE EXCEPTION 'Redelivery of paused message was not idempotent: %',result; END IF;

  result:=public.fn_claim_whatsapp_event(
    'gate-link-only-message','19995550001','123456',repeat('c',64),'51000000-0051-4000-8000-000000000006'
  );
  IF result->>'status'<>'PAUSED' THEN RAISE EXCEPTION 'Financial claim passed link-only mode: %',result; END IF;

  result:=public.fn_complete_whatsapp_link_event(
    'gate-link-only-command','19995550001','123456',repeat('d',64),NULL,NULL
  );
  IF result->>'status'<>'READY' THEN RAISE EXCEPTION 'VINCULAR control event was not accepted in link-only mode: %',result; END IF;

  result:=public.fn_prepare_whatsapp_delivery(
    'gate-link-only-command','19995550001','123456',repeat('d',64),token
  );
  IF result->>'status'<>'SEND' THEN RAISE EXCEPTION 'Link-only control reply was not deliverable: %',result; END IF;
  result:=public.fn_finish_whatsapp_delivery('gate-link-only-command',token,(result->>'epoch')::bigint,'ACCEPTED',200,NULL);
  IF result->>'status'<>'ACCEPTED' THEN RAISE EXCEPTION 'Link-only delivery did not finish: %',result; END IF;
END;
$$;

RESET ROLE;
SELECT public.fn_resume_whatsapp_admissions();
SET LOCAL ROLE service_role;
DO $$
DECLARE result JSONB;
BEGIN
  result:=public.fn_claim_whatsapp_event(
    'gate-paused-message','19995550001','123456',repeat('a',64),'51000000-0051-4000-8000-000000000007'
  );
  IF result->>'status'<>'PAUSED' THEN RAISE EXCEPTION 'Reopening re-admitted a paused event: %',result; END IF;
END;
$$;

RESET ROLE;
DO $$
BEGIN
  IF (SELECT generation FROM public.tb_whatsapp_admission_gate WHERE singleton) < 2 THEN
    RAISE EXCEPTION 'Reopening reused an earlier admission generation';
  END IF;
END;
$$;

ROLLBACK;
