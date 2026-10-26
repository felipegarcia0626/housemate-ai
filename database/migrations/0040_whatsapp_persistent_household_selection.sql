BEGIN;

CREATE TABLE public.tb_whatsapp_user_contexts (
  user_id UUID CONSTRAINT pk_tb_whatsapp_user_contexts PRIMARY KEY
    REFERENCES public.tb_users(id) ON DELETE RESTRICT,
  selected_household_id UUID,
  selected_member_id UUID,
  menu_household_ids UUID[],
  menu_phone_number_id TEXT,
  menu_expires_at TIMESTAMPTZ,
  processing_lease_id UUID,
  processing_epoch BIGINT NOT NULL DEFAULT 0,
  processing_expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_tb_whatsapp_user_contexts_membership
    FOREIGN KEY (selected_household_id, selected_member_id)
    REFERENCES public.tb_household_members(household_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT ck_tb_whatsapp_user_contexts_selection_pair
    CHECK ((selected_household_id IS NULL) = (selected_member_id IS NULL)),
  CONSTRAINT ck_tb_whatsapp_user_contexts_menu_pair
    CHECK (
      (menu_household_ids IS NULL AND menu_phone_number_id IS NULL AND menu_expires_at IS NULL)
      OR
      (menu_household_ids IS NOT NULL AND cardinality(menu_household_ids) > 1
       AND menu_phone_number_id IS NOT NULL AND menu_expires_at IS NOT NULL)
    ),
  CONSTRAINT ck_tb_whatsapp_user_contexts_lease_pair
    CHECK ((processing_lease_id IS NULL) = (processing_expires_at IS NULL)),
  CONSTRAINT ck_tb_whatsapp_user_contexts_epoch
    CHECK (processing_epoch >= 0)
);

ALTER TABLE public.tb_whatsapp_user_contexts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tb_whatsapp_user_contexts FROM PUBLIC;
REVOKE ALL ON TABLE public.tb_whatsapp_user_contexts FROM service_role;
DO $$
DECLARE
  application_role TEXT;
BEGIN
  FOR application_role IN
    SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')
  LOOP
    EXECUTE format(
      'REVOKE ALL ON TABLE public.tb_whatsapp_user_contexts FROM %I',
      application_role
    );
  END LOOP;
END;
$$;
GRANT SELECT, INSERT, UPDATE ON TABLE public.tb_whatsapp_user_contexts TO service_role;

CREATE FUNCTION public.fn_acquire_whatsapp_context_lease(
  p_user_id UUID,
  p_lease_id UUID,
  p_lease_seconds INTEGER DEFAULT 120
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  acquired_epoch BIGINT;
BEGIN
  IF p_user_id IS NULL OR p_lease_id IS NULL
     OR p_lease_seconds < 30 OR p_lease_seconds > 300 THEN
    RAISE EXCEPTION 'Invalid WhatsApp context lease input' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.tb_whatsapp_user_contexts(user_id)
  VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  UPDATE public.tb_whatsapp_user_contexts
     SET processing_lease_id = p_lease_id,
         processing_epoch = processing_epoch + 1,
         processing_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
         updated_at = clock_timestamp()
   WHERE user_id = p_user_id
     AND (processing_lease_id IS NULL OR processing_expires_at <= clock_timestamp())
  RETURNING processing_epoch INTO acquired_epoch;

  IF acquired_epoch IS NULL THEN
    RETURN jsonb_build_object('acquired', false, 'epoch', NULL);
  END IF;
  RETURN jsonb_build_object('acquired', true, 'epoch', acquired_epoch);
END;
$$;

CREATE FUNCTION public.fn_renew_whatsapp_context_lease(
  p_user_id UUID, p_lease_id UUID, p_lease_epoch BIGINT,
  p_lease_seconds INTEGER DEFAULT 120
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  UPDATE public.tb_whatsapp_user_contexts
     SET processing_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
         updated_at = clock_timestamp()
   WHERE user_id = p_user_id
     AND processing_lease_id = p_lease_id
     AND processing_epoch = p_lease_epoch
     AND processing_expires_at > clock_timestamp()
     AND p_lease_seconds BETWEEN 30 AND 300;
  RETURN FOUND;
END;
$$;

CREATE FUNCTION public.fn_release_whatsapp_context_lease(
  p_user_id UUID, p_lease_id UUID, p_lease_epoch BIGINT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  UPDATE public.tb_whatsapp_user_contexts
     SET processing_lease_id = NULL,
         processing_expires_at = NULL,
         updated_at = clock_timestamp()
   WHERE user_id = p_user_id
     AND processing_lease_id = p_lease_id
     AND processing_epoch = p_lease_epoch;
  RETURN FOUND;
END;
$$;

CREATE FUNCTION public.fn_assert_whatsapp_context_lease(
  p_user_id UUID, p_lease_id UUID, p_lease_epoch BIGINT
)
RETURNS BOOLEAN
LANGUAGE sql
VOLATILE
SECURITY INVOKER
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.tb_whatsapp_user_contexts
     WHERE user_id = p_user_id
       AND processing_lease_id = p_lease_id
       AND processing_epoch = p_lease_epoch
       AND processing_expires_at > clock_timestamp()
  );
$$;

CREATE FUNCTION public.fn_transition_whatsapp_household_context(
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
SECURITY INVOKER
AS $$
DECLARE
  context_row public.tb_whatsapp_user_contexts%ROWTYPE;
  target_household_id UUID;
  target_member_id UUID;
BEGIN
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
    SELECT id INTO target_member_id
      FROM public.tb_household_members
     WHERE household_id = p_household_id
       AND user_id = p_user_id
       AND id = p_member_id
       AND status = 'ACTIVE'
     FOR SHARE;
    IF target_member_id IS NULL THEN
      RETURN jsonb_build_object('status', 'MEMBERSHIP_UNAVAILABLE');
    END IF;
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
    SELECT id INTO target_member_id
      FROM public.tb_household_members
     WHERE user_id = p_user_id
       AND household_id = target_household_id
       AND status = 'ACTIVE'
     FOR SHARE;
    IF target_member_id IS NULL THEN
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

CREATE FUNCTION public.fn_require_whatsapp_active_context(
  p_user_id UUID, p_lease_id UUID, p_lease_epoch BIGINT,
  p_household_id UUID, p_actor_member_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  context_row public.tb_whatsapp_user_contexts%ROWTYPE;
BEGIN
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
  PERFORM 1 FROM public.tb_household_members
   WHERE id = p_actor_member_id AND household_id = p_household_id
     AND user_id = p_user_id AND status = 'ACTIVE'
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active household membership is unavailable' USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE FUNCTION public.fn_assert_whatsapp_active_context(
  p_user_id UUID, p_lease_id UUID, p_lease_epoch BIGINT,
  p_household_id UUID, p_actor_member_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
AS $$
BEGIN
  PERFORM public.fn_require_whatsapp_active_context(
    p_user_id, p_lease_id, p_lease_epoch, p_household_id, p_actor_member_id
  );
  RETURN TRUE;
END;
$$;

CREATE FUNCTION public.fn_create_whatsapp_agent_draft(
  p_id UUID, p_household_id UUID, p_actor_member_id UUID,
  p_conversation_key TEXT, p_operation_type public.pending_operation_type,
  p_payload JSONB, p_status public.agent_category_draft_status,
  p_user_id UUID, p_lease_id UUID, p_lease_epoch BIGINT
)
RETURNS public.tb_agent_category_drafts
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  draft_row public.tb_agent_category_drafts%ROWTYPE;
BEGIN
  PERFORM public.fn_require_whatsapp_active_context(
    p_user_id, p_lease_id, p_lease_epoch, p_household_id, p_actor_member_id
  );
  INSERT INTO public.tb_agent_category_drafts(
    id, household_id, actor_member_id, conversation_key, source,
    operation_type, payload, status
  ) VALUES (
    p_id, p_household_id, p_actor_member_id, p_conversation_key, 'WHATSAPP',
    p_operation_type, p_payload, p_status
  ) RETURNING * INTO draft_row;
  RETURN draft_row;
END;
$$;

CREATE FUNCTION public.fn_update_whatsapp_agent_draft(
  p_id UUID, p_household_id UUID, p_actor_member_id UUID,
  p_conversation_key TEXT, p_operation_type public.pending_operation_type,
  p_payload JSONB, p_status public.agent_category_draft_status,
  p_expected_updated_at TIMESTAMPTZ,
  p_user_id UUID, p_lease_id UUID, p_lease_epoch BIGINT
)
RETURNS public.tb_agent_category_drafts
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  draft_row public.tb_agent_category_drafts%ROWTYPE;
BEGIN
  PERFORM public.fn_require_whatsapp_active_context(
    p_user_id, p_lease_id, p_lease_epoch, p_household_id, p_actor_member_id
  );
  UPDATE public.tb_agent_category_drafts
     SET payload = p_payload, operation_type = p_operation_type, status = p_status
   WHERE id = p_id AND household_id = p_household_id
     AND actor_member_id = p_actor_member_id AND conversation_key = p_conversation_key
     AND source = 'WHATSAPP'
     AND (p_expected_updated_at IS NULL OR updated_at = p_expected_updated_at)
  RETURNING * INTO draft_row;
  RETURN draft_row;
END;
$$;

CREATE FUNCTION public.fn_delete_whatsapp_agent_draft(
  p_id UUID, p_household_id UUID, p_actor_member_id UUID,
  p_conversation_key TEXT, p_expected_updated_at TIMESTAMPTZ,
  p_user_id UUID, p_lease_id UUID, p_lease_epoch BIGINT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  PERFORM public.fn_require_whatsapp_active_context(
    p_user_id, p_lease_id, p_lease_epoch, p_household_id, p_actor_member_id
  );
  DELETE FROM public.tb_agent_category_drafts
   WHERE id = p_id AND household_id = p_household_id
     AND actor_member_id = p_actor_member_id AND conversation_key = p_conversation_key
     AND source = 'WHATSAPP' AND updated_at = p_expected_updated_at;
  RETURN FOUND;
END;
$$;

CREATE FUNCTION public.fn_create_whatsapp_pending_proposal(
  p_id UUID, p_household_id UUID, p_conversation_key TEXT,
  p_actor_member_id UUID, p_operation_type public.pending_operation_type,
  p_payload JSONB, p_user_id UUID, p_lease_id UUID, p_lease_epoch BIGINT
)
RETURNS public.tb_pending_proposals
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  proposal_row public.tb_pending_proposals%ROWTYPE;
BEGIN
  PERFORM public.fn_require_whatsapp_active_context(
    p_user_id, p_lease_id, p_lease_epoch, p_household_id, p_actor_member_id
  );
  INSERT INTO public.tb_pending_proposals(
    id, household_id, conversation_key, actor_member_id, source,
    operation_type, payload, status
  ) VALUES (
    p_id, p_household_id, p_conversation_key, p_actor_member_id, 'WHATSAPP',
    p_operation_type, p_payload, 'AWAITING_CONFIRMATION'
  ) RETURNING * INTO proposal_row;
  RETURN proposal_row;
END;
$$;

CREATE FUNCTION public.fn_update_whatsapp_pending_proposal(
  p_id UUID, p_household_id UUID, p_conversation_key TEXT,
  p_actor_member_id UUID, p_operation_type public.pending_operation_type,
  p_payload JSONB, p_expected_updated_at TIMESTAMPTZ,
  p_user_id UUID, p_lease_id UUID, p_lease_epoch BIGINT
)
RETURNS public.tb_pending_proposals
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  proposal_row public.tb_pending_proposals%ROWTYPE;
BEGIN
  PERFORM public.fn_require_whatsapp_active_context(
    p_user_id, p_lease_id, p_lease_epoch, p_household_id, p_actor_member_id
  );
  UPDATE public.tb_pending_proposals
     SET payload = p_payload
   WHERE id = p_id AND household_id = p_household_id
     AND conversation_key = p_conversation_key
     AND actor_member_id = p_actor_member_id AND source = 'WHATSAPP'
     AND operation_type = p_operation_type
     AND status = 'AWAITING_CONFIRMATION'
     AND updated_at = p_expected_updated_at
  RETURNING * INTO proposal_row;
  RETURN proposal_row;
END;
$$;

CREATE FUNCTION public.fn_reject_whatsapp_pending_proposal(
  p_proposal_id UUID, p_household_id UUID, p_conversation_key TEXT,
  p_actor_member_id UUID, p_operation_type public.pending_operation_type,
  p_user_id UUID, p_lease_id UUID, p_lease_epoch BIGINT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  PERFORM public.fn_require_whatsapp_active_context(
    p_user_id, p_lease_id, p_lease_epoch, p_household_id, p_actor_member_id
  );
  RETURN public.fn_reject_pending_proposal(
    p_proposal_id, p_household_id, p_conversation_key,
    p_actor_member_id, 'WHATSAPP', p_operation_type
  );
END;
$$;

-- Replace the wrappers with versions that lock and validate the actor's active
-- membership in the same transaction that creates the financial movement.
DROP FUNCTION public.fn_confirm_pending_expense_consistent(
  UUID, UUID, TEXT, UUID, public.expense_source, TIMESTAMPTZ,
  UUID, UUID, UUID, UUID, TEXT, NUMERIC, DATE, TEXT,
  public.expense_source, JSONB, JSONB
);
CREATE FUNCTION public.fn_confirm_pending_expense_consistent(
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
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  proposal_status public.pending_proposal_status;
  proposal_updated_at TIMESTAMPTZ;
BEGIN
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
      PERFORM 1 FROM public.tb_household_members
       WHERE id = p_actor_member_id AND household_id = p_household_id
         AND status = 'ACTIVE'
       FOR SHARE;
      IF NOT FOUND THEN
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

DROP FUNCTION public.fn_confirm_pending_income_consistent(
  UUID, UUID, TEXT, UUID, public.expense_source, TIMESTAMPTZ,
  UUID, UUID, NUMERIC, DATE, TEXT, UUID
);
CREATE FUNCTION public.fn_confirm_pending_income_consistent(
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
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  proposal_status public.pending_proposal_status;
  proposal_updated_at TIMESTAMPTZ;
BEGIN
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
      PERFORM 1 FROM public.tb_household_members
       WHERE id = p_actor_member_id AND household_id = p_household_id
         AND status = 'ACTIVE'
       FOR SHARE;
      IF NOT FOUND THEN
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

REVOKE EXECUTE ON FUNCTION public.fn_acquire_whatsapp_context_lease(UUID, UUID, INTEGER),
  public.fn_renew_whatsapp_context_lease(UUID, UUID, BIGINT, INTEGER),
  public.fn_release_whatsapp_context_lease(UUID, UUID, BIGINT),
  public.fn_assert_whatsapp_context_lease(UUID, UUID, BIGINT),
  public.fn_transition_whatsapp_household_context(UUID, TEXT, UUID, BIGINT, TEXT, UUID, UUID, UUID[], INTEGER),
  public.fn_require_whatsapp_active_context(UUID, UUID, BIGINT, UUID, UUID),
  public.fn_assert_whatsapp_active_context(UUID, UUID, BIGINT, UUID, UUID),
  public.fn_create_whatsapp_agent_draft(UUID, UUID, UUID, TEXT, public.pending_operation_type, JSONB, public.agent_category_draft_status, UUID, UUID, BIGINT),
  public.fn_update_whatsapp_agent_draft(UUID, UUID, UUID, TEXT, public.pending_operation_type, JSONB, public.agent_category_draft_status, TIMESTAMPTZ, UUID, UUID, BIGINT),
  public.fn_delete_whatsapp_agent_draft(UUID, UUID, UUID, TEXT, TIMESTAMPTZ, UUID, UUID, BIGINT),
  public.fn_create_whatsapp_pending_proposal(UUID, UUID, TEXT, UUID, public.pending_operation_type, JSONB, UUID, UUID, BIGINT),
  public.fn_update_whatsapp_pending_proposal(UUID, UUID, TEXT, UUID, public.pending_operation_type, JSONB, TIMESTAMPTZ, UUID, UUID, BIGINT),
  public.fn_reject_whatsapp_pending_proposal(UUID, UUID, TEXT, UUID, public.pending_operation_type, UUID, UUID, BIGINT),
  public.fn_confirm_pending_expense_consistent(UUID, UUID, TEXT, UUID, public.expense_source, TIMESTAMPTZ, UUID, UUID, UUID, UUID, TEXT, NUMERIC, DATE, TEXT, public.expense_source, JSONB, JSONB, UUID, UUID, BIGINT),
  public.fn_confirm_pending_income_consistent(UUID, UUID, TEXT, UUID, public.expense_source, TIMESTAMPTZ, UUID, UUID, NUMERIC, DATE, TEXT, UUID, UUID, UUID, BIGINT)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.fn_acquire_whatsapp_context_lease(UUID, UUID, INTEGER),
  public.fn_renew_whatsapp_context_lease(UUID, UUID, BIGINT, INTEGER),
  public.fn_release_whatsapp_context_lease(UUID, UUID, BIGINT),
  public.fn_assert_whatsapp_context_lease(UUID, UUID, BIGINT),
  public.fn_transition_whatsapp_household_context(UUID, TEXT, UUID, BIGINT, TEXT, UUID, UUID, UUID[], INTEGER),
  public.fn_require_whatsapp_active_context(UUID, UUID, BIGINT, UUID, UUID),
  public.fn_assert_whatsapp_active_context(UUID, UUID, BIGINT, UUID, UUID),
  public.fn_create_whatsapp_agent_draft(UUID, UUID, UUID, TEXT, public.pending_operation_type, JSONB, public.agent_category_draft_status, UUID, UUID, BIGINT),
  public.fn_update_whatsapp_agent_draft(UUID, UUID, UUID, TEXT, public.pending_operation_type, JSONB, public.agent_category_draft_status, TIMESTAMPTZ, UUID, UUID, BIGINT),
  public.fn_delete_whatsapp_agent_draft(UUID, UUID, UUID, TEXT, TIMESTAMPTZ, UUID, UUID, BIGINT),
  public.fn_create_whatsapp_pending_proposal(UUID, UUID, TEXT, UUID, public.pending_operation_type, JSONB, UUID, UUID, BIGINT),
  public.fn_update_whatsapp_pending_proposal(UUID, UUID, TEXT, UUID, public.pending_operation_type, JSONB, TIMESTAMPTZ, UUID, UUID, BIGINT),
  public.fn_reject_whatsapp_pending_proposal(UUID, UUID, TEXT, UUID, public.pending_operation_type, UUID, UUID, BIGINT),
  public.fn_confirm_pending_expense_consistent(UUID, UUID, TEXT, UUID, public.expense_source, TIMESTAMPTZ, UUID, UUID, UUID, UUID, TEXT, NUMERIC, DATE, TEXT, public.expense_source, JSONB, JSONB, UUID, UUID, BIGINT),
  public.fn_confirm_pending_income_consistent(UUID, UUID, TEXT, UUID, public.expense_source, TIMESTAMPTZ, UUID, UUID, NUMERIC, DATE, TEXT, UUID, UUID, UUID, BIGINT)
TO service_role;

COMMIT;
