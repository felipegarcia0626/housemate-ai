BEGIN;

-- Phase 2 Income read integration test. All fixtures are rolled back.

-- Remove only this test's deterministic fixtures so an interrupted earlier run
-- cannot prevent the fixture graph from being recreated in this transaction.
DELETE FROM public.tb_incomes
WHERE id IN (
  '26000000-0000-4000-8000-000000000041',
  '26000000-0000-4000-8000-000000000042',
  '26000000-0000-4000-8000-000000000043',
  '26000000-0000-4000-8000-000000000044'
);

DELETE FROM public.tb_household_members
WHERE id IN (
  '26000000-0000-4000-8000-000000000021',
  '26000000-0000-4000-8000-000000000022',
  '26000000-0000-4000-8000-000000000023'
);

DELETE FROM public.tb_users
WHERE id IN (
  '26000000-0000-4000-8000-000000000011',
  '26000000-0000-4000-8000-000000000012',
  '26000000-0000-4000-8000-000000000013'
);

DELETE FROM public.tb_households
WHERE id IN (
  '26000000-0000-4000-8000-000000000001',
  '26000000-0000-4000-8000-000000000002'
);

DELETE FROM public.tb_categories
WHERE id IN (
  '26000000-0000-4000-8000-000000000031',
  '26000000-0000-4000-8000-000000000032'
);

INSERT INTO public.tb_households (id, name, created_at)
VALUES
  ('26000000-0000-4000-8000-000000000001', 'Income Read Household A', '2026-08-09T12:00:00Z'),
  ('26000000-0000-4000-8000-000000000002', 'Income Read Household B', '2026-08-09T12:00:00Z');

INSERT INTO public.tb_users (id, display_name, external_identifier, created_at)
VALUES
  ('26000000-0000-4000-8000-000000000011', 'Income Reader A1', 'phase-2-income-a1', '2026-08-09T12:00:00Z'),
  ('26000000-0000-4000-8000-000000000012', 'Income Reader A2', 'phase-2-income-a2', '2026-08-09T12:00:00Z'),
  ('26000000-0000-4000-8000-000000000013', 'Income Reader B1', 'phase-2-income-b1', '2026-08-09T12:00:00Z');

INSERT INTO public.tb_household_members (id, household_id, user_id, display_name, created_at)
VALUES
  ('26000000-0000-4000-8000-000000000021', '26000000-0000-4000-8000-000000000001', '26000000-0000-4000-8000-000000000011', 'Member A1', '2026-08-09T12:00:00Z'),
  ('26000000-0000-4000-8000-000000000022', '26000000-0000-4000-8000-000000000001', '26000000-0000-4000-8000-000000000012', 'Member A2', '2026-08-09T12:00:00Z'),
  ('26000000-0000-4000-8000-000000000023', '26000000-0000-4000-8000-000000000002', '26000000-0000-4000-8000-000000000013', 'Member B1', '2026-08-09T12:00:00Z');

INSERT INTO public.tb_categories (id, name, description, created_at)
VALUES
  ('26000000-0000-4000-8000-000000000031', 'Phase 2 Income Salary', NULL, '2026-08-09T12:00:00Z'),
  ('26000000-0000-4000-8000-000000000032', 'Phase 2 Income Freelance', NULL, '2026-08-09T12:00:00Z');

INSERT INTO public.tb_incomes (
  id, household_id, created_by, member_id, amount, income_date,
  description, category_id, created_at, updated_at
)
VALUES
  ('26000000-0000-4000-8000-000000000041', '26000000-0000-4000-8000-000000000001', '26000000-0000-4000-8000-000000000021', '26000000-0000-4000-8000-000000000021', 1000.01, '2026-08-03', 'Salary', '26000000-0000-4000-8000-000000000031', '2026-08-03T12:00:00Z', '2026-08-03T12:00:00Z'),
  ('26000000-0000-4000-8000-000000000042', '26000000-0000-4000-8000-000000000001', '26000000-0000-4000-8000-000000000021', '26000000-0000-4000-8000-000000000022', 20.02, '2026-08-03', 'Freelance', '26000000-0000-4000-8000-000000000032', '2026-08-03T13:00:00Z', '2026-08-03T13:00:00Z'),
  ('26000000-0000-4000-8000-000000000043', '26000000-0000-4000-8000-000000000001', '26000000-0000-4000-8000-000000000022', '26000000-0000-4000-8000-000000000021', 3.03, '2026-08-02', 'Uncategorized', NULL, '2026-08-02T12:00:00Z', '2026-08-02T12:00:00Z'),
  ('26000000-0000-4000-8000-000000000044', '26000000-0000-4000-8000-000000000002', '26000000-0000-4000-8000-000000000023', '26000000-0000-4000-8000-000000000023', 9999.99, '2026-08-03', 'Other household', NULL, '2026-08-03T14:00:00Z', '2026-08-03T14:00:00Z');

DO $$
DECLARE
  actual_ids UUID[];
  actual_count INTEGER;
  actual_total NUMERIC(14,2);
BEGIN
  SELECT array_agg(id ORDER BY income_date DESC, created_at DESC, id ASC), COUNT(*), COALESCE(SUM(amount), 0)
  INTO actual_ids, actual_count, actual_total
  FROM public.tb_incomes
  WHERE household_id = '26000000-0000-4000-8000-000000000001';

  IF actual_count <> 3 OR actual_total <> 1023.06 THEN
    RAISE EXCEPTION 'FAIL household list/total: count %, total %', actual_count, actual_total;
  END IF;

  IF actual_ids <> ARRAY[
    '26000000-0000-4000-8000-000000000042'::UUID,
    '26000000-0000-4000-8000-000000000041'::UUID,
    '26000000-0000-4000-8000-000000000043'::UUID
  ] THEN
    RAISE EXCEPTION 'FAIL deterministic order: %', actual_ids;
  END IF;
  RAISE NOTICE 'PASS list, household isolation, deterministic order and precise totalIncome';

  SELECT COUNT(*) INTO actual_count FROM public.tb_incomes
  WHERE household_id = '26000000-0000-4000-8000-000000000001' AND income_date >= '2026-08-03';
  IF actual_count <> 2 THEN RAISE EXCEPTION 'FAIL from filter'; END IF;

  SELECT COUNT(*) INTO actual_count FROM public.tb_incomes
  WHERE household_id = '26000000-0000-4000-8000-000000000001' AND income_date <= '2026-08-02';
  IF actual_count <> 1 THEN RAISE EXCEPTION 'FAIL to filter'; END IF;

  SELECT COUNT(*) INTO actual_count FROM public.tb_incomes
  WHERE household_id = '26000000-0000-4000-8000-000000000001'
    AND income_date >= '2026-08-02' AND income_date <= '2026-08-02';
  IF actual_count <> 1 THEN RAISE EXCEPTION 'FAIL date range filter'; END IF;

  SELECT COUNT(*) INTO actual_count FROM public.tb_incomes
  WHERE household_id = '26000000-0000-4000-8000-000000000001'
    AND member_id = '26000000-0000-4000-8000-000000000021';
  IF actual_count <> 2 THEN RAISE EXCEPTION 'FAIL member filter'; END IF;

  SELECT COUNT(*) INTO actual_count FROM public.tb_incomes
  WHERE household_id = '26000000-0000-4000-8000-000000000001'
    AND category_id = '26000000-0000-4000-8000-000000000032';
  IF actual_count <> 1 THEN RAISE EXCEPTION 'FAIL category filter'; END IF;

  SELECT COUNT(*) INTO actual_count FROM public.tb_incomes
  WHERE household_id = '26000000-0000-4000-8000-000000000001'
    AND income_date >= '2026-08-03'
    AND member_id = '26000000-0000-4000-8000-000000000022'
    AND category_id = '26000000-0000-4000-8000-000000000032';
  IF actual_count <> 1 THEN RAISE EXCEPTION 'FAIL combined filters'; END IF;

  SELECT COUNT(*), COALESCE(SUM(amount), 0) INTO actual_count, actual_total
  FROM public.tb_incomes
  WHERE household_id = '26000000-0000-4000-8000-000000000001'
    AND income_date = '2025-01-01';
  IF actual_count <> 0 OR actual_total <> 0 THEN RAISE EXCEPTION 'FAIL empty result'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.tb_incomes
    WHERE household_id = '26000000-0000-4000-8000-000000000001' AND category_id IS NULL
  ) THEN RAISE EXCEPTION 'FAIL nullable category read'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.tb_incomes
    WHERE household_id = '26000000-0000-4000-8000-000000000001'
      AND member_id = '26000000-0000-4000-8000-000000000023'
  ) THEN RAISE EXCEPTION 'FAIL cross-household member isolation'; END IF;

  RAISE NOTICE 'PASS from, to, range, member, category, combined, nullable category and empty-result queries';
END;
$$;

DO $$
DECLARE
  allowed_column TEXT;
  protected_column TEXT;
BEGIN
  IF NOT has_table_privilege('service_role', 'public.tb_incomes', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL service_role lacks SELECT on tb_incomes';
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
  RAISE NOTICE 'PASS service_role retains Income read, approved column UPDATE and DELETE access';
END;
$$;

-- Collection-scale read fixtures exercise the same filtered dataset used by
-- the paginated HTTP collection without changing the persistent database.
INSERT INTO public.tb_incomes (
  id, household_id, created_by, member_id, amount, income_date,
  description, category_id, created_at, updated_at
)
SELECT
  ('26000000-0000-4000-8000-' || lpad((100 + series.n)::text, 12, '0'))::uuid,
  '26000000-0000-4000-8000-000000000001'::uuid,
  '26000000-0000-4000-8000-000000000021'::uuid,
  '26000000-0000-4000-8000-000000000021'::uuid,
  100 + series.n,
  '2026-08-10'::date,
  'Income pagination fixture ' || series.n,
  NULL,
  '2026-08-10T12:00:00Z'::timestamptz + series.n * interval '1 minute',
  '2026-08-10T12:00:00Z'::timestamptz + series.n * interval '1 minute'
FROM generate_series(0, 25) AS series(n);

DO $$
DECLARE
  fixture_count INTEGER;
  fixture_total NUMERIC(14, 2);
  first_amount NUMERIC(14, 2);
  last_amount NUMERIC(14, 2);
BEGIN
  SELECT COUNT(*), COALESCE(SUM(amount), 0)
  INTO fixture_count, fixture_total
  FROM public.tb_incomes
  WHERE household_id = '26000000-0000-4000-8000-000000000001'
    AND description LIKE 'Income pagination fixture %';

  IF fixture_count <> 26 OR fixture_total <> 2925 THEN
    RAISE EXCEPTION 'FAIL paginated fixture set: count %, total %', fixture_count, fixture_total;
  END IF;

  SELECT amount INTO first_amount
  FROM public.tb_incomes
  WHERE household_id = '26000000-0000-4000-8000-000000000001'
    AND description LIKE 'Income pagination fixture %'
  ORDER BY amount ASC, id ASC
  LIMIT 1;

  SELECT amount INTO last_amount
  FROM public.tb_incomes
  WHERE household_id = '26000000-0000-4000-8000-000000000001'
    AND description LIKE 'Income pagination fixture %'
  ORDER BY amount DESC, id ASC
  LIMIT 1;

  IF first_amount <> 100 OR last_amount <> 125 THEN
    RAISE EXCEPTION 'FAIL deterministic amount sorting: first %, last %', first_amount, last_amount;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.tb_incomes
    WHERE household_id = '26000000-0000-4000-8000-000000000002'
      AND description LIKE 'Income pagination fixture %'
  ) THEN
    RAISE EXCEPTION 'FAIL household isolation for paginated fixtures';
  END IF;

  RAISE NOTICE 'PASS collection-scale count, total, deterministic sort and household isolation';
END;
$$;

SELECT 'PASS Phase 2 Income read SQL checks completed' AS result;

ROLLBACK;
