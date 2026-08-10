BEGIN;

-- Phase 2 Dashboard integration test. Every fixture is rolled back.

INSERT INTO public.tb_users (id, display_name, external_identifier, created_at)
VALUES
  ('37000000-0000-4000-8000-000000000011', 'Dashboard User A1', 'phase-2-dashboard-a1', '2026-08-10T12:00:00Z'),
  ('37000000-0000-4000-8000-000000000012', 'Dashboard User A2', 'phase-2-dashboard-a2', '2026-08-10T12:00:00Z'),
  ('37000000-0000-4000-8000-000000000013', 'Dashboard User B', 'phase-2-dashboard-b', '2026-08-10T12:00:00Z');

INSERT INTO public.tb_households (id, name, created_at)
VALUES
  ('37000000-0000-4000-8000-000000000001', 'Dashboard Household A', '2026-08-10T12:00:00Z'),
  ('37000000-0000-4000-8000-000000000002', 'Dashboard Household B', '2026-08-10T12:00:00Z'),
  ('37000000-0000-4000-8000-000000000003', 'Dashboard Empty Household', '2026-08-10T12:00:00Z');

INSERT INTO public.tb_household_members (id, household_id, user_id, display_name, created_at)
VALUES
  ('37000000-0000-4000-8000-000000000021', '37000000-0000-4000-8000-000000000001', '37000000-0000-4000-8000-000000000011', 'Member A1', '2026-08-10T12:00:00Z'),
  ('37000000-0000-4000-8000-000000000022', '37000000-0000-4000-8000-000000000001', '37000000-0000-4000-8000-000000000012', 'Member A2', '2026-08-10T12:00:00Z'),
  ('37000000-0000-4000-8000-000000000023', '37000000-0000-4000-8000-000000000002', '37000000-0000-4000-8000-000000000013', 'Member B', '2026-08-10T12:00:00Z');

INSERT INTO public.tb_categories (id, name, created_at)
VALUES
  ('37000000-0000-4000-8000-000000000031', 'Phase 2 Dashboard Food', '2026-08-10T12:00:00Z'),
  ('37000000-0000-4000-8000-000000000032', 'Phase 2 Dashboard Home', '2026-08-10T12:00:00Z');

INSERT INTO public.tb_incomes (
  id, household_id, created_by, member_id, amount, income_date, description, created_at, updated_at
)
VALUES
  ('37000000-0000-4000-8000-000000000041', '37000000-0000-4000-8000-000000000001', '37000000-0000-4000-8000-000000000021', '37000000-0000-4000-8000-000000000021', 1000.01, '2026-08-01', 'Dashboard income A1', '2026-08-10T12:00:00Z', '2026-08-10T12:00:00Z'),
  ('37000000-0000-4000-8000-000000000042', '37000000-0000-4000-8000-000000000001', '37000000-0000-4000-8000-000000000021', '37000000-0000-4000-8000-000000000021', 0.02, '2026-08-02', 'Dashboard cents A1', '2026-08-10T12:00:00Z', '2026-08-10T12:00:00Z'),
  ('37000000-0000-4000-8000-000000000043', '37000000-0000-4000-8000-000000000001', '37000000-0000-4000-8000-000000000022', '37000000-0000-4000-8000-000000000022', 20.03, '2026-08-03', 'Dashboard income A2', '2026-08-10T12:00:00Z', '2026-08-10T12:00:00Z'),
  ('37000000-0000-4000-8000-000000000044', '37000000-0000-4000-8000-000000000001', '37000000-0000-4000-8000-000000000021', '37000000-0000-4000-8000-000000000021', 7.00, '2026-07-31', 'Before from', '2026-08-10T12:00:00Z', '2026-08-10T12:00:00Z'),
  ('37000000-0000-4000-8000-000000000045', '37000000-0000-4000-8000-000000000001', '37000000-0000-4000-8000-000000000021', '37000000-0000-4000-8000-000000000021', 8.00, '2026-08-04', 'After to', '2026-08-10T12:00:00Z', '2026-08-10T12:00:00Z'),
  ('37000000-0000-4000-8000-000000000046', '37000000-0000-4000-8000-000000000002', '37000000-0000-4000-8000-000000000023', '37000000-0000-4000-8000-000000000023', 9999.99, '2026-08-02', 'Other household', '2026-08-10T12:00:00Z', '2026-08-10T12:00:00Z');

INSERT INTO public.tb_expenses (
  id, household_id, created_by, paid_by, category_id, merchant, total_amount, expense_date, status, source, created_at, updated_at
)
VALUES
  ('37000000-0000-4000-8000-000000000051', '37000000-0000-4000-8000-000000000001', '37000000-0000-4000-8000-000000000022', '37000000-0000-4000-8000-000000000021', '37000000-0000-4000-8000-000000000032', NULL, 100.01, '2026-08-01', 'CONFIRMED', 'WEB', '2026-08-10T12:00:00Z', '2026-08-10T12:00:00Z'),
  ('37000000-0000-4000-8000-000000000052', '37000000-0000-4000-8000-000000000001', '37000000-0000-4000-8000-000000000021', '37000000-0000-4000-8000-000000000022', NULL, NULL, 20.03, '2026-08-03', 'CONFIRMED', 'WEB', '2026-08-10T12:00:00Z', '2026-08-10T12:00:00Z'),
  ('37000000-0000-4000-8000-000000000053', '37000000-0000-4000-8000-000000000001', '37000000-0000-4000-8000-000000000021', '37000000-0000-4000-8000-000000000021', NULL, NULL, 500.00, '2026-08-02', 'PENDING', 'WEB', '2026-08-10T12:00:00Z', '2026-08-10T12:00:00Z'),
  ('37000000-0000-4000-8000-000000000054', '37000000-0000-4000-8000-000000000001', '37000000-0000-4000-8000-000000000021', '37000000-0000-4000-8000-000000000021', NULL, NULL, 600.00, '2026-08-02', 'CANCELLED', 'WEB', '2026-08-10T12:00:00Z', '2026-08-10T12:00:00Z'),
  ('37000000-0000-4000-8000-000000000055', '37000000-0000-4000-8000-000000000002', '37000000-0000-4000-8000-000000000023', '37000000-0000-4000-8000-000000000023', NULL, NULL, 700.00, '2026-08-02', 'CONFIRMED', 'WEB', '2026-08-10T12:00:00Z', '2026-08-10T12:00:00Z'),
  ('37000000-0000-4000-8000-000000000056', '37000000-0000-4000-8000-000000000001', '37000000-0000-4000-8000-000000000021', '37000000-0000-4000-8000-000000000021', '37000000-0000-4000-8000-000000000032', NULL, 3.00, '2026-08-02', 'CONFIRMED', 'WEB', '2026-08-10T12:00:00Z', '2026-08-10T12:00:00Z'),
  ('37000000-0000-4000-8000-000000000057', '37000000-0000-4000-8000-000000000001', '37000000-0000-4000-8000-000000000022', '37000000-0000-4000-8000-000000000022', NULL, NULL, 4.00, '2026-08-02', 'CONFIRMED', 'WEB', '2026-08-10T12:00:00Z', '2026-08-10T12:00:00Z');

INSERT INTO public.tb_expense_items (id, expense_id, name, total_amount, category_id, created_at)
VALUES
  ('37000000-0000-4000-8000-000000000061', '37000000-0000-4000-8000-000000000051', 'Categorized item', 30.00, '37000000-0000-4000-8000-000000000031', '2026-08-10T12:00:00Z'),
  ('37000000-0000-4000-8000-000000000062', '37000000-0000-4000-8000-000000000051', 'Uncategorized item', 10.00, NULL, '2026-08-10T12:00:00Z'),
  ('37000000-0000-4000-8000-000000000063', '37000000-0000-4000-8000-000000000052', 'Nearly full item', 20.02, '37000000-0000-4000-8000-000000000031', '2026-08-10T12:00:00Z');

INSERT INTO public.tb_expense_distributions (id, expense_id, household_member_id, amount, percentage)
VALUES
  ('37000000-0000-4000-8000-000000000071', '37000000-0000-4000-8000-000000000051', '37000000-0000-4000-8000-000000000021', 100.01, 100.00),
  ('37000000-0000-4000-8000-000000000072', '37000000-0000-4000-8000-000000000052', '37000000-0000-4000-8000-000000000022', 20.03, 100.00),
  ('37000000-0000-4000-8000-000000000073', '37000000-0000-4000-8000-000000000055', '37000000-0000-4000-8000-000000000023', 700.00, 100.00),
  ('37000000-0000-4000-8000-000000000074', '37000000-0000-4000-8000-000000000056', '37000000-0000-4000-8000-000000000021', 3.00, 100.00),
  ('37000000-0000-4000-8000-000000000075', '37000000-0000-4000-8000-000000000057', '37000000-0000-4000-8000-000000000022', 4.00, 100.00);

SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

DO $$
DECLARE
  actual_state TEXT;
  actual_message TEXT;
  rejected BOOLEAN := FALSE;
BEGIN
  BEGIN
    INSERT INTO public.tb_expenses (
      id, household_id, created_by, paid_by, category_id, merchant,
      total_amount, expense_date, status, source, created_at, updated_at
    ) VALUES (
      '37000000-0000-4000-8000-000000000058',
      '37000000-0000-4000-8000-000000000001',
      '37000000-0000-4000-8000-000000000021',
      '37000000-0000-4000-8000-000000000021',
      NULL, NULL, 100.00, '2026-08-02', 'CONFIRMED', 'WEB',
      '2026-08-10T12:00:00Z', '2026-08-10T12:00:00Z'
    );

    INSERT INTO public.tb_expense_distributions (
      id, expense_id, household_member_id, amount, percentage
    ) VALUES (
      '37000000-0000-4000-8000-000000000076',
      '37000000-0000-4000-8000-000000000058',
      '37000000-0000-4000-8000-000000000021',
      100.00, 100.00
    );

    INSERT INTO public.tb_expense_items (
      id, expense_id, name, total_amount, category_id, created_at
    ) VALUES
      (
        '37000000-0000-4000-8000-000000000064',
        '37000000-0000-4000-8000-000000000058',
        'Dashboard invalid item A', 60.00,
        '37000000-0000-4000-8000-000000000031',
        '2026-08-10T12:00:00Z'
      ),
      (
        '37000000-0000-4000-8000-000000000065',
        '37000000-0000-4000-8000-000000000058',
        'Dashboard invalid item B', 50.00,
        '37000000-0000-4000-8000-000000000032',
        '2026-08-10T12:00:00Z'
      );

    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS
      actual_state = RETURNED_SQLSTATE,
      actual_message = MESSAGE_TEXT;

    IF actual_state <> '23514' THEN
      RAISE EXCEPTION
        'FAIL categorized ExpenseItems above Expense total: expected SQLSTATE 23514, received % (%)',
        actual_state,
        actual_message;
    END IF;

    rejected := TRUE;
    RAISE NOTICE
      'PASS PostgreSQL rejected categorized ExpenseItems above Expense total: SQLSTATE %',
      actual_state;
  END;

  IF NOT rejected THEN
    RAISE EXCEPTION
      'FAIL categorized ExpenseItems above Expense total were accepted';
  END IF;

  SET CONSTRAINTS ALL DEFERRED;

  IF EXISTS (
    SELECT 1 FROM public.tb_expenses
    WHERE id = '37000000-0000-4000-8000-000000000058'
  ) THEN
    RAISE EXCEPTION 'FAIL rejected invalid Dashboard Expense was not rolled back';
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT has_table_privilege('service_role', 'public.tb_incomes', 'SELECT')
    OR NOT has_table_privilege('service_role', 'public.tb_expenses', 'SELECT')
    OR NOT has_table_privilege('service_role', 'public.tb_expense_items', 'SELECT')
    OR NOT has_table_privilege('service_role', 'public.tb_categories', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL service_role lacks an existing Dashboard SELECT privilege';
  END IF;
  RAISE NOTICE 'PASS Dashboard reuses existing SELECT privileges without a migration';
END;
$$;

SET LOCAL ROLE service_role;

DO $$
DECLARE
  income_total NUMERIC(14,2);
  spent_total NUMERIC(14,2);
  expense_count INTEGER;
  member_rows INTEGER;
  member_a1_total NUMERIC(14,2);
  member_a2_total NUMERIC(14,2);
  member_income_total NUMERIC(14,2);
  category_rows INTEGER;
  category_total NUMERIC(14,2);
  food_total NUMERIC(14,2);
  home_total NUMERIC(14,2);
  uncategorized_total NUMERIC(14,2);
  empty_income NUMERIC(14,2);
  empty_spent NUMERIC(14,2);
BEGIN
  SELECT COALESCE(SUM(amount), 0)::NUMERIC(14,2)
  INTO income_total
  FROM public.tb_incomes
  WHERE household_id = '37000000-0000-4000-8000-000000000001'
    AND income_date >= '2026-08-01'
    AND income_date <= '2026-08-03';

  SELECT COALESCE(SUM(total_amount), 0)::NUMERIC(14,2), COUNT(*)
  INTO spent_total, expense_count
  FROM public.tb_expenses
  WHERE household_id = '37000000-0000-4000-8000-000000000001'
    AND status = 'CONFIRMED'
    AND expense_date >= '2026-08-01'
    AND expense_date <= '2026-08-03';

  IF income_total <> 1020.06 OR spent_total <> 127.04 OR income_total - spent_total <> 893.02 THEN
    RAISE EXCEPTION 'FAIL Dashboard totals: income %, spent %, net %', income_total, spent_total, income_total - spent_total;
  END IF;
  IF expense_count <> 4 THEN
    RAISE EXCEPTION 'FAIL Dashboard expenseCount: %', expense_count;
  END IF;

  SELECT COUNT(*),
    MAX(amount) FILTER (WHERE member_id = '37000000-0000-4000-8000-000000000021'),
    MAX(amount) FILTER (WHERE member_id = '37000000-0000-4000-8000-000000000022'),
    SUM(amount)::NUMERIC(14,2)
  INTO member_rows, member_a1_total, member_a2_total, member_income_total
  FROM (
    SELECT member_id, SUM(amount)::NUMERIC(14,2) AS amount
    FROM public.tb_incomes
    WHERE household_id = '37000000-0000-4000-8000-000000000001'
      AND income_date BETWEEN '2026-08-01' AND '2026-08-03'
    GROUP BY member_id
  ) AS grouped_income;
  IF member_rows <> 2 OR member_a1_total <> 1000.03 OR member_a2_total <> 20.03
    OR member_income_total <> income_total THEN
    RAISE EXCEPTION 'FAIL Dashboard memberIncome: rows %, A1 %, A2 %, sum %',
      member_rows, member_a1_total, member_a2_total, member_income_total;
  END IF;

  WITH included_expenses AS (
    SELECT id, total_amount, category_id
    FROM public.tb_expenses
    WHERE household_id = '37000000-0000-4000-8000-000000000001'
      AND status = 'CONFIRMED'
      AND expense_date BETWEEN '2026-08-01' AND '2026-08-03'
  ), categorized_items AS (
    SELECT item.expense_id, item.category_id, SUM(item.total_amount)::NUMERIC(14,2) AS amount
    FROM public.tb_expense_items AS item
    JOIN included_expenses AS expense ON expense.id = item.expense_id
    WHERE item.category_id IS NOT NULL
    GROUP BY item.expense_id, item.category_id
  ), categorized_item_totals AS (
    SELECT expense_id, SUM(amount)::NUMERIC(14,2) AS amount
    FROM categorized_items
    GROUP BY expense_id
  ), allocations AS (
    SELECT category_id, amount FROM categorized_items
    UNION ALL
    SELECT expense.category_id,
      (expense.total_amount - COALESCE(item_total.amount, 0))::NUMERIC(14,2)
    FROM included_expenses AS expense
    LEFT JOIN categorized_item_totals AS item_total ON item_total.expense_id = expense.id
    WHERE expense.total_amount - COALESCE(item_total.amount, 0) > 0
  ), grouped AS (
    SELECT category_id, SUM(amount)::NUMERIC(14,2) AS amount
    FROM allocations
    GROUP BY category_id
  )
  SELECT COUNT(*), SUM(amount)::NUMERIC(14,2),
    MAX(amount) FILTER (WHERE category_id = '37000000-0000-4000-8000-000000000031'),
    MAX(amount) FILTER (WHERE category_id = '37000000-0000-4000-8000-000000000032'),
    MAX(amount) FILTER (WHERE category_id IS NULL)
  INTO category_rows, category_total, food_total, home_total, uncategorized_total
  FROM grouped;

  IF category_rows <> 3 OR category_total <> spent_total
    OR food_total <> 50.02 OR home_total <> 73.01 OR uncategorized_total <> 4.01 THEN
    RAISE EXCEPTION 'FAIL Dashboard byCategory: rows %, sum %, food %, home %, uncategorized %',
      category_rows, category_total, food_total, home_total, uncategorized_total;
  END IF;

  SELECT COALESCE(SUM(amount), 0)::NUMERIC(14,2) INTO empty_income
  FROM public.tb_incomes WHERE household_id = '37000000-0000-4000-8000-000000000003';
  SELECT COALESCE(SUM(total_amount), 0)::NUMERIC(14,2) INTO empty_spent
  FROM public.tb_expenses WHERE household_id = '37000000-0000-4000-8000-000000000003' AND status = 'CONFIRMED';
  IF empty_income <> 0 OR empty_spent <> 0 THEN
    RAISE EXCEPTION 'FAIL empty Dashboard totals';
  END IF;

  RAISE NOTICE 'PASS Dashboard household/date isolation and inclusive boundaries';
  RAISE NOTICE 'PASS CONFIRMED totalSpent, expenseCount, exact memberIncome and netAmount';
  RAISE NOTICE 'PASS items, no-item Expenses, general and null/null allocation sum exactly to totalSpent';
  RAISE NOTICE 'PASS empty household produces zero database aggregates';
END;
$$;

RESET ROLE;

SELECT 'PASS Phase 2 Dashboard SQL checks completed' AS result;
SELECT 'PASS Phase 2 Dashboard fixtures will now be rolled back' AS result;

ROLLBACK;
