BEGIN;

CREATE FUNCTION public.fn_confirm_pending_income(
  p_proposal_id UUID,
  p_household_id UUID,
  p_conversation_key TEXT,
  p_actor_member_id UUID DEFAULT NULL,
  p_context_source public.expense_source DEFAULT NULL,
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
  proposal_row public.tb_pending_proposals%ROWTYPE;
  created_income_id UUID;
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
      'income_id', NULL
    );
  END IF;

  IF p_actor_member_id IS NULL
     OR p_context_source IS NULL
     OR proposal_row.payload ->> 'actorMemberId' IS DISTINCT FROM p_actor_member_id::TEXT
     OR proposal_row.payload ->> 'source' IS DISTINCT FROM p_context_source::TEXT THEN
    RETURN jsonb_build_object(
      'status', 'NOT_FOUND',
      'income_id', NULL
    );
  END IF;

  IF proposal_row.operation_type <> 'CREATE_INCOME' THEN
    RETURN jsonb_build_object(
      'status', 'INVALID_OPERATION',
      'income_id', NULL
    );
  END IF;

  IF proposal_row.status = 'COMPLETED' THEN
    IF proposal_row.income_id IS NULL THEN
      RAISE EXCEPTION 'Completed CREATE_INCOME proposal has no income reference'
        USING ERRCODE = '23514';
    END IF;

    RETURN jsonb_build_object(
      'status', 'ALREADY_COMPLETED',
      'income_id', proposal_row.income_id
    );
  END IF;

  IF proposal_row.status = 'REJECTED' THEN
    RETURN jsonb_build_object(
      'status', 'REJECTED',
      'income_id', NULL
    );
  END IF;

  IF proposal_row.status <> 'AWAITING_CONFIRMATION' THEN
    RAISE EXCEPTION 'Unsupported pending proposal status'
      USING ERRCODE = '22023';
  END IF;

  IF p_created_by IS NULL
     OR p_member_id IS NULL
     OR p_amount IS NULL
     OR p_income_date IS NULL
     OR p_description IS NULL THEN
    RAISE EXCEPTION 'Income confirmation input is incomplete'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.tb_incomes (
    household_id,
    created_by,
    member_id,
    amount,
    income_date,
    description,
    category_id
  )
  VALUES (
    p_household_id,
    p_created_by,
    p_member_id,
    p_amount,
    p_income_date,
    p_description,
    p_category_id
  )
  RETURNING id INTO created_income_id;

  UPDATE public.tb_pending_proposals
     SET status = 'COMPLETED',
         resolved_at = now(),
         expense_id = NULL,
         income_id = created_income_id
   WHERE id = p_proposal_id
     AND household_id = p_household_id
     AND conversation_key = p_conversation_key
     AND status = 'AWAITING_CONFIRMATION';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pending proposal could not be completed'
      USING ERRCODE = '40001';
  END IF;

  RETURN jsonb_build_object(
    'status', 'CREATED',
    'income_id', created_income_id
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_confirm_pending_income(
  UUID,
  UUID,
  TEXT,
  UUID,
  public.expense_source,
  UUID,
  UUID,
  NUMERIC,
  DATE,
  TEXT,
  UUID
)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.fn_confirm_pending_income(
  UUID,
  UUID,
  TEXT,
  UUID,
  public.expense_source,
  UUID,
  UUID,
  NUMERIC,
  DATE,
  TEXT,
  UUID
)
TO service_role;

COMMIT;
