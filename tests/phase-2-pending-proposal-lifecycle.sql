BEGIN;

-- 2K covers the terminal lifecycle and the atomic/idempotent RPC contracts
-- against the isolated PostgreSQL instance created by scripts/run-sql-tests.cjs.

DO $$
<<lifecycle>>
DECLARE
  household_id CONSTANT UUID := '00000000-0000-4000-8000-000000000001';
  member_id CONSTANT UUID := '00000000-0000-4000-8000-000000000021';
  other_household_id CONSTANT UUID := '20000000-0000-4000-8000-000000000001';
  other_member_id CONSTANT UUID := '20000000-0000-4000-8000-000000000021';
  expense_proposal_id CONSTANT UUID := '20000000-0000-4000-8000-000000000101';
  income_proposal_id CONSTANT UUID := '20000000-0000-4000-8000-000000000102';
  incomplete_expense_id CONSTANT UUID := '20000000-0000-4000-8000-000000000103';
  incomplete_income_id CONSTANT UUID := '20000000-0000-4000-8000-000000000109';
  rejected_expense_id CONSTANT UUID := '20000000-0000-4000-8000-000000000104';
  rollback_expense_id CONSTANT UUID := '20000000-0000-4000-8000-000000000105';
  other_context_id CONSTANT UUID := '20000000-0000-4000-8000-000000000106';
  incompatible_income_id CONSTANT UUID := '20000000-0000-4000-8000-000000000107';
  incompatible_expense_id CONSTANT UUID := '20000000-0000-4000-8000-000000000108';
  expense_result JSONB;
  income_result JSONB;
  rejection_result JSONB;
  status_text TEXT;
  reference_id UUID;
  expected_state TEXT;
  actual_state TEXT;
  before_count BIGINT;
  after_count BIGINT;
  expense_before_count BIGINT;
  income_before_count BIGINT;
BEGIN
  INSERT INTO public.tb_households (id, name)
  VALUES (other_household_id, '2K Other Household');

  INSERT INTO public.tb_users (id, display_name, external_identifier)
  VALUES (
    '20000000-0000-4000-8000-000000000011',
    '2K Other User',
    '2k-other-user'
  );

  INSERT INTO public.tb_household_members (
    id,
    household_id,
    user_id,
    display_name
  )
  VALUES (
    other_member_id,
    other_household_id,
    '20000000-0000-4000-8000-000000000011',
    '2K Other Member'
  );

  INSERT INTO public.tb_pending_proposals (
    id,
    household_id,
    conversation_key,
    operation_type,
    payload,
    status,
    created_at,
    updated_at
  )
  VALUES
    (
      expense_proposal_id,
      household_id,
      '2k-expense',
      'CREATE_EXPENSE',
      jsonb_build_object('actorMemberId', member_id::TEXT, 'source', 'WEB'),
      'AWAITING_CONFIRMATION',
      '2000-01-01 00:00:00+00',
      '2000-01-01 00:00:00+00'
    ),
    (
      income_proposal_id,
      household_id,
      '2k-income',
      'CREATE_INCOME',
      jsonb_build_object('actorMemberId', member_id::TEXT, 'source', 'WEB'),
      'AWAITING_CONFIRMATION',
      '2000-01-01 00:00:00+00',
      '2000-01-01 00:00:00+00'
    ),
    (
      incomplete_expense_id,
      household_id,
      '2k-incomplete-expense',
      'CREATE_EXPENSE',
      jsonb_build_object('actorMemberId', member_id::TEXT, 'source', 'WEB'),
      'AWAITING_CONFIRMATION',
      '2000-01-01 00:00:00+00',
      '2000-01-01 00:00:00+00'
    ),
    (
      incomplete_income_id,
      household_id,
      '2k-incomplete-income',
      'CREATE_INCOME',
      jsonb_build_object('actorMemberId', member_id::TEXT, 'source', 'WEB'),
      'AWAITING_CONFIRMATION',
      '2000-01-01 00:00:00+00',
      '2000-01-01 00:00:00+00'
    ),
    (
      rejected_expense_id,
      household_id,
      '2k-rejected-expense',
      'CREATE_EXPENSE',
      jsonb_build_object('actorMemberId', member_id::TEXT, 'source', 'WEB'),
      'AWAITING_CONFIRMATION',
      '2000-01-01 00:00:00+00',
      '2000-01-01 00:00:00+00'
    ),
    (
      rollback_expense_id,
      household_id,
      '2k-rollback-expense',
      'CREATE_EXPENSE',
      jsonb_build_object('actorMemberId', member_id::TEXT, 'source', 'WEB'),
      'AWAITING_CONFIRMATION',
      '2000-01-01 00:00:00+00',
      '2000-01-01 00:00:00+00'
    ),
    (
      other_context_id,
      other_household_id,
      '2k-other-context',
      'CREATE_EXPENSE',
      jsonb_build_object('actorMemberId', other_member_id::TEXT, 'source', 'WEB'),
      'AWAITING_CONFIRMATION',
      '2000-01-01 00:00:00+00',
      '2000-01-01 00:00:00+00'
    ),
    (
      incompatible_income_id,
      household_id,
      '2k-incompatible-income',
      'CREATE_INCOME',
      jsonb_build_object('actorMemberId', member_id::TEXT, 'source', 'WEB'),
      'AWAITING_CONFIRMATION',
      '2000-01-01 00:00:00+00',
      '2000-01-01 00:00:00+00'
    ),
    (
      incompatible_expense_id,
      household_id,
      '2k-incompatible-expense',
      'CREATE_EXPENSE',
      jsonb_build_object('actorMemberId', member_id::TEXT, 'source', 'WEB'),
      'AWAITING_CONFIRMATION',
      '2000-01-01 00:00:00+00',
      '2000-01-01 00:00:00+00'
    );

  SELECT COUNT(*) INTO before_count
  FROM public.tb_expenses
  WHERE public.tb_expenses.household_id = lifecycle.household_id;
  expense_before_count := before_count;

  SELECT public.fn_confirm_pending_expense_consistent(
    p_proposal_id => expense_proposal_id,
    p_household_id => household_id,
    p_conversation_key => '2k-expense',
    p_actor_member_id => member_id,
    p_context_source => 'WEB'::public.expense_source,
    p_expected_updated_at => '2000-01-01 00:00:00+00',
    p_created_by => member_id,
    p_paid_by => member_id,
    p_category_id => '00000000-0000-4000-8000-000000000031',
    p_merchant => '2K Expense',
    p_total_amount => 100.00,
    p_expense_date => '2026-01-01',
    p_description => '2K expense confirmation',
    p_source => 'WEB'::public.expense_source,
    p_items => jsonb_build_array(
      jsonb_build_object('name', '2K item', 'totalAmount', 100.00)
    ),
    p_distributions => jsonb_build_array(
      jsonb_build_object(
        'householdMemberId', member_id::TEXT,
        'amount', 100.00,
        'percentage', 100.00
      )
    )
  ) INTO expense_result;

  IF expense_result ->> 'status' <> 'CREATED'
     OR expense_result ->> 'expense_id' IS NULL THEN
    RAISE EXCEPTION 'FAIL expense confirmation result: %', expense_result;
  END IF;

  reference_id := (expense_result ->> 'expense_id')::UUID;

  SELECT status::TEXT, expense_id
    INTO status_text, reference_id
    FROM public.tb_pending_proposals
   WHERE id = expense_proposal_id;

  IF status_text <> 'COMPLETED' OR reference_id IS NULL THEN
    RAISE EXCEPTION 'FAIL expense proposal was not completed with reference';
  END IF;

  SELECT COUNT(*) INTO after_count
  FROM public.tb_expenses
  WHERE public.tb_expenses.household_id = lifecycle.household_id;

  IF after_count <> expense_before_count + 1 THEN
    RAISE EXCEPTION 'FAIL expense confirmation created unexpected count: %', after_count;
  END IF;

  SELECT public.fn_confirm_pending_expense_consistent(
    p_proposal_id => expense_proposal_id,
    p_household_id => household_id,
    p_conversation_key => '2k-expense',
    p_actor_member_id => member_id,
    p_context_source => 'WEB'::public.expense_source
  ) INTO expense_result;

  IF expense_result ->> 'status' <> 'ALREADY_COMPLETED'
     OR (expense_result ->> 'expense_id')::UUID <> reference_id THEN
    RAISE EXCEPTION 'FAIL repeated expense confirmation was not idempotent: %', expense_result;
  END IF;

  SELECT COUNT(*) INTO after_count
  FROM public.tb_expenses
  WHERE public.tb_expenses.household_id = lifecycle.household_id;

  IF after_count <> expense_before_count + 1 THEN
    RAISE EXCEPTION 'FAIL repeated expense confirmation created a duplicate';
  END IF;

  RAISE NOTICE 'PASS expense confirmation and idempotent retry';

  SELECT COUNT(*) INTO before_count
  FROM public.tb_incomes
  WHERE public.tb_incomes.household_id = lifecycle.household_id;
  income_before_count := before_count;

  SELECT public.fn_confirm_pending_income_consistent(
    p_proposal_id => income_proposal_id,
    p_household_id => household_id,
    p_conversation_key => '2k-income',
    p_actor_member_id => member_id,
    p_context_source => 'WEB'::public.expense_source,
    p_expected_updated_at => '2000-01-01 00:00:00+00',
    p_created_by => member_id,
    p_member_id => member_id,
    p_amount => 250.00,
    p_income_date => '2026-01-02',
    p_description => '2K income confirmation',
    p_category_id => '00000000-0000-4000-8000-000000000033'
  ) INTO income_result;

  IF income_result ->> 'status' <> 'CREATED'
     OR income_result ->> 'income_id' IS NULL THEN
    RAISE EXCEPTION 'FAIL income confirmation result: %', income_result;
  END IF;

  reference_id := (income_result ->> 'income_id')::UUID;

  SELECT status::TEXT, income_id
    INTO status_text, reference_id
    FROM public.tb_pending_proposals
   WHERE id = income_proposal_id;

  IF status_text <> 'COMPLETED' OR reference_id IS NULL THEN
    RAISE EXCEPTION 'FAIL income proposal was not completed with reference';
  END IF;

  SELECT COUNT(*) INTO after_count
  FROM public.tb_incomes
  WHERE public.tb_incomes.household_id = lifecycle.household_id;

  IF after_count <> income_before_count + 1 THEN
    RAISE EXCEPTION 'FAIL income confirmation created unexpected count: %', after_count;
  END IF;

  SELECT public.fn_confirm_pending_income_consistent(
    p_proposal_id => income_proposal_id,
    p_household_id => household_id,
    p_conversation_key => '2k-income',
    p_actor_member_id => member_id,
    p_context_source => 'WEB'::public.expense_source
  ) INTO income_result;

  IF income_result ->> 'status' <> 'ALREADY_COMPLETED'
     OR (income_result ->> 'income_id')::UUID <> reference_id THEN
    RAISE EXCEPTION 'FAIL repeated income confirmation was not idempotent: %', income_result;
  END IF;

  SELECT COUNT(*) INTO after_count
  FROM public.tb_incomes
  WHERE public.tb_incomes.household_id = lifecycle.household_id;

  IF after_count <> income_before_count + 1 THEN
    RAISE EXCEPTION 'FAIL repeated income confirmation created a duplicate';
  END IF;

  RAISE NOTICE 'PASS income confirmation and idempotent retry';

  expected_state := NULL;
  actual_state := NULL;
  BEGIN
    PERFORM public.fn_confirm_pending_expense_consistent(
      p_proposal_id => incomplete_expense_id,
      p_household_id => household_id,
      p_conversation_key => '2k-incomplete-expense',
      p_actor_member_id => member_id,
      p_context_source => 'WEB'::public.expense_source
    );
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS actual_state = RETURNED_SQLSTATE;
  END;

  IF actual_state IS DISTINCT FROM '22023' THEN
    RAISE EXCEPTION 'FAIL incomplete expense expected SQLSTATE 22023, received %', actual_state;
  END IF;

  SELECT COUNT(*) INTO after_count
  FROM public.tb_expenses
  WHERE public.tb_expenses.household_id = lifecycle.household_id;

  SELECT status::TEXT INTO status_text
  FROM public.tb_pending_proposals
  WHERE id = incomplete_expense_id;

  IF after_count <> expense_before_count + 1 OR status_text <> 'AWAITING_CONFIRMATION' THEN
    RAISE EXCEPTION 'FAIL incomplete expense changed financial state';
  END IF;

  RAISE NOTICE 'PASS incomplete expense does not write or complete';

  actual_state := NULL;
  SELECT COUNT(*) INTO income_before_count
  FROM public.tb_incomes
  WHERE public.tb_incomes.household_id = lifecycle.household_id;

  BEGIN
    PERFORM public.fn_confirm_pending_income_consistent(
      p_proposal_id => incomplete_income_id,
      p_household_id => household_id,
      p_conversation_key => '2k-incomplete-income',
      p_actor_member_id => member_id,
      p_context_source => 'WEB'::public.expense_source
    );
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS actual_state = RETURNED_SQLSTATE;
  END;

  IF actual_state IS DISTINCT FROM '22023' THEN
    RAISE EXCEPTION 'FAIL incomplete income expected SQLSTATE 22023, received %', actual_state;
  END IF;

  SELECT COUNT(*) INTO after_count
  FROM public.tb_incomes
  WHERE public.tb_incomes.household_id = lifecycle.household_id;

  SELECT status::TEXT INTO status_text
  FROM public.tb_pending_proposals
  WHERE id = incomplete_income_id;

  IF after_count <> income_before_count OR status_text <> 'AWAITING_CONFIRMATION' THEN
    RAISE EXCEPTION 'FAIL incomplete income changed financial state';
  END IF;

  RAISE NOTICE 'PASS incomplete income does not write or complete';

  SELECT public.fn_reject_pending_proposal(
    p_proposal_id => rejected_expense_id,
    p_household_id => household_id,
    p_conversation_key => '2k-rejected-expense',
    p_actor_member_id => member_id,
    p_context_source => 'WEB'::public.expense_source,
    p_operation_type => 'CREATE_EXPENSE'::public.pending_operation_type
  ) INTO rejection_result;

  IF rejection_result ->> 'status' <> 'REJECTED' THEN
    RAISE EXCEPTION 'FAIL rejection result: %', rejection_result;
  END IF;

  BEGIN
    SELECT public.fn_confirm_pending_expense_consistent(
      p_proposal_id => rejected_expense_id,
      p_household_id => household_id,
      p_conversation_key => '2k-rejected-expense',
      p_actor_member_id => member_id,
      p_context_source => 'WEB'::public.expense_source
    ) INTO expense_result;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'FAIL rejected proposal confirmation raised unexpectedly: %', SQLERRM;
  END;

  IF expense_result ->> 'status' <> 'REJECTED' THEN
    RAISE EXCEPTION 'FAIL rejected proposal was confirmable: %', expense_result;
  END IF;

  SELECT COUNT(*) INTO after_count
  FROM public.tb_expenses
  WHERE public.tb_expenses.household_id = lifecycle.household_id;

  IF after_count <> expense_before_count + 1 THEN
    RAISE EXCEPTION 'FAIL rejected proposal created an expense';
  END IF;

  RAISE NOTICE 'PASS rejected proposal cannot be confirmed';

  expected_state := NULL;
  actual_state := NULL;
  SELECT COUNT(*) INTO before_count
  FROM public.tb_expenses
  WHERE public.tb_expenses.household_id = lifecycle.household_id;

  BEGIN
    PERFORM public.fn_confirm_pending_expense_consistent(
      p_proposal_id => rollback_expense_id,
      p_household_id => household_id,
      p_conversation_key => '2k-rollback-expense',
      p_actor_member_id => member_id,
      p_context_source => 'WEB'::public.expense_source,
      p_expected_updated_at => '2000-01-01 00:00:00+00',
      p_created_by => member_id,
      p_paid_by => member_id,
      p_category_id => '00000000-0000-4000-8000-000000000031',
      p_receipt_id => 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      p_merchant => '2K Rollback',
      p_total_amount => 125.00,
      p_expense_date => '2026-01-03',
      p_description => '2K rollback',
      p_source => 'WEB'::public.expense_source,
      p_items => jsonb_build_array(
        jsonb_build_object('name', '2K rollback item', 'totalAmount', 125.00)
      ),
      p_distributions => jsonb_build_array(
        jsonb_build_object(
          'householdMemberId', member_id::TEXT,
          'amount', 125.00,
          'percentage', 100.00
        )
      )
    );
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS actual_state = RETURNED_SQLSTATE;
  END;

  IF actual_state IS DISTINCT FROM '23514' THEN
    RAISE EXCEPTION 'FAIL rollback scenario expected SQLSTATE 23514, received %', actual_state;
  END IF;

  SELECT COUNT(*) INTO after_count
  FROM public.tb_expenses
  WHERE public.tb_expenses.household_id = lifecycle.household_id;

  SELECT status::TEXT INTO status_text
  FROM public.tb_pending_proposals
  WHERE id = rollback_expense_id;

  IF after_count <> before_count OR status_text <> 'AWAITING_CONFIRMATION' THEN
    RAISE EXCEPTION 'FAIL expense RPC did not rollback financial write';
  END IF;

  RAISE NOTICE 'PASS expense confirmation rollback';

  SELECT public.fn_confirm_pending_expense_consistent(
    p_proposal_id => other_context_id,
    p_household_id => household_id,
    p_conversation_key => '2k-other-context',
    p_actor_member_id => member_id,
    p_context_source => 'WEB'::public.expense_source
  ) INTO expense_result;

  IF expense_result ->> 'status' <> 'NOT_FOUND' THEN
    RAISE EXCEPTION 'FAIL cross-household proposal was visible: %', expense_result;
  END IF;

  SELECT public.fn_confirm_pending_expense_consistent(
    p_proposal_id => '2fffffff-ffff-4fff-8fff-ffffffffffff',
    p_household_id => household_id,
    p_conversation_key => '2k-missing',
    p_actor_member_id => member_id,
    p_context_source => 'WEB'::public.expense_source
  ) INTO expense_result;

  IF expense_result ->> 'status' <> 'NOT_FOUND' THEN
    RAISE EXCEPTION 'FAIL missing proposal was confirmable: %', expense_result;
  END IF;

  SELECT public.fn_confirm_pending_expense_consistent(
    p_proposal_id => incompatible_income_id,
    p_household_id => household_id,
    p_conversation_key => '2k-incompatible-income',
    p_actor_member_id => member_id,
    p_context_source => 'WEB'::public.expense_source,
    p_expected_updated_at => '2000-01-01 00:00:00+00',
    p_created_by => member_id,
    p_paid_by => member_id,
    p_total_amount => 10.00,
    p_expense_date => '2026-01-04',
    p_source => 'WEB'::public.expense_source,
    p_items => '[]'::JSONB,
    p_distributions => jsonb_build_array(
      jsonb_build_object(
        'householdMemberId', member_id::TEXT,
        'amount', 10.00,
        'percentage', 100.00
      )
    )
  ) INTO expense_result;

  IF expense_result ->> 'status' <> 'INVALID_OPERATION' THEN
    RAISE EXCEPTION 'FAIL incompatible income accepted as expense: %', expense_result;
  END IF;

  SELECT COUNT(*) INTO after_count
  FROM public.tb_expenses
  WHERE public.tb_expenses.household_id = lifecycle.household_id;

  IF after_count <> before_count THEN
    RAISE EXCEPTION 'FAIL incompatible income created an Expense';
  END IF;

  SELECT COUNT(*) INTO before_count
  FROM public.tb_incomes
  WHERE public.tb_incomes.household_id = lifecycle.household_id;

  SELECT public.fn_confirm_pending_income_consistent(
    p_proposal_id => incompatible_expense_id,
    p_household_id => household_id,
    p_conversation_key => '2k-incompatible-expense',
    p_actor_member_id => member_id,
    p_context_source => 'WEB'::public.expense_source,
    p_expected_updated_at => '2000-01-01 00:00:00+00',
    p_created_by => member_id,
    p_member_id => member_id,
    p_amount => 10.00,
    p_income_date => '2026-01-04',
    p_description => '2K incompatible income'
  ) INTO income_result;

  IF income_result ->> 'status' <> 'INVALID_OPERATION' THEN
    RAISE EXCEPTION 'FAIL incompatible expense accepted as income: %', income_result;
  END IF;

  SELECT COUNT(*) INTO after_count
  FROM public.tb_incomes
  WHERE public.tb_incomes.household_id = lifecycle.household_id;

  IF after_count <> before_count THEN
    RAISE EXCEPTION 'FAIL incompatible expense created an Income';
  END IF;

  RAISE NOTICE 'PASS context, missing proposal and operation isolation';
END;
$$;

DO $$
DECLARE
  household_id CONSTANT UUID := '00000000-0000-4000-8000-000000000001';
  member_id CONSTANT UUID := '00000000-0000-4000-8000-000000000021';
  expense_id CONSTANT UUID := '20000000-0000-4000-8000-000000000201';
  test_income_id CONSTANT UUID := '20000000-0000-4000-8000-000000000202';
  proposal_id CONSTANT UUID := '20000000-0000-4000-8000-000000000203';
  actual_state TEXT;
BEGIN
  INSERT INTO public.tb_expenses (
    id,
    household_id,
    created_by,
    paid_by,
    merchant,
    total_amount,
    expense_date,
    status,
    source
  )
  VALUES (
    expense_id,
    household_id,
    member_id,
    member_id,
    '2K Constraint Expense',
    1.00,
    '2026-01-05',
    'CONFIRMED',
    'WEB'
  );

  INSERT INTO public.tb_incomes (
    id,
    household_id,
    created_by,
    member_id,
    amount,
    income_date,
    description
  )
  VALUES (
    test_income_id,
    household_id,
    member_id,
    member_id,
    1.00,
    '2026-01-05',
    '2K Constraint Income'
  );

  INSERT INTO public.tb_pending_proposals (
    id,
    household_id,
    conversation_key,
    operation_type,
    payload,
    status,
    resolved_at,
    expense_id
  )
  VALUES (
    proposal_id,
    household_id,
    '2k-reference-constraint',
    'CREATE_EXPENSE',
    jsonb_build_object('actorMemberId', member_id::TEXT, 'source', 'WEB'),
    'COMPLETED',
    now(),
    expense_id
  );

  actual_state := NULL;
  BEGIN
    UPDATE public.tb_pending_proposals
       SET income_id = test_income_id
     WHERE id = proposal_id;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS actual_state = RETURNED_SQLSTATE;
  END;

  IF actual_state IS DISTINCT FROM '23514' THEN
    RAISE EXCEPTION
      'FAIL simultaneous expense/income references expected SQLSTATE 23514, received %',
      actual_state;
  END IF;

  RAISE NOTICE 'PASS terminal proposal cannot reference Expense and Income simultaneously';
END;
$$;

SELECT 'PASS Phase 2 PendingProposal lifecycle SQL checks completed' AS result;

ROLLBACK;
