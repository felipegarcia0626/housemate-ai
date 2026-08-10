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

DELETE FROM public.tb_incomes
WHERE id IN (
  '27000000-0000-4000-8000-000000000041',
  '27000000-0000-4000-8000-000000000042'
);
DELETE FROM public.tb_household_members
WHERE id IN (
  '27000000-0000-4000-8000-000000000021',
  '27000000-0000-4000-8000-000000000022',
  '27000000-0000-4000-8000-000000000023'
);
DELETE FROM public.tb_users
WHERE id IN (
  '27000000-0000-4000-8000-000000000011',
  '27000000-0000-4000-8000-000000000012',
  '27000000-0000-4000-8000-000000000013'
);
DELETE FROM public.tb_households
WHERE id IN (
  '27000000-0000-4000-8000-000000000001',
  '27000000-0000-4000-8000-000000000002'
);
DELETE FROM public.tb_categories
WHERE id = '27000000-0000-4000-8000-000000000031';

INSERT INTO public.tb_households (id, name, created_at)
VALUES
  ('27000000-0000-4000-8000-000000000001', 'Income Create Household A', '2026-08-09T12:00:00Z'),
  ('27000000-0000-4000-8000-000000000002', 'Income Create Household B', '2026-08-09T12:00:00Z');

INSERT INTO public.tb_users (id, display_name, external_identifier, created_at)
VALUES
  ('27000000-0000-4000-8000-000000000011', 'Income Creator A1', 'phase-2-income-create-a1', '2026-08-09T12:00:00Z'),
  ('27000000-0000-4000-8000-000000000012', 'Income Member A2', 'phase-2-income-create-a2', '2026-08-09T12:00:00Z'),
  ('27000000-0000-4000-8000-000000000013', 'Income Member B1', 'phase-2-income-create-b1', '2026-08-09T12:00:00Z');

INSERT INTO public.tb_household_members (id, household_id, user_id, display_name, created_at)
VALUES
  ('27000000-0000-4000-8000-000000000021', '27000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000011', 'Creator A1', '2026-08-09T12:00:00Z'),
  ('27000000-0000-4000-8000-000000000022', '27000000-0000-4000-8000-000000000001', '27000000-0000-4000-8000-000000000012', 'Member A2', '2026-08-09T12:00:00Z'),
  ('27000000-0000-4000-8000-000000000023', '27000000-0000-4000-8000-000000000002', '27000000-0000-4000-8000-000000000013', 'Member B1', '2026-08-09T12:00:00Z');

INSERT INTO public.tb_categories (id, name, description, created_at)
VALUES ('27000000-0000-4000-8000-000000000031', 'Phase 2 Income Create', NULL, '2026-08-09T12:00:00Z');

SET LOCAL ROLE service_role;

INSERT INTO public.tb_incomes (
  id, household_id, created_by, member_id, amount, income_date,
  description, category_id, created_at, updated_at
)
VALUES (
  '27000000-0000-4000-8000-000000000041',
  '27000000-0000-4000-8000-000000000001',
  '27000000-0000-4000-8000-000000000021',
  '27000000-0000-4000-8000-000000000022',
  1234.56,
  '2026-08-09',
  'Income with category',
  '27000000-0000-4000-8000-000000000031',
  '2026-08-09T13:00:00Z',
  '2026-08-09T13:00:00Z'
);

INSERT INTO public.tb_incomes (
  id, household_id, created_by, member_id, amount, income_date,
  description, category_id, created_at, updated_at
)
VALUES (
  '27000000-0000-4000-8000-000000000042',
  '27000000-0000-4000-8000-000000000001',
  '27000000-0000-4000-8000-000000000022',
  '27000000-0000-4000-8000-000000000021',
  0.01,
  '2026-08-09',
  'Income without category',
  NULL,
  '2026-08-09T14:00:00Z',
  '2026-08-09T14:00:00Z'
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.tb_incomes
    WHERE id = '27000000-0000-4000-8000-000000000041'
      AND household_id = '27000000-0000-4000-8000-000000000001'
      AND created_by = '27000000-0000-4000-8000-000000000021'
      AND member_id = '27000000-0000-4000-8000-000000000022'
      AND amount = 1234.56
      AND category_id = '27000000-0000-4000-8000-000000000031'
  ) THEN
    RAISE EXCEPTION 'FAIL valid Income persistence';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.tb_incomes
    WHERE id = '27000000-0000-4000-8000-000000000042'
      AND amount = 0.01
      AND category_id IS NULL
  ) THEN
    RAISE EXCEPTION 'FAIL nullable Income category';
  END IF;

  RAISE NOTICE 'PASS valid Income persistence, ownership, precision and nullable category';
END;
$$;

SELECT pg_temp.expect_sqlstate(
  'created_by from another household',
  $sql$INSERT INTO public.tb_incomes
    (household_id, created_by, member_id, amount, income_date, description)
    VALUES
    ('27000000-0000-4000-8000-000000000001',
     '27000000-0000-4000-8000-000000000023',
     '27000000-0000-4000-8000-000000000021',
     1.00, '2026-08-09', 'Invalid creator')$sql$,
  '23503'
);

SELECT pg_temp.expect_sqlstate(
  'member from another household',
  $sql$INSERT INTO public.tb_incomes
    (household_id, created_by, member_id, amount, income_date, description)
    VALUES
    ('27000000-0000-4000-8000-000000000001',
     '27000000-0000-4000-8000-000000000021',
     '27000000-0000-4000-8000-000000000023',
     1.00, '2026-08-09', 'Invalid member')$sql$,
  '23503'
);

SELECT pg_temp.expect_sqlstate(
  'non-positive amount',
  $sql$INSERT INTO public.tb_incomes
    (household_id, created_by, member_id, amount, income_date, description)
    VALUES
    ('27000000-0000-4000-8000-000000000001',
     '27000000-0000-4000-8000-000000000021',
     '27000000-0000-4000-8000-000000000021',
     0.00, '2026-08-09', 'Invalid amount')$sql$,
  '23514'
);

SELECT pg_temp.expect_sqlstate(
  'missing category',
  $sql$INSERT INTO public.tb_incomes
    (household_id, created_by, member_id, amount, income_date, description, category_id)
    VALUES
    ('27000000-0000-4000-8000-000000000001',
     '27000000-0000-4000-8000-000000000021',
     '27000000-0000-4000-8000-000000000021',
     1.00, '2026-08-09', 'Invalid category',
     '27000000-0000-4000-8000-000000000099')$sql$,
  '23503'
);

RESET ROLE;

DO $$
DECLARE
  allowed_column TEXT;
  protected_column TEXT;
BEGIN
  IF NOT has_table_privilege('service_role', 'public.tb_incomes', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.tb_incomes', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL service_role lacks required Income create privileges';
  END IF;

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
    RAISE EXCEPTION 'FAIL service_role lacks approved Income DELETE privilege';
  END IF;
  RAISE NOTICE 'PASS service_role has required Income create/read/delete and approved column UPDATE privileges';
END;
$$;

SELECT 'PASS Phase 2 Income create SQL checks completed' AS result;

ROLLBACK;
