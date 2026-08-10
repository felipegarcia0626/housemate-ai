BEGIN;

-- Phase 2 Income delete integration test. All fixtures are rolled back.

DELETE FROM public.tb_incomes
WHERE id IN (
  '29000000-0000-4000-8000-000000000041',
  '29000000-0000-4000-8000-000000000042'
);

DELETE FROM public.tb_household_members
WHERE id IN (
  '29000000-0000-4000-8000-000000000021',
  '29000000-0000-4000-8000-000000000022'
);

DELETE FROM public.tb_users
WHERE id IN (
  '29000000-0000-4000-8000-000000000011',
  '29000000-0000-4000-8000-000000000012'
);

DELETE FROM public.tb_households
WHERE id IN (
  '29000000-0000-4000-8000-000000000001',
  '29000000-0000-4000-8000-000000000002'
);

INSERT INTO public.tb_households (id, name, created_at)
VALUES
  ('29000000-0000-4000-8000-000000000001', 'Income Delete Household A', '2026-08-09T12:00:00Z'),
  ('29000000-0000-4000-8000-000000000002', 'Income Delete Household B', '2026-08-09T12:00:00Z');

INSERT INTO public.tb_users (id, display_name, external_identifier, created_at)
VALUES
  ('29000000-0000-4000-8000-000000000011', 'Income Delete User A', 'phase-2-income-delete-a', '2026-08-09T12:00:00Z'),
  ('29000000-0000-4000-8000-000000000012', 'Income Delete User B', 'phase-2-income-delete-b', '2026-08-09T12:00:00Z');

INSERT INTO public.tb_household_members (
  id, household_id, user_id, display_name, created_at
)
VALUES
  ('29000000-0000-4000-8000-000000000021', '29000000-0000-4000-8000-000000000001', '29000000-0000-4000-8000-000000000011', 'Income Delete Member A', '2026-08-09T12:00:00Z'),
  ('29000000-0000-4000-8000-000000000022', '29000000-0000-4000-8000-000000000002', '29000000-0000-4000-8000-000000000012', 'Income Delete Member B', '2026-08-09T12:00:00Z');

INSERT INTO public.tb_incomes (
  id, household_id, created_by, member_id, amount, income_date,
  description, category_id, created_at, updated_at
)
VALUES
  ('29000000-0000-4000-8000-000000000041', '29000000-0000-4000-8000-000000000001', '29000000-0000-4000-8000-000000000021', '29000000-0000-4000-8000-000000000021', 100.00, '2026-08-09', 'Income to delete', NULL, '2026-08-09T12:00:00Z', '2026-08-09T12:00:00Z'),
  ('29000000-0000-4000-8000-000000000042', '29000000-0000-4000-8000-000000000002', '29000000-0000-4000-8000-000000000022', '29000000-0000-4000-8000-000000000022', 200.00, '2026-08-09', 'Income in another household', NULL, '2026-08-09T12:00:00Z', '2026-08-09T12:00:00Z');

DO $$
BEGIN
  IF NOT has_table_privilege('service_role', 'public.tb_incomes', 'DELETE')
     OR NOT has_table_privilege('service_role', 'public.tb_incomes', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.tb_incomes', 'INSERT') THEN
    RAISE EXCEPTION 'FAIL service_role lacks required Income privileges';
  END IF;

  IF NOT has_column_privilege(
    'service_role', 'public.tb_incomes', 'description', 'UPDATE'
  ) THEN
    RAISE EXCEPTION 'FAIL service_role lacks approved Income UPDATE';
  END IF;

  IF has_column_privilege(
    'service_role', 'public.tb_incomes', 'household_id', 'UPDATE'
  ) THEN
    RAISE EXCEPTION 'FAIL service_role can update protected household_id';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.role_table_grants
    WHERE grantee = 'service_role'
      AND table_schema = 'public'
      AND privilege_type = 'DELETE'
      AND table_name NOT IN (
        'tb_expenses',
        'tb_expense_items',
        'tb_expense_distributions',
        'tb_incomes'
      )
  ) THEN
    RAISE EXCEPTION 'FAIL service_role has unexpected DELETE on another table';
  END IF;

  RAISE NOTICE 'PASS service_role has minimum Income DELETE and existing read/create/update access';
END;
$$;

SET LOCAL ROLE service_role;

DO $$
DECLARE
  deleted_id UUID;
  affected_rows INTEGER;
BEGIN
  DELETE FROM public.tb_incomes
  WHERE id = '29000000-0000-4000-8000-000000000041'
    AND household_id = '29000000-0000-4000-8000-000000000001'
  RETURNING id INTO deleted_id;

  IF deleted_id IS DISTINCT FROM '29000000-0000-4000-8000-000000000041'::UUID THEN
    RAISE EXCEPTION 'FAIL valid Income delete did not return the expected id';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tb_incomes
    WHERE id = '29000000-0000-4000-8000-000000000041'
  ) THEN
    RAISE EXCEPTION 'FAIL deleted Income remains persisted';
  END IF;

  DELETE FROM public.tb_incomes
  WHERE id = '29000000-0000-4000-8000-000000000042'
    AND household_id = '29000000-0000-4000-8000-000000000001';
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows <> 0 THEN
    RAISE EXCEPTION 'FAIL cross-household delete affected a row';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.tb_incomes
    WHERE id = '29000000-0000-4000-8000-000000000042'
      AND household_id = '29000000-0000-4000-8000-000000000002'
  ) THEN
    RAISE EXCEPTION 'FAIL cross-household Income was removed';
  END IF;

  DELETE FROM public.tb_incomes
  WHERE id = '29000000-0000-4000-8000-000000000099'
    AND household_id = '29000000-0000-4000-8000-000000000001';
  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows <> 0 THEN
    RAISE EXCEPTION 'FAIL nonexistent Income delete affected a row';
  END IF;

  RAISE NOTICE 'PASS valid physical delete returned id and removed the Income';
  RAISE NOTICE 'PASS compound id + household_id filter isolates foreign and missing Incomes';
END;
$$;

RESET ROLE;

SELECT 'PASS Phase 2 Income delete SQL checks completed' AS result;
SELECT 'PASS Phase 2 Income delete fixtures will now be rolled back' AS result;

ROLLBACK;
