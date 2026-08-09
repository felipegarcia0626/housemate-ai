BEGIN;

SET CONSTRAINTS ALL DEFERRED;

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

-- Deterministic fixtures exist only inside this transaction.
INSERT INTO public.tb_households (id, name, created_at)
VALUES
  ('40000000-0000-4000-8000-000000000001', 'Update Test Household One', '2000-01-01 00:00:00+00'),
  ('40000000-0000-4000-8000-000000000002', 'Update Test Household Two', '2000-01-01 00:00:00+00');

INSERT INTO public.tb_users (id, display_name, external_identifier, created_at)
VALUES
  ('40000000-0000-4000-8000-000000000011', 'Update Member One', 'phase-2-update-user-1', '2000-01-01 00:00:00+00'),
  ('40000000-0000-4000-8000-000000000012', 'Update Member Two', 'phase-2-update-user-2', '2000-01-01 00:00:00+00'),
  ('40000000-0000-4000-8000-000000000013', 'Update Member Three', 'phase-2-update-user-3', '2000-01-01 00:00:00+00');

INSERT INTO public.tb_household_members (
  id, household_id, user_id, display_name, created_at
)
VALUES
  ('40000000-0000-4000-8000-000000000021', '40000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000011', 'Update Member One', '2000-01-01 00:00:00+00'),
  ('40000000-0000-4000-8000-000000000022', '40000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000012', 'Update Member Two', '2000-01-01 00:00:00+00'),
  ('40000000-0000-4000-8000-000000000023', '40000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000013', 'Update Member Three', '2000-01-01 00:00:00+00');

INSERT INTO public.tb_categories (id, name, description, created_at)
VALUES
  ('40000000-0000-4000-8000-000000000031', 'Phase 2 Update Category One', 'Update test category', '2000-01-01 00:00:00+00'),
  ('40000000-0000-4000-8000-000000000032', 'Phase 2 Update Category Two', 'Update test category', '2000-01-01 00:00:00+00');

INSERT INTO public.tb_expenses (
  id, household_id, created_by, paid_by, category_id, merchant,
  total_amount, expense_date, description, status, source,
  created_at, updated_at
)
VALUES
  ('40000000-0000-4000-8000-000000000101', '40000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000021', '40000000-0000-4000-8000-000000000021', '40000000-0000-4000-8000-000000000031', 'Original Merchant', 100.00, '2026-08-01', 'Original scalar Expense', 'CONFIRMED', 'WEB', '2000-01-01 00:00:00+00', '2000-01-01 00:00:00+00'),
  ('40000000-0000-4000-8000-000000000102', '40000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000021', '40000000-0000-4000-8000-000000000021', NULL, 'Items Merchant', 100.00, '2026-08-02', 'Items Expense', 'CONFIRMED', 'WEB', '2000-01-01 00:00:00+00', '2000-01-01 00:00:00+00'),
  ('40000000-0000-4000-8000-000000000103', '40000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000021', '40000000-0000-4000-8000-000000000021', NULL, 'Distribution Merchant', 100.00, '2026-08-03', 'Distribution Expense', 'CONFIRMED', 'WEB', '2000-01-01 00:00:00+00', '2000-01-01 00:00:00+00'),
  ('40000000-0000-4000-8000-000000000104', '40000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000021', '40000000-0000-4000-8000-000000000021', NULL, 'Pending Merchant', 10.00, '2026-08-04', 'Pending Expense', 'PENDING', 'WEB', '2000-01-01 00:00:00+00', '2000-01-01 00:00:00+00'),
  ('40000000-0000-4000-8000-000000000105', '40000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000021', '40000000-0000-4000-8000-000000000021', NULL, 'Cancelled Merchant', 10.00, '2026-08-05', 'Cancelled Expense', 'CANCELLED', 'WEB', '2000-01-01 00:00:00+00', '2000-01-01 00:00:00+00'),
  ('40000000-0000-4000-8000-000000000106', '40000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000023', '40000000-0000-4000-8000-000000000023', NULL, 'Other Household Merchant', 10.00, '2026-08-06', 'Other Household Expense', 'CONFIRMED', 'WEB', '2000-01-01 00:00:00+00', '2000-01-01 00:00:00+00');

INSERT INTO public.tb_expense_items (
  id, expense_id, name, quantity, unit_price, total_amount, category_id, created_at
)
VALUES
  ('40000000-0000-4000-8000-000000000201', '40000000-0000-4000-8000-000000000102', 'Original Item One', 1.000, 40.00, 40.00, NULL, '2000-01-01 00:00:00+00'),
  ('40000000-0000-4000-8000-000000000202', '40000000-0000-4000-8000-000000000102', 'Original Item Two', 1.000, 20.00, 20.00, NULL, '2000-01-01 00:00:00+00');

INSERT INTO public.tb_expense_distributions (
  id, expense_id, household_member_id, amount, percentage
)
VALUES
  ('40000000-0000-4000-8000-000000000301', '40000000-0000-4000-8000-000000000101', '40000000-0000-4000-8000-000000000021', 50.00, 50.00),
  ('40000000-0000-4000-8000-000000000302', '40000000-0000-4000-8000-000000000101', '40000000-0000-4000-8000-000000000022', 50.00, 50.00),
  ('40000000-0000-4000-8000-000000000303', '40000000-0000-4000-8000-000000000102', '40000000-0000-4000-8000-000000000021', 50.00, 50.00),
  ('40000000-0000-4000-8000-000000000304', '40000000-0000-4000-8000-000000000102', '40000000-0000-4000-8000-000000000022', 50.00, 50.00),
  ('40000000-0000-4000-8000-000000000305', '40000000-0000-4000-8000-000000000103', '40000000-0000-4000-8000-000000000021', 50.00, 50.00),
  ('40000000-0000-4000-8000-000000000306', '40000000-0000-4000-8000-000000000103', '40000000-0000-4000-8000-000000000022', 50.00, 50.00),
  ('40000000-0000-4000-8000-000000000307', '40000000-0000-4000-8000-000000000106', '40000000-0000-4000-8000-000000000023', 10.00, 100.00);

SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

-- Partial scalar update and explicit null semantics.
SELECT public.fn_update_expense(
  '40000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000101',
  TRUE, NULL,
  TRUE, NULL,
  NULL, '2026-08-10', '40000000-0000-4000-8000-000000000022',
  TRUE, NULL,
  NULL, NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.tb_expenses
     WHERE id = '40000000-0000-4000-8000-000000000101'
       AND household_id = '40000000-0000-4000-8000-000000000001'
       AND merchant IS NULL
       AND description IS NULL
       AND category_id IS NULL
       AND expense_date = '2026-08-10'
       AND paid_by = '40000000-0000-4000-8000-000000000022'
       AND total_amount = 100.00
       AND status = 'CONFIRMED'
       AND source = 'WEB'
       AND updated_at > '2000-01-01 00:00:00+00'
  ) THEN
    RAISE EXCEPTION 'FAIL partial scalar update or immutable fields';
  END IF;

  IF (SELECT COUNT(*) FROM public.tb_expense_distributions WHERE expense_id = '40000000-0000-4000-8000-000000000101') <> 2 THEN
    RAISE EXCEPTION 'FAIL omitted distributions were modified';
  END IF;

  RAISE NOTICE 'PASS partial scalar update, explicit nulls and omitted distributions';
END;
$$;

-- Providing the unchanged total does not require replacement distributions.
SELECT public.fn_update_expense(
  '40000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000101',
  FALSE, NULL, FALSE, NULL, 100.00, NULL, NULL, FALSE, NULL,
  NULL, NULL
);

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM public.tb_expense_distributions WHERE expense_id = '40000000-0000-4000-8000-000000000101') <> 2 THEN
    RAISE EXCEPTION 'FAIL unchanged total modified distributions';
  END IF;
  RAISE NOTICE 'PASS unchanged total preserved distributions without splits';
END;
$$;

-- Complete item replacement.
SELECT public.fn_update_expense(
  '40000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000102',
  FALSE, NULL, FALSE, NULL, NULL, NULL, NULL, FALSE, NULL,
  '[{"name":"Replacement Item","quantity":2,"unitPrice":30.00,"totalAmount":60.00,"categoryId":"40000000-0000-4000-8000-000000000032"}]'::JSONB,
  NULL
);

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM public.tb_expense_items WHERE expense_id = '40000000-0000-4000-8000-000000000102') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public.tb_expense_items
        WHERE expense_id = '40000000-0000-4000-8000-000000000102'
          AND name = 'Replacement Item'
          AND quantity = 2.000
          AND unit_price = 30.00
          AND total_amount = 60.00
          AND category_id = '40000000-0000-4000-8000-000000000032'
     ) THEN
    RAISE EXCEPTION 'FAIL complete item replacement';
  END IF;

  RAISE NOTICE 'PASS complete item replacement';
END;
$$;

-- Omitted items remain unchanged, then [] removes all items.
SELECT public.fn_update_expense(
  '40000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000102',
  TRUE, 'Items Preserved', FALSE, NULL, NULL, NULL, NULL, FALSE, NULL,
  NULL, NULL
);

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM public.tb_expense_items WHERE expense_id = '40000000-0000-4000-8000-000000000102') <> 1 THEN
    RAISE EXCEPTION 'FAIL omitted items were not preserved';
  END IF;
  RAISE NOTICE 'PASS omitted items preserved';
END;
$$;

SELECT public.fn_update_expense(
  '40000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000102',
  FALSE, NULL, FALSE, NULL, NULL, NULL, NULL, FALSE, NULL,
  '[]'::JSONB, NULL
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.tb_expense_items WHERE expense_id = '40000000-0000-4000-8000-000000000102') THEN
    RAISE EXCEPTION 'FAIL items empty array did not remove all items';
  END IF;
  RAISE NOTICE 'PASS items empty array removed all items';
END;
$$;

-- Total and distributions change atomically.
SELECT public.fn_update_expense(
  '40000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000103',
  FALSE, NULL, FALSE, NULL, 120.01, NULL, NULL, FALSE, NULL, NULL,
  '[{"householdMemberId":"40000000-0000-4000-8000-000000000021","amount":60.01,"percentage":50.00},{"householdMemberId":"40000000-0000-4000-8000-000000000022","amount":60.00,"percentage":50.00}]'::JSONB
);

SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

DO $$
BEGIN
  IF (SELECT total_amount FROM public.tb_expenses WHERE id = '40000000-0000-4000-8000-000000000103') <> 120.01
     OR (SELECT SUM(amount) FROM public.tb_expense_distributions WHERE expense_id = '40000000-0000-4000-8000-000000000103') <> 120.01
     OR (SELECT SUM(percentage) FROM public.tb_expense_distributions WHERE expense_id = '40000000-0000-4000-8000-000000000103') <> 100.00 THEN
    RAISE EXCEPTION 'FAIL total and distributions replacement';
  END IF;
  RAISE NOTICE 'PASS total and distributions replaced atomically';
END;
$$;

-- Function-level negative cases.
SELECT pg_temp.expect_sqlstate(
  'Expense must exist in current household',
  $sql$SELECT public.fn_update_expense('40000000-0000-4000-8000-000000000001','ffffffff-ffff-4fff-8fff-ffffffffffff',TRUE,'x',FALSE,NULL,NULL,NULL,NULL,FALSE,NULL,NULL,NULL)$sql$,
  'P0002'
);

SELECT pg_temp.expect_sqlstate(
  'Expense from another household is not visible',
  $sql$SELECT public.fn_update_expense('40000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000106',TRUE,'x',FALSE,NULL,NULL,NULL,NULL,FALSE,NULL,NULL,NULL)$sql$,
  'P0002'
);

SELECT pg_temp.expect_sqlstate(
  'PENDING Expense cannot be updated',
  $sql$SELECT public.fn_update_expense('40000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000104',TRUE,'x',FALSE,NULL,NULL,NULL,NULL,FALSE,NULL,NULL,NULL)$sql$,
  '23514'
);

SELECT pg_temp.expect_sqlstate(
  'CANCELLED Expense cannot be updated',
  $sql$SELECT public.fn_update_expense('40000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000105',TRUE,'x',FALSE,NULL,NULL,NULL,NULL,FALSE,NULL,NULL,NULL)$sql$,
  '23514'
);

SELECT pg_temp.expect_sqlstate(
  'At least one field is required',
  $sql$SELECT public.fn_update_expense('40000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000101',FALSE,NULL,FALSE,NULL,NULL,NULL,NULL,FALSE,NULL,NULL,NULL)$sql$,
  '22023'
);

SELECT pg_temp.expect_sqlstate(
  'Changing total requires distributions',
  $sql$SELECT public.fn_update_expense('40000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000101',FALSE,NULL,FALSE,NULL,110.00,NULL,NULL,FALSE,NULL,NULL,NULL)$sql$,
  '23514'
);

SELECT pg_temp.expect_sqlstate(
  'Items must be valid JSON objects',
  $sql$SELECT public.fn_update_expense('40000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000101',FALSE,NULL,FALSE,NULL,NULL,NULL,NULL,FALSE,NULL,'[1]'::JSONB,NULL)$sql$,
  '22023'
);

SELECT pg_temp.expect_sqlstate(
  'Item total cannot exceed Expense total',
  $sql$SELECT public.fn_update_expense('40000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000101',FALSE,NULL,FALSE,NULL,NULL,NULL,NULL,FALSE,NULL,'[{"name":"Too Much","totalAmount":100.01}]'::JSONB,NULL)$sql$,
  '23514'
);

SELECT pg_temp.expect_sqlstate(
  'Distributions cannot be empty',
  $sql$SELECT public.fn_update_expense('40000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000101',FALSE,NULL,FALSE,NULL,NULL,NULL,NULL,FALSE,NULL,NULL,'[]'::JSONB)$sql$,
  '22023'
);

SELECT pg_temp.expect_sqlstate(
  'Distribution percentages must sum to 100.00',
  $sql$SELECT public.fn_update_expense('40000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000101',FALSE,NULL,FALSE,NULL,NULL,NULL,NULL,FALSE,NULL,NULL,'[{"householdMemberId":"40000000-0000-4000-8000-000000000021","amount":100.00,"percentage":99.99}]'::JSONB)$sql$,
  '23514'
);

SELECT pg_temp.expect_sqlstate(
  'Distribution amounts must equal effective total',
  $sql$SELECT public.fn_update_expense('40000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000101',FALSE,NULL,FALSE,NULL,NULL,NULL,NULL,FALSE,NULL,NULL,'[{"householdMemberId":"40000000-0000-4000-8000-000000000021","amount":99.99,"percentage":100.00}]'::JSONB)$sql$,
  '23514'
);

SELECT pg_temp.expect_sqlstate(
  'Distribution member must belong to Expense household',
  $sql$SELECT public.fn_update_expense('40000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000101',FALSE,NULL,FALSE,NULL,NULL,NULL,NULL,FALSE,NULL,NULL,'[{"householdMemberId":"40000000-0000-4000-8000-000000000023","amount":100.00,"percentage":100.00}]'::JSONB)$sql$,
  '23514',
  TRUE
);

SELECT pg_temp.expect_sqlstate(
  'paid_by must belong to Expense household',
  $sql$SELECT public.fn_update_expense('40000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000101',FALSE,NULL,FALSE,NULL,NULL,NULL,'40000000-0000-4000-8000-000000000023',FALSE,NULL,NULL,NULL)$sql$,
  '23503'
);

SELECT pg_temp.expect_sqlstate(
  'Expense category must exist',
  $sql$SELECT public.fn_update_expense('40000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000101',FALSE,NULL,FALSE,NULL,NULL,NULL,NULL,TRUE,'ffffffff-ffff-4fff-8fff-ffffffffffff',NULL,NULL)$sql$,
  '23503'
);

-- Atomic rollback: a deferred distribution failure must undo scalars and items.
CREATE TEMP TABLE phase_2_update_atomicity_baseline ON COMMIT DROP AS
SELECT
  expense.merchant,
  expense.updated_at,
  (SELECT COUNT(*) FROM public.tb_expense_items AS item WHERE item.expense_id = expense.id) AS item_count,
  (SELECT COUNT(*) FROM public.tb_expense_distributions AS distribution WHERE distribution.expense_id = expense.id) AS distribution_count
FROM public.tb_expenses AS expense
WHERE expense.id = '40000000-0000-4000-8000-000000000101';

SELECT pg_temp.expect_sqlstate(
  'Deferred failure rolls back complete Expense update',
  $sql$SELECT public.fn_update_expense(
    '40000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000101',
    TRUE, 'Must Roll Back', FALSE, NULL, NULL, NULL, NULL, FALSE, NULL,
    '[{"name":"Must Roll Back","totalAmount":10.00}]'::JSONB,
    '[{"householdMemberId":"40000000-0000-4000-8000-000000000023","amount":100.00,"percentage":100.00}]'::JSONB
  )$sql$,
  '23514',
  TRUE
);

DO $$
DECLARE
  baseline phase_2_update_atomicity_baseline%ROWTYPE;
BEGIN
  SELECT * INTO baseline FROM phase_2_update_atomicity_baseline;

  IF (SELECT merchant FROM public.tb_expenses WHERE id = '40000000-0000-4000-8000-000000000101') IS DISTINCT FROM baseline.merchant
     OR (SELECT updated_at FROM public.tb_expenses WHERE id = '40000000-0000-4000-8000-000000000101') IS DISTINCT FROM baseline.updated_at
     OR (SELECT COUNT(*) FROM public.tb_expense_items WHERE expense_id = '40000000-0000-4000-8000-000000000101') <> baseline.item_count
     OR (SELECT COUNT(*) FROM public.tb_expense_distributions WHERE expense_id = '40000000-0000-4000-8000-000000000101') <> baseline.distribution_count THEN
    RAISE EXCEPTION 'FAIL failed update left partial aggregate changes';
  END IF;

  RAISE NOTICE 'PASS failed update rolled back scalars, items and distributions';
END;
$$;

-- Real lock contention requires two PostgreSQL sessions and is intentionally
-- outside this single-session rollback-only script.
SELECT 'PASS: all Phase 2 Expense update checks completed' AS result;
SELECT 'PASS: all Phase 2 update fixtures will now be rolled back' AS result;

ROLLBACK;
