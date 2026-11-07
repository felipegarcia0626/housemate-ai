BEGIN;

-- Serialize gate changes with every 0043-0047 WhatsApp mutation/admission.
SELECT pg_catalog.pg_advisory_xact_lock(18443,43);

CREATE TABLE public.tb_whatsapp_admission_gate (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  mode TEXT NOT NULL CHECK (mode IN ('OPEN','DRAINING','LINK_ONLY')),
  generation BIGINT NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  draining_generation BIGINT,
  drain_started_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CHECK ((mode='DRAINING') = (draining_generation IS NOT NULL)),
  CHECK ((mode='DRAINING') = (drain_started_at IS NOT NULL))
);
ALTER TABLE public.tb_whatsapp_admission_gate OWNER TO postgres;
ALTER TABLE public.tb_whatsapp_admission_gate ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tb_whatsapp_admission_gate FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO public.tb_whatsapp_admission_gate(singleton,mode,generation)
VALUES (TRUE,'OPEN',1);

ALTER TABLE public.tb_whatsapp_user_contexts
  ADD COLUMN processing_admission_generation BIGINT;
UPDATE public.tb_whatsapp_user_contexts
SET processing_admission_generation=1
WHERE processing_lease_id IS NOT NULL;
ALTER TABLE public.tb_whatsapp_user_contexts
  ADD CONSTRAINT ck_whatsapp_context_lease_generation
  CHECK ((processing_lease_id IS NULL) = (processing_admission_generation IS NULL));

ALTER TABLE public.tb_whatsapp_event_receipts
  DROP CONSTRAINT tb_whatsapp_event_receipts_processing_state_check,
  ADD CONSTRAINT ck_whatsapp_receipt_processing_state
    CHECK (processing_state IN ('RESERVED','RUNNING','COMPLETED','UNCERTAIN','HISTORICAL','PAUSED')),
  ADD COLUMN admission_generation BIGINT NOT NULL DEFAULT 1
    CHECK (admission_generation BETWEEN 1 AND 9007199254740991);

CREATE FUNCTION public.fn_guard_whatsapp_context_generation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE gate public.tb_whatsapp_admission_gate;
BEGIN
  IF NEW.processing_lease_id IS NULL THEN
    NEW.processing_admission_generation:=NULL;
  ELSIF NEW.processing_lease_id IS DISTINCT FROM OLD.processing_lease_id THEN
    SELECT * INTO gate FROM public.tb_whatsapp_admission_gate WHERE singleton=TRUE;
    IF gate.mode='OPEN' THEN
      NEW.processing_admission_generation:=gate.generation;
    ELSIF gate.mode='DRAINING' THEN
      -- Only the receipt delivery path can admit a short lease while draining;
      -- legacy admission entry points are separately closed below.
      NEW.processing_admission_generation:=gate.draining_generation;
    ELSE
      RAISE EXCEPTION 'WhatsApp admission is link-only' USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.fn_guard_whatsapp_context_generation() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_guard_whatsapp_context_generation() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER tr_whatsapp_context_generation
BEFORE UPDATE OF processing_lease_id,processing_admission_generation
ON public.tb_whatsapp_user_contexts
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_whatsapp_context_generation();

CREATE FUNCTION public.fn_guard_whatsapp_receipt_generation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE gate public.tb_whatsapp_admission_gate;
BEGIN
  SELECT * INTO gate FROM public.tb_whatsapp_admission_gate WHERE singleton=TRUE;
  IF TG_OP='INSERT' THEN
    NEW.admission_generation:=CASE WHEN gate.mode='DRAINING' THEN gate.draining_generation ELSE gate.generation END;
    IF gate.mode='DRAINING'
       AND (NEW.event_kind<>'MESSAGE' OR NEW.processing_state<>'PAUSED') THEN
      RAISE EXCEPTION 'WhatsApp drain rejects new event admissions' USING ERRCODE='42501';
    END IF;
    IF gate.mode='LINK_ONLY'
       AND ((NEW.event_kind='MESSAGE' AND NEW.processing_state<>'PAUSED')
         OR (NEW.event_kind='LINK_CONTROL' AND NEW.processing_state<>'COMPLETED')) THEN
      RAISE EXCEPTION 'WhatsApp admission is link-only' USING ERRCODE='42501';
    END IF;
  ELSE
    NEW.admission_generation:=OLD.admission_generation;
    IF gate.mode='DRAINING' AND NEW.admission_generation IS DISTINCT FROM gate.draining_generation THEN
      RAISE EXCEPTION 'WhatsApp receipt belongs to a stale admission generation' USING ERRCODE='40001';
    END IF;
    IF gate.mode='DRAINING' AND OLD.processing_state='RESERVED' AND NEW.processing_state='RUNNING' THEN
      RAISE EXCEPTION 'WhatsApp drain does not begin reserved work' USING ERRCODE='40001';
    END IF;
    IF gate.mode='LINK_ONLY' AND NEW.event_kind='MESSAGE'
       AND (NEW.processing_state IN ('RESERVED','RUNNING')
         OR NEW.delivery_state IN ('READY','RETRYABLE','SENDING','UNKNOWN')) THEN
      RAISE EXCEPTION 'WhatsApp financial event is fenced by link-only mode' USING ERRCODE='40001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION public.fn_guard_whatsapp_receipt_generation() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_guard_whatsapp_receipt_generation() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER tr_whatsapp_receipt_generation
BEFORE INSERT OR UPDATE OF admission_generation,processing_state,delivery_state
ON public.tb_whatsapp_event_receipts
FOR EACH ROW EXECUTE FUNCTION public.fn_guard_whatsapp_receipt_generation();

CREATE OR REPLACE FUNCTION public.fn_whatsapp_lease_authorized(p_user_id UUID,p_lease_id UUID,p_lease_epoch BIGINT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_context public.tb_whatsapp_user_contexts; v_identity JSONB; gate public.tb_whatsapp_admission_gate;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(18443,43);
  SELECT * INTO gate FROM public.tb_whatsapp_admission_gate WHERE singleton=TRUE;
  SELECT * INTO v_context FROM public.tb_whatsapp_user_contexts WHERE user_id=p_user_id FOR SHARE;
  IF NOT FOUND OR p_lease_id IS NULL OR p_lease_epoch IS NULL
     OR v_context.processing_lease_id IS DISTINCT FROM p_lease_id
     OR v_context.processing_epoch IS DISTINCT FROM p_lease_epoch
     OR v_context.processing_expires_at IS NULL OR v_context.processing_expires_at<=pg_catalog.clock_timestamp()
     OR v_context.authorization_origin IS NULL
     OR gate.mode='LINK_ONLY'
     OR (gate.mode='OPEN' AND v_context.processing_admission_generation IS DISTINCT FROM gate.generation)
     OR (gate.mode='DRAINING' AND v_context.processing_admission_generation IS DISTINCT FROM gate.draining_generation) THEN
    RETURN false;
  END IF;
  -- During drain, only a receipt-aware worker that began before the close may
  -- keep using this lease. Legacy workers have no matching RUNNING receipt.
  IF gate.mode='DRAINING' AND NOT EXISTS (
    SELECT 1 FROM public.tb_whatsapp_event_receipts r
    WHERE r.event_kind='MESSAGE' AND r.processing_state='RUNNING'
      AND r.user_id=p_user_id AND r.context_lease_id=p_lease_id AND r.context_epoch=p_lease_epoch
      AND r.admission_generation=gate.draining_generation
      AND r.event_expires_at>pg_catalog.clock_timestamp()
  ) THEN
    RETURN false;
  END IF;
  v_identity:=public.fn_resolve_whatsapp_identity_locked(v_context.authorization_sender);
  RETURN COALESCE(v_identity IS NOT NULL
    AND (v_identity->>'userId')::uuid=p_user_id
    AND v_identity->>'origin'=v_context.authorization_origin
    AND (v_identity->>'linkId')::uuid IS NOT DISTINCT FROM v_context.authorization_link_id
    AND (v_identity->>'authorizationVersion')::bigint IS NOT DISTINCT FROM v_context.authorization_version,false);
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_renew_whatsapp_context_lease(
  p_user_id UUID,p_lease_id UUID,p_lease_epoch BIGINT,p_lease_seconds INTEGER DEFAULT 120
)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE gate public.tb_whatsapp_admission_gate;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(18443,43);
  SELECT * INTO gate FROM public.tb_whatsapp_admission_gate WHERE singleton=TRUE;
  IF gate.mode<>'OPEN' OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 300
     OR NOT public.fn_whatsapp_lease_authorized(p_user_id,p_lease_id,p_lease_epoch) THEN
    RETURN false;
  END IF;
  UPDATE public.tb_whatsapp_user_contexts SET processing_expires_at=pg_catalog.clock_timestamp()+pg_catalog.make_interval(secs=>p_lease_seconds),
    updated_at=pg_catalog.clock_timestamp()
  WHERE user_id=p_user_id AND processing_lease_id=p_lease_id AND processing_epoch=p_lease_epoch
    AND processing_expires_at>pg_catalog.clock_timestamp();
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_admit_whatsapp_sender(p_sender TEXT,p_lease_id UUID,p_lease_seconds INTEGER DEFAULT 120)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_identity JSONB; gate public.tb_whatsapp_admission_gate;
BEGIN
  IF p_sender IS NULL OR p_sender !~ '^[1-9][0-9]{7,14}$' THEN
    RAISE EXCEPTION 'Invalid WhatsApp sender' USING ERRCODE='22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(18443,43);
  SELECT * INTO gate FROM public.tb_whatsapp_admission_gate WHERE singleton=TRUE;
  IF gate.mode<>'OPEN' THEN RETURN jsonb_build_object('status','PAUSED','acquired',false); END IF;
  v_identity:=public.fn_resolve_whatsapp_identity_locked(p_sender);
  RETURN public.fn_admit_whatsapp_identity_locked(v_identity,p_sender,p_lease_id,p_lease_seconds);
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_acquire_whatsapp_context_lease(p_user_id UUID,p_lease_id UUID,p_lease_seconds INTEGER DEFAULT 120)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_sender TEXT; v_identity JSONB; gate public.tb_whatsapp_admission_gate;
BEGIN
  IF p_user_id IS NULL OR p_lease_id IS NULL OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 300 THEN
    RAISE EXCEPTION 'Invalid WhatsApp context lease input' USING ERRCODE='22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(18443,43);
  SELECT * INTO gate FROM public.tb_whatsapp_admission_gate WHERE singleton=TRUE;
  IF gate.mode<>'OPEN' THEN RETURN jsonb_build_object('acquired',false,'epoch',NULL,'status','PAUSED'); END IF;
  SELECT external_identifier INTO v_sender FROM public.tb_users WHERE id=p_user_id FOR SHARE;
  v_identity:=public.fn_resolve_whatsapp_identity_locked(v_sender);
  IF v_identity IS NULL OR v_identity->>'origin'<>'LEGACY' OR (v_identity->>'userId')::uuid IS DISTINCT FROM p_user_id
     OR EXISTS(SELECT 1 FROM public.tb_whatsapp_links WHERE user_id=p_user_id) THEN
    RETURN jsonb_build_object('acquired',false,'epoch',NULL);
  END IF;
  RETURN public.fn_admit_whatsapp_identity_locked(v_identity,v_sender,p_lease_id,p_lease_seconds);
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_require_whatsapp_event(p_event_id TEXT,p_token UUID,p_epoch BIGINT,p_require_scope BOOLEAN)
RETURNS public.tb_whatsapp_event_receipts LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public.tb_whatsapp_event_receipts; a UUID; gate public.tb_whatsapp_admission_gate;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(18443,43);
  SELECT * INTO gate FROM public.tb_whatsapp_admission_gate WHERE singleton=TRUE;
  SELECT * INTO r FROM public.tb_whatsapp_event_receipts WHERE external_event_id=p_event_id;
  IF NOT FOUND OR p_token IS NULL OR p_epoch IS NULL OR p_require_scope IS NULL
     OR r.event_token IS DISTINCT FROM p_token OR r.event_epoch IS DISTINCT FROM p_epoch
     OR r.event_expires_at IS NULL OR r.event_expires_at<=pg_catalog.clock_timestamp()
     OR r.processing_state NOT IN ('RESERVED','RUNNING')
     OR (gate.mode='OPEN' AND r.admission_generation IS DISTINCT FROM gate.generation)
     OR (gate.mode='DRAINING' AND r.admission_generation IS DISTINCT FROM gate.draining_generation)
     OR (gate.mode='DRAINING' AND r.processing_state<>'RUNNING')
     OR gate.mode='LINK_ONLY' THEN
    RAISE EXCEPTION 'WhatsApp event is no longer current' USING ERRCODE='40001';
  END IF;
  IF NOT public.fn_whatsapp_lease_authorized(r.user_id,r.context_lease_id,r.context_epoch) THEN
    RAISE EXCEPTION 'WhatsApp event authorization is unavailable' USING ERRCODE='40001';
  END IF;
  IF p_require_scope THEN
    IF r.processing_state<>'RUNNING' OR r.household_id IS NULL OR r.actor_member_id IS NULL THEN
      RAISE EXCEPTION 'WhatsApp event scope is unavailable' USING ERRCODE='40001';
    END IF;
    SELECT auth_user_id INTO a FROM public.tb_users WHERE id=r.user_id;
    PERFORM 1 FROM auth.users WHERE id=a FOR SHARE NOWAIT;
    PERFORM 1 FROM public.tb_households WHERE id=r.household_id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.tb_users WHERE id=r.user_id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.tb_household_members WHERE id=r.actor_member_id AND household_id=r.household_id FOR SHARE NOWAIT;
    PERFORM public.fn_require_whatsapp_active_context(r.user_id,r.context_lease_id,r.context_epoch,r.household_id,r.actor_member_id);
  END IF;
  SELECT * INTO r FROM public.tb_whatsapp_event_receipts WHERE external_event_id=p_event_id FOR UPDATE;
  IF r.event_expires_at<=pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'WhatsApp event is no longer current' USING ERRCODE='40001';
  END IF;
  RETURN r;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_renew_whatsapp_event(p_event_id TEXT,p_token UUID,p_epoch BIGINT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE gate public.tb_whatsapp_admission_gate; r public.tb_whatsapp_event_receipts;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(18443,43);
  SELECT * INTO gate FROM public.tb_whatsapp_admission_gate WHERE singleton=TRUE;
  IF gate.mode<>'OPEN' THEN RETURN false; END IF;
  r:=public.fn_require_whatsapp_event(p_event_id,p_token,p_epoch,false);
  IF NOT public.fn_renew_whatsapp_context_lease(r.user_id,r.context_lease_id,r.context_epoch,120) THEN RETURN false; END IF;
  UPDATE public.tb_whatsapp_event_receipts SET event_expires_at=pg_catalog.clock_timestamp()+interval '120 seconds',
    updated_at=pg_catalog.clock_timestamp() WHERE external_event_id=p_event_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_claim_whatsapp_event(p_event_id TEXT,p_sender TEXT,p_phone_number_id TEXT,p_message_digest TEXT,p_new_token UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE f TEXT; r public.tb_whatsapp_event_receipts; admission JSONB; identity_now JSONB; selection_now JSONB; lease UUID; inserted TEXT; gate public.tb_whatsapp_admission_gate;
BEGIN
  f:=public.fn_whatsapp_event_fingerprint(p_event_id,p_sender,p_phone_number_id,p_message_digest);
  IF p_new_token IS NULL THEN RAISE EXCEPTION 'Invalid WhatsApp event token' USING ERRCODE='22023'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(18443,43);
  SELECT * INTO gate FROM public.tb_whatsapp_admission_gate WHERE singleton=TRUE FOR SHARE;
  SELECT * INTO r FROM public.tb_whatsapp_event_receipts WHERE external_event_id=p_event_id FOR UPDATE;
  IF FOUND THEN
    IF r.request_digest<>f THEN RETURN jsonb_build_object('status','CONFLICT'); END IF;
    IF r.processing_state='PAUSED' THEN RETURN jsonb_build_object('status','PAUSED'); END IF;
    IF gate.mode='LINK_ONLY' AND r.event_kind='MESSAGE' THEN RETURN jsonb_build_object('status','PAUSED'); END IF;
    IF r.processing_state='RESERVED' AND gate.mode<>'OPEN' THEN
      UPDATE public.tb_whatsapp_event_receipts SET processing_state='PAUSED',event_token=NULL,event_expires_at=NULL,updated_at=pg_catalog.clock_timestamp()
        WHERE external_event_id=p_event_id RETURNING * INTO r;
      IF r.user_id IS NOT NULL AND r.context_lease_id IS NOT NULL THEN
        UPDATE public.tb_whatsapp_user_contexts SET processing_lease_id=NULL,processing_expires_at=NULL,
          processing_epoch=processing_epoch+1,processing_admission_generation=NULL,updated_at=pg_catalog.clock_timestamp()
        WHERE user_id=r.user_id AND processing_lease_id=r.context_lease_id AND processing_epoch=r.context_epoch;
      END IF;
      RETURN jsonb_build_object('status','PAUSED');
    END IF;
    IF r.processing_state='RUNNING' AND r.event_expires_at<=pg_catalog.clock_timestamp() THEN
      UPDATE public.tb_whatsapp_event_receipts SET processing_state=CASE WHEN business_result IS NULL THEN 'UNCERTAIN' ELSE 'COMPLETED' END,
        updated_at=pg_catalog.clock_timestamp() WHERE external_event_id=p_event_id RETURNING * INTO r;
    END IF;
    IF r.processing_state='UNCERTAIN' THEN RETURN jsonb_build_object('status','UNCERTAIN'); END IF;
    IF r.delivery_state='UNKNOWN' THEN RETURN jsonb_build_object('status','UNKNOWN'); END IF;
    IF r.processing_state='COMPLETED' THEN
      RETURN jsonb_build_object('status',CASE WHEN r.delivery_state IN ('READY','RETRYABLE','SENDING') AND gate.mode<>'LINK_ONLY' THEN 'READY' ELSE 'DUPLICATE' END);
    END IF;
    IF r.processing_state<>'RESERVED' OR r.event_expires_at>pg_catalog.clock_timestamp() THEN RETURN jsonb_build_object('status','BUSY'); END IF;
  ELSIF EXISTS(SELECT 1 FROM public.tb_processed_whatsapp_events WHERE external_event_id=p_event_id) THEN
    RETURN jsonb_build_object('status','HISTORICAL');
  ELSIF gate.mode<>'OPEN' THEN
    INSERT INTO public.tb_processed_whatsapp_events(external_event_id) VALUES(p_event_id) ON CONFLICT DO NOTHING RETURNING external_event_id INTO inserted;
    IF inserted IS NULL THEN RETURN jsonb_build_object('status','HISTORICAL'); END IF;
    INSERT INTO public.tb_whatsapp_event_receipts(external_event_id,request_digest,event_kind,processing_state,delivery_state,admission_generation)
    VALUES(p_event_id,f,'MESSAGE','PAUSED','NONE',gate.generation);
    RETURN jsonb_build_object('status','PAUSED');
  END IF;
  identity_now:=public.fn_resolve_whatsapp_identity_locked(p_sender);
  IF identity_now IS NULL OR (r.identity_snapshot IS NOT NULL AND r.identity_snapshot IS DISTINCT FROM identity_now) THEN
    RETURN jsonb_build_object('status','UNAVAILABLE');
  END IF;
  IF r.external_event_id IS NOT NULL THEN
    SELECT jsonb_build_array(selected_household_id,selected_member_id,menu_household_ids,menu_phone_number_id,extract(epoch FROM menu_expires_at))
      INTO selection_now FROM public.tb_whatsapp_user_contexts WHERE user_id=r.user_id FOR SHARE;
    IF r.admission_selection IS DISTINCT FROM selection_now THEN
      UPDATE public.tb_whatsapp_event_receipts SET processing_state='UNCERTAIN',updated_at=pg_catalog.clock_timestamp() WHERE external_event_id=p_event_id;
      RETURN jsonb_build_object('status','UNCERTAIN');
    END IF;
  END IF;
  lease:=pg_catalog.gen_random_uuid();
  admission:=public.fn_admit_whatsapp_identity_locked(identity_now,p_sender,lease,120);
  IF admission->>'status'<>'ADMITTED' THEN RETURN jsonb_build_object('status',admission->>'status'); END IF;
  IF r.external_event_id IS NULL THEN
    INSERT INTO public.tb_processed_whatsapp_events(external_event_id) VALUES(p_event_id) ON CONFLICT DO NOTHING RETURNING external_event_id INTO inserted;
    IF inserted IS NULL THEN
      IF NOT public.fn_release_whatsapp_context_lease((identity_now->>'userId')::uuid,lease,(admission->>'epoch')::bigint) THEN
        RAISE EXCEPTION 'Unable to release historical WhatsApp context lease' USING ERRCODE='40001';
      END IF;
      RETURN jsonb_build_object('status','HISTORICAL');
    END IF;
    SELECT jsonb_build_array(selected_household_id,selected_member_id,menu_household_ids,menu_phone_number_id,extract(epoch FROM menu_expires_at))
      INTO selection_now FROM public.tb_whatsapp_user_contexts WHERE user_id=(identity_now->>'userId')::uuid;
    INSERT INTO public.tb_whatsapp_event_receipts(external_event_id,request_digest,event_kind,processing_state,identity_snapshot,admission_selection,
      user_id,context_lease_id,context_epoch,event_token,event_expires_at,admission_generation)
    VALUES(p_event_id,f,'MESSAGE','RESERVED',identity_now,selection_now,(identity_now->>'userId')::uuid,lease,
      (admission->>'epoch')::bigint,p_new_token,pg_catalog.clock_timestamp()+interval '120 seconds',gate.generation) RETURNING * INTO r;
  ELSE
    UPDATE public.tb_whatsapp_event_receipts SET event_token=p_new_token,event_epoch=event_epoch+1,event_expires_at=pg_catalog.clock_timestamp()+interval '120 seconds',
      context_lease_id=lease,context_epoch=(admission->>'epoch')::bigint,updated_at=pg_catalog.clock_timestamp()
      WHERE external_event_id=p_event_id RETURNING * INTO r;
  END IF;
  RETURN jsonb_build_object('status','CLAIMED','epoch',r.event_epoch,'userId',r.user_id,'leaseId',lease,'contextEpoch',r.context_epoch);
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_begin_whatsapp_event(p_event_id TEXT,p_token UUID,p_epoch BIGINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public.tb_whatsapp_event_receipts;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(18443,43);
  SELECT * INTO r FROM public.tb_whatsapp_event_receipts WHERE external_event_id=p_event_id FOR UPDATE;
  IF FOUND AND r.processing_state='PAUSED' THEN RETURN jsonb_build_object('status','PAUSED'); END IF;
  r:=public.fn_require_whatsapp_event(p_event_id,p_token,p_epoch,false);
  IF r.processing_state='RUNNING' THEN RETURN jsonb_build_object('status','ALREADY_STARTED'); END IF;
  UPDATE public.tb_whatsapp_event_receipts SET processing_state='RUNNING',updated_at=pg_catalog.clock_timestamp() WHERE external_event_id=p_event_id;
  RETURN jsonb_build_object('status','STARTED');
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_complete_whatsapp_link_event(p_event_id TEXT,p_sender TEXT,p_phone_number_id TEXT,p_message_digest TEXT,p_challenge_id UUID,p_code_digest TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE f TEXT; r public.tb_whatsapp_event_receipts; outcome JSONB; gate public.tb_whatsapp_admission_gate;
BEGIN
  f:=public.fn_whatsapp_event_fingerprint(p_event_id,p_sender,p_phone_number_id,p_message_digest);
  PERFORM pg_catalog.pg_advisory_xact_lock(18443,43);
  SELECT * INTO gate FROM public.tb_whatsapp_admission_gate WHERE singleton=TRUE FOR SHARE;
  SELECT * INTO r FROM public.tb_whatsapp_event_receipts WHERE external_event_id=p_event_id FOR UPDATE;
  IF FOUND THEN
    IF r.request_digest<>f OR r.event_kind<>'LINK_CONTROL' THEN RETURN jsonb_build_object('status','CONFLICT'); END IF;
    RETURN jsonb_build_object('status',CASE WHEN r.delivery_state IN ('READY','RETRYABLE','SENDING') THEN 'READY' ELSE 'DUPLICATE' END);
  END IF;
  IF EXISTS(SELECT 1 FROM public.tb_processed_whatsapp_events WHERE external_event_id=p_event_id) THEN RETURN jsonb_build_object('status','HISTORICAL'); END IF;
  IF gate.mode='DRAINING' THEN RETURN jsonb_build_object('status','PAUSED'); END IF;
  IF p_challenge_id IS NULL OR p_code_digest IS NULL THEN
    INSERT INTO public.tb_processed_whatsapp_events(external_event_id) VALUES(p_event_id);
    outcome:=jsonb_build_object('status','INVALID');
  ELSE
    outcome:=public.fn_complete_whatsapp_link_challenge(p_challenge_id,p_sender,p_code_digest,p_event_id);
  END IF;
  INSERT INTO public.tb_whatsapp_event_receipts(external_event_id,request_digest,event_kind,processing_state,delivery_state,business_result,
    reply_template,reply_text,reply_guard,reply_expires_at,admission_generation)
  VALUES(p_event_id,f,'LINK_CONTROL','COMPLETED','READY',jsonb_build_object('status',outcome->>'status'),
    'LINK_CONTROL_V1','Solicitud de vinculación procesada. Consulta el estado en la aplicación.','{}',
    pg_catalog.clock_timestamp()+interval '72 hours',gate.generation);
  RETURN jsonb_build_object('status','READY');
END;
$$;

CREATE FUNCTION public.fn_whatsapp_admission_counts()
RETURNS JSONB LANGUAGE SQL SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object(
    'reserved',count(*) FILTER (WHERE processing_state='RESERVED'),
    'running',count(*) FILTER (WHERE processing_state='RUNNING'),
    'uncertain',count(*) FILTER (WHERE processing_state='UNCERTAIN'),
    'ready',count(*) FILTER (WHERE delivery_state='READY'),
    'retryable',count(*) FILTER (WHERE delivery_state='RETRYABLE'),
    'sending',count(*) FILTER (WHERE delivery_state='SENDING'),
    'unknown',count(*) FILTER (WHERE delivery_state='UNKNOWN'),
    'leases_active',(SELECT count(*) FROM public.tb_whatsapp_user_contexts WHERE processing_lease_id IS NOT NULL AND processing_expires_at>pg_catalog.clock_timestamp()),
    'leases_expired',(SELECT count(*) FROM public.tb_whatsapp_user_contexts WHERE processing_lease_id IS NOT NULL AND (processing_expires_at IS NULL OR processing_expires_at<=pg_catalog.clock_timestamp())),
    'legacy_unreceipted',(SELECT count(*) FROM public.tb_processed_whatsapp_events e
       CROSS JOIN public.tb_whatsapp_admission_gate g
       WHERE g.singleton=TRUE AND g.mode='DRAINING'
         AND e.processed_at>=g.drain_started_at
         AND NOT EXISTS(SELECT 1 FROM public.tb_whatsapp_event_receipts r WHERE r.external_event_id=e.external_event_id))
  )
  FROM public.tb_whatsapp_event_receipts;
$$;

CREATE FUNCTION public.fn_get_whatsapp_admission_status()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE gate public.tb_whatsapp_admission_gate; counts JSONB;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(18443,43);
  SELECT * INTO gate FROM public.tb_whatsapp_admission_gate WHERE singleton=TRUE;
  counts:=public.fn_whatsapp_admission_counts();
  RETURN jsonb_build_object('mode',gate.mode,'generation',gate.generation,'drainingGeneration',gate.draining_generation,
    'drainStartedAt',gate.drain_started_at,'databaseBlockers',counts,
    'databaseClear',COALESCE((counts->>'reserved')::bigint,0)+(counts->>'running')::bigint+(counts->>'uncertain')::bigint+
      (counts->>'ready')::bigint+(counts->>'retryable')::bigint+(counts->>'sending')::bigint+(counts->>'unknown')::bigint+
      (counts->>'leases_active')::bigint+(counts->>'leases_expired')::bigint+(counts->>'legacy_unreceipted')::bigint=0,
    'externalInvocationVerificationRequired',true);
END;
$$;

CREATE FUNCTION public.fn_start_whatsapp_drain()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE gate public.tb_whatsapp_admission_gate; r RECORD; counts JSONB;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(18443,43);
  SELECT * INTO gate FROM public.tb_whatsapp_admission_gate WHERE singleton=TRUE FOR UPDATE;
  IF gate.mode='DRAINING' THEN RETURN public.fn_get_whatsapp_admission_status(); END IF;
  IF gate.mode<>'OPEN' THEN RETURN jsonb_build_object('status','NOT_OPEN','mode',gate.mode); END IF;
  UPDATE public.tb_whatsapp_admission_gate SET mode='DRAINING',draining_generation=generation,
    generation=generation+1,drain_started_at=pg_catalog.clock_timestamp(),updated_at=pg_catalog.clock_timestamp()
  WHERE singleton=TRUE;
  FOR r IN UPDATE public.tb_whatsapp_event_receipts SET processing_state='PAUSED',event_token=NULL,event_expires_at=NULL,
      updated_at=pg_catalog.clock_timestamp()
    WHERE event_kind='MESSAGE' AND processing_state='RESERVED'
    RETURNING user_id,context_lease_id,context_epoch
  LOOP
    IF r.user_id IS NOT NULL AND r.context_lease_id IS NOT NULL AND r.context_epoch IS NOT NULL THEN
      UPDATE public.tb_whatsapp_user_contexts SET processing_lease_id=NULL,processing_expires_at=NULL,
        processing_epoch=processing_epoch+1,processing_admission_generation=NULL,updated_at=pg_catalog.clock_timestamp()
      WHERE user_id=r.user_id AND processing_lease_id=r.context_lease_id AND processing_epoch=r.context_epoch;
    END IF;
  END LOOP;
  counts:=public.fn_whatsapp_admission_counts();
  RETURN jsonb_build_object('status','DRAINING','mode','DRAINING','databaseBlockers',counts,
    'externalInvocationVerificationRequired',true);
END;
$$;

CREATE FUNCTION public.fn_reap_whatsapp_drain()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE gate public.tb_whatsapp_admission_gate; r RECORD; expired_running INTEGER:=0; expired_sending INTEGER:=0; expired_leases INTEGER:=0;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(18443,43);
  SELECT * INTO gate FROM public.tb_whatsapp_admission_gate WHERE singleton=TRUE FOR UPDATE;
  IF gate.mode<>'DRAINING' THEN RETURN jsonb_build_object('status','NOT_DRAINING'); END IF;
  UPDATE public.tb_whatsapp_event_receipts SET processing_state='PAUSED',event_token=NULL,event_expires_at=NULL,
    updated_at=pg_catalog.clock_timestamp()
  WHERE processing_state='RESERVED' AND event_expires_at<=pg_catalog.clock_timestamp();
  FOR r IN UPDATE public.tb_whatsapp_event_receipts SET
      processing_state=CASE WHEN business_result IS NULL THEN 'UNCERTAIN' ELSE 'COMPLETED' END,
      delivery_state=CASE WHEN business_result IS NULL THEN 'NONE'
        WHEN reply_text IS NOT NULL AND reply_expires_at>pg_catalog.clock_timestamp() THEN 'READY' ELSE 'EXPIRED' END,
      event_token=NULL,event_expires_at=NULL,updated_at=pg_catalog.clock_timestamp()
    WHERE processing_state='RUNNING' AND event_expires_at<=pg_catalog.clock_timestamp()
    RETURNING user_id,context_lease_id,context_epoch
  LOOP
    expired_running:=expired_running+1;
    IF r.user_id IS NOT NULL AND r.context_lease_id IS NOT NULL AND r.context_epoch IS NOT NULL THEN
      UPDATE public.tb_whatsapp_user_contexts SET processing_lease_id=NULL,processing_expires_at=NULL,
        processing_epoch=processing_epoch+1,processing_admission_generation=NULL,updated_at=pg_catalog.clock_timestamp()
      WHERE user_id=r.user_id AND processing_lease_id=r.context_lease_id AND processing_epoch=r.context_epoch;
    END IF;
  END LOOP;
  FOR r IN UPDATE public.tb_whatsapp_event_receipts SET delivery_state='UNKNOWN',delivery_token=NULL,delivery_expires_at=NULL,
      updated_at=pg_catalog.clock_timestamp()
    WHERE delivery_state='SENDING' AND delivery_expires_at<=pg_catalog.clock_timestamp()
    RETURNING user_id,context_lease_id,context_epoch
  LOOP
    expired_sending:=expired_sending+1;
    IF r.user_id IS NOT NULL AND r.context_lease_id IS NOT NULL AND r.context_epoch IS NOT NULL THEN
      UPDATE public.tb_whatsapp_user_contexts SET processing_lease_id=NULL,processing_expires_at=NULL,
        processing_epoch=processing_epoch+1,processing_admission_generation=NULL,updated_at=pg_catalog.clock_timestamp()
      WHERE user_id=r.user_id AND processing_lease_id=r.context_lease_id AND processing_epoch=r.context_epoch;
    END IF;
  END LOOP;
  UPDATE public.tb_whatsapp_user_contexts SET processing_lease_id=NULL,processing_expires_at=NULL,
    processing_epoch=processing_epoch+1,processing_admission_generation=NULL,updated_at=pg_catalog.clock_timestamp()
  WHERE processing_lease_id IS NOT NULL AND (processing_expires_at IS NULL OR processing_expires_at<=pg_catalog.clock_timestamp());
  GET DIAGNOSTICS expired_leases=ROW_COUNT;
  RETURN jsonb_build_object('status','REAPED','runningToUncertainOrCompleted',expired_running,
    'sendingToUnknown',expired_sending,'expiredLeasesFenced',expired_leases,
    'databaseBlockers',public.fn_whatsapp_admission_counts());
END;
$$;

CREATE FUNCTION public.fn_enter_whatsapp_link_only()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE gate public.tb_whatsapp_admission_gate; counts JSONB; blockers BIGINT;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(18443,43);
  SELECT * INTO gate FROM public.tb_whatsapp_admission_gate WHERE singleton=TRUE FOR UPDATE;
  IF gate.mode<>'DRAINING' THEN RETURN jsonb_build_object('status','NOT_DRAINING','mode',gate.mode); END IF;
  counts:=public.fn_whatsapp_admission_counts();
  blockers:=COALESCE((counts->>'reserved')::bigint,0)+(counts->>'running')::bigint+(counts->>'uncertain')::bigint+
    (counts->>'ready')::bigint+(counts->>'retryable')::bigint+(counts->>'sending')::bigint+(counts->>'unknown')::bigint+
    (counts->>'leases_active')::bigint+(counts->>'leases_expired')::bigint+(counts->>'legacy_unreceipted')::bigint;
  IF blockers>0 THEN RETURN jsonb_build_object('status','BLOCKED','databaseBlockers',counts,'externalInvocationVerificationRequired',true); END IF;
  UPDATE public.tb_whatsapp_admission_gate SET mode='LINK_ONLY',generation=generation+1,
    draining_generation=NULL,drain_started_at=NULL,updated_at=pg_catalog.clock_timestamp() WHERE singleton=TRUE;
  RETURN jsonb_build_object('status','LINK_ONLY','databaseBlockers',counts,'externalInvocationVerificationRequired',true);
END;
$$;

CREATE FUNCTION public.fn_resume_whatsapp_admissions()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE gate public.tb_whatsapp_admission_gate;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(18443,43);
  SELECT * INTO gate FROM public.tb_whatsapp_admission_gate WHERE singleton=TRUE FOR UPDATE;
  IF gate.mode='OPEN' THEN RETURN jsonb_build_object('status','OPEN','generation',gate.generation); END IF;
  IF gate.mode='DRAINING' THEN
    -- Keep the generation increment performed when draining began. Reopening
    -- never reuses the generation of the closed admission window.
    UPDATE public.tb_whatsapp_admission_gate SET mode='OPEN',generation=generation,
      draining_generation=NULL,drain_started_at=NULL,updated_at=pg_catalog.clock_timestamp() WHERE singleton=TRUE;
  ELSE
    UPDATE public.tb_whatsapp_admission_gate SET mode='OPEN',generation=generation+1,
      draining_generation=NULL,drain_started_at=NULL,updated_at=pg_catalog.clock_timestamp() WHERE singleton=TRUE;
  END IF;
  SELECT * INTO gate FROM public.tb_whatsapp_admission_gate WHERE singleton=TRUE;
  RETURN jsonb_build_object('status','OPEN','generation',gate.generation);
END;
$$;

-- Administrative controls stay owner-only. Runtime receives no gate-table access.
DO $$
DECLARE f RECORD;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS signature
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('fn_whatsapp_admission_counts','fn_get_whatsapp_admission_status',
      'fn_start_whatsapp_drain','fn_reap_whatsapp_drain','fn_enter_whatsapp_link_only','fn_resume_whatsapp_admissions')
  LOOP
    EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO postgres',f.signature);
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.signature);
  END LOOP;
END;
$$;

-- The old webhook reserved IDs with direct service_role INSERT. New receipts use
-- SECURITY DEFINER entry points; removing this bypass stops old runtimes before
-- they can invoke the agent after the drain begins.
REVOKE INSERT ON public.tb_processed_whatsapp_events FROM service_role;

COMMIT;
