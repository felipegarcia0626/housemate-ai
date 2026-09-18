BEGIN;

-- Confirmation wrappers hold the proposal lock while fencing the Node-side
-- preparation against a payload update that occurred after it was read.
CREATE FUNCTION public.fn_confirm_pending_expense_consistent(
  p_proposal_id UUID,
  p_household_id UUID,
  p_conversation_key TEXT,
  p_actor_member_id UUID DEFAULT NULL,
  p_context_source public.expense_source DEFAULT NULL,
  p_expected_updated_at TIMESTAMPTZ DEFAULT NULL,
  p_created_by UUID DEFAULT NULL,
  p_paid_by UUID DEFAULT NULL,
  p_category_id UUID DEFAULT NULL,
  p_receipt_id UUID DEFAULT NULL,
  p_merchant TEXT DEFAULT NULL,
  p_total_amount NUMERIC(14,2) DEFAULT NULL,
  p_expense_date DATE DEFAULT NULL,
  p_description TEXT DEFAULT NULL,
  p_source public.expense_source DEFAULT NULL,
  p_items JSONB DEFAULT NULL,
  p_distributions JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  proposal_status public.pending_proposal_status;
  proposal_updated_at TIMESTAMPTZ;
BEGIN
  SELECT status, updated_at
    INTO proposal_status, proposal_updated_at
    FROM public.tb_pending_proposals
   WHERE id = p_proposal_id
     AND household_id = p_household_id
     AND conversation_key = p_conversation_key
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'status', 'NOT_FOUND',
      'expense_id', NULL
    );
  END IF;

  IF proposal_status = 'AWAITING_CONFIRMATION' THEN
    IF p_expected_updated_at IS NULL
       AND (
         p_created_by IS NOT NULL
         OR p_paid_by IS NOT NULL
         OR p_category_id IS NOT NULL
         OR p_receipt_id IS NOT NULL
         OR p_merchant IS NOT NULL
         OR p_total_amount IS NOT NULL
         OR p_expense_date IS NOT NULL
         OR p_description IS NOT NULL
         OR p_source IS NOT NULL
         OR p_items IS NOT NULL
         OR p_distributions IS NOT NULL
       ) THEN
      RAISE EXCEPTION 'Expected pending proposal version is required'
        USING ERRCODE = '22023';
    END IF;

    IF p_expected_updated_at IS NOT NULL
       AND proposal_updated_at IS DISTINCT FROM p_expected_updated_at THEN
      RAISE EXCEPTION 'Pending proposal changed before confirmation'
        USING ERRCODE = '40001';
    END IF;
  END IF;

  RETURN public.fn_confirm_pending_expense(
    p_proposal_id,
    p_household_id,
    p_conversation_key,
    p_actor_member_id,
    p_context_source,
    p_created_by,
    p_paid_by,
    p_category_id,
    p_receipt_id,
    p_merchant,
    p_total_amount,
    p_expense_date,
    p_description,
    p_source,
    p_items,
    p_distributions
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_confirm_pending_expense_consistent(
  UUID,
  UUID,
  TEXT,
  UUID,
  public.expense_source,
  TIMESTAMPTZ,
  UUID,
  UUID,
  UUID,
  UUID,
  TEXT,
  NUMERIC,
  DATE,
  TEXT,
  public.expense_source,
  JSONB,
  JSONB
)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.fn_confirm_pending_expense_consistent(
  UUID,
  UUID,
  TEXT,
  UUID,
  public.expense_source,
  TIMESTAMPTZ,
  UUID,
  UUID,
  UUID,
  UUID,
  TEXT,
  NUMERIC,
  DATE,
  TEXT,
  public.expense_source,
  JSONB,
  JSONB
)
TO service_role;

CREATE FUNCTION public.fn_confirm_pending_income_consistent(
  p_proposal_id UUID,
  p_household_id UUID,
  p_conversation_key TEXT,
  p_actor_member_id UUID DEFAULT NULL,
  p_context_source public.expense_source DEFAULT NULL,
  p_expected_updated_at TIMESTAMPTZ DEFAULT NULL,
  p_created_by UUID DEFAULT NULL,
  p_member_id UUID DEFAULT NULL,
  p_amount NUMERIC(14,2) DEFAULT NULL,
  p_income_date DATE DEFAULT NULL,
  p_description TEXT DEFAULT NULL,
  p_category_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  proposal_status public.pending_proposal_status;
  proposal_updated_at TIMESTAMPTZ;
BEGIN
  SELECT status, updated_at
    INTO proposal_status, proposal_updated_at
    FROM public.tb_pending_proposals
   WHERE id = p_proposal_id
     AND household_id = p_household_id
     AND conversation_key = p_conversation_key
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'status', 'NOT_FOUND',
      'income_id', NULL
    );
  END IF;

  IF proposal_status = 'AWAITING_CONFIRMATION' THEN
    IF p_expected_updated_at IS NULL
       AND (
         p_created_by IS NOT NULL
         OR p_member_id IS NOT NULL
         OR p_amount IS NOT NULL
         OR p_income_date IS NOT NULL
         OR p_description IS NOT NULL
         OR p_category_id IS NOT NULL
       ) THEN
      RAISE EXCEPTION 'Expected pending proposal version is required'
        USING ERRCODE = '22023';
    END IF;

    IF p_expected_updated_at IS NOT NULL
       AND proposal_updated_at IS DISTINCT FROM p_expected_updated_at THEN
      RAISE EXCEPTION 'Pending proposal changed before confirmation'
        USING ERRCODE = '40001';
    END IF;
  END IF;

  RETURN public.fn_confirm_pending_income(
    p_proposal_id,
    p_household_id,
    p_conversation_key,
    p_actor_member_id,
    p_context_source,
    p_created_by,
    p_member_id,
    p_amount,
    p_income_date,
    p_description,
    p_category_id
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_confirm_pending_income_consistent(
  UUID,
  UUID,
  TEXT,
  UUID,
  public.expense_source,
  TIMESTAMPTZ,
  UUID,
  UUID,
  NUMERIC,
  DATE,
  TEXT,
  UUID
)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.fn_confirm_pending_income_consistent(
  UUID,
  UUID,
  TEXT,
  UUID,
  public.expense_source,
  TIMESTAMPTZ,
  UUID,
  UUID,
  NUMERIC,
  DATE,
  TEXT,
  UUID
)
TO service_role;

COMMIT;
