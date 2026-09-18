BEGIN;

CREATE FUNCTION public.fn_reject_pending_proposal(
  p_proposal_id UUID,
  p_household_id UUID,
  p_conversation_key TEXT,
  p_actor_member_id UUID DEFAULT NULL,
  p_context_source public.expense_source DEFAULT NULL,
  p_operation_type public.pending_operation_type DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  proposal_row public.tb_pending_proposals%ROWTYPE;
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
      'expense_id', NULL,
      'income_id', NULL
    );
  END IF;

  IF p_actor_member_id IS NULL
     OR p_context_source IS NULL
     OR proposal_row.payload ->> 'actorMemberId' IS DISTINCT FROM p_actor_member_id::TEXT
     OR proposal_row.payload ->> 'source' IS DISTINCT FROM p_context_source::TEXT THEN
    RETURN jsonb_build_object(
      'status', 'NOT_FOUND',
      'expense_id', NULL,
      'income_id', NULL
    );
  END IF;

  IF p_operation_type IS NULL
     OR p_operation_type NOT IN ('CREATE_EXPENSE', 'CREATE_INCOME')
     OR proposal_row.operation_type <> p_operation_type
     OR proposal_row.operation_type NOT IN ('CREATE_EXPENSE', 'CREATE_INCOME') THEN
    RETURN jsonb_build_object(
      'status', 'INVALID_OPERATION',
      'expense_id', NULL,
      'income_id', NULL
    );
  END IF;

  IF proposal_row.status = 'REJECTED' THEN
    RETURN jsonb_build_object(
      'status', 'REJECTED',
      'expense_id', NULL,
      'income_id', NULL
    );
  END IF;

  IF proposal_row.status = 'COMPLETED' THEN
    RETURN jsonb_build_object(
      'status', 'ALREADY_COMPLETED',
      'expense_id', proposal_row.expense_id,
      'income_id', proposal_row.income_id
    );
  END IF;

  IF proposal_row.status <> 'AWAITING_CONFIRMATION' THEN
    RAISE EXCEPTION 'Unsupported pending proposal status'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.tb_pending_proposals
     SET status = 'REJECTED',
         resolved_at = now(),
         expense_id = NULL,
         income_id = NULL
   WHERE id = p_proposal_id
     AND household_id = p_household_id
     AND conversation_key = p_conversation_key
     AND status = 'AWAITING_CONFIRMATION';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pending proposal could not be rejected'
      USING ERRCODE = '40001';
  END IF;

  RETURN jsonb_build_object(
    'status', 'REJECTED',
    'expense_id', NULL,
    'income_id', NULL
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_reject_pending_proposal(
  UUID,
  UUID,
  TEXT,
  UUID,
  public.expense_source,
  public.pending_operation_type
)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.fn_reject_pending_proposal(
  UUID,
  UUID,
  TEXT,
  UUID,
  public.expense_source,
  public.pending_operation_type
)
TO service_role;

COMMIT;
