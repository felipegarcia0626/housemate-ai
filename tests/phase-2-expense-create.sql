BEGIN;

SET CONSTRAINTS ALL DEFERRED;

CREATE TEMP TABLE phase_2_created_expenses (
  test_name TEXT PRIMARY KEY,
  expense_id UUID NOT NULL
) ON COMMIT DROP;

CREATE FUNCTION pg_temp.expect_sqlstate(
  test_name TEXT,
  statement TEXT,
  expected_state TEXT,
  force_deferred_constraints BOOLEAN DEFAULT FALSE
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

    IF force_deferred_constraints THEN
      SET CONSTRAINTS ALL IMMEDIATE;
    END IF;
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

-- Every fixture is created inside this transaction and disappears on ROLLBACK.
INSERT INTO public.tb_households (id, name, created_at)
VALUES
  (
    '20000000-0000-4000-8000-000000000001',
    'Phase 2 Expense Test Household One',
    '2000-01-01 00:00:00+00'
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    'Phase 2 Expense Test Household Two',
    '2000-01-01 00:00:00+00'
  );

INSERT INTO public.tb_users (
  id,
  display_name,
  external_identifier,
  created_at
)
VALUES
  (
    '20000000-0000-4000-8000-000000000011',
    'Phase 2 Expense Test User One',
    'phase-2-expense-test-user-one',
    '2000-01-01 00:00:00+00'
  ),
  (
    '20000000-0000-4000-8000-000000000012',
    'Phase 2 Expense Test User Two',
    'phase-2-expense-test-user-two',
    '2000-01-01 00:00:00+00'
  ),
  (
    '20000000-0000-4000-8000-000000000013',
    'Phase 2 Expense Test User Three',
    'phase-2-expense-test-user-three',
    '2000-01-01 00:00:00+00'
  );

INSERT INTO public.tb_household_members (
  id,
  household_id,
  user_id,
  display_name,
  created_at
)
VALUES
  (
    '20000000-0000-4000-8000-000000000021',
    '20000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000011',
    'Phase 2 Member One',
    '2000-01-01 00:00:00+00'
  ),
  (
    '20000000-0000-4000-8000-000000000022',
    '20000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000012',
    'Phase 2 Member Two',
    '2000-01-01 00:00:00+00'
  ),
  (
    '20000000-0000-4000-8000-000000000023',
    '20000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000013',
    'Phase 2 Other Household Member',
    '2000-01-01 00:00:00+00'
  );

INSERT INTO public.tb_categories (id, name, description, created_at)
VALUES (
  '20000000-0000-4000-8000-000000000031',
  'Phase 2 Expense Test Category',
  'Temporary category for the Expense RPC test',
  '2000-01-01 00:00:00+00'
);

INSERT INTO public.tb_receipts (
  id,
  household_id,
  conversation_key,
  storage_path,
  original_filename,
  mime_type,
  processing_status
)
VALUES
  (
    '20000000-0000-4000-8000-000000000041',
    '20000000-0000-4000-8000-000000000001',
    'phase-2-expense-test-pending',
    'phase-2/pending.jpg',
    'pending.jpg',
    'image/jpeg',
    'PENDING'
  ),
  (
    '20000000-0000-4000-8000-000000000042',
    '20000000-0000-4000-8000-000000000001',
    'phase-2-expense-test-processed',
    'phase-2/processed.jpg',
    'processed.jpg',
    'image/jpeg',
    'PROCESSED'
  ),
  (
    '20000000-0000-4000-8000-000000000043',
    '20000000-0000-4000-8000-000000000002',
    'phase-2-expense-test-other-household',
    'phase-2/other-household.jpg',
    'other-household.jpg',
    'image/jpeg',
    'PROCESSED'
  );

-- Successful creation with NULL merchant and an empty item array.
INSERT INTO phase_2_created_expenses (test_name, expense_id)
SELECT
  'null-merchant-empty-items',
  public.fn_create_expense(
    '20000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000021',
    '20000000-0000-4000-8000-000000000021',
    NULL,
    NULL,
    NULL,
    10.01,
    '2026-08-09',
    'Phase 2 NULL merchant success',
    'WEB',
    '[]'::JSONB,
    '[
      {
        "householdMemberId": "20000000-0000-4000-8000-000000000021",
        "amount": 10.01,
        "percentage": 100.00
      }
    ]'::JSONB
  );

SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

DO $$
DECLARE
  created_expense_id UUID;
BEGIN
  SELECT expense_id
    INTO created_expense_id
    FROM phase_2_created_expenses
   WHERE test_name = 'null-merchant-empty-items';

  IF NOT EXISTS (
    SELECT 1
      FROM public.tb_expenses
     WHERE id = created_expense_id
       AND household_id = '20000000-0000-4000-8000-000000000001'
       AND status = 'CONFIRMED'
       AND merchant IS NULL
       AND total_amount = 10.01
  ) THEN
    RAISE EXCEPTION 'FAIL NULL merchant Expense was not created correctly';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.tb_expense_items
     WHERE expense_id = created_expense_id
  ) THEN
    RAISE EXCEPTION 'FAIL p_items = [] created unexpected ExpenseItems';
  END IF;

  IF (
    SELECT COUNT(*)
      FROM public.tb_expense_distributions
     WHERE expense_id = created_expense_id
  ) <> 1 THEN
    RAISE EXCEPTION 'FAIL NULL merchant Expense distributions were not created';
  END IF;

  RAISE NOTICE 'PASS create CONFIRMED Expense with merchant NULL and p_items = []';
END;
$$;

-- Successful aggregate creation with merchant, items, distributions and Receipt.
INSERT INTO phase_2_created_expenses (test_name, expense_id)
SELECT
  'complete-aggregate',
  public.fn_create_expense(
    '20000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000021',
    '20000000-0000-4000-8000-000000000022',
    '20000000-0000-4000-8000-000000000031',
    '20000000-0000-4000-8000-000000000042',
    'Phase 2 Test Merchant',
    100.01,
    '2026-08-09',
    'Phase 2 complete aggregate success',
    'RECEIPT',
    '[
      {
        "name": "First item",
        "quantity": 2.000,
        "unitPrice": 20.00,
        "totalAmount": 40.00,
        "categoryId": "20000000-0000-4000-8000-000000000031"
      },
      {
        "name": "Second item",
        "quantity": null,
        "unitPrice": null,
        "totalAmount": 10.01,
        "categoryId": null
      }
    ]'::JSONB,
    '[
      {
        "householdMemberId": "20000000-0000-4000-8000-000000000021",
        "amount": 50.01,
        "percentage": 50.00
      },
      {
        "householdMemberId": "20000000-0000-4000-8000-000000000022",
        "amount": 50.00,
        "percentage": 50.00
      }
    ]'::JSONB
  );

SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

DO $$
DECLARE
  created_expense_id UUID;
  item_count INTEGER;
  distribution_count INTEGER;
  distribution_amount_total NUMERIC(14,2);
  distribution_percentage_total NUMERIC(5,2);
BEGIN
  SELECT expense_id
    INTO created_expense_id
    FROM phase_2_created_expenses
   WHERE test_name = 'complete-aggregate';

  IF NOT EXISTS (
    SELECT 1
      FROM public.tb_expenses
     WHERE id = created_expense_id
       AND household_id = '20000000-0000-4000-8000-000000000001'
       AND created_by = '20000000-0000-4000-8000-000000000021'
       AND paid_by = '20000000-0000-4000-8000-000000000022'
       AND category_id = '20000000-0000-4000-8000-000000000031'
       AND merchant = 'Phase 2 Test Merchant'
       AND total_amount = 100.01
       AND status = 'CONFIRMED'
       AND source = 'RECEIPT'
  ) THEN
    RAISE EXCEPTION 'FAIL complete Expense was not created correctly';
  END IF;

  SELECT COUNT(*), COALESCE(SUM(total_amount), 0)
    INTO item_count, distribution_amount_total
    FROM public.tb_expense_items
   WHERE expense_id = created_expense_id;

  IF item_count <> 2 OR distribution_amount_total <> 50.01 THEN
    RAISE EXCEPTION 'FAIL ExpenseItems were not created correctly';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.tb_expense_items
     WHERE expense_id = created_expense_id
       AND name = 'First item'
       AND quantity = 2.000
       AND unit_price = 20.00
       AND total_amount = 40.00
       AND category_id = '20000000-0000-4000-8000-000000000031'
  ) OR NOT EXISTS (
    SELECT 1
      FROM public.tb_expense_items
     WHERE expense_id = created_expense_id
       AND name = 'Second item'
       AND quantity IS NULL
       AND unit_price IS NULL
       AND total_amount = 10.01
       AND category_id IS NULL
  ) THEN
    RAISE EXCEPTION 'FAIL ExpenseItem field mapping is incorrect';
  END IF;

  SELECT
    COUNT(*),
    COALESCE(SUM(amount), 0),
    COALESCE(SUM(percentage), 0)
  INTO
    distribution_count,
    distribution_amount_total,
    distribution_percentage_total
  FROM public.tb_expense_distributions
  WHERE expense_id = created_expense_id;

  IF distribution_count <> 2
     OR distribution_amount_total <> 100.01
     OR distribution_percentage_total <> 100.00 THEN
    RAISE EXCEPTION 'FAIL ExpenseDistributions were not created correctly';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.tb_receipts
     WHERE id = '20000000-0000-4000-8000-000000000042'
       AND household_id = '20000000-0000-4000-8000-000000000001'
       AND processing_status = 'PROCESSED'
       AND expense_id = created_expense_id
  ) THEN
    RAISE EXCEPTION 'FAIL processed Receipt was not associated atomically';
  END IF;

  RAISE NOTICE 'PASS complete Expense aggregate and processed Receipt association';
END;
$$;

-- Function-level validation failures.
SELECT pg_temp.expect_sqlstate(
  'distribution percentages must sum to 100.00',
  $sql$SELECT public.fn_create_expense(
    '20000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000021',
    '20000000-0000-4000-8000-000000000021',
    NULL, NULL, NULL, 10.00, '2026-08-09',
    'Phase 2 invalid percentage sum', 'WEB', '[]'::JSONB,
    '[{"householdMemberId":"20000000-0000-4000-8000-000000000021","amount":10.00,"percentage":99.99}]'::JSONB
  )$sql$,
  '23514'
);

SELECT pg_temp.expect_sqlstate(
  'distribution amounts must equal Expense total',
  $sql$SELECT public.fn_create_expense(
    '20000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000021',
    '20000000-0000-4000-8000-000000000021',
    NULL, NULL, NULL, 10.00, '2026-08-09',
    'Phase 2 invalid amount sum', 'WEB', '[]'::JSONB,
    '[{"householdMemberId":"20000000-0000-4000-8000-000000000021","amount":9.99,"percentage":100.00}]'::JSONB
  )$sql$,
  '23514'
);

-- Household, category and deferred trigger failures.
SELECT pg_temp.expect_sqlstate(
  'distribution member must belong to Expense household',
  $sql$SELECT public.fn_create_expense(
    '20000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000021',
    '20000000-0000-4000-8000-000000000021',
    NULL, NULL, NULL, 10.00, '2026-08-09',
    'Phase 2 cross-household distribution', 'WEB', '[]'::JSONB,
    '[{"householdMemberId":"20000000-0000-4000-8000-000000000023","amount":10.00,"percentage":100.00}]'::JSONB
  )$sql$,
  '23514',
  TRUE
);

SELECT pg_temp.expect_sqlstate(
  'created_by must belong to Expense household',
  $sql$SELECT public.fn_create_expense(
    '20000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000023',
    '20000000-0000-4000-8000-000000000021',
    NULL, NULL, NULL, 10.00, '2026-08-09',
    'Phase 2 cross-household creator', 'WEB', '[]'::JSONB,
    '[{"householdMemberId":"20000000-0000-4000-8000-000000000021","amount":10.00,"percentage":100.00}]'::JSONB
  )$sql$,
  '23503'
);

SELECT pg_temp.expect_sqlstate(
  'paid_by must belong to Expense household',
  $sql$SELECT public.fn_create_expense(
    '20000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000021',
    '20000000-0000-4000-8000-000000000023',
    NULL, NULL, NULL, 10.00, '2026-08-09',
    'Phase 2 cross-household payer', 'WEB', '[]'::JSONB,
    '[{"householdMemberId":"20000000-0000-4000-8000-000000000021","amount":10.00,"percentage":100.00}]'::JSONB
  )$sql$,
  '23503'
);

SELECT pg_temp.expect_sqlstate(
  'Expense category must exist',
  $sql$SELECT public.fn_create_expense(
    '20000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000021',
    '20000000-0000-4000-8000-000000000021',
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
    NULL, NULL, 10.00, '2026-08-09',
    'Phase 2 missing category', 'WEB', '[]'::JSONB,
    '[{"householdMemberId":"20000000-0000-4000-8000-000000000021","amount":10.00,"percentage":100.00}]'::JSONB
  )$sql$,
  '23503'
);

-- Receipt validation and single-use association.
SELECT pg_temp.expect_sqlstate(
  'Receipt must exist',
  $sql$SELECT public.fn_create_expense(
    '20000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000021',
    '20000000-0000-4000-8000-000000000021',
    NULL, 'ffffffff-ffff-4fff-8fff-ffffffffffff', NULL,
    10.00, '2026-08-09', 'Phase 2 missing Receipt', 'RECEIPT',
    '[]'::JSONB,
    '[{"householdMemberId":"20000000-0000-4000-8000-000000000021","amount":10.00,"percentage":100.00}]'::JSONB
  )$sql$,
  '23514'
);

CREATE TEMP TABLE phase_2_atomicity_baseline ON COMMIT DROP AS
SELECT
  (SELECT COUNT(*) FROM public.tb_expenses) AS expense_count,
  (SELECT COUNT(*) FROM public.tb_expense_items) AS item_count,
  (
    SELECT COUNT(*) FROM public.tb_expense_distributions
  ) AS distribution_count;

SELECT pg_temp.expect_sqlstate(
  'Receipt must be PROCESSED',
  $sql$SELECT public.fn_create_expense(
    '20000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000021',
    '20000000-0000-4000-8000-000000000021',
    NULL, '20000000-0000-4000-8000-000000000041', NULL,
    10.00, '2026-08-09', 'Phase 2 pending Receipt atomicity', 'RECEIPT',
    '[{"name":"Atomic item","quantity":1,"unitPrice":10,"totalAmount":10,"categoryId":null}]'::JSONB,
    '[{"householdMemberId":"20000000-0000-4000-8000-000000000021","amount":10.00,"percentage":100.00}]'::JSONB
  )$sql$,
  '23514'
);

DO $$
DECLARE
  expected_expense_count BIGINT;
  expected_item_count BIGINT;
  expected_distribution_count BIGINT;
BEGIN
  SELECT expense_count, item_count, distribution_count
    INTO
      expected_expense_count,
      expected_item_count,
      expected_distribution_count
    FROM phase_2_atomicity_baseline;

  IF (SELECT COUNT(*) FROM public.tb_expenses) <> expected_expense_count
     OR (SELECT COUNT(*) FROM public.tb_expense_items) <> expected_item_count
     OR (
       SELECT COUNT(*) FROM public.tb_expense_distributions
     ) <> expected_distribution_count
     OR EXISTS (
    SELECT 1
      FROM public.tb_receipts
     WHERE id = '20000000-0000-4000-8000-000000000041'
       AND expense_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'FAIL failed Receipt association left partial aggregate data';
  END IF;

  RAISE NOTICE 'PASS failed Receipt association rolled back the complete aggregate';
END;
$$;

SELECT pg_temp.expect_sqlstate(
  'Receipt must belong to Expense household',
  $sql$SELECT public.fn_create_expense(
    '20000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000021',
    '20000000-0000-4000-8000-000000000021',
    NULL, '20000000-0000-4000-8000-000000000043', NULL,
    10.00, '2026-08-09', 'Phase 2 other-household Receipt', 'RECEIPT',
    '[]'::JSONB,
    '[{"householdMemberId":"20000000-0000-4000-8000-000000000021","amount":10.00,"percentage":100.00}]'::JSONB
  )$sql$,
  '23514'
);

SELECT pg_temp.expect_sqlstate(
  'Receipt cannot be associated twice',
  $sql$SELECT public.fn_create_expense(
    '20000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000021',
    '20000000-0000-4000-8000-000000000021',
    NULL, '20000000-0000-4000-8000-000000000042', NULL,
    10.00, '2026-08-09', 'Phase 2 already-associated Receipt', 'RECEIPT',
    '[]'::JSONB,
    '[{"householdMemberId":"20000000-0000-4000-8000-000000000021","amount":10.00,"percentage":100.00}]'::JSONB
  )$sql$,
  '23514'
);

SET CONSTRAINTS ALL IMMEDIATE;

SELECT 'PASS: all Phase 2 Expense creation checks completed' AS result;
SELECT 'PASS: all Phase 2 fixtures will now be rolled back' AS result;

ROLLBACK;
