BEGIN;

-- Keep proposal lifecycle operations behind the authenticated Web boundary.
-- The service_role grants from 0011/0016 and the 0047 WhatsApp wrappers remain
-- in place for compatibility; this migration does not alter that perimeter.
CREATE FUNCTION public.fn_assert_web_pending_proposal_snapshot(
  p_household_id uuid,
  p_actor_member_id uuid,
  p_operation_type public.pending_operation_type,
  p_payload jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_snapshot jsonb;
  v_presented jsonb;
  v_persistence jsonb;
  v_category_ids uuid[];
  v_member_id uuid;
  v_item jsonb;
  v_amount numeric;
BEGIN
  IF p_household_id IS NULL OR p_actor_member_id IS NULL
     OR p_operation_type NOT IN ('CREATE_EXPENSE', 'CREATE_INCOME')
     OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.jsonb_object_keys(p_payload) AS key_name
        WHERE key_name NOT IN (
          'actorMemberId', 'source', 'draftId', 'expense', 'income',
          '_web_confirmation'
        )
     ) THEN
    RAISE EXCEPTION 'Web pending proposal payload is invalid'
      USING ERRCODE = '22023';
  END IF;

  IF p_operation_type = 'CREATE_EXPENSE' THEN
    IF p_payload ? 'income'
       OR pg_catalog.jsonb_typeof(p_payload -> 'expense') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Web Expense proposal payload is invalid'
        USING ERRCODE = '22023';
    END IF;

    v_snapshot := p_payload -> '_web_confirmation';
    v_presented := v_snapshot -> 'presented';
    v_persistence := v_snapshot -> 'persistence';
    IF pg_catalog.jsonb_typeof(v_snapshot) IS DISTINCT FROM 'object'
       OR pg_catalog.jsonb_typeof(v_presented) IS DISTINCT FROM 'object'
       OR pg_catalog.jsonb_typeof(v_persistence) IS DISTINCT FROM 'object'
       OR v_presented IS DISTINCT FROM p_payload -> 'expense'
       OR pg_catalog.jsonb_typeof(v_presented -> 'totalAmount') IS DISTINCT FROM 'number'
       OR pg_catalog.jsonb_typeof(v_presented -> 'paidByMemberId') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(v_presented -> 'categoryId') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(v_presented -> 'expenseDate') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(v_presented -> 'splits') IS DISTINCT FROM 'array'
       OR (v_presented ? 'items'
           AND pg_catalog.jsonb_typeof(v_presented -> 'items') NOT IN ('array', 'null'))
       OR pg_catalog.jsonb_typeof(v_persistence -> 'totalAmount') IS DISTINCT FROM 'number'
       OR pg_catalog.jsonb_typeof(v_persistence -> 'paidByMemberId') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(v_persistence -> 'categoryId') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(v_persistence -> 'expenseDate') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(v_persistence -> 'items') IS DISTINCT FROM 'array'
       OR pg_catalog.jsonb_typeof(v_persistence -> 'distributions') IS DISTINCT FROM 'array'
       OR v_persistence ->> 'householdId' IS DISTINCT FROM p_household_id::text
       OR v_persistence ->> 'createdBy' IS DISTINCT FROM p_actor_member_id::text
       OR v_persistence ->> 'source' IS DISTINCT FROM 'WEB'
       OR (v_persistence ->> 'paidByMemberId') IS DISTINCT FROM
          (v_presented ->> 'paidByMemberId')
       OR (v_persistence ->> 'totalAmount') IS DISTINCT FROM
          (v_presented ->> 'totalAmount')
       OR v_persistence ->> 'expenseDate' IS DISTINCT FROM v_presented ->> 'expenseDate'
       OR v_persistence ->> 'merchant' IS DISTINCT FROM v_presented ->> 'merchant'
       OR v_persistence ->> 'description' IS DISTINCT FROM v_presented ->> 'description'
       OR v_persistence ->> 'categoryId' IS DISTINCT FROM v_presented ->> 'categoryId'
       OR v_persistence ->> 'receiptId' IS DISTINCT FROM v_presented ->> 'receiptId'
       OR coalesce(v_persistence -> 'items', '[]'::jsonb)
          IS DISTINCT FROM coalesce(nullif(v_presented -> 'items', 'null'::jsonb), '[]'::jsonb) THEN
      RAISE EXCEPTION 'Web Expense proposal snapshot is inconsistent'
        USING ERRCODE = '22023';
    END IF;

    IF (v_presented ? 'merchant'
        AND pg_catalog.jsonb_typeof(v_presented -> 'merchant') NOT IN ('string', 'null'))
       OR (v_presented ? 'description'
        AND pg_catalog.jsonb_typeof(v_presented -> 'description') NOT IN ('string', 'null'))
       OR (v_presented ? 'receiptId'
        AND pg_catalog.jsonb_typeof(v_presented -> 'receiptId') NOT IN ('string', 'null'))
       OR (v_presented ? 'categoryId'
        AND pg_catalog.jsonb_typeof(v_presented -> 'categoryId') <> 'string') THEN
      RAISE EXCEPTION 'Web Expense proposal fields are invalid'
        USING ERRCODE = '22023';
    END IF;

    FOR v_item IN
      SELECT element.value
        FROM pg_catalog.jsonb_array_elements(v_persistence -> 'items') AS element(value)
    LOOP
      IF pg_catalog.jsonb_typeof(v_item) IS DISTINCT FROM 'object'
         OR pg_catalog.jsonb_typeof(v_item -> 'name') IS DISTINCT FROM 'string'
         OR pg_catalog.jsonb_typeof(v_item -> 'totalAmount') IS DISTINCT FROM 'number'
         OR (v_item ? 'quantity'
             AND pg_catalog.jsonb_typeof(v_item -> 'quantity') NOT IN ('number', 'null'))
         OR (v_item ? 'unitPrice'
             AND pg_catalog.jsonb_typeof(v_item -> 'unitPrice') NOT IN ('number', 'null'))
         OR (v_item ? 'categoryId'
             AND pg_catalog.jsonb_typeof(v_item -> 'categoryId') NOT IN ('string', 'null')) THEN
        RAISE EXCEPTION 'Web Expense item snapshot is invalid'
          USING ERRCODE = '22023';
      END IF;
    END LOOP;

    PERFORM public.fn_assert_web_expense_texts(
      v_persistence ->> 'merchant', true, v_persistence -> 'items'
    );
    PERFORM public.fn_assert_web_expense_distribution_snapshot(
      v_presented -> 'totalAmount', v_presented -> 'splits',
      v_persistence -> 'totalAmount', v_persistence -> 'distributions'
    );
    BEGIN
      v_amount := (v_persistence ->> 'totalAmount')::numeric;
      v_member_id := (v_persistence ->> 'paidByMemberId')::uuid;
      PERFORM (v_persistence ->> 'expenseDate')::date;
    EXCEPTION
      WHEN invalid_text_representation OR datetime_field_overflow
        OR numeric_value_out_of_range THEN
        RAISE EXCEPTION 'Web Expense proposal values are invalid'
          USING ERRCODE = '22023';
    END;
    PERFORM public.fn_assert_web_expense_numeric_scales(
      v_amount, v_persistence -> 'items', v_persistence -> 'distributions'
    );
    IF v_amount <= 0 OR v_amount > 999999999999.99 THEN
      RAISE EXCEPTION 'Web Expense total is out of range'
        USING ERRCODE = '22023';
    END IF;

    v_category_ids := ARRAY[(v_persistence ->> 'categoryId')::uuid] || coalesce(
      ARRAY(
        SELECT (element.value ->> 'categoryId')::uuid
          FROM pg_catalog.jsonb_array_elements(v_persistence -> 'items') AS element(value)
         WHERE pg_catalog.jsonb_typeof(element.value -> 'categoryId') = 'string'
      ), ARRAY[]::uuid[]
    );
    PERFORM public.fn_assert_web_financial_categories('EXPENSE', v_category_ids);

    PERFORM 1
      FROM public.tb_household_members AS member
     WHERE member.id = v_member_id
       AND member.household_id = p_household_id
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Web Expense member is unavailable'
        USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
    END IF;
    FOR v_member_id IN
      SELECT DISTINCT (element.value ->> 'householdMemberId')::uuid
        FROM pg_catalog.jsonb_array_elements(v_persistence -> 'distributions') AS element(value)
    LOOP
      PERFORM 1
        FROM public.tb_household_members AS member
       WHERE member.id = v_member_id
         AND member.household_id = p_household_id
       FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Web Expense distribution member is unavailable'
          USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
      END IF;
    END LOOP;
    RETURN;
  END IF;

  IF p_payload ? 'expense'
     OR pg_catalog.jsonb_typeof(p_payload -> 'income') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Web Income proposal payload is invalid'
      USING ERRCODE = '22023';
  END IF;

  v_snapshot := p_payload -> '_web_confirmation';
  v_presented := v_snapshot -> 'presented';
  v_persistence := v_snapshot -> 'persistence';
  IF pg_catalog.jsonb_typeof(v_snapshot) IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(v_presented) IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(v_persistence) IS DISTINCT FROM 'object'
     OR v_presented IS DISTINCT FROM p_payload -> 'income'
     OR pg_catalog.jsonb_typeof(v_presented -> 'amount') IS DISTINCT FROM 'number'
     OR pg_catalog.jsonb_typeof(v_presented -> 'memberId') IS DISTINCT FROM 'string'
     OR pg_catalog.jsonb_typeof(v_presented -> 'incomeDate') IS DISTINCT FROM 'string'
     OR pg_catalog.jsonb_typeof(v_persistence -> 'amount') IS DISTINCT FROM 'number'
     OR pg_catalog.jsonb_typeof(v_persistence -> 'memberId') IS DISTINCT FROM 'string'
     OR pg_catalog.jsonb_typeof(v_persistence -> 'incomeDate') IS DISTINCT FROM 'string'
     OR v_persistence ->> 'householdId' IS DISTINCT FROM p_household_id::text
     OR v_persistence ->> 'createdBy' IS DISTINCT FROM p_actor_member_id::text
     OR v_persistence ->> 'memberId' IS DISTINCT FROM v_presented ->> 'memberId'
     OR v_persistence ->> 'amount' IS DISTINCT FROM v_presented ->> 'amount'
     OR v_persistence ->> 'incomeDate' IS DISTINCT FROM v_presented ->> 'incomeDate'
     OR v_persistence ->> 'description' IS DISTINCT FROM v_presented ->> 'description'
     OR v_persistence ->> 'categoryId' IS DISTINCT FROM v_presented ->> 'categoryId' THEN
    RAISE EXCEPTION 'Web Income proposal snapshot is inconsistent'
      USING ERRCODE = '22023';
  END IF;

  IF pg_catalog.jsonb_typeof(v_persistence -> 'categoryId') IS DISTINCT FROM 'string'
     OR (v_presented ? 'description'
       AND pg_catalog.jsonb_typeof(v_presented -> 'description') NOT IN ('string', 'null')) THEN
    RAISE EXCEPTION 'Web Income proposal fields are invalid'
      USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_amount := (v_persistence ->> 'amount')::numeric;
    v_member_id := (v_persistence ->> 'memberId')::uuid;
    PERFORM (v_persistence ->> 'incomeDate')::date;
  EXCEPTION
    WHEN invalid_text_representation OR datetime_field_overflow
      OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Web Income proposal values are invalid'
        USING ERRCODE = '22023';
  END;
  PERFORM public.fn_assert_web_numeric_scale(v_amount, 2, 'Income amount');
  IF v_amount <= 0 OR v_amount > 999999999999.99 THEN
    RAISE EXCEPTION 'Web Income amount is out of range'
      USING ERRCODE = '22023';
  END IF;
  PERFORM public.fn_assert_web_financial_categories(
    'INCOME', ARRAY[(v_persistence ->> 'categoryId')::uuid]
  );
  PERFORM 1
    FROM public.tb_household_members AS member
   WHERE member.id = v_member_id
     AND member.household_id = p_household_id
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Web Income member is unavailable'
      USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
  END IF;
END;
$$;

CREATE FUNCTION public.fn_create_web_pending_proposal(
  p_household_id uuid,
  p_conversation_key text,
  p_operation_type public.pending_operation_type,
  p_payload jsonb
) RETURNS public.tb_pending_proposals
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_actor_member_id uuid;
  v_conversation_key text;
  v_payload jsonb;
  v_proposal public.tb_pending_proposals%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR auth.role() IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION 'Financial access is unavailable'
      USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
  END IF;
  v_actor_member_id := public.fn_require_web_financial_actor(p_household_id);
  IF p_operation_type NOT IN ('CREATE_EXPENSE', 'CREATE_INCOME') THEN
    RAISE EXCEPTION 'Unsupported Web proposal operation'
      USING ERRCODE = '22023';
  END IF;
  v_conversation_key := 'web:' || p_household_id::text || ':' || v_actor_member_id::text;
  IF p_conversation_key IS DISTINCT FROM v_conversation_key THEN
    RAISE EXCEPTION 'Web conversation is unavailable'
      USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
  END IF;
  v_payload := p_payload || pg_catalog.jsonb_build_object(
    'actorMemberId', v_actor_member_id::text, 'source', 'WEB'
  );
  PERFORM public.fn_assert_web_pending_proposal_snapshot(
    p_household_id, v_actor_member_id, p_operation_type, v_payload
  );
  INSERT INTO public.tb_pending_proposals(
    household_id, conversation_key, actor_member_id, source,
    operation_type, payload, status
  ) VALUES (
    p_household_id, v_conversation_key, v_actor_member_id, 'WEB',
    p_operation_type, v_payload, 'AWAITING_CONFIRMATION'
  ) RETURNING * INTO v_proposal;
  RETURN v_proposal;
END;
$$;

CREATE FUNCTION public.fn_get_web_pending_proposal(
  p_proposal_id uuid,
  p_household_id uuid,
  p_conversation_key text,
  p_operation_type public.pending_operation_type
) RETURNS public.tb_pending_proposals
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_actor_member_id uuid;
  v_conversation_key text;
  v_proposal public.tb_pending_proposals%ROWTYPE;
BEGIN
  v_actor_member_id := public.fn_require_web_financial_actor(p_household_id);
  v_conversation_key := 'web:' || p_household_id::text || ':' || v_actor_member_id::text;
  IF p_conversation_key IS DISTINCT FROM v_conversation_key THEN
    RAISE EXCEPTION 'Web conversation is unavailable'
      USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
  END IF;
  SELECT proposal.* INTO v_proposal
    FROM public.tb_pending_proposals AS proposal
   WHERE proposal.id = p_proposal_id
     AND proposal.household_id = p_household_id
     AND proposal.conversation_key = v_conversation_key
     AND proposal.actor_member_id = v_actor_member_id
     AND proposal.source = 'WEB'
     AND proposal.payload ->> 'actorMemberId' = v_actor_member_id::text
     AND proposal.payload ->> 'source' = 'WEB'
     AND proposal.operation_type = p_operation_type
     AND proposal.status = 'AWAITING_CONFIRMATION';
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN v_proposal;
END;
$$;

CREATE FUNCTION public.fn_get_web_active_pending_proposal(
  p_household_id uuid,
  p_conversation_key text
) RETURNS public.tb_pending_proposals
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_actor_member_id uuid;
  v_conversation_key text;
  v_proposal public.tb_pending_proposals%ROWTYPE;
BEGIN
  v_actor_member_id := public.fn_require_web_financial_actor(p_household_id);
  v_conversation_key := 'web:' || p_household_id::text || ':' || v_actor_member_id::text;
  IF p_conversation_key IS DISTINCT FROM v_conversation_key THEN
    RAISE EXCEPTION 'Web conversation is unavailable'
      USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
  END IF;
  SELECT proposal.* INTO v_proposal
    FROM public.tb_pending_proposals AS proposal
   WHERE proposal.household_id = p_household_id
     AND proposal.conversation_key = v_conversation_key
     AND proposal.actor_member_id = v_actor_member_id
     AND proposal.source = 'WEB'
     AND proposal.payload ->> 'actorMemberId' = v_actor_member_id::text
     AND proposal.payload ->> 'source' = 'WEB'
     AND proposal.status = 'AWAITING_CONFIRMATION';
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN v_proposal;
END;
$$;

CREATE FUNCTION public.fn_get_web_latest_terminal_pending_proposal(
  p_household_id uuid,
  p_conversation_key text
) RETURNS public.tb_pending_proposals
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_actor_member_id uuid;
  v_conversation_key text;
  v_proposal public.tb_pending_proposals%ROWTYPE;
BEGIN
  v_actor_member_id := public.fn_require_web_financial_actor(p_household_id);
  v_conversation_key := 'web:' || p_household_id::text || ':' || v_actor_member_id::text;
  IF p_conversation_key IS DISTINCT FROM v_conversation_key THEN
    RAISE EXCEPTION 'Web conversation is unavailable'
      USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
  END IF;
  SELECT proposal.* INTO v_proposal
    FROM public.tb_pending_proposals AS proposal
   WHERE proposal.household_id = p_household_id
     AND proposal.conversation_key = v_conversation_key
     AND proposal.actor_member_id = v_actor_member_id
     AND proposal.source = 'WEB'
     AND proposal.payload ->> 'actorMemberId' = v_actor_member_id::text
     AND proposal.payload ->> 'source' = 'WEB'
     AND proposal.status IN ('COMPLETED', 'REJECTED')
   ORDER BY proposal.resolved_at DESC NULLS LAST, proposal.created_at DESC, proposal.id DESC
   LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN v_proposal;
END;
$$;

CREATE FUNCTION public.fn_update_web_pending_proposal(
  p_proposal_id uuid,
  p_household_id uuid,
  p_conversation_key text,
  p_operation_type public.pending_operation_type,
  p_expected_updated_at timestamptz,
  p_payload jsonb
) RETURNS public.tb_pending_proposals
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_actor_member_id uuid;
  v_conversation_key text;
  v_payload jsonb;
  v_proposal public.tb_pending_proposals%ROWTYPE;
BEGIN
  v_actor_member_id := public.fn_require_web_financial_actor(p_household_id);
  v_conversation_key := 'web:' || p_household_id::text || ':' || v_actor_member_id::text;
  IF p_conversation_key IS DISTINCT FROM v_conversation_key THEN
    RAISE EXCEPTION 'Web conversation is unavailable'
      USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
  END IF;
  SELECT proposal.* INTO v_proposal
    FROM public.tb_pending_proposals AS proposal
   WHERE proposal.id = p_proposal_id
     AND proposal.household_id = p_household_id
     AND proposal.conversation_key = v_conversation_key
     AND proposal.actor_member_id = v_actor_member_id
     AND proposal.source = 'WEB'
     AND proposal.payload ->> 'actorMemberId' = v_actor_member_id::text
     AND proposal.payload ->> 'source' = 'WEB'
     AND proposal.operation_type = p_operation_type
     AND proposal.status = 'AWAITING_CONFIRMATION'
   FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_expected_updated_at IS NULL
     OR v_proposal.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'Web pending proposal changed before correction'
      USING ERRCODE = '40001';
  END IF;
  v_payload := p_payload || pg_catalog.jsonb_build_object(
    'actorMemberId', v_actor_member_id::text, 'source', 'WEB'
  );
  PERFORM public.fn_assert_web_pending_proposal_snapshot(
    p_household_id, v_actor_member_id, p_operation_type, v_payload
  );
  UPDATE public.tb_pending_proposals AS proposal
     SET payload = v_payload
   WHERE proposal.id = p_proposal_id
     AND proposal.household_id = p_household_id
     AND proposal.conversation_key = v_conversation_key
     AND proposal.actor_member_id = v_actor_member_id
     AND proposal.source = 'WEB'
     AND proposal.operation_type = p_operation_type
     AND proposal.status = 'AWAITING_CONFIRMATION'
     AND proposal.updated_at = p_expected_updated_at
  RETURNING proposal.* INTO v_proposal;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN v_proposal;
END;
$$;

CREATE FUNCTION public.fn_compensate_web_pending_proposal(
  p_proposal_id uuid,
  p_household_id uuid,
  p_conversation_key text,
  p_operation_type public.pending_operation_type,
  p_expected_created_at timestamptz,
  p_expected_updated_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_actor_member_id uuid;
  v_conversation_key text;
  v_proposal public.tb_pending_proposals%ROWTYPE;
BEGIN
  v_actor_member_id := public.fn_require_web_financial_actor(p_household_id);
  v_conversation_key := 'web:' || p_household_id::text || ':' || v_actor_member_id::text;
  IF p_conversation_key IS DISTINCT FROM v_conversation_key THEN
    RAISE EXCEPTION 'Web conversation is unavailable'
      USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
  END IF;
  SELECT proposal.* INTO v_proposal
    FROM public.tb_pending_proposals AS proposal
   WHERE proposal.id = p_proposal_id
     AND proposal.household_id = p_household_id
     AND proposal.conversation_key = v_conversation_key
     AND proposal.actor_member_id = v_actor_member_id
     AND proposal.source = 'WEB'
     AND proposal.payload ->> 'actorMemberId' = v_actor_member_id::text
     AND proposal.payload ->> 'source' = 'WEB'
     AND proposal.operation_type = p_operation_type
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'NOT_FOUND');
  END IF;
  IF v_proposal.status IS DISTINCT FROM 'AWAITING_CONFIRMATION'
     OR p_expected_created_at IS NULL
     OR p_expected_updated_at IS NULL
     OR v_proposal.created_at IS DISTINCT FROM p_expected_created_at
     OR v_proposal.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RETURN pg_catalog.jsonb_build_object('status', 'VERSION_CONFLICT');
  END IF;
  DELETE FROM public.tb_pending_proposals AS proposal
   WHERE proposal.id = p_proposal_id
     AND proposal.household_id = p_household_id
     AND proposal.conversation_key = v_conversation_key
     AND proposal.actor_member_id = v_actor_member_id
     AND proposal.source = 'WEB'
     AND proposal.operation_type = p_operation_type
     AND proposal.status = 'AWAITING_CONFIRMATION'
     AND proposal.created_at = p_expected_created_at
     AND proposal.updated_at = p_expected_updated_at;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'VERSION_CONFLICT');
  END IF;
  RETURN pg_catalog.jsonb_build_object('status', 'REMOVED');
END;
$$;

ALTER FUNCTION public.fn_assert_web_pending_proposal_snapshot(uuid,uuid,public.pending_operation_type,jsonb) OWNER TO postgres;
ALTER FUNCTION public.fn_create_web_pending_proposal(uuid,text,public.pending_operation_type,jsonb) OWNER TO postgres;
ALTER FUNCTION public.fn_get_web_pending_proposal(uuid,uuid,text,public.pending_operation_type) OWNER TO postgres;
ALTER FUNCTION public.fn_get_web_active_pending_proposal(uuid,text) OWNER TO postgres;
ALTER FUNCTION public.fn_get_web_latest_terminal_pending_proposal(uuid,text) OWNER TO postgres;
ALTER FUNCTION public.fn_update_web_pending_proposal(uuid,uuid,text,public.pending_operation_type,timestamptz,jsonb) OWNER TO postgres;
ALTER FUNCTION public.fn_compensate_web_pending_proposal(uuid,uuid,text,public.pending_operation_type,timestamptz,timestamptz) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_assert_web_pending_proposal_snapshot(uuid,uuid,public.pending_operation_type,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_create_web_pending_proposal(uuid,text,public.pending_operation_type,jsonb)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.fn_get_web_pending_proposal(uuid,uuid,text,public.pending_operation_type)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.fn_get_web_active_pending_proposal(uuid,text)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.fn_get_web_latest_terminal_pending_proposal(uuid,text)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.fn_update_web_pending_proposal(uuid,uuid,text,public.pending_operation_type,timestamptz,jsonb)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.fn_compensate_web_pending_proposal(uuid,uuid,text,public.pending_operation_type,timestamptz,timestamptz)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.fn_create_web_pending_proposal(uuid,text,public.pending_operation_type,jsonb)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_get_web_pending_proposal(uuid,uuid,text,public.pending_operation_type)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_get_web_active_pending_proposal(uuid,text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_get_web_latest_terminal_pending_proposal(uuid,text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_update_web_pending_proposal(uuid,uuid,text,public.pending_operation_type,timestamptz,jsonb)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_compensate_web_pending_proposal(uuid,uuid,text,public.pending_operation_type,timestamptz,timestamptz)
  TO authenticated;

COMMIT;
