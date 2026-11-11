BEGIN;

DO $$
DECLARE
  complete_event_id UUID;
  partial_event_id UUID;
  evidence_row public.tb_whatsapp_event_forensic_evidence;
  ref_row public.tb_whatsapp_event_forensic_proposal_refs;
  role_name TEXT;
  rel_name TEXT;
  function_name TEXT;
  rel_oid OID;
  proc RECORD;
BEGIN
  SELECT id INTO complete_event_id
    FROM public.tb_processed_whatsapp_events
   WHERE external_event_id = 'forensic-0059-history-complete';
  SELECT id INTO partial_event_id
    FROM public.tb_processed_whatsapp_events
   WHERE external_event_id = 'forensic-0059-history-partial';
  IF complete_event_id IS NULL OR partial_event_id IS NULL THEN
    RAISE EXCEPTION '0059 pre-migration fixtures are missing';
  END IF;

  SELECT * INTO evidence_row FROM public.tb_whatsapp_event_forensic_evidence
   WHERE processed_event_id = complete_event_id;
  IF NOT FOUND
     OR evidence_row.capture_method <> 'HISTORICAL_BACKFILL'
     OR evidence_row.evidence_quality <> 'PARTIAL_HISTORICAL'
     OR evidence_row.processing_state_before_purge <> 'COMPLETED'
     OR evidence_row.delivery_state_before_purge <> 'UNKNOWN'
     OR evidence_row.business_result_status <> 'CREATED'
     OR evidence_row.business_result_expense_id IS DISTINCT FROM '59000000-0059-4000-8000-000000000013'::UUID
     OR evidence_row.provider_metadata_status <> 'HTTP_AND_PROVIDER_CODE_RECORDED'
     OR evidence_row.http_status <> 503
     OR evidence_row.provider_code <> 131047
     OR evidence_row.cause_recording_status <> 'NOT_RECORDED' THEN
    RAISE EXCEPTION 'Historical complete-source backfill was not faithfully classified';
  END IF;
  IF pg_catalog.to_jsonb(evidence_row)::TEXT LIKE '%forensic-sensitive-sentinel%'
     OR pg_catalog.to_jsonb(evidence_row)::TEXT LIKE '%199900005901%' THEN
    RAISE EXCEPTION 'Sensitive receipt content leaked into forensic evidence';
  END IF;
  SELECT * INTO ref_row FROM public.tb_whatsapp_event_forensic_proposal_refs
   WHERE processed_event_id = complete_event_id;
  IF NOT FOUND
     OR ref_row.proposal_id IS DISTINCT FROM '59000000-0059-4000-8000-000000000014'::UUID
     OR ref_row.operation_type <> 'CREATE_EXPENSE'
     OR ref_row.proposal_version <> '7'
     OR ref_row.version_status <> 'VALID' THEN
    RAISE EXCEPTION 'Allowlisted proposal reference was not backfilled';
  END IF;
  IF pg_catalog.to_jsonb(ref_row)::TEXT LIKE '%forensic-sensitive-sentinel%'
     OR pg_catalog.to_jsonb(ref_row)::TEXT LIKE '%updatedAt%'
     OR pg_catalog.to_jsonb(ref_row)::TEXT LIKE '%payload%' THEN
    RAISE EXCEPTION 'Artifact payload data was copied into the forensic reference';
  END IF;

  SELECT * INTO evidence_row FROM public.tb_whatsapp_event_forensic_evidence
   WHERE processed_event_id = partial_event_id;
  IF NOT FOUND
     OR evidence_row.capture_method <> 'HISTORICAL_BACKFILL'
     OR evidence_row.evidence_quality <> 'PARTIAL_HISTORICAL'
     OR evidence_row.tombstoned_at_at_capture IS NULL
     OR evidence_row.context_epoch IS NOT NULL
     OR evidence_row.user_id IS NOT NULL
     OR evidence_row.household_id IS NOT NULL
     OR evidence_row.business_result_status IS NOT NULL
     OR evidence_row.operation_digest IS NOT NULL THEN
    RAISE EXCEPTION 'Previously tombstoned history was reconstructed or misclassified';
  END IF;

  FOR rel_name IN
    SELECT unnest(ARRAY[
      'tb_whatsapp_event_forensic_evidence',
      'tb_whatsapp_event_forensic_proposal_refs'
    ])
  LOOP
    rel_oid := pg_catalog.to_regclass('public.' || rel_name);
    IF pg_catalog.pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class WHERE oid = rel_oid)) <> 'postgres'
       OR NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = rel_oid) THEN
      RAISE EXCEPTION 'Forensic table ownership or RLS is incorrect: %', rel_name;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.aclexplode(COALESCE(
        (SELECT relacl FROM pg_catalog.pg_class WHERE oid = rel_oid),
        pg_catalog.acldefault('r', (SELECT relowner FROM pg_catalog.pg_class WHERE oid = rel_oid))
      )) a WHERE a.grantee = 0
    ) THEN
      RAISE EXCEPTION 'PUBLIC has direct forensic table privileges: %', rel_name;
    END IF;
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF pg_catalog.has_table_privilege(role_name, rel_oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
        RAISE EXCEPTION 'Application role has direct forensic table privileges: % / %', role_name, rel_name;
      END IF;
    END LOOP;
  END LOOP;

  FOREACH function_name IN ARRAY ARRAY[
    'public.fn_capture_whatsapp_forensic_proposal_refs(uuid,jsonb)',
    'public.fn_preserve_whatsapp_event_forensic_evidence(text,text,text,text)',
    'public.fn_reject_whatsapp_forensic_evidence_mutation()',
    'public.fn_purge_whatsapp_event_payloads(integer)'
  ] LOOP
    SELECT p.* INTO proc FROM pg_catalog.pg_proc p
     WHERE p.oid = function_name::regprocedure;
    IF pg_catalog.pg_get_userbyid(proc.proowner) <> 'postgres'
       OR proc.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog'] THEN
      RAISE EXCEPTION 'Forensic function ownership/search_path is unsafe: %', function_name;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.aclexplode(COALESCE(proc.proacl, pg_catalog.acldefault('f', proc.proowner))) a
       WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'PUBLIC can execute private forensic function: %', function_name;
    END IF;
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF pg_catalog.has_function_privilege(role_name, proc.oid, 'EXECUTE') THEN
        RAISE EXCEPTION 'Application role can execute private forensic function: % / %', role_name, function_name;
      END IF;
    END LOOP;
    IF function_name = 'public.fn_purge_whatsapp_event_payloads(integer)' AND NOT proc.prosecdef THEN
      RAISE EXCEPTION 'Purger must remain SECURITY DEFINER';
    END IF;
    IF function_name <> 'public.fn_purge_whatsapp_event_payloads(integer)' AND proc.prosecdef THEN
      RAISE EXCEPTION 'Forensic helper/trigger must remain SECURITY INVOKER: %', function_name;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = 'public.tb_whatsapp_event_forensic_evidence'::regclass
       AND NOT a.attisdropped
       AND a.attname IN (
         'external_event_id', 'identity_snapshot', 'admission_selection', 'artifacts',
         'business_result', 'reply_text', 'reply_guard', 'event_token', 'delivery_token', 'phone', 'message_text'
       )
  ) THEN
    RAISE EXCEPTION 'Forensic evidence schema contains a prohibited raw field';
  END IF;

  BEGIN
    UPDATE public.tb_whatsapp_event_forensic_evidence
       SET captured_at = captured_at + INTERVAL '1 second'
     WHERE processed_event_id = complete_event_id;
    RAISE EXCEPTION 'Append-only evidence UPDATE was accepted' USING ERRCODE = 'P0001';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;
  BEGIN
    DELETE FROM public.tb_whatsapp_event_forensic_evidence
     WHERE processed_event_id = complete_event_id;
    RAISE EXCEPTION 'Append-only evidence DELETE was accepted' USING ERRCODE = 'P0001';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;
END;
$$;

DO $$
DECLARE
  msg_digest TEXT := repeat('f', 64);
  sender_number TEXT := '19990005901';
  phone_number_id TEXT := '123456';
  event_id TEXT;
  internal_id UUID;
  before_receipt JSONB;
  after_receipt JSONB;
  before_evidence JSONB;
  after_evidence JSONB;
  all_evidence_before JSONB;
  all_evidence_after JSONB;
  result_value JSONB;
  counts JSONB;
  failed BOOLEAN := FALSE;
  row_value RECORD;
  evidence_row public.tb_whatsapp_event_forensic_evidence;
  ref_row public.tb_whatsapp_event_forensic_proposal_refs;
  statuses TEXT[];
BEGIN
  INSERT INTO public.tb_processed_whatsapp_events(id, external_event_id, processed_at)
  VALUES
    ('59000000-0059-4000-8000-000000000100', 'forensic-0059-purge-failure', pg_catalog.clock_timestamp() - INTERVAL '50 days'),
    ('59000000-0059-4000-8000-000000000101', 'forensic-0059-live-unknown', pg_catalog.clock_timestamp() - INTERVAL '40 days'),
    ('59000000-0059-4000-8000-000000000102', 'forensic-0059-live-uncertain', pg_catalog.clock_timestamp() - INTERVAL '39 days'),
    ('59000000-0059-4000-8000-000000000103', 'forensic-0059-completed', pg_catalog.clock_timestamp() - INTERVAL '10 days'),
    ('59000000-0059-4000-8000-000000000104', 'forensic-0059-old-evidence', pg_catalog.clock_timestamp() - INTERVAL '400 days'),
    ('59000000-0059-4000-8000-000000000105', 'forensic-0059-completed-aged', pg_catalog.clock_timestamp() - INTERVAL '40 days');

  INSERT INTO public.tb_whatsapp_event_receipts(
    external_event_id, request_digest, event_kind, processing_state, delivery_state,
    identity_snapshot, admission_selection, context_lease_id, context_epoch,
    household_id, actor_member_id, conversation_digest, event_token, event_epoch, event_expires_at,
    business_result, operation_digest, artifacts, reply_template, reply_text, reply_guard, reply_expires_at,
    delivery_epoch, delivery_attempts, http_status, provider_code, created_at, updated_at
  )
  SELECT fixture.event_id,
         public.fn_whatsapp_event_fingerprint(fixture.event_id, sender_number, phone_number_id, msg_digest),
         'MESSAGE', fixture.state_value, fixture.delivery_value,
         '{"phone":"19990005901","message":"forensic-live-sensitive-sentinel"}'::JSONB,
         '{"selection":"forensic-live-sensitive-sentinel"}'::JSONB,
          CASE WHEN fixture.event_id IN ('forensic-0059-purge-failure', 'forensic-0059-live-uncertain')
           THEN '59000000-0059-4000-8000-000000000110'::UUID ELSE NULL END,
          CASE WHEN fixture.event_id IN ('forensic-0059-purge-failure', 'forensic-0059-live-uncertain') THEN 12::BIGINT ELSE NULL END,
          CASE WHEN fixture.event_id <> 'forensic-0059-completed' THEN '59000000-0059-4000-8000-000000000111'::UUID ELSE NULL END,
          CASE WHEN fixture.event_id <> 'forensic-0059-completed' THEN '59000000-0059-4000-8000-000000000112'::UUID ELSE NULL END,
         repeat('c', 64),
          CASE WHEN fixture.event_id = 'forensic-0059-purge-failure' THEN '59000000-0059-4000-8000-000000000113'::UUID ELSE NULL END,
         2,
          CASE WHEN fixture.event_id = 'forensic-0059-purge-failure' THEN pg_catalog.clock_timestamp() - INTERVAL '49 days' ELSE NULL END,
          CASE WHEN fixture.event_id = 'forensic-0059-live-unknown'
           THEN '{"status":"CREATED","expense_id":"59000000-0059-4000-8000-000000000114"}'::JSONB ELSE NULL END,
          CASE WHEN fixture.event_id = 'forensic-0059-live-unknown' THEN repeat('d', 64) ELSE NULL END,
         CASE
            WHEN fixture.event_id = 'forensic-0059-live-uncertain'
             THEN '{"59000000-0059-4000-8000-000000000115":{"operation":"CREATE_INCOME","updatedAt":"2026-11-01T00:00:00Z"}}'::JSONB
           ELSE '{"59000000-0059-4000-8000-000000000116":{"version":"3","operation":"CREATE_EXPENSE","payload":"forensic-live-sensitive-sentinel"}}'::JSONB
         END,
         'TEXT_V1', 'forensic-live-sensitive-sentinel', '{"sensitive":"forensic-live-sensitive-sentinel"}'::JSONB,
          CASE WHEN fixture.event_id IN ('forensic-0059-completed', 'forensic-0059-completed-aged')
           THEN pg_catalog.clock_timestamp() - INTERVAL '1 day'
           ELSE pg_catalog.clock_timestamp() - INTERVAL '35 days' END,
         3, 4,
          CASE WHEN fixture.event_id = 'forensic-0059-live-unknown' THEN 503 ELSE NULL END,
          CASE WHEN fixture.event_id = 'forensic-0059-live-unknown' THEN 131047 ELSE NULL END,
          CASE fixture.event_id
           WHEN 'forensic-0059-purge-failure' THEN pg_catalog.clock_timestamp() - INTERVAL '50 days'
           WHEN 'forensic-0059-live-unknown' THEN pg_catalog.clock_timestamp() - INTERVAL '40 days'
           WHEN 'forensic-0059-live-uncertain' THEN pg_catalog.clock_timestamp() - INTERVAL '39 days'
           WHEN 'forensic-0059-completed' THEN pg_catalog.clock_timestamp() - INTERVAL '10 days'
           WHEN 'forensic-0059-completed-aged' THEN pg_catalog.clock_timestamp() - INTERVAL '40 days'
           ELSE pg_catalog.clock_timestamp() - INTERVAL '400 days'
         END,
         pg_catalog.clock_timestamp() - INTERVAL '9 days'
    FROM (VALUES
      ('forensic-0059-purge-failure', 'RUNNING', 'NONE'),
      ('forensic-0059-live-unknown', 'COMPLETED', 'UNKNOWN'),
      ('forensic-0059-live-uncertain', 'UNCERTAIN', 'NONE'),
      ('forensic-0059-completed', 'COMPLETED', 'READY'),
      ('forensic-0059-completed-aged', 'COMPLETED', 'READY'),
      ('forensic-0059-old-evidence', 'UNCERTAIN', 'NONE')
    ) AS fixture(event_id, state_value, delivery_value);

  -- Seed one old, partial evidence record before its source reaches the purger.
  -- This models indefinite retention and checks that conflict handling never
  -- overwrites the captured evidence.
  INSERT INTO public.tb_whatsapp_event_forensic_evidence(
    processed_event_id, request_digest, event_kind,
    processing_state_before_purge, processing_state_after_purge,
    delivery_state_before_purge, delivery_state_after_purge,
    event_recorded_at, receipt_created_at, receipt_updated_at,
    event_expires_at, delivery_expires_at, reply_expires_at, tombstoned_at_at_capture,
    admission_generation, event_epoch, delivery_epoch, context_epoch,
    has_context_lease, has_event_token, has_delivery_token,
    user_id, household_id, actor_member_id, conversation_digest, operation_digest,
    business_result_status, business_result_expense_id, business_result_income_id, business_result_proposal_id,
    artifact_entry_count, artifact_container_valid,
    delivery_attempts, http_status, provider_code, provider_metadata_status,
    cause_recording_status, capture_method, evidence_quality, captured_at
  )
  SELECT p.id, r.request_digest, 'MESSAGE',
         'UNCERTAIN', 'UNCERTAIN', 'NONE', 'NONE',
         p.processed_at, r.created_at, r.updated_at, NULL, NULL, NULL, NULL,
         r.admission_generation, r.event_epoch, r.delivery_epoch, NULL,
         FALSE, FALSE, FALSE, NULL, NULL, NULL, NULL, NULL,
         NULL, NULL, NULL, NULL, 0, TRUE, 0, NULL, NULL,
         'NOT_RECORDED', 'NOT_RECORDED', 'HISTORICAL_BACKFILL', 'PARTIAL_HISTORICAL',
         pg_catalog.clock_timestamp() - INTERVAL '10 years'
    FROM public.tb_processed_whatsapp_events p
    JOIN public.tb_whatsapp_event_receipts r ON r.external_event_id = p.external_event_id
   WHERE p.external_event_id = 'forensic-0059-old-evidence';

  SELECT id INTO internal_id FROM public.tb_processed_whatsapp_events
   WHERE external_event_id = 'forensic-0059-old-evidence';
  SELECT pg_catalog.to_jsonb(e) INTO before_evidence FROM public.tb_whatsapp_event_forensic_evidence e
   WHERE processed_event_id = internal_id;
  IF before_evidence IS NULL OR (before_evidence ->> 'captured_at')::TIMESTAMPTZ > pg_catalog.clock_timestamp() - INTERVAL '9 years' THEN
    RAISE EXCEPTION 'Old evidence fixture was not created';
  END IF;

  -- Inject a failure after the evidence INSERT itself. The function call's
  -- exception subtransaction must remove that row and preserve the receipt.
  EXECUTE $ddl$
    CREATE FUNCTION public.test_0059_forensic_evidence_insert_failure()
    RETURNS TRIGGER LANGUAGE plpgsql AS $trigger$
    BEGIN
      IF NEW.processed_event_id = '59000000-0059-4000-8000-000000000100'::UUID THEN
        RAISE EXCEPTION 'injected forensic evidence write failure' USING ERRCODE = 'P0001';
      END IF;
      RETURN NEW;
    END;
    $trigger$
  $ddl$;
  EXECUTE 'CREATE TRIGGER test_0059_forensic_evidence_insert_failure AFTER INSERT ON public.tb_whatsapp_event_forensic_evidence FOR EACH ROW EXECUTE FUNCTION public.test_0059_forensic_evidence_insert_failure()';
  SELECT pg_catalog.to_jsonb(r) INTO before_receipt FROM public.tb_whatsapp_event_receipts r
   WHERE external_event_id = 'forensic-0059-purge-failure';
  failed := FALSE;
  BEGIN
    PERFORM public.fn_purge_whatsapp_event_payloads(1000);
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'injected forensic evidence write failure' THEN RAISE; END IF;
    failed := TRUE;
  END;
  IF NOT failed THEN RAISE EXCEPTION 'Purger did not surface evidence persistence failure'; END IF;
  SELECT pg_catalog.to_jsonb(r) INTO after_receipt FROM public.tb_whatsapp_event_receipts r
   WHERE external_event_id = 'forensic-0059-purge-failure';
  IF after_receipt IS DISTINCT FROM before_receipt THEN
    RAISE EXCEPTION 'Receipt was purged despite the evidence write failure';
  END IF;
  SELECT id INTO internal_id FROM public.tb_processed_whatsapp_events
   WHERE external_event_id = 'forensic-0059-purge-failure';
  IF EXISTS (SELECT 1 FROM public.tb_whatsapp_event_forensic_evidence WHERE processed_event_id = internal_id) THEN
    RAISE EXCEPTION 'Partial evidence survived failed purge';
  END IF;
  EXECUTE 'DROP TRIGGER test_0059_forensic_evidence_insert_failure ON public.tb_whatsapp_event_forensic_evidence';
  EXECUTE 'DROP FUNCTION public.test_0059_forensic_evidence_insert_failure()';

  IF public.fn_purge_whatsapp_event_payloads(1000) < 6 THEN
    RAISE EXCEPTION 'Purger did not process the aged ambiguity and completed fixtures';
  END IF;

  FOR event_id IN SELECT unnest(ARRAY[
    'forensic-0059-purge-failure', 'forensic-0059-live-unknown',
    'forensic-0059-live-uncertain', 'forensic-0059-old-evidence'
  ]) LOOP
    SELECT e.id INTO internal_id FROM public.tb_processed_whatsapp_events e
     WHERE e.external_event_id = event_id;
    SELECT * INTO row_value FROM public.tb_whatsapp_event_forensic_evidence e
     WHERE e.processed_event_id = internal_id;
    IF NOT FOUND OR (row_value.capture_method <> 'PURGER' AND event_id <> 'forensic-0059-old-evidence') THEN
      RAISE EXCEPTION 'Missing purge evidence for %', event_id;
    END IF;
    IF event_id <> 'forensic-0059-old-evidence' AND row_value.evidence_quality <> 'COMPLETE' THEN
      RAISE EXCEPTION 'Newly captured purge evidence was not marked complete: %', event_id;
    END IF;
    IF pg_catalog.to_jsonb(row_value)::TEXT LIKE '%forensic-live-sensitive-sentinel%'
       OR pg_catalog.to_jsonb(row_value)::TEXT LIKE '%19990005901%' THEN
      RAISE EXCEPTION 'Sensitive live receipt content leaked into evidence: %', event_id;
    END IF;
  END LOOP;

  SELECT e.id INTO internal_id FROM public.tb_processed_whatsapp_events e
   WHERE e.external_event_id = 'forensic-0059-purge-failure';
  SELECT * INTO evidence_row FROM public.tb_whatsapp_event_forensic_evidence e
   WHERE e.processed_event_id = internal_id;
  IF evidence_row.processing_state_before_purge <> 'RUNNING'
     OR evidence_row.processing_state_after_purge <> 'UNCERTAIN'
     OR evidence_row.has_event_token IS DISTINCT FROM TRUE
     OR evidence_row.context_epoch <> 12
     OR evidence_row.event_epoch <> 2
     OR evidence_row.admission_generation < 1
     OR evidence_row.cause_recording_status <> 'NOT_RECORDED' THEN
    RAISE EXCEPTION 'RUNNING-to-UNCERTAIN forensic state/fencing projection is incorrect';
  END IF;

  SELECT e.id INTO internal_id FROM public.tb_processed_whatsapp_events e
   WHERE e.external_event_id = 'forensic-0059-live-unknown';
  SELECT * INTO evidence_row FROM public.tb_whatsapp_event_forensic_evidence e
   WHERE e.processed_event_id = internal_id;
  IF evidence_row.processing_state_before_purge <> 'COMPLETED'
     OR evidence_row.delivery_state_before_purge <> 'UNKNOWN'
     OR evidence_row.delivery_state_after_purge <> 'UNKNOWN'
     OR evidence_row.business_result_status <> 'CREATED'
     OR evidence_row.business_result_expense_id IS DISTINCT FROM '59000000-0059-4000-8000-000000000114'::UUID
     OR evidence_row.http_status <> 503
     OR evidence_row.provider_code <> 131047
     OR evidence_row.provider_metadata_status <> 'HTTP_AND_PROVIDER_CODE_RECORDED' THEN
    RAISE EXCEPTION 'UNKNOWN delivery forensic projection is incorrect';
  END IF;
  SELECT * INTO ref_row FROM public.tb_whatsapp_event_forensic_proposal_refs
   WHERE processed_event_id = internal_id;
  IF NOT FOUND OR ref_row.proposal_id <> '59000000-0059-4000-8000-000000000116'::UUID
     OR ref_row.proposal_version <> '3' OR ref_row.version_status <> 'VALID' THEN
    RAISE EXCEPTION 'Current artifact allowlist was not preserved';
  END IF;

  SELECT e.id INTO internal_id FROM public.tb_processed_whatsapp_events e
   WHERE e.external_event_id = 'forensic-0059-live-uncertain';
  SELECT * INTO evidence_row FROM public.tb_whatsapp_event_forensic_evidence e
   WHERE e.processed_event_id = internal_id;
  IF evidence_row.processing_state_before_purge <> 'UNCERTAIN'
     OR evidence_row.processing_state_after_purge <> 'UNCERTAIN'
     OR evidence_row.business_result_status IS NOT NULL
     OR evidence_row.business_result_proposal_id IS NOT NULL THEN
    RAISE EXCEPTION 'UNCERTAIN business result was invented';
  END IF;
  SELECT * INTO ref_row FROM public.tb_whatsapp_event_forensic_proposal_refs
   WHERE processed_event_id = internal_id;
  IF NOT FOUND OR ref_row.proposal_id <> '59000000-0059-4000-8000-000000000115'::UUID
     OR ref_row.version_status <> 'MISSING' OR ref_row.proposal_version IS NOT NULL THEN
    RAISE EXCEPTION 'Missing legacy proposal version was inferred';
  END IF;

  SELECT * INTO row_value FROM public.tb_whatsapp_event_receipts
   WHERE external_event_id = 'forensic-0059-purge-failure';
    IF row_value.processing_state <> 'UNCERTAIN' OR row_value.delivery_state <> 'NONE'
     OR row_value.identity_snapshot IS NOT NULL OR row_value.admission_selection IS NOT NULL
     OR row_value.artifacts <> '{}'::JSONB OR row_value.event_token IS NOT NULL
     OR row_value.context_lease_id IS NOT NULL OR row_value.household_id IS NOT NULL
     OR row_value.actor_member_id IS NOT NULL OR row_value.operation_digest IS NOT NULL
     OR row_value.reply_text IS NOT NULL OR row_value.reply_guard IS NOT NULL
     OR row_value.http_status IS NOT NULL OR row_value.provider_code IS NOT NULL
     OR row_value.delivery_attempts <> 0 OR row_value.tombstoned_at IS NULL THEN
    RAISE EXCEPTION 'Purger failed to redact aged source data or changed ambiguity incorrectly';
  END IF;

  SELECT * INTO row_value FROM public.tb_whatsapp_event_receipts
   WHERE external_event_id = 'forensic-0059-live-unknown';
  IF row_value.processing_state <> 'COMPLETED' OR row_value.delivery_state <> 'UNKNOWN'
     OR row_value.business_result IS NULL OR row_value.reply_text IS NOT NULL
     OR row_value.reply_guard IS NOT NULL OR row_value.identity_snapshot IS NOT NULL
     OR row_value.tombstoned_at IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN receipt did not retain its state/result while redacting payload';
  END IF;

  SELECT * INTO row_value FROM public.tb_whatsapp_event_receipts
   WHERE external_event_id = 'forensic-0059-live-uncertain';
  IF row_value.processing_state <> 'UNCERTAIN' OR row_value.delivery_state <> 'NONE'
     OR row_value.identity_snapshot IS NOT NULL OR row_value.reply_text IS NOT NULL
     OR row_value.tombstoned_at IS NULL THEN
    RAISE EXCEPTION 'UNCERTAIN receipt did not retain its state while redacting payload';
  END IF;

  SELECT * INTO row_value FROM public.tb_whatsapp_event_receipts
   WHERE external_event_id = 'forensic-0059-completed';
  IF row_value.processing_state <> 'COMPLETED' OR row_value.delivery_state <> 'EXPIRED'
     OR row_value.reply_text IS NOT NULL OR row_value.reply_guard IS NOT NULL
     OR row_value.identity_snapshot IS NULL OR row_value.tombstoned_at IS NOT NULL THEN
    RAISE EXCEPTION 'Completed receipt retention behavior changed';
  END IF;
  SELECT id INTO internal_id FROM public.tb_processed_whatsapp_events
   WHERE external_event_id = 'forensic-0059-completed';
  IF EXISTS (SELECT 1 FROM public.tb_whatsapp_event_forensic_evidence WHERE processed_event_id = internal_id) THEN
    RAISE EXCEPTION 'Completed receipt incorrectly received ambiguity evidence';
  END IF;

  SELECT * INTO row_value FROM public.tb_whatsapp_event_receipts
   WHERE external_event_id = 'forensic-0059-completed-aged';
  IF row_value.processing_state <> 'COMPLETED' OR row_value.delivery_state <> 'EXPIRED'
     OR row_value.reply_text IS NOT NULL OR row_value.reply_guard IS NOT NULL
     OR row_value.identity_snapshot IS NOT NULL OR row_value.admission_selection IS NOT NULL
     OR row_value.artifacts <> '{}'::JSONB OR row_value.tombstoned_at IS NULL THEN
    RAISE EXCEPTION 'Aged completed receipt did not retain the existing purge behavior';
  END IF;
  SELECT id INTO internal_id FROM public.tb_processed_whatsapp_events
   WHERE external_event_id = 'forensic-0059-completed-aged';
  IF EXISTS (SELECT 1 FROM public.tb_whatsapp_event_forensic_evidence WHERE processed_event_id = internal_id) THEN
    RAISE EXCEPTION 'Aged completed receipt incorrectly received ambiguity evidence';
  END IF;

  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(e) ORDER BY e.processed_event_id), '[]'::JSONB)
    INTO all_evidence_before FROM public.tb_whatsapp_event_forensic_evidence e;
  SELECT pg_catalog.to_jsonb(e) INTO before_evidence FROM public.tb_whatsapp_event_forensic_evidence e
   WHERE processed_event_id = (
     SELECT id FROM public.tb_processed_whatsapp_events WHERE external_event_id = 'forensic-0059-old-evidence'
   );
  IF public.fn_purge_whatsapp_event_payloads(1000) <> 0 THEN
    RAISE EXCEPTION 'Repeated purge unexpectedly found an already tombstoned receipt';
  END IF;
  SELECT pg_catalog.to_jsonb(e) INTO after_evidence FROM public.tb_whatsapp_event_forensic_evidence e
   WHERE processed_event_id = (
     SELECT id FROM public.tb_processed_whatsapp_events WHERE external_event_id = 'forensic-0059-old-evidence'
   );
  IF after_evidence IS DISTINCT FROM before_evidence
     OR (after_evidence ->> 'captured_at')::TIMESTAMPTZ > pg_catalog.clock_timestamp() - INTERVAL '9 years'
     OR (SELECT count(*) FROM public.tb_whatsapp_event_forensic_evidence WHERE processed_event_id = (
       SELECT id FROM public.tb_processed_whatsapp_events WHERE external_event_id = 'forensic-0059-old-evidence'
     )) <> 1 THEN
    RAISE EXCEPTION 'Old forensic evidence expired, duplicated, or was overwritten';
  END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(e) ORDER BY e.processed_event_id), '[]'::JSONB)
    INTO all_evidence_after FROM public.tb_whatsapp_event_forensic_evidence e;
  IF all_evidence_after IS DISTINCT FROM all_evidence_before THEN
    RAISE EXCEPTION 'Repeated purge duplicated or changed retained forensic evidence';
  END IF;

  PERFORM public.fn_start_whatsapp_drain();
  result_value := public.fn_enter_whatsapp_link_only();
  counts := result_value -> 'databaseBlockers';
  IF result_value ->> 'status' <> 'BLOCKED'
     OR COALESCE((counts ->> 'unknown')::BIGINT, 0) < 1
     OR COALESCE((counts ->> 'uncertain')::BIGINT, 0) < 1 THEN
    RAISE EXCEPTION 'Ambiguous receipts stopped blocking LINK_ONLY after evidence preservation';
  END IF;

  -- Retrying the original claim after preservation still returns closed states.
  statuses := ARRAY[]::TEXT[];
  FOREACH event_id IN ARRAY ARRAY['forensic-0059-live-unknown', 'forensic-0059-live-uncertain'] LOOP
    result_value := public.fn_claim_whatsapp_event(event_id, sender_number, phone_number_id, msg_digest, pg_catalog.gen_random_uuid());
    statuses := pg_catalog.array_append(statuses, result_value ->> 'status');
  END LOOP;
  IF NOT ('UNKNOWN' = ANY(statuses)) OR NOT ('UNCERTAIN' = ANY(statuses)) THEN
    RAISE EXCEPTION 'Forensic evidence was treated as authorization to retry: %', statuses;
  END IF;
END;
$$;

ROLLBACK;
