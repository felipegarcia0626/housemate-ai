BEGIN;

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
      RAISE EXCEPTION 'FAIL %: expected SQLSTATE %, received % (%)',
        test_name, expected_state, actual_state, actual_message;
    END IF;

    RAISE NOTICE 'PASS %: SQLSTATE %', test_name, actual_state;
    RETURN;
  END;

  RAISE EXCEPTION 'FAIL %: statement succeeded; expected SQLSTATE %',
    test_name, expected_state;
END;
$$;

INSERT INTO public.tb_categories (id, name, description)
VALUES (
  '60000000-0000-4000-8000-000000000001',
  'Phase 2 Legacy Category',
  'Legacy compatibility fixture'
);

DO $$
DECLARE
  legacy_category public.tb_categories;
BEGIN
  SELECT * INTO legacy_category
  FROM public.tb_categories
  WHERE id = '60000000-0000-4000-8000-000000000001';

  IF legacy_category.movement_type IS NOT NULL
     OR legacy_category.level IS NOT NULL
     OR legacy_category.parent_id IS NOT NULL
     OR NOT legacy_category.is_active
     OR legacy_category.updated_at IS NULL THEN
    RAISE EXCEPTION 'FAIL legacy category defaults are not compatible';
  END IF;

  RAISE NOTICE 'PASS legacy category remains untyped and active by default';
END;
$$;

INSERT INTO public.tb_categories (
  id, movement_type, level, name, description
)
VALUES
  (
    '60000000-0000-4000-8000-000000000010',
    'EXPENSE',
    'MACRO',
    'Phase 2 Expense Macro',
    NULL
  ),
  (
    '60000000-0000-4000-8000-000000000011',
    'INCOME',
    'MACRO',
    'Phase 2 Income Macro',
    NULL
  );

INSERT INTO public.tb_categories (
  id, movement_type, level, parent_id, name, description
)
VALUES
  (
    '60000000-0000-4000-8000-000000000012',
    'EXPENSE',
    'MICRO',
    '60000000-0000-4000-8000-000000000010',
    'Phase 2 Expense Micro',
    NULL
  ),
  (
    '60000000-0000-4000-8000-000000000013',
    'INCOME',
    'MICRO',
    '60000000-0000-4000-8000-000000000011',
    'Phase 2 Income Micro',
    NULL
  );

DO $$
BEGIN
  IF (
    SELECT COUNT(*)
    FROM public.tb_categories
    WHERE id IN (
      '60000000-0000-4000-8000-000000000010',
      '60000000-0000-4000-8000-000000000011',
      '60000000-0000-4000-8000-000000000012',
      '60000000-0000-4000-8000-000000000013'
    )
  ) <> 4 THEN
    RAISE EXCEPTION 'FAIL valid macro/micro fixtures were not inserted';
  END IF;

  RAISE NOTICE 'PASS valid EXPENSE and INCOME macro/micro hierarchies';
END;
$$;

SELECT pg_temp.expect_sqlstate(
  'MICRO requires parent',
  $sql$INSERT INTO public.tb_categories (id, movement_type, level, name)
        VALUES ('60000000-0000-4000-8000-000000000020', 'EXPENSE', 'MICRO', 'No parent')$sql$,
  '23514'
);

SELECT pg_temp.expect_sqlstate(
  'MACRO cannot have parent',
  $sql$INSERT INTO public.tb_categories (id, movement_type, level, parent_id, name)
        VALUES ('60000000-0000-4000-8000-000000000021', 'EXPENSE', 'MACRO', '60000000-0000-4000-8000-000000000010', 'Macro with parent')$sql$,
  '23514'
);

SELECT pg_temp.expect_sqlstate(
  'MICRO parent must be MACRO',
  $sql$INSERT INTO public.tb_categories (id, movement_type, level, parent_id, name)
        VALUES ('60000000-0000-4000-8000-000000000022', 'EXPENSE', 'MICRO', '60000000-0000-4000-8000-000000000012', 'Micro parent')$sql$,
  '23514'
);

SELECT pg_temp.expect_sqlstate(
  'MICRO parent must have same movement type',
  $sql$INSERT INTO public.tb_categories (id, movement_type, level, parent_id, name)
        VALUES ('60000000-0000-4000-8000-000000000023', 'INCOME', 'MICRO', '60000000-0000-4000-8000-000000000010', 'Cross movement parent')$sql$,
  '23514'
);

SELECT pg_temp.expect_sqlstate(
  'Duplicate legacy names remain blocked',
  $sql$INSERT INTO public.tb_categories (id, name)
        VALUES ('60000000-0000-4000-8000-000000000024', 'Phase 2 Legacy Category')$sql$,
  '23505'
);

SELECT pg_temp.expect_sqlstate(
  'Duplicate EXPENSE macro names are blocked',
  $sql$INSERT INTO public.tb_categories (id, movement_type, level, name)
        VALUES ('60000000-0000-4000-8000-000000000025', 'EXPENSE', 'MACRO', 'Phase 2 Expense Macro')$sql$,
  '23505'
);

SELECT pg_temp.expect_sqlstate(
  'Duplicate EXPENSE micro names under same parent are blocked',
  $sql$INSERT INTO public.tb_categories (id, movement_type, level, parent_id, name)
        VALUES ('60000000-0000-4000-8000-000000000026', 'EXPENSE', 'MICRO', '60000000-0000-4000-8000-000000000010', 'Phase 2 Expense Micro')$sql$,
  '23505'
);

INSERT INTO public.tb_categories (id, movement_type, level, name)
VALUES (
  '60000000-0000-4000-8000-000000000027',
  'INCOME',
  'MACRO',
  'Phase 2 Expense Macro'
);

DO $$
BEGIN
  RAISE NOTICE 'PASS same category name is allowed across movement types';
END;
$$;

INSERT INTO public.tb_expenses (
  id,
  household_id,
  created_by,
  paid_by,
  category_id,
  merchant,
  total_amount,
  expense_date,
  status,
  source
)
VALUES (
  '60000000-0000-4000-8000-000000000030',
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000021',
  '00000000-0000-4000-8000-000000000021',
  '60000000-0000-4000-8000-000000000001',
  'Phase 2 legacy expense',
  1.00,
  '2026-01-01',
  'PENDING',
  'WEB'
);

INSERT INTO public.tb_incomes (
  id,
  household_id,
  created_by,
  member_id,
  amount,
  income_date,
  description,
  category_id
)
VALUES (
  '60000000-0000-4000-8000-000000000031',
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000021',
  '00000000-0000-4000-8000-000000000021',
  1.00,
  '2026-01-01',
  'Phase 2 legacy income',
  '60000000-0000-4000-8000-000000000001'
);

DO $$
BEGIN
  IF (
    SELECT COUNT(*)
    FROM public.tb_expenses
    WHERE id = '60000000-0000-4000-8000-000000000030'
      AND category_id = '60000000-0000-4000-8000-000000000001'
  ) <> 1 THEN
    RAISE EXCEPTION 'FAIL existing Expense category FK is not preserved';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM public.tb_incomes
    WHERE id = '60000000-0000-4000-8000-000000000031'
      AND category_id = '60000000-0000-4000-8000-000000000001'
  ) <> 1 THEN
    RAISE EXCEPTION 'FAIL existing Income category FK is not preserved';
  END IF;

  RAISE NOTICE 'PASS existing Expense and Income category references remain valid';
END;
$$;

SELECT 'PASS Phase 2 hierarchical category schema checks completed' AS result;

ROLLBACK;
