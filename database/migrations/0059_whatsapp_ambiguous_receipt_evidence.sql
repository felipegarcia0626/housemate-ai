BEGIN;

-- Serialize the historical snapshot and the purge replacement with the same
-- WhatsApp gate used by receipt mutations.
SELECT pg_catalog.pg_advisory_xact_lock(18443, 43);

CREATE TABLE public.tb_whatsapp_event_forensic_evidence (
  processed_event_id UUID PRIMARY KEY
    REFERENCES public.tb_processed_whatsapp_events(id) ON DELETE RESTRICT,
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  event_kind TEXT NOT NULL CHECK (event_kind IN ('MESSAGE', 'LINK_CONTROL')),
  processing_state_before_purge TEXT NOT NULL
    CHECK (processing_state_before_purge IN ('RESERVED', 'RUNNING', 'COMPLETED', 'UNCERTAIN', 'HISTORICAL', 'PAUSED')),
  processing_state_after_purge TEXT NOT NULL
    CHECK (processing_state_after_purge IN ('RESERVED', 'RUNNING', 'COMPLETED', 'UNCERTAIN', 'HISTORICAL', 'PAUSED')),
  delivery_state_before_purge TEXT NOT NULL
    CHECK (delivery_state_before_purge IN ('NONE', 'READY', 'SENDING', 'RETRYABLE', 'ACCEPTED', 'UNKNOWN', 'BLOCKED', 'EXPIRED')),
  delivery_state_after_purge TEXT NOT NULL
    CHECK (delivery_state_after_purge IN ('NONE', 'READY', 'SENDING', 'RETRYABLE', 'ACCEPTED', 'UNKNOWN', 'BLOCKED', 'EXPIRED')),
  event_recorded_at TIMESTAMPTZ NOT NULL,
  receipt_created_at TIMESTAMPTZ NOT NULL,
  receipt_updated_at TIMESTAMPTZ NOT NULL,
  event_expires_at TIMESTAMPTZ,
  delivery_expires_at TIMESTAMPTZ,
  reply_expires_at TIMESTAMPTZ,
  tombstoned_at_at_capture TIMESTAMPTZ,
  admission_generation BIGINT NOT NULL CHECK (admission_generation BETWEEN 1 AND 9007199254740991),
  event_epoch BIGINT NOT NULL CHECK (event_epoch BETWEEN 1 AND 9007199254740991),
  delivery_epoch BIGINT NOT NULL CHECK (delivery_epoch BETWEEN 0 AND 9007199254740991),
  context_epoch BIGINT CHECK (context_epoch IS NULL OR context_epoch > 0),
  has_context_lease BOOLEAN NOT NULL,
  has_event_token BOOLEAN NOT NULL,
  has_delivery_token BOOLEAN NOT NULL,
  user_id UUID,
  household_id UUID,
  actor_member_id UUID,
  conversation_digest TEXT CHECK (conversation_digest IS NULL OR conversation_digest ~ '^[0-9a-f]{64}$'),
  operation_digest TEXT CHECK (operation_digest IS NULL OR operation_digest ~ '^[0-9a-f]{64}$'),
  business_result_status TEXT CHECK (business_result_status IS NULL OR business_result_status IN (
    'CREATED', 'ALREADY_COMPLETED', 'REJECTED', 'REMOVED', 'NOT_FOUND',
    'LINKED', 'INVALID', 'RATE_LIMITED', 'UNAVAILABLE'
  )),
  business_result_expense_id UUID,
  business_result_income_id UUID,
  business_result_proposal_id UUID,
  artifact_entry_count INTEGER NOT NULL CHECK (artifact_entry_count >= 0),
  artifact_container_valid BOOLEAN NOT NULL,
  delivery_attempts INTEGER NOT NULL CHECK (delivery_attempts >= 0),
  http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  provider_code BIGINT CHECK (provider_code IS NULL OR provider_code BETWEEN 0 AND 9007199254740991),
  provider_metadata_status TEXT NOT NULL
    CHECK (provider_metadata_status IN ('NOT_RECORDED', 'HTTP_STATUS_RECORDED', 'PROVIDER_CODE_RECORDED', 'HTTP_AND_PROVIDER_CODE_RECORDED')),
  cause_recording_status TEXT NOT NULL DEFAULT 'NOT_RECORDED'
    CHECK (cause_recording_status = 'NOT_RECORDED'),
  capture_method TEXT NOT NULL CHECK (capture_method IN ('PURGER', 'HISTORICAL_BACKFILL')),
  evidence_quality TEXT NOT NULL CHECK (evidence_quality IN ('COMPLETE', 'PARTIAL_HISTORICAL')),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CHECK ((household_id IS NULL) = (actor_member_id IS NULL)),
  CHECK (has_context_lease = (context_epoch IS NOT NULL)),
  CHECK (has_event_token = (event_expires_at IS NOT NULL)),
  CHECK (has_delivery_token = (delivery_expires_at IS NOT NULL)),
  CHECK (num_nonnulls(business_result_expense_id, business_result_income_id, business_result_proposal_id) <= 1),
  CHECK (processing_state_before_purge = 'UNCERTAIN'
      OR delivery_state_before_purge = 'UNKNOWN'
      OR processing_state_after_purge = 'UNCERTAIN'
      OR delivery_state_after_purge = 'UNKNOWN')
);

CREATE INDEX ix_whatsapp_forensic_evidence_captured_at
  ON public.tb_whatsapp_event_forensic_evidence(captured_at);
ALTER TABLE public.tb_whatsapp_event_forensic_evidence OWNER TO postgres;
ALTER TABLE public.tb_whatsapp_event_forensic_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tb_whatsapp_event_forensic_evidence FROM PUBLIC, anon, authenticated, service_role;

-- Only the artifact identifiers and concurrency metadata needed to trace a
-- proposal are retained. Payload, updatedAt, and arbitrary artifact JSON are
-- intentionally excluded.
CREATE TABLE public.tb_whatsapp_event_forensic_proposal_refs (
  processed_event_id UUID NOT NULL
    REFERENCES public.tb_whatsapp_event_forensic_evidence(processed_event_id) ON DELETE RESTRICT,
  proposal_id UUID NOT NULL,
  operation_type TEXT,
  operation_status TEXT NOT NULL CHECK (operation_status IN ('AVAILABLE', 'MISSING', 'UNRECOGNIZED')),
  proposal_version TEXT,
  version_status TEXT NOT NULL CHECK (version_status IN ('VALID', 'MISSING', 'INVALID')),
  PRIMARY KEY (processed_event_id, proposal_id),
  CHECK ((operation_status = 'AVAILABLE') = (operation_type IS NOT NULL)),
  CHECK (operation_type IS NULL OR operation_type IN (
    'CREATE_EXPENSE', 'UPDATE_EXPENSE', 'DELETE_EXPENSE',
    'CREATE_INCOME', 'UPDATE_INCOME', 'DELETE_INCOME'
  )),
  CHECK ((version_status = 'VALID') = (proposal_version IS NOT NULL)),
  CHECK (proposal_version IS NULL OR (
    proposal_version ~ '^[1-9][0-9]*$'
    AND length(proposal_version) <= 19
    AND (length(proposal_version) < 19 OR proposal_version <= '9223372036854775807')
  ))
);
CREATE INDEX ix_whatsapp_forensic_proposal_refs_proposal_id
  ON public.tb_whatsapp_event_forensic_proposal_refs(proposal_id);
ALTER TABLE public.tb_whatsapp_event_forensic_proposal_refs OWNER TO postgres;
ALTER TABLE public.tb_whatsapp_event_forensic_proposal_refs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tb_whatsapp_event_forensic_proposal_refs FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.fn_reject_whatsapp_forensic_evidence_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'WhatsApp forensic evidence is append-only'
    USING ERRCODE = '55000';
  RETURN OLD;
END;
$$;
ALTER FUNCTION public.fn_reject_whatsapp_forensic_evidence_mutation() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_reject_whatsapp_forensic_evidence_mutation() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER tr_whatsapp_forensic_evidence_append_only
BEFORE UPDATE OR DELETE ON public.tb_whatsapp_event_forensic_evidence
FOR EACH ROW EXECUTE FUNCTION public.fn_reject_whatsapp_forensic_evidence_mutation();
CREATE TRIGGER tr_whatsapp_forensic_proposal_refs_append_only
BEFORE UPDATE OR DELETE ON public.tb_whatsapp_event_forensic_proposal_refs
FOR EACH ROW EXECUTE FUNCTION public.fn_reject_whatsapp_forensic_evidence_mutation();

CREATE FUNCTION public.fn_capture_whatsapp_forensic_proposal_refs(
  p_processed_event_id UUID,
  p_artifacts JSONB
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  artifact_row RECORD;
  proposal_id UUID;
  operation_value TEXT;
  operation_status_value TEXT;
  version_value TEXT;
  version_status_value TEXT;
  inserted_count INTEGER := 0;
BEGIN
  IF pg_catalog.jsonb_typeof(p_artifacts) IS DISTINCT FROM 'object' THEN
    RETURN 0;
  END IF;

  FOR artifact_row IN SELECT key, value FROM pg_catalog.jsonb_each(p_artifacts) LOOP
    IF artifact_row.key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      CONTINUE;
    END IF;
    proposal_id := artifact_row.key::UUID;

    operation_value := CASE
      WHEN pg_catalog.jsonb_typeof(artifact_row.value) = 'object' THEN artifact_row.value ->> 'operation'
      ELSE NULL
    END;
    IF operation_value IN (
      'CREATE_EXPENSE', 'UPDATE_EXPENSE', 'DELETE_EXPENSE',
      'CREATE_INCOME', 'UPDATE_INCOME', 'DELETE_INCOME'
    ) THEN
      operation_status_value := 'AVAILABLE';
    ELSIF operation_value IS NULL THEN
      operation_status_value := 'MISSING';
      operation_value := NULL;
    ELSE
      operation_status_value := 'UNRECOGNIZED';
      operation_value := NULL;
    END IF;

    IF pg_catalog.jsonb_typeof(artifact_row.value) IS DISTINCT FROM 'object'
       OR NOT (artifact_row.value ? 'version') THEN
      version_status_value := 'MISSING';
      version_value := NULL;
    ELSE
      version_value := artifact_row.value ->> 'version';
      IF pg_catalog.jsonb_typeof(artifact_row.value -> 'version') = 'string'
         AND version_value ~ '^[1-9][0-9]*$'
         AND pg_catalog.length(version_value) <= 19
         AND (pg_catalog.length(version_value) < 19 OR version_value <= '9223372036854775807') THEN
        version_status_value := 'VALID';
      ELSE
        version_status_value := 'INVALID';
        version_value := NULL;
      END IF;
    END IF;

    INSERT INTO public.tb_whatsapp_event_forensic_proposal_refs(
      processed_event_id, proposal_id, operation_type, operation_status,
      proposal_version, version_status
    ) VALUES (
      p_processed_event_id, proposal_id, operation_value, operation_status_value,
      version_value, version_status_value
    ) ON CONFLICT ON CONSTRAINT tb_whatsapp_event_forensic_proposal_refs_pkey DO NOTHING;
    inserted_count := inserted_count + 1;
  END LOOP;

  RETURN inserted_count;
END;
$$;
ALTER FUNCTION public.fn_capture_whatsapp_forensic_proposal_refs(UUID, JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_capture_whatsapp_forensic_proposal_refs(UUID, JSONB) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.fn_preserve_whatsapp_event_forensic_evidence(
  p_external_event_id TEXT,
  p_capture_method TEXT,
  p_processing_state_after_purge TEXT,
  p_delivery_state_after_purge TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  source_row RECORD;
  captured_event_id UUID;
BEGIN
  IF p_capture_method IS NULL
     OR p_capture_method NOT IN ('PURGER', 'HISTORICAL_BACKFILL') THEN
    RAISE EXCEPTION 'Invalid WhatsApp evidence capture method' USING ERRCODE = '22023';
  END IF;

  SELECT e.id AS processed_event_id, e.processed_at AS event_recorded_at, receipt_row.*
    INTO source_row
    FROM public.tb_whatsapp_event_receipts receipt_row
    JOIN public.tb_processed_whatsapp_events e ON e.external_event_id = receipt_row.external_event_id
   WHERE receipt_row.external_event_id = p_external_event_id
   FOR UPDATE OF receipt_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'WhatsApp receipt evidence source is unavailable' USING ERRCODE = '23503';
  END IF;

  IF source_row.processing_state <> 'UNCERTAIN'
     AND source_row.delivery_state <> 'UNKNOWN'
     AND p_processing_state_after_purge <> 'UNCERTAIN'
     AND p_delivery_state_after_purge <> 'UNKNOWN' THEN
    RETURN FALSE;
  END IF;

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
    cause_recording_status, capture_method, evidence_quality
  ) VALUES (
    source_row.processed_event_id, source_row.request_digest, source_row.event_kind,
    source_row.processing_state, p_processing_state_after_purge,
    source_row.delivery_state, p_delivery_state_after_purge,
    source_row.event_recorded_at, source_row.created_at, source_row.updated_at,
    source_row.event_expires_at, source_row.delivery_expires_at, source_row.reply_expires_at, source_row.tombstoned_at,
    source_row.admission_generation, source_row.event_epoch, source_row.delivery_epoch, source_row.context_epoch,
    source_row.context_lease_id IS NOT NULL, source_row.event_token IS NOT NULL, source_row.delivery_token IS NOT NULL,
    source_row.user_id, source_row.household_id, source_row.actor_member_id, source_row.conversation_digest,
    CASE WHEN source_row.operation_digest ~ '^[0-9a-f]{64}$' THEN source_row.operation_digest ELSE NULL END,
    CASE
      WHEN pg_catalog.jsonb_typeof(source_row.business_result) = 'object'
       AND source_row.business_result ->> 'status' IN (
         'CREATED', 'ALREADY_COMPLETED', 'REJECTED', 'REMOVED', 'NOT_FOUND',
         'LINKED', 'INVALID', 'RATE_LIMITED', 'UNAVAILABLE'
       )
      THEN source_row.business_result ->> 'status'
      ELSE NULL
    END,
    CASE
      WHEN pg_catalog.jsonb_typeof(source_row.business_result) = 'object'
       AND source_row.business_result ->> 'expense_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (source_row.business_result ->> 'expense_id')::UUID
      ELSE NULL
    END,
    CASE
      WHEN pg_catalog.jsonb_typeof(source_row.business_result) = 'object'
       AND source_row.business_result ->> 'income_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (source_row.business_result ->> 'income_id')::UUID
      ELSE NULL
    END,
    CASE
      WHEN pg_catalog.jsonb_typeof(source_row.business_result) = 'object'
       AND source_row.business_result ->> 'proposal_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (source_row.business_result ->> 'proposal_id')::UUID
      ELSE NULL
    END,
    CASE
      WHEN pg_catalog.jsonb_typeof(source_row.artifacts) = 'object' THEN (
        SELECT count(*)::INTEGER
          FROM pg_catalog.jsonb_each(source_row.artifacts)
      )
      ELSE 0
    END,
    pg_catalog.jsonb_typeof(source_row.artifacts) = 'object',
    source_row.delivery_attempts, source_row.http_status, source_row.provider_code,
    CASE
      WHEN source_row.http_status IS NOT NULL AND source_row.provider_code IS NOT NULL THEN 'HTTP_AND_PROVIDER_CODE_RECORDED'
      WHEN source_row.http_status IS NOT NULL THEN 'HTTP_STATUS_RECORDED'
      WHEN source_row.provider_code IS NOT NULL THEN 'PROVIDER_CODE_RECORDED'
      ELSE 'NOT_RECORDED'
    END,
    'NOT_RECORDED', p_capture_method,
    CASE WHEN p_capture_method = 'HISTORICAL_BACKFILL' OR source_row.tombstoned_at IS NOT NULL
      THEN 'PARTIAL_HISTORICAL' ELSE 'COMPLETE' END
  ) ON CONFLICT (processed_event_id) DO NOTHING
  RETURNING processed_event_id INTO captured_event_id;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  PERFORM public.fn_capture_whatsapp_forensic_proposal_refs(captured_event_id, source_row.artifacts);
  RETURN TRUE;
END;
$$;
ALTER FUNCTION public.fn_preserve_whatsapp_event_forensic_evidence(TEXT, TEXT, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_preserve_whatsapp_event_forensic_evidence(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;

-- Backfill only the projection still available for already-ambiguous rows.
-- All backfilled rows are marked historical/partial: prior transitions and
-- causes cannot be reconstructed from the current receipt alone.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT external_event_id, processing_state, delivery_state
      FROM public.tb_whatsapp_event_receipts
     WHERE processing_state = 'UNCERTAIN' OR delivery_state = 'UNKNOWN'
     ORDER BY created_at
     FOR UPDATE
  LOOP
    PERFORM public.fn_preserve_whatsapp_event_forensic_evidence(
      r.external_event_id, 'HISTORICAL_BACKFILL', r.processing_state, r.delivery_state
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_purge_whatsapp_event_payloads(p_limit INTEGER DEFAULT 1000)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  n INTEGER := 0;
  v_now TIMESTAMPTZ;
  v_is_aged BOOLEAN;
  v_processing_after TEXT;
  v_delivery_after TEXT;
  v_updated INTEGER;
  r RECORD;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'Invalid cleanup limit' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(18443, 43);
  v_now := pg_catalog.clock_timestamp();

  FOR r IN
    SELECT receipt.*
      FROM public.tb_whatsapp_event_receipts receipt
     WHERE (receipt.reply_expires_at <= v_now AND (receipt.reply_text IS NOT NULL OR receipt.reply_guard IS NOT NULL))
        OR (receipt.created_at <= v_now - INTERVAL '30 days' AND receipt.tombstoned_at IS NULL)
     ORDER BY receipt.created_at
     LIMIT p_limit
     FOR UPDATE OF receipt
  LOOP
    v_is_aged := r.created_at <= v_now - INTERVAL '30 days';
    v_processing_after := CASE
      WHEN v_is_aged AND r.processing_state IN ('RESERVED', 'RUNNING') THEN 'UNCERTAIN'
      ELSE r.processing_state
    END;
    v_delivery_after := CASE
      WHEN r.delivery_state = 'SENDING' THEN 'UNKNOWN'
      WHEN r.delivery_state IN ('NONE', 'ACCEPTED', 'UNKNOWN', 'BLOCKED') THEN r.delivery_state
      ELSE 'EXPIRED'
    END;

    IF r.processing_state = 'UNCERTAIN' OR r.delivery_state = 'UNKNOWN'
       OR v_processing_after = 'UNCERTAIN' OR v_delivery_after = 'UNKNOWN' THEN
      PERFORM public.fn_preserve_whatsapp_event_forensic_evidence(
        r.external_event_id, 'PURGER', v_processing_after, v_delivery_after
      );
    END IF;

    UPDATE public.tb_whatsapp_event_receipts
       SET reply_text = NULL,
           reply_guard = NULL,
           reply_template = NULL,
           delivery_state = CASE
             WHEN delivery_state = 'SENDING' THEN 'UNKNOWN'
             WHEN delivery_state IN ('NONE', 'ACCEPTED', 'UNKNOWN', 'BLOCKED') THEN delivery_state
             ELSE 'EXPIRED'
           END,
           identity_snapshot = CASE WHEN v_is_aged THEN NULL ELSE identity_snapshot END,
           admission_selection = CASE WHEN v_is_aged THEN NULL ELSE admission_selection END,
           artifacts = CASE WHEN v_is_aged THEN '{}'::JSONB ELSE artifacts END,
           user_id = CASE WHEN v_is_aged THEN NULL ELSE user_id END,
           household_id = CASE WHEN v_is_aged THEN NULL ELSE household_id END,
           actor_member_id = CASE WHEN v_is_aged THEN NULL ELSE actor_member_id END,
           context_lease_id = CASE WHEN v_is_aged THEN NULL ELSE context_lease_id END,
           context_epoch = CASE WHEN v_is_aged THEN NULL ELSE context_epoch END,
           event_token = CASE WHEN v_is_aged THEN NULL ELSE event_token END,
           event_expires_at = CASE WHEN v_is_aged THEN NULL ELSE event_expires_at END,
           delivery_token = CASE WHEN v_is_aged THEN NULL ELSE delivery_token END,
           delivery_expires_at = CASE WHEN v_is_aged THEN NULL ELSE delivery_expires_at END,
           conversation_digest = CASE WHEN v_is_aged THEN NULL ELSE conversation_digest END,
           operation_digest = CASE WHEN v_is_aged THEN NULL ELSE operation_digest END,
           http_status = CASE WHEN v_is_aged THEN NULL ELSE http_status END,
           provider_code = CASE WHEN v_is_aged THEN NULL ELSE provider_code END,
           delivery_attempts = CASE WHEN v_is_aged THEN 0 ELSE delivery_attempts END,
           tombstoned_at = CASE WHEN v_is_aged THEN v_now ELSE tombstoned_at END,
           processing_state = v_processing_after,
           updated_at = v_now
     WHERE external_event_id = r.external_event_id;

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated <> 1 THEN
      RAISE EXCEPTION 'WhatsApp receipt changed during purge' USING ERRCODE = '40001';
    END IF;
    n := n + 1;
  END LOOP;

  RETURN n;
END;
$$;

ALTER FUNCTION public.fn_purge_whatsapp_event_payloads(INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_purge_whatsapp_event_payloads(INTEGER) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.tb_whatsapp_event_forensic_evidence IS
  'Redacted append-only projection retained without TTL for unresolved WhatsApp UNKNOWN/UNCERTAIN receipts; it does not authorize retry or resolution.';
COMMENT ON COLUMN public.tb_whatsapp_event_forensic_evidence.event_recorded_at IS
  'Copied from processed_whatsapp_events.processed_at; this is the local record time, not a provider-supplied event timestamp.';
COMMENT ON TABLE public.tb_whatsapp_event_forensic_proposal_refs IS
  'Allowlisted proposal identifiers and concurrency metadata extracted from receipt artifacts; no proposal payload is retained.';

COMMIT;
