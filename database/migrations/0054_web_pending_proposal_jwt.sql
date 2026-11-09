BEGIN;

-- Web proposal confirmation is a JWT-authenticated boundary. It derives the
-- actor and canonical conversation in PostgreSQL, then reuses the existing
-- eligibility/consistency/base confirmation chain. The old service_role
-- grants on those generic functions are intentionally retained for the
-- WhatsApp/legacy compatibility period; revoking them is a separate cutover.
-- The stored Web confirmation snapshot is server-produced. Remove inherited
-- direct API-role access to proposals so authenticated callers cannot replace
-- both the presented payload and its persistence snapshot before confirmation.
-- service_role access from 0011/0016 is deliberately preserved.
REVOKE ALL ON TABLE public.tb_pending_proposals
  FROM PUBLIC, anon, authenticated;

DO $pending_proposal_column_acl$
DECLARE
  target_column RECORD;
BEGIN
  FOR target_column IN
    SELECT attribute.attname
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid = 'public.tb_pending_proposals'::regclass
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE SELECT (%1$I) ON TABLE public.tb_pending_proposals FROM PUBLIC, anon, authenticated',
      target_column.attname
    );
    EXECUTE pg_catalog.format(
      'REVOKE INSERT (%1$I) ON TABLE public.tb_pending_proposals FROM PUBLIC, anon, authenticated',
      target_column.attname
    );
    EXECUTE pg_catalog.format(
      'REVOKE UPDATE (%1$I) ON TABLE public.tb_pending_proposals FROM PUBLIC, anon, authenticated',
      target_column.attname
    );
    EXECUTE pg_catalog.format(
      'REVOKE REFERENCES (%1$I) ON TABLE public.tb_pending_proposals FROM PUBLIC, anon, authenticated',
      target_column.attname
    );
  END LOOP;
END;
$pending_proposal_column_acl$;

-- Validate the persisted split before any value reaches the generic
-- confirmation chain's NUMERIC(p,s) casts. This reproduces
-- calculateSplitAmounts: floor each percentage allocation in cents, then give
-- residual cents to the largest remainder, breaking ties by lowercase member
-- UUID (bytewise UUID text order under C collation).
CREATE FUNCTION public.fn_assert_web_expense_distribution_snapshot(
  p_presented_total jsonb,
  p_presented_splits jsonb,
  p_persistence_total jsonb,
  p_distributions jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_presented_total numeric;
  v_persistence_total numeric;
  v_total_cents bigint;
  v_split record;
  v_distribution jsonb;
  v_member_id uuid;
  v_percentage numeric;
  v_distribution_percentage numeric;
  v_distribution_amount numeric;
  v_basis_points bigint;
  v_percentage_total bigint := 0;
  v_numerator bigint;
  v_base_cents bigint[] := ARRAY[]::bigint[];
  v_remainders bigint[] := ARRAY[]::bigint[];
  v_member_ids uuid[] := ARRAY[]::uuid[];
  v_distribution_amounts numeric[] := ARRAY[]::numeric[];
  v_bonus_cents boolean[];
  v_allocation_count integer;
  v_residual_cents bigint;
  v_floor_total numeric;
  v_distribution_total numeric := 0;
  v_expected_amount numeric;
  v_index integer;
BEGIN
  IF pg_catalog.jsonb_typeof(p_presented_total) IS DISTINCT FROM 'number'
     OR pg_catalog.jsonb_typeof(p_persistence_total) IS DISTINCT FROM 'number'
     OR pg_catalog.jsonb_typeof(p_presented_splits) IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_typeof(p_distributions) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Web Expense distribution snapshot is invalid'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_presented_total := (p_presented_total #>> '{}')::numeric;
    v_persistence_total := (p_persistence_total #>> '{}')::numeric;
  EXCEPTION
    WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Web Expense total amount is invalid'
        USING ERRCODE = '22023';
  END;

  PERFORM public.fn_assert_web_numeric_scale(
    v_presented_total, 2, 'Presented Expense total'
  );
  PERFORM public.fn_assert_web_numeric_scale(
    v_persistence_total, 2, 'Persisted Expense total'
  );
  IF v_presented_total IS DISTINCT FROM v_persistence_total
     OR v_persistence_total <= 0
     OR v_persistence_total > 999999999999.99 THEN
    RAISE EXCEPTION 'Web Expense total amount is inconsistent or out of range'
      USING ERRCODE = '22023';
  END IF;

  v_allocation_count := pg_catalog.jsonb_array_length(p_presented_splits);
  IF v_allocation_count = 0
     OR v_allocation_count <> pg_catalog.jsonb_array_length(p_distributions) THEN
    RAISE EXCEPTION 'Web Expense split and distribution counts differ'
      USING ERRCODE = '22023';
  END IF;

  v_total_cents := (v_persistence_total * 100)::bigint;
  FOR v_split IN
    SELECT elements.value, elements.ordinality
      FROM pg_catalog.jsonb_array_elements(p_presented_splits)
        WITH ORDINALITY AS elements(value, ordinality)
     ORDER BY elements.ordinality
  LOOP
    v_distribution := p_distributions -> (v_split.ordinality - 1)::integer;
    IF pg_catalog.jsonb_typeof(v_split.value) IS DISTINCT FROM 'object'
       OR pg_catalog.jsonb_typeof(v_distribution) IS DISTINCT FROM 'object'
       OR pg_catalog.jsonb_typeof(v_split.value -> 'householdMemberId') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(v_distribution -> 'householdMemberId') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(v_split.value -> 'percentage') IS DISTINCT FROM 'number'
       OR pg_catalog.jsonb_typeof(v_distribution -> 'percentage') IS DISTINCT FROM 'number'
       OR pg_catalog.jsonb_typeof(v_distribution -> 'amount') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'Web Expense split or distribution entry is invalid'
        USING ERRCODE = '22023';
    END IF;

    BEGIN
      v_member_id := (v_split.value ->> 'householdMemberId')::uuid;
      IF v_member_id IS DISTINCT FROM
         (v_distribution ->> 'householdMemberId')::uuid THEN
        RAISE EXCEPTION 'Web Expense split member order is inconsistent'
          USING ERRCODE = '22023';
      END IF;
      v_percentage := (v_split.value ->> 'percentage')::numeric;
      v_distribution_percentage := (v_distribution ->> 'percentage')::numeric;
      v_distribution_amount := (v_distribution ->> 'amount')::numeric;
    EXCEPTION
      WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RAISE EXCEPTION 'Web Expense split or distribution value is invalid'
          USING ERRCODE = '22023';
    END;

    IF v_member_id = ANY(v_member_ids) THEN
      RAISE EXCEPTION 'Web Expense splits contain a duplicate member'
        USING ERRCODE = '22023';
    END IF;
    PERFORM public.fn_assert_web_numeric_scale(
      v_percentage, 2, 'Expense split percentage'
    );
    PERFORM public.fn_assert_web_numeric_scale(
      v_distribution_percentage, 2, 'Expense distribution percentage'
    );
    PERFORM public.fn_assert_web_numeric_scale(
      v_distribution_amount, 2, 'Expense distribution amount'
    );
    IF v_percentage < 0 OR v_percentage > 100
       OR v_distribution_percentage IS DISTINCT FROM v_percentage
       OR v_distribution_amount < 0
       OR v_distribution_amount > 999999999999.99 THEN
      RAISE EXCEPTION 'Web Expense distribution is inconsistent or out of range'
        USING ERRCODE = '22023';
    END IF;

    v_basis_points := (v_percentage * 100)::bigint;
    v_percentage_total := v_percentage_total + v_basis_points;
    v_numerator := v_total_cents * v_basis_points;
    v_member_ids := pg_catalog.array_append(v_member_ids, v_member_id);
    v_base_cents := pg_catalog.array_append(
      v_base_cents, v_numerator / 10000
    );
    v_remainders := pg_catalog.array_append(
      v_remainders, v_numerator % 10000
    );
    v_distribution_amounts := pg_catalog.array_append(
      v_distribution_amounts, v_distribution_amount
    );
    v_distribution_total := v_distribution_total + v_distribution_amount;
  END LOOP;

  IF v_percentage_total <> 10000
     OR v_distribution_total IS DISTINCT FROM v_persistence_total THEN
    RAISE EXCEPTION 'Web Expense split totals are inconsistent'
      USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(pg_catalog.sum(allocation.cents), 0)
    INTO v_floor_total
    FROM pg_catalog.unnest(v_base_cents) AS allocation(cents);
  v_residual_cents := v_total_cents - v_floor_total::bigint;
  IF v_residual_cents < 0 OR v_residual_cents >= v_allocation_count THEN
    RAISE EXCEPTION 'Web Expense residual allocation is invalid'
      USING ERRCODE = '22023';
  END IF;

  v_bonus_cents := pg_catalog.array_fill(false, ARRAY[v_allocation_count]);
  FOR v_index IN
    SELECT positions.position
      FROM pg_catalog.generate_subscripts(v_member_ids, 1) AS positions(position)
     ORDER BY v_remainders[positions.position] DESC,
              pg_catalog.lower(v_member_ids[positions.position]::text) COLLATE "C" ASC
     LIMIT v_residual_cents
  LOOP
    v_bonus_cents[v_index] := true;
  END LOOP;

  FOR v_index IN 1..v_allocation_count LOOP
    v_expected_amount := (
      v_base_cents[v_index] + CASE WHEN v_bonus_cents[v_index] THEN 1 ELSE 0 END
    )::numeric / 100;
    IF v_distribution_amounts[v_index] IS DISTINCT FROM v_expected_amount THEN
      RAISE EXCEPTION 'Web Expense distribution amount does not match approved splits'
        USING ERRCODE = '22023';
    END IF;
  END LOOP;
END;
$$;

CREATE FUNCTION public.fn_confirm_web_pending_expense(
  p_proposal_id uuid,
  p_household_id uuid,
  p_expected_updated_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_auth_user_id uuid := auth.uid();
  v_actor_member_id uuid;
  v_conversation_key text;
  v_proposal public.tb_pending_proposals%ROWTYPE;
  v_snapshot jsonb;
  v_presented jsonb;
  v_persistence jsonb;
  v_member_id uuid;
  v_category_ids uuid[];
BEGIN
  IF v_auth_user_id IS NULL
     OR auth.role() IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION 'Financial access is unavailable'
      USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
  END IF;

  v_actor_member_id := public.fn_require_web_financial_actor(p_household_id);
  v_conversation_key := 'web:' || p_household_id::text || ':' || v_actor_member_id::text;

  SELECT * INTO v_proposal
    FROM public.tb_pending_proposals AS proposal
   WHERE proposal.id = p_proposal_id
     AND proposal.household_id = p_household_id
     AND proposal.conversation_key = v_conversation_key
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'NOT_FOUND', 'expense_id', NULL);
  END IF;

  IF v_proposal.payload ->> 'actorMemberId' IS DISTINCT FROM v_actor_member_id::text
     OR v_proposal.payload ->> 'source' IS DISTINCT FROM 'WEB'
     OR v_proposal.actor_member_id IS DISTINCT FROM v_actor_member_id
     OR v_proposal.source IS DISTINCT FROM 'WEB' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'NOT_FOUND', 'expense_id', NULL);
  END IF;

  IF v_proposal.operation_type IS DISTINCT FROM 'CREATE_EXPENSE' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'INVALID_OPERATION', 'expense_id', NULL);
  END IF;

  IF v_proposal.status = 'COMPLETED' THEN
    IF v_proposal.expense_id IS NULL THEN
      RAISE EXCEPTION 'Completed CREATE_EXPENSE proposal has no expense reference'
        USING ERRCODE = '23514';
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'status', 'ALREADY_COMPLETED', 'expense_id', v_proposal.expense_id
    );
  END IF;
  IF v_proposal.status = 'REJECTED' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'REJECTED', 'expense_id', NULL);
  END IF;
  IF v_proposal.status IS DISTINCT FROM 'AWAITING_CONFIRMATION' THEN
    RAISE EXCEPTION 'Unsupported pending proposal status' USING ERRCODE = '22023';
  END IF;
  IF p_expected_updated_at IS NULL
     OR v_proposal.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'Pending proposal changed before confirmation' USING ERRCODE = '40001';
  END IF;

  v_snapshot := v_proposal.payload -> '_web_confirmation';
  v_presented := v_snapshot -> 'presented';
  v_persistence := v_snapshot -> 'persistence';
  IF pg_catalog.jsonb_typeof(v_snapshot) IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(v_presented) IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(v_persistence) IS DISTINCT FROM 'object'
     OR v_presented IS DISTINCT FROM v_proposal.payload -> 'expense'
     OR pg_catalog.jsonb_typeof(v_presented -> 'splits') IS DISTINCT FROM 'array'
     OR (
       v_presented ? 'items'
       AND pg_catalog.jsonb_typeof(v_presented -> 'items') NOT IN ('array', 'null')
     )
     OR pg_catalog.jsonb_typeof(v_persistence -> 'items') IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_typeof(v_persistence -> 'distributions') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Web proposal confirmation payload is invalid'
      USING ERRCODE = '22023';
  END IF;

  PERFORM public.fn_assert_web_expense_distribution_snapshot(
    v_presented -> 'totalAmount',
    v_presented -> 'splits',
    v_persistence -> 'totalAmount',
    v_persistence -> 'distributions'
  );
  -- Validate item money and quantity against the original JSON numbers before
  -- the established 0003 writer applies its NUMERIC(p,s) typmods.
  PERFORM public.fn_assert_web_expense_numeric_scales(
    (v_persistence ->> 'totalAmount')::numeric,
    v_persistence -> 'items',
    v_persistence -> 'distributions'
  );

  -- The snapshot was produced by the existing domain preparation function at
  -- proposal creation/correction. Reject stale or mismatched source fields;
  -- callers cannot provide financial values to this RPC at all.
  IF v_persistence ->> 'householdId' IS DISTINCT FROM p_household_id::text
     OR v_persistence ->> 'createdBy' IS DISTINCT FROM v_actor_member_id::text
     OR v_persistence ->> 'source' IS DISTINCT FROM 'WEB'
     OR (v_persistence ->> 'paidByMemberId')::uuid
          IS DISTINCT FROM (v_presented ->> 'paidByMemberId')::uuid
     OR (v_persistence ->> 'totalAmount')::numeric
          IS DISTINCT FROM (v_presented ->> 'totalAmount')::numeric
     OR v_persistence ->> 'expenseDate' IS DISTINCT FROM v_presented ->> 'expenseDate'
     OR v_persistence ->> 'merchant' IS DISTINCT FROM v_presented ->> 'merchant'
     OR v_persistence ->> 'description' IS DISTINCT FROM v_presented ->> 'description'
     OR (v_persistence ->> 'categoryId')::uuid
          IS DISTINCT FROM (v_presented ->> 'categoryId')::uuid
     OR (v_persistence ->> 'receiptId')::uuid
          IS DISTINCT FROM (v_presented ->> 'receiptId')::uuid
     OR coalesce(v_persistence -> 'items', '[]'::jsonb)
          IS DISTINCT FROM coalesce(nullif(v_presented -> 'items', 'null'::jsonb), '[]'::jsonb)
      THEN
    RAISE EXCEPTION 'Web proposal confirmation payload is unavailable or stale'
      USING ERRCODE = '40001';
  END IF;

  IF pg_catalog.jsonb_typeof(v_persistence -> 'items') IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_typeof(v_persistence -> 'distributions') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Web proposal confirmation payload is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT ARRAY[(v_persistence ->> 'categoryId')::uuid] || coalesce(
    ARRAY(
      SELECT (item.value ->> 'categoryId')::uuid
        FROM pg_catalog.jsonb_array_elements(v_persistence -> 'items') AS item(value)
       WHERE pg_catalog.jsonb_typeof(item.value -> 'categoryId') = 'string'
    ), ARRAY[]::uuid[]
  ) INTO v_category_ids;
  PERFORM public.fn_assert_web_financial_categories('EXPENSE', v_category_ids);

  PERFORM 1
    FROM public.tb_household_members AS member
   WHERE member.id = (v_persistence ->> 'paidByMemberId')::uuid
     AND member.household_id = p_household_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial access is unavailable'
      USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
  END IF;

  FOR v_member_id IN
    SELECT DISTINCT (distribution.value ->> 'householdMemberId')::uuid
      FROM pg_catalog.jsonb_array_elements(v_persistence -> 'distributions') AS distribution(value)
  LOOP
    PERFORM 1
      FROM public.tb_household_members AS member
     WHERE member.id = v_member_id
       AND member.household_id = p_household_id
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Financial access is unavailable'
        USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
    END IF;
  END LOOP;

  RETURN public.fn_confirm_pending_expense_eligible(
    v_auth_user_id,
    p_proposal_id,
    p_household_id,
    v_conversation_key,
    v_actor_member_id,
    'WEB'::public.expense_source,
    p_expected_updated_at,
    v_actor_member_id,
    (v_persistence ->> 'paidByMemberId')::uuid,
    (v_persistence ->> 'categoryId')::uuid,
    (v_persistence ->> 'receiptId')::uuid,
    v_persistence ->> 'merchant',
    (v_persistence ->> 'totalAmount')::numeric,
    (v_persistence ->> 'expenseDate')::date,
    v_persistence ->> 'description',
    'WEB'::public.expense_source,
    v_persistence -> 'items',
    v_persistence -> 'distributions',
    NULL,
    NULL,
    NULL
  );
END;
$$;

CREATE FUNCTION public.fn_confirm_web_pending_income(
  p_proposal_id uuid,
  p_household_id uuid,
  p_expected_updated_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_auth_user_id uuid := auth.uid();
  v_actor_member_id uuid;
  v_conversation_key text;
  v_proposal public.tb_pending_proposals%ROWTYPE;
  v_snapshot jsonb;
  v_presented jsonb;
  v_persistence jsonb;
  v_amount numeric;
  v_presented_amount numeric;
BEGIN
  IF v_auth_user_id IS NULL
     OR auth.role() IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION 'Financial access is unavailable'
      USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
  END IF;

  v_actor_member_id := public.fn_require_web_financial_actor(p_household_id);
  v_conversation_key := 'web:' || p_household_id::text || ':' || v_actor_member_id::text;

  SELECT * INTO v_proposal
    FROM public.tb_pending_proposals AS proposal
   WHERE proposal.id = p_proposal_id
     AND proposal.household_id = p_household_id
     AND proposal.conversation_key = v_conversation_key
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'NOT_FOUND', 'income_id', NULL);
  END IF;
  IF v_proposal.payload ->> 'actorMemberId' IS DISTINCT FROM v_actor_member_id::text
     OR v_proposal.payload ->> 'source' IS DISTINCT FROM 'WEB'
     OR v_proposal.actor_member_id IS DISTINCT FROM v_actor_member_id
     OR v_proposal.source IS DISTINCT FROM 'WEB' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'NOT_FOUND', 'income_id', NULL);
  END IF;
  IF v_proposal.operation_type IS DISTINCT FROM 'CREATE_INCOME' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'INVALID_OPERATION', 'income_id', NULL);
  END IF;

  IF v_proposal.status = 'COMPLETED' THEN
    IF v_proposal.income_id IS NULL THEN
      RAISE EXCEPTION 'Completed CREATE_INCOME proposal has no income reference'
        USING ERRCODE = '23514';
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'status', 'ALREADY_COMPLETED', 'income_id', v_proposal.income_id
    );
  END IF;
  IF v_proposal.status = 'REJECTED' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'REJECTED', 'income_id', NULL);
  END IF;
  IF v_proposal.status IS DISTINCT FROM 'AWAITING_CONFIRMATION' THEN
    RAISE EXCEPTION 'Unsupported pending proposal status' USING ERRCODE = '22023';
  END IF;
  IF p_expected_updated_at IS NULL
     OR v_proposal.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'Pending proposal changed before confirmation' USING ERRCODE = '40001';
  END IF;

  v_snapshot := v_proposal.payload -> '_web_confirmation';
  v_presented := v_snapshot -> 'presented';
  v_persistence := v_snapshot -> 'persistence';
  IF pg_catalog.jsonb_typeof(v_snapshot) IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(v_presented) IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(v_persistence) IS DISTINCT FROM 'object'
     OR v_presented IS DISTINCT FROM v_proposal.payload -> 'income' THEN
    RAISE EXCEPTION 'Web proposal confirmation payload is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.jsonb_typeof(v_presented -> 'amount') IS DISTINCT FROM 'number'
     OR pg_catalog.jsonb_typeof(v_persistence -> 'amount') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'Web Income amount snapshot is invalid'
      USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_amount := (v_persistence ->> 'amount')::numeric;
    v_presented_amount := (v_presented ->> 'amount')::numeric;
  EXCEPTION
    WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Web Income amount is invalid'
        USING ERRCODE = '22023';
  END;
  PERFORM public.fn_assert_web_numeric_scale(
    v_presented_amount, 2, 'Presented Income amount'
  );
  PERFORM public.fn_assert_web_numeric_scale(
    v_amount, 2, 'Persisted Income amount'
  );
  IF v_amount <= 0 OR v_amount > 999999999999.99 THEN
    RAISE EXCEPTION 'Web Income amount is out of range'
      USING ERRCODE = '22023';
  END IF;
  IF v_persistence ->> 'householdId' IS DISTINCT FROM p_household_id::text
     OR v_persistence ->> 'createdBy' IS DISTINCT FROM v_actor_member_id::text
     OR (v_persistence ->> 'memberId')::uuid IS DISTINCT FROM (v_presented ->> 'memberId')::uuid
      OR v_amount IS DISTINCT FROM v_presented_amount
     OR v_persistence ->> 'incomeDate' IS DISTINCT FROM v_presented ->> 'incomeDate'
     OR v_persistence ->> 'description' IS DISTINCT FROM v_presented ->> 'description'
     OR (v_persistence ->> 'categoryId')::uuid IS DISTINCT FROM (v_presented ->> 'categoryId')::uuid THEN
    RAISE EXCEPTION 'Web proposal confirmation payload is unavailable or stale'
      USING ERRCODE = '40001';
  END IF;

  PERFORM 1
    FROM public.tb_household_members AS member
   WHERE member.id = (v_persistence ->> 'memberId')::uuid
     AND member.household_id = p_household_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial access is unavailable'
      USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
  END IF;

  PERFORM public.fn_assert_web_financial_categories(
    'INCOME', ARRAY[(v_persistence ->> 'categoryId')::uuid]
  );

  RETURN public.fn_confirm_pending_income_eligible(
    v_auth_user_id,
    p_proposal_id,
    p_household_id,
    v_conversation_key,
    v_actor_member_id,
    'WEB'::public.expense_source,
    p_expected_updated_at,
    v_actor_member_id,
    (v_persistence ->> 'memberId')::uuid,
    (v_persistence ->> 'amount')::numeric,
    (v_persistence ->> 'incomeDate')::date,
    v_persistence ->> 'description',
    (v_persistence ->> 'categoryId')::uuid,
    NULL,
    NULL,
    NULL
  );
END;
$$;

CREATE FUNCTION public.fn_reject_web_pending_proposal(
  p_proposal_id uuid,
  p_household_id uuid,
  p_operation_type public.pending_operation_type
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_auth_user_id uuid := auth.uid();
  v_actor_member_id uuid;
  v_conversation_key text;
  v_proposal public.tb_pending_proposals%ROWTYPE;
BEGIN
  IF v_auth_user_id IS NULL
     OR auth.role() IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION 'Financial access is unavailable'
      USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
  END IF;

  v_actor_member_id := public.fn_require_web_financial_actor(p_household_id);
  v_conversation_key := 'web:' || p_household_id::text || ':' || v_actor_member_id::text;

  SELECT * INTO v_proposal
    FROM public.tb_pending_proposals AS proposal
   WHERE proposal.id = p_proposal_id
     AND proposal.household_id = p_household_id
     AND proposal.conversation_key = v_conversation_key
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'NOT_FOUND', 'expense_id', NULL, 'income_id', NULL
    );
  END IF;
  IF v_proposal.payload ->> 'actorMemberId' IS DISTINCT FROM v_actor_member_id::text
     OR v_proposal.payload ->> 'source' IS DISTINCT FROM 'WEB'
     OR v_proposal.actor_member_id IS DISTINCT FROM v_actor_member_id
     OR v_proposal.source IS DISTINCT FROM 'WEB' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'NOT_FOUND', 'expense_id', NULL, 'income_id', NULL
    );
  END IF;
  IF p_operation_type IS NULL
     OR p_operation_type NOT IN ('CREATE_EXPENSE', 'CREATE_INCOME')
     OR v_proposal.operation_type IS DISTINCT FROM p_operation_type THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'INVALID_OPERATION', 'expense_id', NULL, 'income_id', NULL
    );
  END IF;

  -- The generic INVOKER function executes internally as this postgres-owned
  -- SECURITY DEFINER wrapper; WhatsApp keeps its independent 0047 wrapper.
  RETURN public.fn_reject_pending_proposal(
    p_proposal_id,
    p_household_id,
    v_conversation_key,
    v_actor_member_id,
    'WEB'::public.expense_source,
    p_operation_type
  );
END;
$$;

ALTER FUNCTION public.fn_confirm_web_pending_expense(uuid,uuid,timestamptz) OWNER TO postgres;
ALTER FUNCTION public.fn_confirm_web_pending_income(uuid,uuid,timestamptz) OWNER TO postgres;
ALTER FUNCTION public.fn_reject_web_pending_proposal(uuid,uuid,public.pending_operation_type) OWNER TO postgres;
ALTER FUNCTION public.fn_assert_web_expense_distribution_snapshot(jsonb,jsonb,jsonb,jsonb) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_assert_web_expense_distribution_snapshot(jsonb,jsonb,jsonb,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.fn_confirm_web_pending_expense(uuid,uuid,timestamptz)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.fn_confirm_web_pending_income(uuid,uuid,timestamptz)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.fn_reject_web_pending_proposal(uuid,uuid,public.pending_operation_type)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.fn_confirm_web_pending_expense(uuid,uuid,timestamptz)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_confirm_web_pending_income(uuid,uuid,timestamptz)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_reject_web_pending_proposal(uuid,uuid,public.pending_operation_type)
  TO authenticated;

COMMIT;
