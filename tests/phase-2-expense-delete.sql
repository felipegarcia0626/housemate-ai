BEGIN;

SET CONSTRAINTS ALL DEFERRED;

CREATE FUNCTION pg_temp.expect_sqlstate(
  test_name TEXT,
  statement TEXT,
  expected_state TEXT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  actual_state TEXT;
  actual_message TEXT;
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS
      actual_state = RETURNED_SQLSTATE,
      actual_message = MESSAGE_TEXT;

    IF actual_state <> expected_state THEN
      RAISE EXCEPTION
        'FAIL %: expected SQLSTATE %, received % (%)',
        test_name,
        expected_state,
        actual_state,
        actual_message;
    END IF;

    RAISE NOTICE 'PASS %: SQLSTATE %', test_name, actual_state;
    RETURN;
  END;

  RAISE EXCEPTION
    'FAIL %: statement succeeded; expected SQLSTATE %',
    test_name,
    expected_state;
END;
$$;

INSERT INTO public.tb_households (id, name, created_at)
VALUES
  ('50000000-0000-4000-8000-000000000001', 'Delete Test Household One', '2000-01-01 00:00:00+00'),
  ('50000000-0000-4000-8000-000000000002', 'Delete Test Household Two', '2000-01-01 00:00:00+00');

INSERT INTO public.tb_users (id, display_name, external_identifier, created_at)
VALUES
  ('50000000-0000-4000-8000-000000000011', 'Delete Member One', 'phase-2-delete-user-1', '2000-01-01 00:00:00+00'),
  ('50000000-0000-4000-8000-000000000012', 'Delete Member Two', 'phase-2-delete-user-2', '2000-01-01 00:00:00+00'),
  ('50000000-0000-4000-8000-000000000013', 'Delete Member Three', 'phase-2-delete-user-3', '2000-01-01 00:00:00+00');

INSERT INTO public.tb_household_members (
  id, household_id, user_id, display_name, created_at
)
VALUES
  ('50000000-0000-4000-8000-000000000021', '50000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000011', 'Delete Member One', '2000-01-01 00:00:00+00'),
  ('50000000-0000-4000-8000-000000000022', '50000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000012', 'Delete Member Two', '2000-01-01 00:00:00+00'),
  ('50000000-0000-4000-8000-000000000023', '50000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000013', 'Delete Member Three', '2000-01-01 00:00:00+00');

INSERT INTO public.tb_categories (id, name, description, created_at)
VALUES (
  '50000000-0000-4000-8000-000000000031',
  'Phase 2 Delete Category',
  'Temporary category for delete tests',
  '2000-01-01 00:00:00+00'
);

INSERT INTO public.tb_expenses (
  id, household_id, created_by, paid_by, category_id, merchant,
  total_amount, expense_date, description, status, source,
  created_at, updated_at
)
VALUES
  ('50000000-0000-4000-8000-000000000101', '50000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000021', '50000000-0000-4000-8000-000000000021', NULL, 'Pending without Receipt', 100.00, '2026-08-01', 'Pending physical delete', 'PENDING', 'WEB', '2000-01-01 00:00:00+00', '2000-01-01 00:00:00+00'),
  ('50000000-0000-4000-8000-000000000102', '50000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000021', '50000000-0000-4000-8000-000000000022', NULL, 'Pending with Receipt', 100.00, '2026-08-02', 'Pending restricted delete', 'PENDING', 'RECEIPT', '2000-01-01 00:00:00+00', '2000-01-01 00:00:00+00'),
  ('50000000-0000-4000-8000-000000000103', '50000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000021', '50000000-0000-4000-8000-000000000022', '50000000-0000-4000-8000-000000000031', 'Confirmed Merchant', 100.00, '2026-08-03', 'Confirmed historical Expense', 'CONFIRMED', 'RECEIPT', '2000-01-01 00:00:00+00', '2000-01-01 00:00:00+00'),
  ('50000000-0000-4000-8000-000000000104', '50000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000021', '50000000-0000-4000-8000-000000000021', NULL, 'Already Cancelled', 100.00, '2026-08-04', 'Cancelled idempotency', 'CANCELLED', 'WEB', '2000-01-01 00:00:00+00', '2000-01-01 00:00:00+00'),
  ('50000000-0000-4000-8000-000000000105', '50000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000023', '50000000-0000-4000-8000-000000000023', NULL, 'Other Household', 10.00, '2026-08-05', 'Must remain hidden', 'CONFIRMED', 'WEB', '2000-01-01 00:00:00+00', '2000-01-01 00:00:00+00');

INSERT INTO public.tb_expense_items (
  id, expense_id, name, quantity, unit_price, total_amount, category_id, created_at
)
VALUES
  ('50000000-0000-4000-8000-000000000201', '50000000-0000-4000-8000-000000000101', 'Pending Item', 1.000, 40.00, 40.00, NULL, '2000-01-01 00:00:00+00'),
  ('50000000-0000-4000-8000-000000000202', '50000000-0000-4000-8000-000000000102', 'Restricted Item', 1.000, 40.00, 40.00, NULL, '2000-01-01 00:00:00+00'),
  ('50000000-0000-4000-8000-000000000203', '50000000-0000-4000-8000-000000000103', 'Confirmed Item', 2.000, 20.00, 40.00, '50000000-0000-4000-8000-000000000031', '2000-01-01 00:00:00+00'),
  ('50000000-0000-4000-8000-000000000204', '50000000-0000-4000-8000-000000000104', 'Cancelled Item', 1.000, 20.00, 20.00, NULL, '2000-01-01 00:00:00+00');

INSERT INTO public.tb_expense_distributions (
  id, expense_id, household_member_id, amount, percentage
)
VALUES
  ('50000000-0000-4000-8000-000000000301', '50000000-0000-4000-8000-000000000101', '50000000-0000-4000-8000-000000000021', 100.00, 100.00),
  ('50000000-0000-4000-8000-000000000302', '50000000-0000-4000-8000-000000000102', '50000000-0000-4000-8000-000000000021', 100.00, 100.00),
  ('50000000-0000-4000-8000-000000000303', '50000000-0000-4000-8000-000000000103', '50000000-0000-4000-8000-000000000021', 50.00, 50.00),
  ('50000000-0000-4000-8000-000000000304', '50000000-0000-4000-8000-000000000103', '50000000-0000-4000-8000-000000000022', 50.00, 50.00),
  ('50000000-0000-4000-8000-000000000305', '50000000-0000-4000-8000-000000000104', '50000000-0000-4000-8000-000000000021', 100.00, 100.00),
  ('50000000-0000-4000-8000-000000000306', '50000000-0000-4000-8000-000000000105', '50000000-0000-4000-8000-000000000023', 10.00, 100.00);

INSERT INTO public.tb_receipts (
  id, household_id, conversation_key, expense_id, storage_path,
  original_filename, mime_type, processing_status
)
VALUES
  ('50000000-0000-4000-8000-000000000401', '50000000-0000-4000-8000-000000000001', 'phase-2-delete-pending', '50000000-0000-4000-8000-000000000102', 'delete/pending.jpg', 'pending.jpg', 'image/jpeg', 'PROCESSED'),
  ('50000000-0000-4000-8000-000000000402', '50000000-0000-4000-8000-000000000001', 'phase-2-delete-confirmed', '50000000-0000-4000-8000-000000000103', 'delete/confirmed.jpg', 'confirmed.jpg', 'image/jpeg', 'PROCESSED'),
  ('50000000-0000-4000-8000-000000000403', '50000000-0000-4000-8000-000000000001', 'phase-2-delete-cancelled', '50000000-0000-4000-8000-000000000104', 'delete/cancelled.jpg', 'cancelled.jpg', 'image/jpeg', 'PROCESSED');

SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

DO $$
DECLARE
  delete_result TEXT;
BEGIN
  delete_result := public.fn_delete_expense(
    '50000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000101'
  );

  IF delete_result <> 'DELETED'
     OR EXISTS (SELECT 1 FROM public.tb_expenses WHERE id = '50000000-0000-4000-8000-000000000101')
     OR EXISTS (SELECT 1 FROM public.tb_expense_items WHERE expense_id = '50000000-0000-4000-8000-000000000101')
     OR EXISTS (SELECT 1 FROM public.tb_expense_distributions WHERE expense_id = '50000000-0000-4000-8000-000000000101') THEN
    RAISE EXCEPTION 'FAIL PENDING Expense or its children were not deleted';
  END IF;

  RAISE NOTICE 'PASS PENDING Expense and children deleted by cascade';
END;
$$;

SELECT pg_temp.expect_sqlstate(
  'PENDING Expense with Receipt is protected atomically',
  $sql$SELECT public.fn_delete_expense('50000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000102')$sql$,
  '23503'
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tb_expenses WHERE id = '50000000-0000-4000-8000-000000000102' AND status = 'PENDING')
     OR NOT EXISTS (SELECT 1 FROM public.tb_expense_items WHERE id = '50000000-0000-4000-8000-000000000202')
     OR NOT EXISTS (SELECT 1 FROM public.tb_expense_distributions WHERE id = '50000000-0000-4000-8000-000000000302')
     OR NOT EXISTS (SELECT 1 FROM public.tb_receipts WHERE id = '50000000-0000-4000-8000-000000000401' AND expense_id = '50000000-0000-4000-8000-000000000102') THEN
    RAISE EXCEPTION 'FAIL restricted PENDING delete left partial changes';
  END IF;

  RAISE NOTICE 'PASS Receipt restriction preserved PENDING Expense and complete aggregate';
END;
$$;

CREATE TEMP TABLE confirmed_expense_baseline ON COMMIT DROP AS
SELECT * FROM public.tb_expenses
WHERE id = '50000000-0000-4000-8000-000000000103';

DO $$
DECLARE
  delete_result TEXT;
  baseline confirmed_expense_baseline%ROWTYPE;
  current_expense public.tb_expenses%ROWTYPE;
BEGIN
  SELECT * INTO baseline FROM confirmed_expense_baseline;
  delete_result := public.fn_delete_expense(
    '50000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000103'
  );
  SELECT * INTO current_expense FROM public.tb_expenses
  WHERE id = '50000000-0000-4000-8000-000000000103';

  IF delete_result <> 'CANCELLED'
     OR current_expense.status <> 'CANCELLED'
     OR current_expense.updated_at <= baseline.updated_at
     OR current_expense.household_id IS DISTINCT FROM baseline.household_id
     OR current_expense.created_by IS DISTINCT FROM baseline.created_by
     OR current_expense.paid_by IS DISTINCT FROM baseline.paid_by
     OR current_expense.category_id IS DISTINCT FROM baseline.category_id
     OR current_expense.merchant IS DISTINCT FROM baseline.merchant
     OR current_expense.total_amount IS DISTINCT FROM baseline.total_amount
     OR current_expense.currency IS DISTINCT FROM baseline.currency
     OR current_expense.expense_date IS DISTINCT FROM baseline.expense_date
     OR current_expense.description IS DISTINCT FROM baseline.description
     OR current_expense.source IS DISTINCT FROM baseline.source
     OR current_expense.created_at IS DISTINCT FROM baseline.created_at THEN
    RAISE EXCEPTION 'FAIL CONFIRMED Expense cancellation changed unexpected fields';
  END IF;

  IF (SELECT COUNT(*) FROM public.tb_expense_items WHERE expense_id = current_expense.id) <> 1
     OR (SELECT COUNT(*) FROM public.tb_expense_distributions WHERE expense_id = current_expense.id) <> 2
     OR NOT EXISTS (SELECT 1 FROM public.tb_receipts WHERE id = '50000000-0000-4000-8000-000000000402' AND expense_id = current_expense.id) THEN
    RAISE EXCEPTION 'FAIL cancellation did not preserve children or Receipt';
  END IF;

  RAISE NOTICE 'PASS CONFIRMED Expense cancelled with history and Receipt preserved';
END;
$$;

SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

CREATE TEMP TABLE cancelled_expense_baseline ON COMMIT DROP AS
SELECT * FROM public.tb_expenses
WHERE id = '50000000-0000-4000-8000-000000000104';

DO $$
DECLARE
  first_result TEXT;
  second_result TEXT;
  baseline cancelled_expense_baseline%ROWTYPE;
  current_expense public.tb_expenses%ROWTYPE;
BEGIN
  SELECT * INTO baseline FROM cancelled_expense_baseline;
  first_result := public.fn_delete_expense(
    '50000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000104'
  );
  second_result := public.fn_delete_expense(
    '50000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000104'
  );
  SELECT * INTO current_expense FROM public.tb_expenses
  WHERE id = '50000000-0000-4000-8000-000000000104';

  IF first_result <> 'ALREADY_CANCELLED'
     OR second_result <> 'ALREADY_CANCELLED'
     OR to_jsonb(current_expense) IS DISTINCT FROM to_jsonb(baseline)
     OR (SELECT COUNT(*) FROM public.tb_expense_items WHERE expense_id = current_expense.id) <> 1
     OR (SELECT COUNT(*) FROM public.tb_expense_distributions WHERE expense_id = current_expense.id) <> 1
     OR NOT EXISTS (SELECT 1 FROM public.tb_receipts WHERE id = '50000000-0000-4000-8000-000000000403' AND expense_id = current_expense.id) THEN
    RAISE EXCEPTION 'FAIL CANCELLED Expense operation was not idempotent';
  END IF;

  RAISE NOTICE 'PASS CANCELLED Expense remained unchanged across repeated calls';
END;
$$;

SELECT pg_temp.expect_sqlstate(
  'Expense must exist in current household',
  $sql$SELECT public.fn_delete_expense('50000000-0000-4000-8000-000000000001','ffffffff-ffff-4fff-8fff-ffffffffffff')$sql$,
  'P0002'
);

SELECT pg_temp.expect_sqlstate(
  'Expense from another household remains hidden',
  $sql$SELECT public.fn_delete_expense('50000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000105')$sql$,
  'P0002'
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.tb_expenses
    WHERE id = '50000000-0000-4000-8000-000000000105'
      AND household_id = '50000000-0000-4000-8000-000000000002'
      AND status = 'CONFIRMED'
  ) THEN
    RAISE EXCEPTION 'FAIL other-household Expense was modified';
  END IF;

  RAISE NOTICE 'PASS other-household Expense remained unchanged';
END;
$$;

SELECT pg_temp.expect_sqlstate(
  'Invalid UUID is rejected by PostgreSQL',
  $sql$SELECT public.fn_delete_expense('not-a-uuid','50000000-0000-4000-8000-000000000103')$sql$,
  '22P02'
);

-- Real lock contention requires two coordinated PostgreSQL sessions and is
-- intentionally outside this single-session rollback-only script.
SELECT 'PASS: all Phase 2 Expense delete checks completed' AS result;
SELECT 'PASS: all Phase 2 delete fixtures will now be rolled back' AS result;

ROLLBACK;
