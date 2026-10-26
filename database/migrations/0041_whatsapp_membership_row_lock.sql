BEGIN;

-- Encapsulate the row lock required by WhatsApp context validation. The
-- service role can validate an exact user/household/member tuple without
-- receiving write privileges on household memberships.
CREATE FUNCTION public.fn_lock_whatsapp_active_membership(
  p_user_id UUID,
  p_household_id UUID,
  p_member_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  locked_member_id UUID;
BEGIN
  IF p_user_id IS NULL OR p_household_id IS NULL OR p_member_id IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT member.id INTO locked_member_id
    FROM public.tb_household_members AS member
   WHERE member.id = p_member_id
     AND member.household_id = p_household_id
     AND member.user_id = p_user_id
     AND member.status = 'ACTIVE'
   FOR SHARE;

  RETURN locked_member_id IS NOT NULL;
END;
$$;

ALTER FUNCTION public.fn_lock_whatsapp_active_membership(UUID, UUID, UUID)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_lock_whatsapp_active_membership(UUID, UUID, UUID)
  FROM PUBLIC, service_role;
DO $roles$
DECLARE
  application_role TEXT;
BEGIN
  FOR application_role IN
    SELECT rolname FROM pg_catalog.pg_roles
     WHERE rolname IN ('anon', 'authenticated')
  LOOP
    EXECUTE format(
      'REVOKE ALL ON FUNCTION public.fn_lock_whatsapp_active_membership(UUID, UUID, UUID) FROM %I',
      application_role
    );
  END LOOP;
END;
$roles$;
GRANT EXECUTE ON FUNCTION public.fn_lock_whatsapp_active_membership(UUID, UUID, UUID)
  TO service_role;

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
SECURITY INVOKER
AS $$
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
SECURITY INVOKER
AS $$
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

COMMIT;
