BEGIN;

-- Complementary ledger. Historical reservations are never reconstructed.
CREATE TABLE public.tb_whatsapp_event_receipts (
  external_event_id TEXT PRIMARY KEY REFERENCES public.tb_processed_whatsapp_events(external_event_id) ON DELETE RESTRICT,
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  event_kind TEXT NOT NULL CHECK (event_kind IN ('MESSAGE','LINK_CONTROL')),
  processing_state TEXT NOT NULL CHECK (processing_state IN ('RESERVED','RUNNING','COMPLETED','UNCERTAIN','HISTORICAL')),
  delivery_state TEXT NOT NULL DEFAULT 'NONE' CHECK (delivery_state IN ('NONE','READY','SENDING','RETRYABLE','ACCEPTED','UNKNOWN','BLOCKED','EXPIRED')),
  identity_snapshot JSONB,
  admission_selection JSONB,
  user_id UUID REFERENCES public.tb_users(id) ON DELETE RESTRICT,
  context_lease_id UUID,
  context_epoch BIGINT,
  household_id UUID,
  actor_member_id UUID,
  conversation_digest TEXT,
  event_token UUID,
  event_epoch BIGINT NOT NULL DEFAULT 1 CHECK (event_epoch BETWEEN 1 AND 9007199254740991),
  event_expires_at TIMESTAMPTZ,
  business_result JSONB,
  operation_digest TEXT,
  artifacts JSONB NOT NULL DEFAULT '{}'::jsonb,
  reply_template TEXT,
  reply_text TEXT CHECK (octet_length(reply_text) <= 32768),
  reply_guard JSONB,
  reply_expires_at TIMESTAMPTZ,
  delivery_token UUID,
  delivery_epoch BIGINT NOT NULL DEFAULT 0 CHECK (delivery_epoch BETWEEN 0 AND 9007199254740991),
  delivery_expires_at TIMESTAMPTZ,
  delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  http_status INTEGER CHECK (http_status BETWEEN 100 AND 599),
  provider_code BIGINT CHECK (provider_code BETWEEN 0 AND 9007199254740991),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  tombstoned_at TIMESTAMPTZ,
  CHECK ((household_id IS NULL) = (actor_member_id IS NULL)),
  CHECK ((context_lease_id IS NULL) = (context_epoch IS NULL)),
  CHECK ((event_token IS NULL) = (event_expires_at IS NULL)),
  CHECK ((delivery_token IS NULL) = (delivery_expires_at IS NULL)),
  CHECK (processing_state <> 'RESERVED' OR event_token IS NOT NULL),
  CHECK (delivery_state <> 'SENDING' OR delivery_token IS NOT NULL)
);
CREATE INDEX ix_whatsapp_receipt_retention ON public.tb_whatsapp_event_receipts(created_at);
ALTER TABLE public.tb_whatsapp_event_receipts OWNER TO postgres;
ALTER TABLE public.tb_whatsapp_event_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tb_whatsapp_event_receipts FROM PUBLIC,service_role;

CREATE FUNCTION public.fn_whatsapp_event_fingerprint(p_event_id TEXT,p_sender TEXT,p_phone_number_id TEXT,p_message_digest TEXT)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF p_event_id IS NULL OR length(p_event_id) NOT BETWEEN 1 AND 512
     OR p_sender IS NULL OR p_sender !~ '^[1-9][0-9]{7,14}$'
     OR p_phone_number_id IS NULL OR p_phone_number_id !~ '^[0-9]{1,32}$'
     OR p_message_digest IS NULL OR p_message_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid WhatsApp event' USING ERRCODE='22023';
  END IF;
  RETURN encode(sha256(convert_to(jsonb_build_array(p_event_id,p_sender,p_phone_number_id,p_message_digest)::text,'UTF8')),'hex');
END;
$$;

-- Gate -> current identity/context -> receipt -> NOWAIT business prelocks.
-- The gate is transaction-scoped and is never held over HTTP or OpenAI.
CREATE FUNCTION public.fn_require_whatsapp_event(p_event_id TEXT,p_token UUID,p_epoch BIGINT,p_require_scope BOOLEAN)
RETURNS public.tb_whatsapp_event_receipts LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public.tb_whatsapp_event_receipts; a UUID;
BEGIN
  PERFORM pg_advisory_xact_lock(18443,43);
  SELECT * INTO r FROM public.tb_whatsapp_event_receipts WHERE external_event_id=p_event_id;
  IF NOT FOUND OR p_token IS NULL OR p_epoch IS NULL OR p_require_scope IS NULL
     OR r.event_token IS DISTINCT FROM p_token OR r.event_epoch IS DISTINCT FROM p_epoch
     OR r.event_expires_at IS NULL OR r.event_expires_at<=clock_timestamp()
     OR r.processing_state NOT IN ('RESERVED','RUNNING') THEN
    RAISE EXCEPTION 'WhatsApp event is no longer current' USING ERRCODE='40001';
  END IF;
  IF NOT public.fn_whatsapp_lease_authorized(r.user_id,r.context_lease_id,r.context_epoch) THEN
    RAISE EXCEPTION 'WhatsApp event authorization is unavailable' USING ERRCODE='40001';
  END IF;
  IF p_require_scope THEN
    IF r.processing_state <> 'RUNNING' OR r.household_id IS NULL OR r.actor_member_id IS NULL THEN
      RAISE EXCEPTION 'WhatsApp event scope is unavailable' USING ERRCODE='40001';
    END IF;
    SELECT auth_user_id INTO a FROM public.tb_users WHERE id=r.user_id;
    -- Avoid inversions with Web invitation/lifecycle transactions. A conflict
    -- aborts this transaction; callers must not retry a RUNNING agent.
    PERFORM 1 FROM auth.users WHERE id=a FOR SHARE NOWAIT;
    PERFORM 1 FROM public.tb_households WHERE id=r.household_id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.tb_users WHERE id=r.user_id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.tb_household_members WHERE id=r.actor_member_id AND household_id=r.household_id FOR SHARE NOWAIT;
    PERFORM public.fn_require_whatsapp_active_context(r.user_id,r.context_lease_id,r.context_epoch,r.household_id,r.actor_member_id);
  END IF;
  SELECT * INTO r FROM public.tb_whatsapp_event_receipts WHERE external_event_id=p_event_id FOR UPDATE;
  IF r.event_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'WhatsApp event is no longer current' USING ERRCODE='40001';
  END IF;
  RETURN r;
END;
$$;

CREATE FUNCTION public.fn_claim_whatsapp_event(p_event_id TEXT,p_sender TEXT,p_phone_number_id TEXT,p_message_digest TEXT,p_new_token UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE f TEXT; r public.tb_whatsapp_event_receipts; admission JSONB; identity_now JSONB; selection_now JSONB; lease UUID; inserted TEXT;
BEGIN
  f:=public.fn_whatsapp_event_fingerprint(p_event_id,p_sender,p_phone_number_id,p_message_digest);
  IF p_new_token IS NULL THEN RAISE EXCEPTION 'Invalid WhatsApp event token' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(18443,43);
  SELECT * INTO r FROM public.tb_whatsapp_event_receipts WHERE external_event_id=p_event_id FOR UPDATE;
  IF FOUND THEN
    IF r.request_digest<>f THEN RETURN jsonb_build_object('status','CONFLICT'); END IF;
    IF r.processing_state='RUNNING' AND r.event_expires_at<=clock_timestamp() THEN
      UPDATE public.tb_whatsapp_event_receipts SET processing_state=CASE WHEN business_result IS NULL THEN 'UNCERTAIN' ELSE 'COMPLETED' END,
        updated_at=clock_timestamp() WHERE external_event_id=p_event_id RETURNING * INTO r;
    END IF;
    IF r.processing_state='UNCERTAIN' THEN RETURN jsonb_build_object('status','UNCERTAIN'); END IF;
    IF r.delivery_state='UNKNOWN' THEN RETURN jsonb_build_object('status','UNKNOWN'); END IF;
    IF r.processing_state='COMPLETED' THEN
      RETURN jsonb_build_object('status',CASE WHEN r.delivery_state IN ('READY','RETRYABLE','SENDING') THEN 'READY' ELSE 'DUPLICATE' END);
    END IF;
    IF r.processing_state<>'RESERVED' OR r.event_expires_at>clock_timestamp() THEN RETURN jsonb_build_object('status','BUSY'); END IF;
  ELSIF EXISTS(SELECT 1 FROM public.tb_processed_whatsapp_events WHERE external_event_id=p_event_id) THEN
    RETURN jsonb_build_object('status','HISTORICAL');
  END IF;
  identity_now:=public.fn_resolve_whatsapp_identity_locked(p_sender);
  IF identity_now IS NULL OR (r.identity_snapshot IS NOT NULL AND r.identity_snapshot IS DISTINCT FROM identity_now) THEN
    RETURN jsonb_build_object('status','UNAVAILABLE');
  END IF;
  IF r.external_event_id IS NOT NULL THEN
    SELECT jsonb_build_array(selected_household_id,selected_member_id,menu_household_ids,menu_phone_number_id,extract(epoch FROM menu_expires_at))
      INTO selection_now FROM public.tb_whatsapp_user_contexts WHERE user_id=r.user_id FOR SHARE;
    IF r.admission_selection IS DISTINCT FROM selection_now THEN
      UPDATE public.tb_whatsapp_event_receipts SET processing_state='UNCERTAIN',updated_at=clock_timestamp() WHERE external_event_id=p_event_id;
      RETURN jsonb_build_object('status','UNCERTAIN');
    END IF;
  END IF;
  lease:=gen_random_uuid();
  admission:=public.fn_admit_whatsapp_identity_locked(identity_now,p_sender,lease,120);
  IF admission->>'status'<>'ADMITTED' THEN RETURN jsonb_build_object('status',admission->>'status'); END IF;
  IF r.external_event_id IS NULL THEN
    INSERT INTO public.tb_processed_whatsapp_events(external_event_id) VALUES(p_event_id) ON CONFLICT DO NOTHING RETURNING external_event_id INTO inserted;
    IF inserted IS NULL THEN
      -- A pre-receipt runtime may reserve this ID without taking our gate.
      -- Release only the lease this claim just acquired; if the fence no longer
      -- matches, abort so the lease acquisition rolls back with this transaction.
      IF NOT public.fn_release_whatsapp_context_lease(
        (identity_now->>'userId')::uuid,
        lease,
        (admission->>'epoch')::bigint
      ) THEN
        RAISE EXCEPTION 'Unable to release historical WhatsApp context lease'
          USING ERRCODE='40001';
      END IF;
      RETURN jsonb_build_object('status','HISTORICAL');
    END IF;
    SELECT jsonb_build_array(selected_household_id,selected_member_id,menu_household_ids,menu_phone_number_id,extract(epoch FROM menu_expires_at))
      INTO selection_now FROM public.tb_whatsapp_user_contexts WHERE user_id=(identity_now->>'userId')::uuid;
    INSERT INTO public.tb_whatsapp_event_receipts(external_event_id,request_digest,event_kind,processing_state,identity_snapshot,admission_selection,user_id,context_lease_id,context_epoch,event_token,event_expires_at)
    VALUES(p_event_id,f,'MESSAGE','RESERVED',identity_now,selection_now,(identity_now->>'userId')::uuid,lease,(admission->>'epoch')::bigint,p_new_token,clock_timestamp()+interval '120 seconds') RETURNING * INTO r;
  ELSE
    UPDATE public.tb_whatsapp_event_receipts SET event_token=p_new_token,event_epoch=event_epoch+1,event_expires_at=clock_timestamp()+interval '120 seconds',
      context_lease_id=lease,context_epoch=(admission->>'epoch')::bigint,updated_at=clock_timestamp()
      WHERE external_event_id=p_event_id RETURNING * INTO r;
  END IF;
  RETURN jsonb_build_object('status','CLAIMED','epoch',r.event_epoch,'userId',r.user_id,'leaseId',lease,'contextEpoch',r.context_epoch);
END;
$$;

CREATE FUNCTION public.fn_begin_whatsapp_event(p_event_id TEXT,p_token UUID,p_epoch BIGINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public.tb_whatsapp_event_receipts;
BEGIN
  r:=public.fn_require_whatsapp_event(p_event_id,p_token,p_epoch,false);
  IF r.processing_state='RUNNING' THEN RETURN jsonb_build_object('status','ALREADY_STARTED'); END IF;
  UPDATE public.tb_whatsapp_event_receipts SET processing_state='RUNNING',updated_at=clock_timestamp() WHERE external_event_id=p_event_id;
  RETURN jsonb_build_object('status','STARTED');
END;
$$;

CREATE FUNCTION public.fn_assert_whatsapp_event(p_event_id TEXT,p_token UUID,p_epoch BIGINT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public.tb_whatsapp_event_receipts;
BEGIN
  r:=public.fn_require_whatsapp_event(p_event_id,p_token,p_epoch,false);
  RETURN r.processing_state='RUNNING';
END;
$$;

CREATE FUNCTION public.fn_bind_whatsapp_event_context(p_event_id TEXT,p_token UUID,p_epoch BIGINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public.tb_whatsapp_event_receipts; c public.tb_whatsapp_user_contexts;
BEGIN
  r:=public.fn_require_whatsapp_event(p_event_id,p_token,p_epoch,false);
  IF r.processing_state<>'RUNNING' THEN RAISE EXCEPTION 'WhatsApp event has not started' USING ERRCODE='40001'; END IF;
  SELECT * INTO c FROM public.tb_whatsapp_user_contexts WHERE user_id=r.user_id;
  IF r.household_id IS NOT NULL AND (r.household_id IS DISTINCT FROM c.selected_household_id OR r.actor_member_id IS DISTINCT FROM c.selected_member_id) THEN
    RAISE EXCEPTION 'WhatsApp event scope changed' USING ERRCODE='40001';
  END IF;
  IF c.selected_household_id IS NULL THEN RAISE EXCEPTION 'WhatsApp event scope is unavailable' USING ERRCODE='40001'; END IF;
  UPDATE public.tb_whatsapp_event_receipts SET household_id=c.selected_household_id,actor_member_id=c.selected_member_id,updated_at=clock_timestamp() WHERE external_event_id=p_event_id;
  r:=public.fn_require_whatsapp_event(p_event_id,p_token,p_epoch,true);
  RETURN jsonb_build_object('status','BOUND','householdId',r.household_id,'actorMemberId',r.actor_member_id);
END;
$$;

CREATE FUNCTION public.fn_renew_whatsapp_event(p_event_id TEXT,p_token UUID,p_epoch BIGINT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public.tb_whatsapp_event_receipts;
BEGIN
  r:=public.fn_require_whatsapp_event(p_event_id,p_token,p_epoch,false);
  IF NOT public.fn_renew_whatsapp_context_lease(r.user_id,r.context_lease_id,r.context_epoch,120) THEN RETURN false; END IF;
  UPDATE public.tb_whatsapp_event_receipts SET event_expires_at=clock_timestamp()+interval '120 seconds',updated_at=clock_timestamp() WHERE external_event_id=p_event_id;
  RETURN true;
END;
$$;

CREATE FUNCTION public.fn_finish_whatsapp_event(p_event_id TEXT,p_token UUID,p_epoch BIGINT,p_reply_template TEXT,p_reply_text TEXT,p_reply_guard JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public.tb_whatsapp_event_receipts; c public.tb_whatsapp_user_contexts; guard JSONB; draft public.tb_agent_category_drafts; proposal public.tb_pending_proposals;
BEGIN
  r:=public.fn_require_whatsapp_event(p_event_id,p_token,p_epoch,false);
  IF r.processing_state<>'RUNNING' OR p_reply_template IS NULL OR p_reply_text IS NULL OR p_reply_guard IS NULL
    OR octet_length(p_reply_text)>32768 OR length(p_reply_template)>64 THEN
    RAISE EXCEPTION 'Invalid WhatsApp result' USING ERRCODE='22023';
  END IF;
  SELECT * INTO c FROM public.tb_whatsapp_user_contexts WHERE user_id=r.user_id;
  -- A generic control reply (for example, no available households) must not
  -- inherit an inactive selection. Bound financial events retain their scope.
  IF r.household_id IS NULL AND NOT EXISTS(SELECT 1 FROM public.tb_household_members
    WHERE id=c.selected_member_id AND household_id=c.selected_household_id AND user_id=r.user_id AND status='ACTIVE') THEN
    c.selected_household_id:=NULL;
    c.selected_member_id:=NULL;
  END IF;
  guard:=p_reply_guard||jsonb_build_object('householdIds',COALESCE((SELECT jsonb_agg(household_id ORDER BY household_id) FROM public.tb_household_members WHERE user_id=r.user_id AND status='ACTIVE'),'[]'::jsonb));
  r.conversation_digest:=COALESCE(r.conversation_digest,p_reply_guard->>'conversationDigest');
  IF c.menu_expires_at IS NOT NULL THEN
    guard:=guard||jsonb_build_object('menuExpiresAt',c.menu_expires_at,'menuHouseholdIds',c.menu_household_ids);
  END IF;
  IF r.household_id IS NOT NULL THEN
    SELECT * INTO draft FROM public.tb_agent_category_drafts WHERE household_id=r.household_id AND actor_member_id=r.actor_member_id AND source='WHATSAPP' AND encode(sha256(convert_to(conversation_key,'UTF8')),'hex')=r.conversation_digest;
    IF FOUND THEN guard:=guard||jsonb_build_object('draftId',draft.id,'draftUpdatedAt',draft.updated_at); END IF;
    SELECT * INTO proposal FROM public.tb_pending_proposals WHERE household_id=r.household_id AND actor_member_id=r.actor_member_id AND source='WHATSAPP' AND status='AWAITING_CONFIRMATION' AND encode(sha256(convert_to(conversation_key,'UTF8')),'hex')=r.conversation_digest;
    IF FOUND THEN guard:=guard||jsonb_build_object('proposalId',proposal.id,'proposalUpdatedAt',proposal.updated_at); END IF;
  END IF;
  -- A transactional financial checkpoint always wins over a later generic error.
  UPDATE public.tb_whatsapp_event_receipts SET processing_state='COMPLETED',delivery_state='READY',
    reply_template=CASE WHEN business_result IS NULL THEN p_reply_template ELSE reply_template END,
    reply_text=CASE WHEN business_result IS NULL THEN p_reply_text ELSE reply_text END,
    reply_guard=CASE WHEN business_result IS NULL THEN guard ELSE reply_guard END,
    household_id=COALESCE(household_id,c.selected_household_id),actor_member_id=COALESCE(actor_member_id,c.selected_member_id),
    reply_expires_at=COALESCE(reply_expires_at,clock_timestamp()+interval '72 hours'),updated_at=clock_timestamp()
    WHERE external_event_id=p_event_id;
  RETURN jsonb_build_object('status','COMPLETED');
END;
$$;

CREATE FUNCTION public.fn_fail_whatsapp_event(p_event_id TEXT,p_token UUID,p_epoch BIGINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public.tb_whatsapp_event_receipts;
BEGIN
  r:=public.fn_require_whatsapp_event(p_event_id,p_token,p_epoch,false);
  UPDATE public.tb_whatsapp_event_receipts SET processing_state=CASE WHEN business_result IS NULL THEN 'UNCERTAIN' ELSE 'COMPLETED' END,
    delivery_state=CASE WHEN business_result IS NULL THEN 'NONE' ELSE 'READY' END,updated_at=clock_timestamp()
    WHERE external_event_id=p_event_id RETURNING * INTO r;
  RETURN jsonb_build_object('status',r.processing_state);
END;
$$;

CREATE FUNCTION public.fn_complete_whatsapp_link_event(p_event_id TEXT,p_sender TEXT,p_phone_number_id TEXT,p_message_digest TEXT,p_challenge_id UUID,p_code_digest TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE f TEXT; r public.tb_whatsapp_event_receipts; outcome JSONB;
BEGIN
  f:=public.fn_whatsapp_event_fingerprint(p_event_id,p_sender,p_phone_number_id,p_message_digest);
  PERFORM pg_advisory_xact_lock(18443,43);
  SELECT * INTO r FROM public.tb_whatsapp_event_receipts WHERE external_event_id=p_event_id FOR UPDATE;
  IF FOUND THEN
    IF r.request_digest<>f OR r.event_kind<>'LINK_CONTROL' THEN RETURN jsonb_build_object('status','CONFLICT'); END IF;
    RETURN jsonb_build_object('status',CASE WHEN r.delivery_state IN ('READY','RETRYABLE','SENDING') THEN 'READY' ELSE 'DUPLICATE' END);
  END IF;
  IF EXISTS(SELECT 1 FROM public.tb_processed_whatsapp_events WHERE external_event_id=p_event_id) THEN RETURN jsonb_build_object('status','HISTORICAL'); END IF;
  IF p_challenge_id IS NULL OR p_code_digest IS NULL THEN
    INSERT INTO public.tb_processed_whatsapp_events(external_event_id) VALUES(p_event_id);
    outcome:=jsonb_build_object('status','INVALID');
  ELSE
    outcome:=public.fn_complete_whatsapp_link_challenge(p_challenge_id,p_sender,p_code_digest,p_event_id);
  END IF;
  -- No code, digest of the code, link ID or account data is copied here.
  INSERT INTO public.tb_whatsapp_event_receipts(external_event_id,request_digest,event_kind,processing_state,delivery_state,business_result,reply_template,reply_text,reply_guard,reply_expires_at)
  VALUES(p_event_id,f,'LINK_CONTROL','COMPLETED','READY',jsonb_build_object('status',outcome->>'status'),
    'LINK_CONTROL_V1','Solicitud de vinculación procesada. Consulta el estado en la aplicación.','{}',clock_timestamp()+interval '72 hours');
  RETURN jsonb_build_object('status','READY');
END;
$$;

CREATE FUNCTION public.fn_prepare_whatsapp_delivery(p_event_id TEXT,p_sender TEXT,p_phone_number_id TEXT,p_message_digest TEXT,p_new_token UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE f TEXT; r public.tb_whatsapp_event_receipts; ident JSONB; admission JSONB; c public.tb_whatsapp_user_contexts; a UUID; lease UUID;
BEGIN
  f:=public.fn_whatsapp_event_fingerprint(p_event_id,p_sender,p_phone_number_id,p_message_digest);
  IF p_new_token IS NULL THEN RAISE EXCEPTION 'Invalid delivery token' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(18443,43);
  SELECT * INTO r FROM public.tb_whatsapp_event_receipts WHERE external_event_id=p_event_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','HISTORICAL'); END IF;
  IF r.request_digest<>f THEN RETURN jsonb_build_object('status','CONFLICT'); END IF;
  IF r.delivery_state='SENDING' THEN
    IF r.delivery_expires_at>clock_timestamp() THEN RETURN jsonb_build_object('status','BUSY'); END IF;
    UPDATE public.tb_whatsapp_event_receipts SET delivery_state='UNKNOWN',updated_at=clock_timestamp() WHERE external_event_id=p_event_id;
    RETURN jsonb_build_object('status','UNKNOWN');
  END IF;
  IF r.delivery_state IN ('ACCEPTED','UNKNOWN','BLOCKED','EXPIRED') THEN RETURN jsonb_build_object('status',r.delivery_state); END IF;
  IF r.processing_state<>'COMPLETED' OR r.delivery_state NOT IN ('READY','RETRYABLE') THEN RETURN jsonb_build_object('status','WAIT'); END IF;
  IF r.reply_text IS NULL OR r.reply_expires_at IS NULL OR r.reply_expires_at<=clock_timestamp() THEN
    UPDATE public.tb_whatsapp_event_receipts SET delivery_state='EXPIRED',reply_text=NULL,reply_guard=NULL,updated_at=clock_timestamp() WHERE external_event_id=p_event_id;
    RETURN jsonb_build_object('status','EXPIRED');
  END IF;
  IF r.event_kind='MESSAGE' THEN
    ident:=public.fn_resolve_whatsapp_identity_locked(p_sender);
    IF ident IS NULL OR r.identity_snapshot IS DISTINCT FROM ident THEN
      UPDATE public.tb_whatsapp_event_receipts SET delivery_state='BLOCKED',reply_text=NULL,updated_at=clock_timestamp() WHERE external_event_id=p_event_id;
      RETURN jsonb_build_object('status','BLOCKED');
    END IF;
    -- NOWAIT prelocks precede the existing membership/eligibility helpers.
    SELECT auth_user_id INTO a FROM public.tb_users WHERE id=r.user_id;
    PERFORM 1 FROM auth.users WHERE id=a FOR SHARE NOWAIT;
    PERFORM 1 FROM public.tb_households WHERE id=r.household_id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.tb_users WHERE id=r.user_id FOR SHARE NOWAIT;
    PERFORM 1 FROM public.tb_household_members WHERE id=r.actor_member_id FOR SHARE NOWAIT;
    SELECT * INTO c FROM public.tb_whatsapp_user_contexts WHERE user_id=r.user_id FOR UPDATE;
    IF r.household_id IS NOT NULL AND (c.selected_household_id IS DISTINCT FROM r.household_id OR c.selected_member_id IS DISTINCT FROM r.actor_member_id
      OR NOT EXISTS(SELECT 1 FROM public.tb_household_members WHERE id=r.actor_member_id AND household_id=r.household_id AND user_id=r.user_id AND status='ACTIVE')) THEN
      UPDATE public.tb_whatsapp_event_receipts SET delivery_state='BLOCKED',reply_text=NULL,updated_at=clock_timestamp() WHERE external_event_id=p_event_id;
      RETURN jsonb_build_object('status','BLOCKED');
    END IF;
    IF COALESCE((r.reply_guard->>'financial')::boolean,false) THEN
      BEGIN
        PERFORM public.fn_require_financial_eligibility(a,r.household_id,r.actor_member_id);
      EXCEPTION WHEN insufficient_privilege THEN
        UPDATE public.tb_whatsapp_event_receipts SET delivery_state='BLOCKED',reply_text=NULL,updated_at=clock_timestamp() WHERE external_event_id=p_event_id;
        RETURN jsonb_build_object('status','BLOCKED');
      END;
    END IF;
    IF r.reply_guard ? 'householdIds' THEN
      PERFORM 1 FROM public.tb_household_members WHERE user_id=r.user_id
        AND household_id IN (SELECT value::uuid FROM jsonb_array_elements_text(r.reply_guard->'householdIds')) FOR SHARE NOWAIT;
    END IF;
    IF r.reply_guard ? 'householdIds' AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(r.reply_guard->'householdIds') h
      WHERE NOT EXISTS(SELECT 1 FROM public.tb_household_members WHERE user_id=r.user_id AND household_id=h.value::uuid AND status='ACTIVE')) THEN
      UPDATE public.tb_whatsapp_event_receipts SET delivery_state='BLOCKED',reply_text=NULL,updated_at=clock_timestamp() WHERE external_event_id=p_event_id;
      RETURN jsonb_build_object('status','BLOCKED');
    END IF;
    IF r.reply_guard ? 'draftId' THEN
      PERFORM 1 FROM public.tb_agent_category_drafts WHERE id=(r.reply_guard->>'draftId')::uuid FOR SHARE NOWAIT;
    END IF;
    IF r.reply_guard ? 'draftId' AND NOT EXISTS(SELECT 1 FROM public.tb_agent_category_drafts
      WHERE id=(r.reply_guard->>'draftId')::uuid AND household_id=r.household_id AND actor_member_id=r.actor_member_id AND source='WHATSAPP'
        AND updated_at=(r.reply_guard->>'draftUpdatedAt')::timestamptz AND updated_at>clock_timestamp()-interval '30 minutes') THEN
      UPDATE public.tb_whatsapp_event_receipts SET delivery_state='EXPIRED',reply_text=NULL,updated_at=clock_timestamp() WHERE external_event_id=p_event_id;
      RETURN jsonb_build_object('status','EXPIRED');
    END IF;
    IF r.reply_guard ? 'menuExpiresAt' AND (c.menu_expires_at IS NULL OR c.menu_expires_at<=clock_timestamp()
      OR c.menu_expires_at IS DISTINCT FROM (r.reply_guard->>'menuExpiresAt')::timestamptz
      OR to_jsonb(c.menu_household_ids) IS DISTINCT FROM r.reply_guard->'menuHouseholdIds') THEN
      UPDATE public.tb_whatsapp_event_receipts SET delivery_state='EXPIRED',reply_text=NULL,updated_at=clock_timestamp() WHERE external_event_id=p_event_id;
      RETURN jsonb_build_object('status','EXPIRED');
    END IF;
    IF r.reply_guard ? 'proposalId' THEN
      PERFORM 1 FROM public.tb_pending_proposals WHERE id=(r.reply_guard->>'proposalId')::uuid FOR SHARE NOWAIT;
    END IF;
    IF r.reply_guard ? 'proposalId' AND NOT EXISTS(SELECT 1 FROM public.tb_pending_proposals
      WHERE id=(r.reply_guard->>'proposalId')::uuid AND household_id=r.household_id AND actor_member_id=r.actor_member_id
        AND source='WHATSAPP' AND status='AWAITING_CONFIRMATION' AND updated_at=(r.reply_guard->>'proposalUpdatedAt')::timestamptz) THEN
      UPDATE public.tb_whatsapp_event_receipts SET delivery_state='EXPIRED',reply_text=NULL,updated_at=clock_timestamp() WHERE external_event_id=p_event_id;
      RETURN jsonb_build_object('status','EXPIRED');
    END IF;
    lease:=gen_random_uuid();
    admission:=public.fn_admit_whatsapp_identity_locked(ident,p_sender,lease,60);
    IF admission->>'status'<>'ADMITTED' THEN RETURN jsonb_build_object('status','BUSY'); END IF;
    UPDATE public.tb_whatsapp_event_receipts SET context_lease_id=lease,context_epoch=(admission->>'epoch')::bigint WHERE external_event_id=p_event_id;
  END IF;
  UPDATE public.tb_whatsapp_event_receipts SET delivery_state='SENDING',delivery_token=p_new_token,delivery_epoch=delivery_epoch+1,
    delivery_expires_at=clock_timestamp()+interval '60 seconds',delivery_attempts=delivery_attempts+1,updated_at=clock_timestamp()
    WHERE external_event_id=p_event_id RETURNING * INTO r;
  RETURN jsonb_build_object('status','SEND','epoch',r.delivery_epoch,'text',r.reply_text);
END;
$$;

CREATE FUNCTION public.fn_finish_whatsapp_delivery(p_event_id TEXT,p_token UUID,p_epoch BIGINT,p_outcome TEXT,p_http_status INTEGER,p_provider_code BIGINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public.tb_whatsapp_event_receipts;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('ACCEPTED','RETRYABLE','UNKNOWN')
    OR (p_http_status IS NOT NULL AND p_http_status NOT BETWEEN 100 AND 599)
    OR (p_provider_code IS NOT NULL AND p_provider_code NOT BETWEEN 0 AND 9007199254740991) THEN
    RAISE EXCEPTION 'Invalid delivery outcome' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(18443,43);
  SELECT * INTO r FROM public.tb_whatsapp_event_receipts WHERE external_event_id=p_event_id FOR UPDATE;
  IF NOT FOUND OR p_token IS NULL OR p_epoch IS NULL OR r.delivery_token IS DISTINCT FROM p_token OR r.delivery_epoch IS DISTINCT FROM p_epoch
    OR r.delivery_state<>'SENDING' OR r.delivery_expires_at IS NULL OR r.delivery_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'WhatsApp delivery is no longer current' USING ERRCODE='40001';
  END IF;
  -- RETRYABLE is reserved for a transport that demonstrably never started HTTP.
  IF p_outcome='RETRYABLE' AND p_http_status IS NOT NULL THEN RAISE EXCEPTION 'Ambiguous delivery cannot be retried' USING ERRCODE='22023'; END IF;
  UPDATE public.tb_whatsapp_event_receipts SET delivery_state=p_outcome,http_status=p_http_status,provider_code=p_provider_code,
    updated_at=clock_timestamp() WHERE external_event_id=p_event_id;
  IF r.user_id IS NOT NULL THEN PERFORM public.fn_release_whatsapp_context_lease(r.user_id,r.context_lease_id,r.context_epoch); END IF;
  RETURN jsonb_build_object('status',p_outcome);
END;
$$;

CREATE FUNCTION public.fn_purge_whatsapp_event_payloads(p_limit INTEGER DEFAULT 1000)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE n INTEGER;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'Invalid cleanup limit' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(18443,43);
  WITH expired AS (SELECT external_event_id FROM public.tb_whatsapp_event_receipts
    WHERE (reply_expires_at<=clock_timestamp() AND (reply_text IS NOT NULL OR reply_guard IS NOT NULL))
       OR (created_at<=clock_timestamp()-interval '30 days' AND tombstoned_at IS NULL)
    ORDER BY created_at LIMIT p_limit FOR UPDATE)
  UPDATE public.tb_whatsapp_event_receipts r SET reply_text=NULL,reply_guard=NULL,reply_template=NULL,
    delivery_state=CASE WHEN delivery_state='SENDING' THEN 'UNKNOWN' WHEN delivery_state IN ('NONE','ACCEPTED','UNKNOWN','BLOCKED') THEN delivery_state ELSE 'EXPIRED' END,
    identity_snapshot=CASE WHEN created_at<=clock_timestamp()-interval '30 days' THEN NULL ELSE identity_snapshot END,
    admission_selection=CASE WHEN created_at<=clock_timestamp()-interval '30 days' THEN NULL ELSE admission_selection END,
    artifacts=CASE WHEN created_at<=clock_timestamp()-interval '30 days' THEN '{}'::jsonb ELSE artifacts END,
    user_id=CASE WHEN created_at<=clock_timestamp()-interval '30 days' THEN NULL ELSE user_id END,
    household_id=CASE WHEN created_at<=clock_timestamp()-interval '30 days' THEN NULL ELSE household_id END,
    actor_member_id=CASE WHEN created_at<=clock_timestamp()-interval '30 days' THEN NULL ELSE actor_member_id END,
    context_lease_id=CASE WHEN created_at<=clock_timestamp()-interval '30 days' THEN NULL ELSE context_lease_id END,
    context_epoch=CASE WHEN created_at<=clock_timestamp()-interval '30 days' THEN NULL ELSE context_epoch END,
    event_token=CASE WHEN created_at<=clock_timestamp()-interval '30 days' THEN NULL ELSE event_token END,
    event_expires_at=CASE WHEN created_at<=clock_timestamp()-interval '30 days' THEN NULL ELSE event_expires_at END,
    delivery_token=CASE WHEN created_at<=clock_timestamp()-interval '30 days' THEN NULL ELSE delivery_token END,
    delivery_expires_at=CASE WHEN created_at<=clock_timestamp()-interval '30 days' THEN NULL ELSE delivery_expires_at END,
    conversation_digest=CASE WHEN created_at<=clock_timestamp()-interval '30 days' THEN NULL ELSE conversation_digest END,
    operation_digest=CASE WHEN created_at<=clock_timestamp()-interval '30 days' THEN NULL ELSE operation_digest END,
    http_status=CASE WHEN created_at<=clock_timestamp()-interval '30 days' THEN NULL ELSE http_status END,
    provider_code=CASE WHEN created_at<=clock_timestamp()-interval '30 days' THEN NULL ELSE provider_code END,
    delivery_attempts=CASE WHEN created_at<=clock_timestamp()-interval '30 days' THEN 0 ELSE delivery_attempts END,
    tombstoned_at=CASE WHEN created_at<=clock_timestamp()-interval '30 days' THEN clock_timestamp() ELSE tombstoned_at END,
    processing_state=CASE WHEN created_at<=clock_timestamp()-interval '30 days' AND processing_state IN ('RESERVED','RUNNING') THEN 'UNCERTAIN' ELSE processing_state END,
    updated_at=clock_timestamp() FROM expired e WHERE r.external_event_id=e.external_event_id;
  GET DIAGNOSTICS n=ROW_COUNT;
  RETURN n;
END;
$$;

DO $$
DECLARE f RECORD; role_name TEXT;
BEGIN
  FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') LOOP
    EXECUTE format('REVOKE ALL ON public.tb_whatsapp_event_receipts FROM %I',role_name);
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure AS signature,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('fn_whatsapp_event_fingerprint','fn_require_whatsapp_event','fn_claim_whatsapp_event',
      'fn_begin_whatsapp_event','fn_assert_whatsapp_event','fn_bind_whatsapp_event_context','fn_renew_whatsapp_event',
      'fn_finish_whatsapp_event','fn_fail_whatsapp_event','fn_purge_whatsapp_event_payloads',
      'fn_complete_whatsapp_link_event','fn_prepare_whatsapp_delivery','fn_finish_whatsapp_delivery') LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',f.signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,service_role',f.signature);
    FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f.signature,role_name);
    END LOOP;
    IF f.proname NOT IN ('fn_whatsapp_event_fingerprint','fn_require_whatsapp_event','fn_purge_whatsapp_event_payloads') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
    END IF;
  END LOOP;
END;
$$;

COMMIT;
