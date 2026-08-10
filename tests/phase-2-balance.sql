BEGIN;

-- Phase 2 Balance integration test. Every fixture is rolled back.

INSERT INTO public.tb_households (id, name)
VALUES
  ('32000000-0000-4000-8000-000000000001', 'Balance Household A'),
  ('32000000-0000-4000-8000-000000000002', 'Balance Household B'),
  ('32000000-0000-4000-8000-000000000003', 'Balance No Expenses'),
  ('32000000-0000-4000-8000-000000000004', 'Balance No Members');

INSERT INTO public.tb_users (id, display_name, external_identifier)
VALUES
  ('32000000-0000-4000-8000-000000000011', 'Balance A1', 'balance-a1'),
  ('32000000-0000-4000-8000-000000000012', 'Balance A2', 'balance-a2'),
  ('32000000-0000-4000-8000-000000000013', 'Balance A3', 'balance-a3'),
  ('32000000-0000-4000-8000-000000000014', 'Balance B1', 'balance-b1'),
  ('32000000-0000-4000-8000-000000000015', 'Balance C1', 'balance-c1');

INSERT INTO public.tb_household_members (id, household_id, user_id, display_name)
VALUES
  ('32000000-0000-4000-8000-000000000021', '32000000-0000-4000-8000-000000000001', '32000000-0000-4000-8000-000000000011', 'Balance A1'),
  ('32000000-0000-4000-8000-000000000022', '32000000-0000-4000-8000-000000000001', '32000000-0000-4000-8000-000000000012', 'Balance A2'),
  ('32000000-0000-4000-8000-000000000023', '32000000-0000-4000-8000-000000000001', '32000000-0000-4000-8000-000000000013', 'Balance A3'),
  ('32000000-0000-4000-8000-000000000024', '32000000-0000-4000-8000-000000000002', '32000000-0000-4000-8000-000000000014', 'Balance B1'),
  ('32000000-0000-4000-8000-000000000025', '32000000-0000-4000-8000-000000000003', '32000000-0000-4000-8000-000000000015', 'Balance C1');

INSERT INTO public.tb_expenses (
  id, household_id, created_by, paid_by, merchant, total_amount,
  expense_date, status, source
)
VALUES
  ('32000000-0000-4000-8000-000000000101', '32000000-0000-4000-8000-000000000001', '32000000-0000-4000-8000-000000000022', '32000000-0000-4000-8000-000000000021', NULL, 100.01, '2026-08-01', 'CONFIRMED', 'WEB'),
  ('32000000-0000-4000-8000-000000000102', '32000000-0000-4000-8000-000000000001', '32000000-0000-4000-8000-000000000021', '32000000-0000-4000-8000-000000000022', NULL, 20.02, '2026-08-02', 'CONFIRMED', 'WEB'),
  ('32000000-0000-4000-8000-000000000103', '32000000-0000-4000-8000-000000000001', '32000000-0000-4000-8000-000000000021', '32000000-0000-4000-8000-000000000023', NULL, 999.99, '2026-08-03', 'PENDING', 'WEB'),
  ('32000000-0000-4000-8000-000000000104', '32000000-0000-4000-8000-000000000001', '32000000-0000-4000-8000-000000000021', '32000000-0000-4000-8000-000000000023', NULL, 888.88, '2026-08-04', 'CANCELLED', 'WEB'),
  ('32000000-0000-4000-8000-000000000105', '32000000-0000-4000-8000-000000000002', '32000000-0000-4000-8000-000000000024', '32000000-0000-4000-8000-000000000024', NULL, 777.77, '2026-08-05', 'CONFIRMED', 'WEB');

INSERT INTO public.tb_expense_distributions (
  id, expense_id, household_member_id, amount, percentage
)
VALUES
  ('32000000-0000-4000-8000-000000000201', '32000000-0000-4000-8000-000000000101', '32000000-0000-4000-8000-000000000021', 50.00, 50.00),
  ('32000000-0000-4000-8000-000000000202', '32000000-0000-4000-8000-000000000101', '32000000-0000-4000-8000-000000000022', 50.01, 50.00),
  ('32000000-0000-4000-8000-000000000203', '32000000-0000-4000-8000-000000000102', '32000000-0000-4000-8000-000000000021', 10.01, 50.00),
  ('32000000-0000-4000-8000-000000000204', '32000000-0000-4000-8000-000000000102', '32000000-0000-4000-8000-000000000022', 10.01, 50.00),
  ('32000000-0000-4000-8000-000000000205', '32000000-0000-4000-8000-000000000103', '32000000-0000-4000-8000-000000000023', 999.99, 100.00),
  ('32000000-0000-4000-8000-000000000206', '32000000-0000-4000-8000-000000000104', '32000000-0000-4000-8000-000000000023', 888.88, 100.00),
  ('32000000-0000-4000-8000-000000000207', '32000000-0000-4000-8000-000000000105', '32000000-0000-4000-8000-000000000024', 777.77, 100.00);

INSERT INTO public.tb_incomes (
  id, household_id, created_by, member_id, amount, income_date, description
)
VALUES (
  '32000000-0000-4000-8000-000000000301',
  '32000000-0000-4000-8000-000000000001',
  '32000000-0000-4000-8000-000000000021',
  '32000000-0000-4000-8000-000000000021',
  999999.99,
  '2026-08-06',
  'Must not affect Balance'
);

SET CONSTRAINTS ALL IMMEDIATE;

DO $$
BEGIN
  IF NOT has_table_privilege('service_role', 'public.tb_household_members', 'SELECT')
    OR NOT has_table_privilege('service_role', 'public.tb_expenses', 'SELECT')
    OR NOT has_table_privilege('service_role', 'public.tb_expense_distributions', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL service_role lacks an existing Balance SELECT grant';
  END IF;
  RAISE NOTICE 'PASS existing grants are sufficient for Balance reads';
END;
$$;

SET LOCAL ROLE service_role;

DO $$
DECLARE
  actual JSONB;
  no_expense_balance NUMERIC;
  empty_member_count INTEGER;
BEGIN
  WITH relevant_expenses AS (
    SELECT id, paid_by, total_amount
    FROM public.tb_expenses
    WHERE household_id = '32000000-0000-4000-8000-000000000001'
      AND status = 'CONFIRMED'
  ),
  paid AS (
    SELECT paid_by AS member_id, SUM(total_amount) AS amount
    FROM relevant_expenses
    GROUP BY paid_by
  ),
  shares AS (
    SELECT distribution.household_member_id AS member_id,
           SUM(distribution.amount) AS amount
    FROM relevant_expenses expense
    JOIN public.tb_expense_distributions distribution
      ON distribution.expense_id = expense.id
    GROUP BY distribution.household_member_id
  ),
  balances AS (
    SELECT member.id AS member_id,
           COALESCE(paid.amount, 0)::NUMERIC(14,2) AS paid,
           COALESCE(shares.amount, 0)::NUMERIC(14,2) AS share,
           (COALESCE(paid.amount, 0) - COALESCE(shares.amount, 0))::NUMERIC(14,2) AS balance
    FROM public.tb_household_members member
    LEFT JOIN paid ON paid.member_id = member.id
    LEFT JOIN shares ON shares.member_id = member.id
    WHERE member.household_id = '32000000-0000-4000-8000-000000000001'
  )
  SELECT jsonb_agg(
    jsonb_build_object('memberId', member_id, 'paid', paid, 'share', share, 'balance', balance)
    ORDER BY member_id
  ) INTO actual
  FROM balances;

  IF actual <> jsonb_build_array(
    jsonb_build_object('memberId', '32000000-0000-4000-8000-000000000021', 'paid', 100.01, 'share', 60.01, 'balance', 40.00),
    jsonb_build_object('memberId', '32000000-0000-4000-8000-000000000022', 'paid', 20.02, 'share', 60.02, 'balance', -40.00),
    jsonb_build_object('memberId', '32000000-0000-4000-8000-000000000023', 'paid', 0.00, 'share', 0.00, 'balance', 0.00)
  ) THEN
    RAISE EXCEPTION 'FAIL unexpected Balance result: %', actual;
  END IF;

  IF (
    SELECT SUM((entry ->> 'balance')::NUMERIC)
    FROM jsonb_array_elements(actual) entry
  ) <> 0 THEN
    RAISE EXCEPTION 'FAIL household balances do not sum to zero';
  END IF;

  SELECT COALESCE(SUM(expense.total_amount), 0)
  INTO no_expense_balance
  FROM public.tb_expenses expense
  WHERE expense.household_id = '32000000-0000-4000-8000-000000000003'
    AND expense.status = 'CONFIRMED';
  IF no_expense_balance <> 0 THEN
    RAISE EXCEPTION 'FAIL household without Expenses is not zero';
  END IF;

  SELECT COUNT(*) INTO empty_member_count
  FROM public.tb_household_members
  WHERE household_id = '32000000-0000-4000-8000-000000000004';
  IF empty_member_count <> 0 THEN
    RAISE EXCEPTION 'FAIL empty household unexpectedly has members';
  END IF;

  RAISE NOTICE 'PASS paid_by, persisted shares, cents and zero-sum Balance';
  RAISE NOTICE 'PASS PENDING, CANCELLED, other-household Expenses and Income are excluded';
  RAISE NOTICE 'PASS inactive member, household without Expenses and household without members';
END;
$$;

RESET ROLE;

SELECT 'PASS Phase 2 Balance SQL checks completed' AS result;
SELECT 'PASS Phase 2 Balance fixtures will now be rolled back' AS result;

ROLLBACK;
