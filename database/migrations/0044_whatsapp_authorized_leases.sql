BEGIN;

-- No backfill: an in-flight pre-0044 lease must drain/expire before reacquisition.
ALTER TABLE public.tb_whatsapp_user_contexts
  ADD COLUMN authorization_origin TEXT,
  ADD COLUMN authorization_sender TEXT,
  ADD COLUMN authorization_link_id UUID REFERENCES public.tb_whatsapp_links(id) ON DELETE RESTRICT,
  ADD COLUMN authorization_version BIGINT,
  ADD CONSTRAINT ck_whatsapp_lease_authorization CHECK (
    (authorization_origin IS NULL AND authorization_sender IS NULL AND authorization_link_id IS NULL AND authorization_version IS NULL)
    OR (authorization_origin IS NOT NULL AND authorization_sender IS NOT NULL AND (
      (authorization_origin = 'LEGACY' AND authorization_link_id IS NULL AND authorization_version IS NULL)
      OR (authorization_origin = 'VERIFIED' AND authorization_link_id IS NOT NULL AND authorization_version IS NOT NULL AND authorization_version BETWEEN 1 AND 9007199254740991)
    ))
  );

-- Caller holds the shared transaction gate before invoking this private helper.
-- The legacy entry retains exact historical identifiers; the new public entry
-- additionally requires the canonical numeric Meta sender.
CREATE FUNCTION public.fn_resolve_whatsapp_identity_locked(p_sender TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_legacy UUID; v_link public.tb_whatsapp_links;
BEGIN
  IF p_sender IS NULL OR p_sender = '' THEN RETURN NULL; END IF;
  SELECT id INTO v_legacy FROM public.tb_users WHERE external_identifier = p_sender FOR SHARE;
  SELECT * INTO v_link FROM public.tb_whatsapp_links WHERE sender = p_sender AND status = 'ACTIVE' FOR SHARE;
  IF FOUND THEN
    IF v_legacy IS NOT NULL AND v_legacy IS DISTINCT FROM v_link.user_id THEN RETURN NULL; END IF;
    RETURN jsonb_build_object('userId', v_link.user_id, 'origin', 'VERIFIED', 'linkId', v_link.id, 'authorizationVersion', v_link.authorization_version);
  END IF;
  IF EXISTS(SELECT 1 FROM public.tb_whatsapp_links WHERE sender = p_sender AND status = 'REVOKED') THEN RETURN NULL; END IF;
  IF v_legacy IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('userId', v_legacy, 'origin', 'LEGACY', 'linkId', NULL, 'authorizationVersion', NULL);
END;
$$;

CREATE FUNCTION public.fn_resolve_whatsapp_sender(p_sender TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_identity JSONB;
BEGIN
  IF p_sender IS NULL OR p_sender !~ '^[1-9][0-9]{7,14}$' THEN
    RAISE EXCEPTION 'Invalid WhatsApp sender' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(18443,43);
  v_identity := public.fn_resolve_whatsapp_identity_locked(p_sender);
  IF v_identity IS NULL THEN RETURN jsonb_build_object('status','UNAVAILABLE'); END IF;
  RETURN v_identity || jsonb_build_object('status','RESOLVED');
END;
$$;

CREATE FUNCTION public.fn_admit_whatsapp_identity_locked(p_identity JSONB,p_sender TEXT,p_lease_id UUID,p_lease_seconds INTEGER)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_epoch BIGINT; v_user UUID := (p_identity->>'userId')::uuid;
BEGIN
  IF p_lease_id IS NULL OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 300 THEN
    RAISE EXCEPTION 'Invalid WhatsApp context lease input' USING ERRCODE='22023';
  END IF;
  IF v_user IS NULL THEN RETURN jsonb_build_object('status','UNAVAILABLE','acquired',false); END IF;
  INSERT INTO public.tb_whatsapp_user_contexts(user_id) VALUES(v_user) ON CONFLICT DO NOTHING;
  UPDATE public.tb_whatsapp_user_contexts SET
    processing_lease_id=p_lease_id, processing_epoch=processing_epoch+1,
    processing_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),
    authorization_origin=p_identity->>'origin', authorization_sender=p_sender,
    authorization_link_id=(p_identity->>'linkId')::uuid,
    authorization_version=(p_identity->>'authorizationVersion')::bigint,
    updated_at=clock_timestamp()
  WHERE user_id=v_user AND (processing_lease_id IS NULL OR processing_expires_at<=clock_timestamp())
  RETURNING processing_epoch INTO v_epoch;
  IF v_epoch IS NULL THEN RETURN jsonb_build_object('status','BUSY','acquired',false); END IF;
  RETURN p_identity || jsonb_build_object('status','ADMITTED','acquired',true,'epoch',v_epoch);
END;
$$;

CREATE FUNCTION public.fn_admit_whatsapp_sender(p_sender TEXT,p_lease_id UUID,p_lease_seconds INTEGER DEFAULT 120)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_identity JSONB;
BEGIN
  IF p_sender IS NULL OR p_sender !~ '^[1-9][0-9]{7,14}$' THEN
    RAISE EXCEPTION 'Invalid WhatsApp sender' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(18443,43);
  v_identity := public.fn_resolve_whatsapp_identity_locked(p_sender);
  RETURN public.fn_admit_whatsapp_identity_locked(v_identity,p_sender,p_lease_id,p_lease_seconds);
END;
$$;

-- Compatibility for the existing backend. A caller cannot choose a user with a
-- verified link and obtain an unversioned lease via the historical entry point.
CREATE OR REPLACE FUNCTION public.fn_acquire_whatsapp_context_lease(p_user_id UUID,p_lease_id UUID,p_lease_seconds INTEGER DEFAULT 120)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_sender TEXT; v_identity JSONB;
BEGIN
  IF p_user_id IS NULL OR p_lease_id IS NULL OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 300 THEN
    RAISE EXCEPTION 'Invalid WhatsApp context lease input' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(18443,43);
  SELECT external_identifier INTO v_sender FROM public.tb_users WHERE id=p_user_id FOR SHARE;
  v_identity := public.fn_resolve_whatsapp_identity_locked(v_sender);
  IF v_identity IS NULL OR v_identity->>'origin' <> 'LEGACY' OR (v_identity->>'userId')::uuid IS DISTINCT FROM p_user_id
     OR EXISTS(SELECT 1 FROM public.tb_whatsapp_links WHERE user_id=p_user_id) THEN
    RETURN jsonb_build_object('acquired',false,'epoch',NULL);
  END IF;
  RETURN public.fn_admit_whatsapp_identity_locked(v_identity,v_sender,p_lease_id,p_lease_seconds);
END;
$$;

CREATE FUNCTION public.fn_whatsapp_lease_authorized(p_user_id UUID,p_lease_id UUID,p_lease_epoch BIGINT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_context public.tb_whatsapp_user_contexts; v_identity JSONB;
BEGIN
  PERFORM pg_advisory_xact_lock(18443,43);
  SELECT * INTO v_context FROM public.tb_whatsapp_user_contexts WHERE user_id=p_user_id FOR SHARE;
  IF NOT FOUND OR p_lease_id IS NULL OR p_lease_epoch IS NULL
     OR v_context.processing_lease_id IS DISTINCT FROM p_lease_id
     OR v_context.processing_epoch IS DISTINCT FROM p_lease_epoch
     OR v_context.processing_expires_at IS NULL OR v_context.processing_expires_at<=clock_timestamp()
     OR v_context.authorization_origin IS NULL THEN RETURN false; END IF;
  v_identity := public.fn_resolve_whatsapp_identity_locked(v_context.authorization_sender);
  RETURN COALESCE(v_identity IS NOT NULL
    AND (v_identity->>'userId')::uuid = p_user_id
    AND v_identity->>'origin' = v_context.authorization_origin
    AND (v_identity->>'linkId')::uuid IS NOT DISTINCT FROM v_context.authorization_link_id
    AND (v_identity->>'authorizationVersion')::bigint IS NOT DISTINCT FROM v_context.authorization_version,false);
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_assert_whatsapp_context_lease(p_user_id UUID,p_lease_id UUID,p_lease_epoch BIGINT)
RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  RETURN public.fn_whatsapp_lease_authorized(p_user_id,p_lease_id,p_lease_epoch);
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_renew_whatsapp_context_lease(p_user_id UUID,p_lease_id UUID,p_lease_epoch BIGINT,p_lease_seconds INTEGER DEFAULT 120)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(18443,43);
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 300
     OR NOT public.fn_whatsapp_lease_authorized(p_user_id,p_lease_id,p_lease_epoch) THEN RETURN false; END IF;
  UPDATE public.tb_whatsapp_user_contexts SET processing_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),updated_at=clock_timestamp()
    WHERE user_id=p_user_id;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_release_whatsapp_context_lease(p_user_id UUID,p_lease_id UUID,p_lease_epoch BIGINT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(18443,43);
  UPDATE public.tb_whatsapp_user_contexts SET processing_lease_id=NULL,processing_expires_at=NULL,updated_at=clock_timestamp()
    WHERE user_id=p_user_id AND processing_lease_id=p_lease_id AND processing_epoch=p_lease_epoch;
  RETURN FOUND;
END;
$$;

CREATE FUNCTION public.fn_revoke_whatsapp_link(p_auth_user_id UUID,p_link_id UUID,p_expected_version BIGINT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_user UUID; v_link public.tb_whatsapp_links;
BEGIN
  PERFORM pg_advisory_xact_lock(18443,43);
  v_user := public.fn_whatsapp_link_account(p_auth_user_id);
  SELECT * INTO v_link FROM public.tb_whatsapp_links WHERE id=p_link_id AND user_id=v_user FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','NOT_FOUND'); END IF;
  IF v_link.status='REVOKED' THEN RETURN jsonb_build_object('status','REVOKED'); END IF;
  IF p_expected_version IS NULL OR p_expected_version IS DISTINCT FROM v_link.authorization_version THEN
    RETURN jsonb_build_object('status','STALE');
  END IF;
  UPDATE public.tb_whatsapp_links SET status='REVOKED',revoked_at=clock_timestamp(),authorization_version=authorization_version+1 WHERE id=p_link_id;
  RETURN jsonb_build_object('status','REVOKED');
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_transition_whatsapp_household_context(
  p_user_id UUID,
  p_phone_number_id TEXT,
  p_lease_id UUID,
  p_lease_epoch BIGINT,
  p_action TEXT,
  p_household_id UUID DEFAULT NULL,
  p_member_id UUID DEFAULT NULL,
  p_household_ids UUID[] DEFAULT NULL,
  p_option_number INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  context_row public.tb_whatsapp_user_contexts%ROWTYPE;
  target_household_id UUID;
  target_member_id UUID;
BEGIN
  PERFORM pg_advisory_xact_lock(18443,43);
  IF NOT public.fn_whatsapp_lease_authorized(p_user_id,p_lease_id,p_lease_epoch) THEN
    RAISE EXCEPTION 'WhatsApp context lease is no longer current' USING ERRCODE='40001';
  END IF;
  SELECT * INTO context_row
    FROM public.tb_whatsapp_user_contexts
   WHERE user_id = p_user_id
   FOR UPDATE;
  IF NOT FOUND
     OR p_lease_id IS NULL
     OR p_lease_epoch IS NULL
     OR context_row.processing_lease_id IS NULL
     OR context_row.processing_expires_at IS NULL
     OR context_row.processing_lease_id IS DISTINCT FROM p_lease_id
     OR context_row.processing_epoch IS DISTINCT FROM p_lease_epoch
     OR context_row.processing_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'WhatsApp context lease is no longer current' USING ERRCODE = '40001';
  END IF;

  IF p_action = 'SET_SELECTION' THEN
    IF NOT public.fn_lock_whatsapp_active_membership(
      p_user_id, p_household_id, p_member_id
    ) THEN
      RETURN jsonb_build_object('status', 'MEMBERSHIP_UNAVAILABLE');
    END IF;
    target_member_id := p_member_id;
    UPDATE public.tb_whatsapp_user_contexts
       SET selected_household_id = p_household_id,
           selected_member_id = target_member_id,
           menu_household_ids = NULL,
           menu_phone_number_id = NULL,
           menu_expires_at = NULL,
           updated_at = clock_timestamp()
     WHERE user_id = p_user_id;
    RETURN jsonb_build_object('status', 'SELECTED', 'household_id', p_household_id, 'member_id', target_member_id);
  ELSIF p_action = 'OPEN_MENU' THEN
    IF p_phone_number_id IS NULL OR p_household_ids IS NULL
       OR cardinality(p_household_ids) < 2
       OR cardinality(p_household_ids) <> cardinality(ARRAY(SELECT DISTINCT unnest(p_household_ids)))
       OR (SELECT count(*) FROM public.tb_household_members
            WHERE user_id = p_user_id AND status = 'ACTIVE'
              AND household_id = ANY(p_household_ids)) <> cardinality(p_household_ids) THEN
      RAISE EXCEPTION 'Invalid WhatsApp household menu' USING ERRCODE = '22023';
    END IF;
    UPDATE public.tb_whatsapp_user_contexts
       SET menu_household_ids = p_household_ids,
           menu_phone_number_id = p_phone_number_id,
           menu_expires_at = clock_timestamp() + interval '30 minutes',
           updated_at = clock_timestamp()
     WHERE user_id = p_user_id;
    RETURN jsonb_build_object('status', 'MENU_OPENED');
  ELSIF p_action = 'CHOOSE_OPTION' THEN
    IF context_row.menu_household_ids IS NULL
       OR context_row.menu_phone_number_id IS DISTINCT FROM p_phone_number_id THEN
      RETURN jsonb_build_object('status', 'NO_CURRENT_MENU');
    END IF;
    IF context_row.menu_expires_at <= clock_timestamp() THEN
      UPDATE public.tb_whatsapp_user_contexts
         SET menu_household_ids = NULL, menu_phone_number_id = NULL,
             menu_expires_at = NULL, updated_at = clock_timestamp()
       WHERE user_id = p_user_id;
      RETURN jsonb_build_object('status', 'MENU_EXPIRED');
    END IF;
    IF p_option_number IS NULL OR p_option_number < 1
       OR p_option_number > cardinality(context_row.menu_household_ids) THEN
      RETURN jsonb_build_object('status', 'INVALID_OPTION');
    END IF;
    target_household_id := context_row.menu_household_ids[p_option_number];
    SELECT member.id INTO target_member_id
      FROM public.tb_household_members AS member
     WHERE member.user_id = p_user_id
       AND member.household_id = target_household_id
       AND member.status = 'ACTIVE';
    IF target_member_id IS NULL
       OR NOT public.fn_lock_whatsapp_active_membership(
         p_user_id, target_household_id, target_member_id
       ) THEN
      UPDATE public.tb_whatsapp_user_contexts
         SET menu_household_ids = NULL, menu_phone_number_id = NULL,
             menu_expires_at = NULL, updated_at = clock_timestamp()
       WHERE user_id = p_user_id;
      RETURN jsonb_build_object('status', 'MEMBERSHIP_UNAVAILABLE');
    END IF;
    UPDATE public.tb_whatsapp_user_contexts
       SET selected_household_id = target_household_id,
           selected_member_id = target_member_id,
           menu_household_ids = NULL,
           menu_phone_number_id = NULL,
           menu_expires_at = NULL,
           updated_at = clock_timestamp()
     WHERE user_id = p_user_id;
    RETURN jsonb_build_object('status', 'SELECTED', 'household_id', target_household_id, 'member_id', target_member_id);
  ELSIF p_action = 'CANCEL_MENU' THEN
    UPDATE public.tb_whatsapp_user_contexts
       SET menu_household_ids = NULL,
           menu_phone_number_id = NULL,
           menu_expires_at = NULL,
           updated_at = clock_timestamp()
     WHERE user_id = p_user_id;
    RETURN jsonb_build_object('status', 'MENU_CANCELLED');
  ELSIF p_action = 'CLEAR_SELECTION' THEN
    UPDATE public.tb_whatsapp_user_contexts
       SET selected_household_id = NULL,
           selected_member_id = NULL,
           menu_household_ids = NULL,
           menu_phone_number_id = NULL,
           menu_expires_at = NULL,
           updated_at = clock_timestamp()
     WHERE user_id = p_user_id;
    RETURN jsonb_build_object('status', 'SELECTION_CLEARED');
  ELSE
    RAISE EXCEPTION 'Unsupported WhatsApp context action' USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_require_whatsapp_active_context(
  p_user_id UUID, p_lease_id UUID, p_lease_epoch BIGINT,
  p_household_id UUID, p_actor_member_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  context_row public.tb_whatsapp_user_contexts%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(18443,43);
  IF NOT public.fn_whatsapp_lease_authorized(p_user_id,p_lease_id,p_lease_epoch) THEN
    RAISE EXCEPTION 'WhatsApp context lease is no longer current' USING ERRCODE='40001';
  END IF;
  SELECT * INTO context_row
    FROM public.tb_whatsapp_user_contexts
   WHERE user_id = p_user_id
   FOR SHARE;
  IF NOT FOUND
     OR p_lease_id IS NULL
     OR p_lease_epoch IS NULL
     OR context_row.processing_lease_id IS NULL
     OR context_row.processing_expires_at IS NULL
     OR context_row.processing_lease_id IS DISTINCT FROM p_lease_id
     OR context_row.processing_epoch IS DISTINCT FROM p_lease_epoch
     OR context_row.processing_expires_at <= clock_timestamp()
     OR context_row.selected_household_id IS DISTINCT FROM p_household_id
     OR context_row.selected_member_id IS DISTINCT FROM p_actor_member_id THEN
    RAISE EXCEPTION 'WhatsApp household context is no longer current' USING ERRCODE = '40001';
  END IF;
  IF NOT public.fn_lock_whatsapp_active_membership(
    p_user_id, p_household_id, p_actor_member_id
  ) THEN
    RAISE EXCEPTION 'Active household membership is unavailable' USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_confirm_pending_expense_consistent(
  p_proposal_id UUID, p_household_id UUID, p_conversation_key TEXT,
  p_actor_member_id UUID DEFAULT NULL,
  p_context_source public.expense_source DEFAULT NULL,
  p_expected_updated_at TIMESTAMPTZ DEFAULT NULL,
  p_created_by UUID DEFAULT NULL, p_paid_by UUID DEFAULT NULL,
  p_category_id UUID DEFAULT NULL, p_receipt_id UUID DEFAULT NULL,
  p_merchant TEXT DEFAULT NULL, p_total_amount NUMERIC(14,2) DEFAULT NULL,
  p_expense_date DATE DEFAULT NULL, p_description TEXT DEFAULT NULL,
  p_source public.expense_source DEFAULT NULL, p_items JSONB DEFAULT NULL,
  p_distributions JSONB DEFAULT NULL,
  p_whatsapp_user_id UUID DEFAULT NULL,
  p_whatsapp_lease_id UUID DEFAULT NULL,
  p_whatsapp_lease_epoch BIGINT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  proposal_status public.pending_proposal_status;
  proposal_updated_at TIMESTAMPTZ;
BEGIN
  IF p_context_source = 'WHATSAPP' THEN
    PERFORM pg_advisory_xact_lock(18443,43);
  END IF;
  SELECT status, updated_at INTO proposal_status, proposal_updated_at
    FROM public.tb_pending_proposals
   WHERE id = p_proposal_id AND household_id = p_household_id
     AND conversation_key = p_conversation_key
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'NOT_FOUND', 'expense_id', NULL);
  END IF;
  IF proposal_status = 'AWAITING_CONFIRMATION' THEN
    IF p_context_source = 'WHATSAPP' THEN
      IF p_actor_member_id IS NULL OR p_whatsapp_user_id IS NULL OR p_whatsapp_lease_id IS NULL
         OR p_whatsapp_lease_epoch IS NULL THEN
        RETURN jsonb_build_object('status', 'NOT_FOUND', 'expense_id', NULL);
      END IF;
      IF NOT public.fn_lock_whatsapp_active_membership(
        p_whatsapp_user_id, p_household_id, p_actor_member_id
      ) THEN
        RETURN jsonb_build_object('status', 'NOT_FOUND', 'expense_id', NULL);
      END IF;
      PERFORM public.fn_require_whatsapp_active_context(
        p_whatsapp_user_id, p_whatsapp_lease_id, p_whatsapp_lease_epoch,
        p_household_id, p_actor_member_id
      );
    END IF;
    IF p_expected_updated_at IS NULL
       AND (p_created_by IS NOT NULL OR p_paid_by IS NOT NULL OR p_category_id IS NOT NULL
         OR p_receipt_id IS NOT NULL OR p_merchant IS NOT NULL OR p_total_amount IS NOT NULL
         OR p_expense_date IS NOT NULL OR p_description IS NOT NULL OR p_source IS NOT NULL
         OR p_items IS NOT NULL OR p_distributions IS NOT NULL) THEN
      RAISE EXCEPTION 'Expected pending proposal version is required' USING ERRCODE = '22023';
    END IF;
    IF p_expected_updated_at IS NOT NULL
       AND proposal_updated_at IS DISTINCT FROM p_expected_updated_at THEN
      RAISE EXCEPTION 'Pending proposal changed before confirmation' USING ERRCODE = '40001';
    END IF;
  END IF;
  RETURN public.fn_confirm_pending_expense(
    p_proposal_id, p_household_id, p_conversation_key, p_actor_member_id,
    p_context_source, p_created_by, p_paid_by, p_category_id, p_receipt_id,
    p_merchant, p_total_amount, p_expense_date, p_description, p_source,
    p_items, p_distributions
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_confirm_pending_income_consistent(
  p_proposal_id UUID, p_household_id UUID, p_conversation_key TEXT,
  p_actor_member_id UUID DEFAULT NULL,
  p_context_source public.expense_source DEFAULT NULL,
  p_expected_updated_at TIMESTAMPTZ DEFAULT NULL,
  p_created_by UUID DEFAULT NULL, p_member_id UUID DEFAULT NULL,
  p_amount NUMERIC(14,2) DEFAULT NULL, p_income_date DATE DEFAULT NULL,
  p_description TEXT DEFAULT NULL, p_category_id UUID DEFAULT NULL,
  p_whatsapp_user_id UUID DEFAULT NULL,
  p_whatsapp_lease_id UUID DEFAULT NULL,
  p_whatsapp_lease_epoch BIGINT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  proposal_status public.pending_proposal_status;
  proposal_updated_at TIMESTAMPTZ;
BEGIN
  IF p_context_source = 'WHATSAPP' THEN
    PERFORM pg_advisory_xact_lock(18443,43);
  END IF;
  SELECT status, updated_at INTO proposal_status, proposal_updated_at
    FROM public.tb_pending_proposals
   WHERE id = p_proposal_id AND household_id = p_household_id
     AND conversation_key = p_conversation_key
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'NOT_FOUND', 'income_id', NULL);
  END IF;
  IF proposal_status = 'AWAITING_CONFIRMATION' THEN
    IF p_context_source = 'WHATSAPP' THEN
      IF p_actor_member_id IS NULL OR p_whatsapp_user_id IS NULL OR p_whatsapp_lease_id IS NULL
         OR p_whatsapp_lease_epoch IS NULL THEN
        RETURN jsonb_build_object('status', 'NOT_FOUND', 'income_id', NULL);
      END IF;
      IF NOT public.fn_lock_whatsapp_active_membership(
        p_whatsapp_user_id, p_household_id, p_actor_member_id
      ) THEN
        RETURN jsonb_build_object('status', 'NOT_FOUND', 'income_id', NULL);
      END IF;
      PERFORM public.fn_require_whatsapp_active_context(
        p_whatsapp_user_id, p_whatsapp_lease_id, p_whatsapp_lease_epoch,
        p_household_id, p_actor_member_id
      );
    END IF;
    IF p_expected_updated_at IS NULL
       AND (p_created_by IS NOT NULL OR p_member_id IS NOT NULL OR p_amount IS NOT NULL
         OR p_income_date IS NOT NULL OR p_description IS NOT NULL OR p_category_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Expected pending proposal version is required' USING ERRCODE = '22023';
    END IF;
    IF p_expected_updated_at IS NOT NULL
       AND proposal_updated_at IS DISTINCT FROM p_expected_updated_at THEN
      RAISE EXCEPTION 'Pending proposal changed before confirmation' USING ERRCODE = '40001';
    END IF;
  END IF;
  RETURN public.fn_confirm_pending_income(
    p_proposal_id, p_household_id, p_conversation_key, p_actor_member_id,
    p_context_source, p_created_by, p_member_id, p_amount, p_income_date,
    p_description, p_category_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_confirm_pending_expense_eligible(p_auth_user_id UUID, p_proposal_id UUID, p_household_id UUID, p_conversation_key TEXT,
  p_actor_member_id UUID DEFAULT NULL,
  p_context_source public.expense_source DEFAULT NULL,
  p_expected_updated_at TIMESTAMPTZ DEFAULT NULL,
  p_created_by UUID DEFAULT NULL, p_paid_by UUID DEFAULT NULL,
  p_category_id UUID DEFAULT NULL, p_receipt_id UUID DEFAULT NULL,
  p_merchant TEXT DEFAULT NULL, p_total_amount NUMERIC(14,2) DEFAULT NULL,
  p_expense_date DATE DEFAULT NULL, p_description TEXT DEFAULT NULL,
  p_source public.expense_source DEFAULT NULL, p_items JSONB DEFAULT NULL,
  p_distributions JSONB DEFAULT NULL,
  p_whatsapp_user_id UUID DEFAULT NULL,
  p_whatsapp_lease_id UUID DEFAULT NULL,
  p_whatsapp_lease_epoch BIGINT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE effective_auth_id UUID := p_auth_user_id; effective_user_id UUID;
BEGIN
  IF p_context_source = 'WHATSAPP' THEN
    PERFORM pg_advisory_xact_lock(18443,43);
  END IF;
  IF p_context_source = 'WHATSAPP' THEN
    -- Transitional channel identity is derived only from the controlled lease user.
    SELECT auth_user_id INTO effective_auth_id FROM public.tb_users WHERE id = p_whatsapp_user_id;
    IF p_auth_user_id IS NOT NULL AND p_auth_user_id IS DISTINCT FROM effective_auth_id THEN
      RAISE EXCEPTION 'Financial access is unavailable' USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
    END IF;
  END IF;
  effective_user_id := public.fn_require_financial_eligibility(effective_auth_id, p_household_id, p_actor_member_id);
  IF p_created_by IS NOT NULL AND p_created_by IS DISTINCT FROM p_actor_member_id THEN
    RAISE EXCEPTION 'Financial access is unavailable' USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
  END IF;
  IF p_context_source = 'WHATSAPP' AND effective_user_id IS DISTINCT FROM p_whatsapp_user_id THEN
    RAISE EXCEPTION 'Financial access is unavailable' USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
  END IF;
  RETURN public.fn_confirm_pending_expense_consistent(p_proposal_id, p_household_id, p_conversation_key, p_actor_member_id, p_context_source, p_expected_updated_at, p_created_by, p_paid_by, p_category_id, p_receipt_id, p_merchant, p_total_amount, p_expense_date, p_description, p_source, p_items, p_distributions, p_whatsapp_user_id, p_whatsapp_lease_id, p_whatsapp_lease_epoch);
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_confirm_pending_income_eligible(p_auth_user_id UUID, p_proposal_id UUID, p_household_id UUID, p_conversation_key TEXT,
  p_actor_member_id UUID DEFAULT NULL,
  p_context_source public.expense_source DEFAULT NULL,
  p_expected_updated_at TIMESTAMPTZ DEFAULT NULL,
  p_created_by UUID DEFAULT NULL, p_member_id UUID DEFAULT NULL,
  p_amount NUMERIC(14,2) DEFAULT NULL, p_income_date DATE DEFAULT NULL,
  p_description TEXT DEFAULT NULL, p_category_id UUID DEFAULT NULL,
  p_whatsapp_user_id UUID DEFAULT NULL,
  p_whatsapp_lease_id UUID DEFAULT NULL,
  p_whatsapp_lease_epoch BIGINT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE effective_auth_id UUID := p_auth_user_id; effective_user_id UUID;
BEGIN
  IF p_context_source = 'WHATSAPP' THEN
    PERFORM pg_advisory_xact_lock(18443,43);
  END IF;
  IF p_context_source = 'WHATSAPP' THEN
    -- Transitional channel identity is derived only from the controlled lease user.
    SELECT auth_user_id INTO effective_auth_id FROM public.tb_users WHERE id = p_whatsapp_user_id;
    IF p_auth_user_id IS NOT NULL AND p_auth_user_id IS DISTINCT FROM effective_auth_id THEN
      RAISE EXCEPTION 'Financial access is unavailable' USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
    END IF;
  END IF;
  effective_user_id := public.fn_require_financial_eligibility(effective_auth_id, p_household_id, p_actor_member_id);
  IF p_created_by IS NOT NULL AND p_created_by IS DISTINCT FROM p_actor_member_id THEN
    RAISE EXCEPTION 'Financial access is unavailable' USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
  END IF;
  IF p_context_source = 'WHATSAPP' AND effective_user_id IS DISTINCT FROM p_whatsapp_user_id THEN
    RAISE EXCEPTION 'Financial access is unavailable' USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
  END IF;
  RETURN public.fn_confirm_pending_income_consistent(p_proposal_id, p_household_id, p_conversation_key, p_actor_member_id, p_context_source, p_expected_updated_at, p_created_by, p_member_id, p_amount, p_income_date, p_description, p_category_id, p_whatsapp_user_id, p_whatsapp_lease_id, p_whatsapp_lease_epoch);
END;
$$;

DO $permissions$
DECLARE f RECORD; r TEXT;
BEGIN
  FOR f IN SELECT p.oid,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('fn_transition_whatsapp_household_context','fn_require_whatsapp_active_context','fn_confirm_pending_expense_consistent','fn_confirm_pending_income_consistent','fn_confirm_pending_expense_eligible','fn_confirm_pending_income_eligible','fn_resolve_whatsapp_identity_locked','fn_resolve_whatsapp_sender','fn_admit_whatsapp_identity_locked','fn_admit_whatsapp_sender','fn_acquire_whatsapp_context_lease','fn_whatsapp_lease_authorized','fn_assert_whatsapp_context_lease','fn_renew_whatsapp_context_lease','fn_release_whatsapp_context_lease','fn_revoke_whatsapp_link') LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',f.oid::regprocedure);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, service_role',f.oid::regprocedure);
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f.oid::regprocedure,r);
    END LOOP;
    IF f.proname NOT IN ('fn_resolve_whatsapp_identity_locked','fn_admit_whatsapp_identity_locked','fn_whatsapp_lease_authorized') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.oid::regprocedure);
    END IF;
  END LOOP;
END;
$permissions$;

COMMIT;
