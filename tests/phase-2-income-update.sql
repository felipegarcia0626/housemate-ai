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
  ('28000000-0000-4000-8000-000000000001', 'Income Update Household One', '2000-01-01 00:00:00+00'),
  ('28000000-0000-4000-8000-000000000002', 'Income Update Household Two', '2000-01-01 00:00:00+00');

INSERT INTO public.tb_users (id, display_name, external_identifier, created_at)
VALUES
  ('28000000-0000-4000-8000-000000000011', 'Income Update User One', 'phase-2-income-update-user-1', '2000-01-01 00:00:00+00'),
  ('28000000-0000-4000-8000-000000000012', 'Income Update User Two', 'phase-2-income-update-user-2', '2000-01-01 00:00:00+00'),
  ('28000000-0000-4000-8000-000000000013', 'Income Update User Three', 'phase-2-income-update-user-3', '2000-01-01 00:00:00+00');

INSERT INTO public.tb_household_members (
  id, household_id, user_id, display_name, created_at
)
VALUES
  ('28000000-0000-4000-8000-000000000021', '28000000-0000-4000-8000-000000000001', '28000000-0000-4000-8000-000000000011', 'Income Update Member One', '2000-01-01 00:00:00+00'),
  ('28000000-0000-4000-8000-000000000022', '28000000-0000-4000-8000-000000000001', '28000000-0000-4000-8000-000000000012', 'Income Update Member Two', '2000-01-01 00:00:00+00'),
  ('28000000-0000-4000-8000-000000000023', '28000000-0000-4000-8000-000000000002', '28000000-0000-4000-8000-000000000013', 'Income Update Member Three', '2000-01-01 00:00:00+00');

INSERT INTO public.tb_categories (id, name, description, created_at)
VALUES (
  '28000000-0000-4000-8000-000000000031',
  'Income Update Category',
  'Temporary category for Income update tests',
  '2000-01-01 00:00:00+00'
);

INSERT INTO public.tb_categories (
  id, name, description, movement_type, level, parent_id, is_active, created_at
)
VALUES (
  '28000000-0000-4000-8000-000000000051',
  'Income Update Macro',
  'Temporary macro category for Income update tests',
  'INCOME',
  'MACRO',
  NULL,
  TRUE,
  '2000-01-01 00:00:00+00'
);

INSERT INTO public.tb_categories (
  id, name, description, movement_type, level, parent_id, is_active, created_at
)
VALUES
  (
    '28000000-0000-4000-8000-000000000052',
    'Income Update Micro A',
    'Initial micro category for Income update tests',
    'INCOME',
    'MICRO',
    '28000000-0000-4000-8000-000000000051',
    TRUE,
    '2000-01-01 00:00:00+00'
  ),
  (
    '28000000-0000-4000-8000-000000000053',
    'Income Update Micro B',
    'Replacement micro category for Income update tests',
    'INCOME',
    'MICRO',
    '28000000-0000-4000-8000-000000000051',
    TRUE,
    '2000-01-01 00:00:00+00'
  );

INSERT INTO public.tb_incomes (
  id, household_id, created_by, member_id, amount, income_date,
  description, category_id, created_at, updated_at
)
VALUES
  ('28000000-0000-4000-8000-000000000041', '28000000-0000-4000-8000-000000000001', '28000000-0000-4000-8000-000000000021', '28000000-0000-4000-8000-000000000021', 100.00, '2026-08-01', 'Original Income', '28000000-0000-4000-8000-000000000052', '2000-01-01 00:00:00+00', '2000-01-01 00:00:00+00'),
  ('28000000-0000-4000-8000-000000000042', '28000000-0000-4000-8000-000000000001', '28000000-0000-4000-8000-000000000021', '28000000-0000-4000-8000-000000000021', 10.00, '2026-08-02', 'Partial Income', NULL, '2000-01-01 00:00:00+00', '2000-01-01 00:00:00+00'),
  ('28000000-0000-4000-8000-000000000043', '28000000-0000-4000-8000-000000000002', '28000000-0000-4000-8000-000000000023', '28000000-0000-4000-8000-000000000023', 999.99, '2026-08-03', 'Other Household Income', NULL, '2000-01-01 00:00:00+00', '2000-01-01 00:00:00+00');

CREATE TEMP TABLE income_update_baseline ON COMMIT DROP AS
SELECT * FROM public.tb_incomes
WHERE id = '28000000-0000-4000-8000-000000000041';

CREATE TEMP TABLE income_category_update_baseline ON COMMIT DROP AS
SELECT * FROM public.tb_incomes
WHERE id = '28000000-0000-4000-8000-000000000041';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.tb_categories AS micro_a
    JOIN public.tb_categories AS macro
      ON macro.id = micro_a.parent_id
     AND macro.movement_type = micro_a.movement_type
    JOIN public.tb_categories AS micro_b
      ON micro_b.parent_id = macro.id
     AND micro_b.movement_type = macro.movement_type
    WHERE micro_a.id = '28000000-0000-4000-8000-000000000052'
      AND micro_b.id = '28000000-0000-4000-8000-000000000053'
      AND macro.level = 'MACRO'
      AND micro_a.level = 'MICRO'
      AND micro_b.level = 'MICRO'
      AND macro.movement_type = 'INCOME'
      AND micro_a.is_active
      AND micro_b.is_active
  ) THEN
    RAISE EXCEPTION 'FAIL Income Micro A and Micro B do not share a valid INCOME hierarchy';
  END IF;
END;
$$;

UPDATE public.tb_incomes
SET category_id = '28000000-0000-4000-8000-000000000053'
WHERE id = '28000000-0000-4000-8000-000000000041'
  AND household_id = '28000000-0000-4000-8000-000000000001';

DO $$
DECLARE
  baseline income_category_update_baseline%ROWTYPE;
  current_income public.tb_incomes%ROWTYPE;
BEGIN
  SELECT * INTO baseline FROM income_category_update_baseline;
  SELECT * INTO current_income FROM public.tb_incomes
  WHERE id = '28000000-0000-4000-8000-000000000041';

  IF baseline.category_id IS DISTINCT FROM '28000000-0000-4000-8000-000000000052'
     OR current_income.category_id IS DISTINCT FROM '28000000-0000-4000-8000-000000000053'
     OR current_income.id IS DISTINCT FROM baseline.id
     OR current_income.household_id IS DISTINCT FROM baseline.household_id
     OR current_income.created_by IS DISTINCT FROM baseline.created_by
     OR current_income.member_id IS DISTINCT FROM baseline.member_id
     OR current_income.amount IS DISTINCT FROM baseline.amount
     OR current_income.income_date IS DISTINCT FROM baseline.income_date
     OR current_income.description IS DISTINCT FROM baseline.description
     OR current_income.created_at IS DISTINCT FROM baseline.created_at THEN
    RAISE EXCEPTION 'FAIL valid Income Micro A to Micro B update changed unexpected fields';
  END IF;

  RAISE NOTICE 'PASS valid Income Micro A to Micro B update preserved other fields';
END;
$$;

UPDATE public.tb_incomes
SET member_id = '28000000-0000-4000-8000-000000000022',
    amount = 1234.56,
    income_date = '2026-08-09',
    description = 'Updated Income',
    category_id = NULL
WHERE id = '28000000-0000-4000-8000-000000000041'
  AND household_id = '28000000-0000-4000-8000-000000000001';

DO $$
DECLARE
  baseline income_update_baseline%ROWTYPE;
  current_income public.tb_incomes%ROWTYPE;
BEGIN
  SELECT * INTO baseline FROM income_update_baseline;
  SELECT * INTO current_income FROM public.tb_incomes
  WHERE id = '28000000-0000-4000-8000-000000000041';

  IF current_income.member_id <> '28000000-0000-4000-8000-000000000022'
     OR current_income.amount <> 1234.56
     OR current_income.income_date <> '2026-08-09'
     OR current_income.description <> 'Updated Income'
     OR current_income.category_id IS NOT NULL
     OR current_income.updated_at <= baseline.updated_at
     OR current_income.id IS DISTINCT FROM baseline.id
     OR current_income.household_id IS DISTINCT FROM baseline.household_id
     OR current_income.created_by IS DISTINCT FROM baseline.created_by
     OR current_income.created_at IS DISTINCT FROM baseline.created_at THEN
    RAISE EXCEPTION 'FAIL valid multi-field Income update';
  END IF;

  RAISE NOTICE 'PASS valid multi-field update, category NULL, precision, immutability and updated_at';
END;
$$;

UPDATE public.tb_incomes
SET description = 'Partial Update Only'
WHERE id = '28000000-0000-4000-8000-000000000042'
  AND household_id = '28000000-0000-4000-8000-000000000001';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.tb_incomes
    WHERE id = '28000000-0000-4000-8000-000000000042'
      AND description = 'Partial Update Only'
      AND member_id = '28000000-0000-4000-8000-000000000021'
      AND amount = 10.00
      AND income_date = '2026-08-02'
      AND category_id IS NULL
  ) THEN
    RAISE EXCEPTION 'FAIL partial Income update changed omitted fields';
  END IF;

  RAISE NOTICE 'PASS partial Income update preserved omitted fields';
END;
$$;

DO $$
DECLARE
  affected_rows INTEGER;
BEGIN
  UPDATE public.tb_incomes
  SET description = 'Must Not Change'
  WHERE id = '28000000-0000-4000-8000-000000000043'
    AND household_id = '28000000-0000-4000-8000-000000000001';
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows <> 0 THEN
    RAISE EXCEPTION 'FAIL other-household Income was updated';
  END IF;

  UPDATE public.tb_incomes
  SET description = 'Must Not Exist'
  WHERE id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
    AND household_id = '28000000-0000-4000-8000-000000000001';
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows <> 0 THEN
    RAISE EXCEPTION 'FAIL nonexistent Income was updated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.tb_incomes
    WHERE id = '28000000-0000-4000-8000-000000000043'
      AND household_id = '28000000-0000-4000-8000-000000000002'
      AND description = 'Other Household Income'
  ) THEN
    RAISE EXCEPTION 'FAIL other-household Income changed';
  END IF;

  RAISE NOTICE 'PASS nonexistent and other-household updates affected zero rows';
END;
$$;

SELECT pg_temp.expect_sqlstate(
  'member from another household',
  $sql$UPDATE public.tb_incomes
    SET member_id = '28000000-0000-4000-8000-000000000023'
    WHERE id = '28000000-0000-4000-8000-000000000042'
      AND household_id = '28000000-0000-4000-8000-000000000001'$sql$,
  '23503'
);

SELECT pg_temp.expect_sqlstate(
  'missing category',
  $sql$UPDATE public.tb_incomes
    SET category_id = '28000000-0000-4000-8000-000000000099'
    WHERE id = '28000000-0000-4000-8000-000000000042'
      AND household_id = '28000000-0000-4000-8000-000000000001'$sql$,
  '23503'
);

SELECT pg_temp.expect_sqlstate(
  'non-positive amount',
  $sql$UPDATE public.tb_incomes
    SET amount = 0.00
    WHERE id = '28000000-0000-4000-8000-000000000042'
      AND household_id = '28000000-0000-4000-8000-000000000001'$sql$,
  '23514'
);

DO $$
DECLARE
  allowed_column TEXT;
  protected_column TEXT;
BEGIN
  FOREACH allowed_column IN ARRAY ARRAY[
    'member_id', 'amount', 'income_date', 'description', 'category_id'
  ] LOOP
    IF NOT has_column_privilege(
      'service_role', 'public.tb_incomes', allowed_column, 'UPDATE'
    ) THEN
      RAISE EXCEPTION 'FAIL service_role lacks UPDATE on %', allowed_column;
    END IF;
  END LOOP;

  FOREACH protected_column IN ARRAY ARRAY[
    'id', 'household_id', 'created_by', 'created_at', 'updated_at'
  ] LOOP
    IF has_column_privilege(
      'service_role', 'public.tb_incomes', protected_column, 'UPDATE'
    ) THEN
      RAISE EXCEPTION 'FAIL service_role has UPDATE on protected column %', protected_column;
    END IF;
  END LOOP;

  IF NOT has_table_privilege('service_role', 'public.tb_incomes', 'DELETE') THEN
    RAISE EXCEPTION 'FAIL service_role lacks approved Income DELETE';
  END IF;

  RAISE NOTICE 'PASS service_role has approved Income UPDATE columns and DELETE';
END;
$$;

SET LOCAL ROLE service_role;

SELECT pg_temp.expect_sqlstate(
  'service_role cannot update household_id',
  $sql$UPDATE public.tb_incomes
    SET household_id = '28000000-0000-4000-8000-000000000002'
    WHERE id = '28000000-0000-4000-8000-000000000042'$sql$,
  '42501'
);

RESET ROLE;

SELECT 'PASS Phase 2 Income update SQL checks completed' AS result;
SELECT 'PASS Phase 2 Income update fixtures will now be rolled back' AS result;

ROLLBACK;
