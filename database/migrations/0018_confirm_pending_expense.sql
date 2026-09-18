BEGIN;

CREATE FUNCTION public.fn_confirm_pending_expense(
  p_proposal_id UUID,
  p_household_id UUID,
  p_conversation_key TEXT,
  p_actor_member_id UUID DEFAULT NULL,
  p_context_source public.expense_source DEFAULT NULL,
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
  proposal_row public.tb_pending_proposals%ROWTYPE;
  created_expense_id UUID;
BEGIN
  SELECT *
    INTO proposal_row
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

  IF p_actor_member_id IS NULL
     OR p_context_source IS NULL
     OR proposal_row.payload ->> 'actorMemberId' IS DISTINCT FROM p_actor_member_id::TEXT
     OR proposal_row.payload ->> 'source' IS DISTINCT FROM p_context_source::TEXT THEN
    RETURN jsonb_build_object(
      'status', 'NOT_FOUND',
      'expense_id', NULL
    );
  END IF;

  IF proposal_row.operation_type <> 'CREATE_EXPENSE' THEN
    RETURN jsonb_build_object(
      'status', 'INVALID_OPERATION',
      'expense_id', NULL
    );
  END IF;

  IF proposal_row.status = 'COMPLETED' THEN
    IF proposal_row.expense_id IS NULL THEN
      RAISE EXCEPTION 'Completed CREATE_EXPENSE proposal has no expense reference'
        USING ERRCODE = '23514';
    END IF;

    RETURN jsonb_build_object(
      'status', 'ALREADY_COMPLETED',
      'expense_id', proposal_row.expense_id
    );
  END IF;

  IF proposal_row.status = 'REJECTED' THEN
    RETURN jsonb_build_object(
      'status', 'REJECTED',
      'expense_id', NULL
    );
  END IF;

  IF proposal_row.status <> 'AWAITING_CONFIRMATION' THEN
    RAISE EXCEPTION 'Unsupported pending proposal status'
      USING ERRCODE = '22023';
  END IF;

  IF p_created_by IS NULL
     OR p_paid_by IS NULL
     OR p_total_amount IS NULL
     OR p_expense_date IS NULL
     OR p_source IS NULL
     OR p_items IS NULL
     OR p_distributions IS NULL THEN
    RAISE EXCEPTION 'Expense confirmation input is incomplete'
      USING ERRCODE = '22023';
  END IF;

  created_expense_id := public.fn_create_expense(
    p_household_id,
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

  UPDATE public.tb_pending_proposals
     SET status = 'COMPLETED',
         resolved_at = now(),
         expense_id = created_expense_id,
         income_id = NULL
   WHERE id = p_proposal_id
     AND household_id = p_household_id
     AND status = 'AWAITING_CONFIRMATION';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pending proposal could not be completed'
      USING ERRCODE = '40001';
  END IF;

  RETURN jsonb_build_object(
    'status', 'CREATED',
    'expense_id', created_expense_id
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_confirm_pending_expense(
  UUID,
  UUID,
  TEXT,
  UUID,
  public.expense_source,
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

GRANT EXECUTE ON FUNCTION public.fn_confirm_pending_expense(
  UUID,
  UUID,
  TEXT,
  UUID,
  public.expense_source,
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

COMMIT;
