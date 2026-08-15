BEGIN;

-- Phase 2 Category read integration test. All fixtures are rolled back.

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

INSERT INTO public.tb_categories (id, name, description, created_at)
VALUES
  ('30000000-0000-4000-8000-000000000031', 'Phase 2 Category Read Alpha', 'Temporary read fixture', '2026-08-09T12:00:00Z'),
  ('30000000-0000-4000-8000-000000000032', 'Phase 2 Category Read Beta', NULL, '2026-08-09T12:00:00Z');

SELECT pg_temp.expect_sqlstate(
  'Category name is required',
  $sql$INSERT INTO public.tb_categories (name) VALUES (NULL)$sql$,
  '23502'
);

SELECT pg_temp.expect_sqlstate(
  'Category name is unique',
  $sql$INSERT INTO public.tb_categories (name)
    VALUES ('Phase 2 Category Read Alpha')$sql$,
  '23505'
);

DO $$
BEGIN
  IF NOT has_table_privilege('service_role', 'public.tb_categories', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL service_role lacks Category SELECT';
  END IF;

  IF has_table_privilege(
    'service_role', 'public.tb_categories', 'INSERT, UPDATE, DELETE'
  ) THEN
    RAISE EXCEPTION 'FAIL service_role has unexpected Category write access';
  END IF;

  RAISE NOTICE 'PASS service_role has Category SELECT without INSERT, UPDATE or DELETE';
END;
$$;

SET LOCAL ROLE service_role;

DO $$
DECLARE
  fixture_count INTEGER;
  seed_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO fixture_count
  FROM public.tb_categories
  WHERE (id, name) IN (
    ('30000000-0000-4000-8000-000000000031'::UUID, 'Phase 2 Category Read Alpha'),
    ('30000000-0000-4000-8000-000000000032'::UUID, 'Phase 2 Category Read Beta')
  );

  IF fixture_count <> 2 THEN
    RAISE EXCEPTION 'FAIL Category read did not return both id/name fixtures';
  END IF;

  SELECT COUNT(*) INTO seed_count
  FROM public.tb_categories
  WHERE (id, name) IN (
    ('00000000-0000-4000-8000-000000000031'::UUID, 'Alimentación'),
    ('00000000-0000-4000-8000-000000000032'::UUID, 'Otros'),
    ('00000000-0000-4000-8000-000000000033'::UUID, 'Salario'),
    ('00000000-0000-4000-8000-000000000034'::UUID, 'Honorarios'),
    ('00000000-0000-4000-8000-000000000035'::UUID, 'Vivienda'),
    ('00000000-0000-4000-8000-000000000036'::UUID, 'Transporte'),
    ('00000000-0000-4000-8000-000000000037'::UUID, 'Salud'),
    ('00000000-0000-4000-8000-000000000038'::UUID, 'Mascotas'),
    ('00000000-0000-4000-8000-000000000039'::UUID, 'Ocio'),
    ('00000000-0000-4000-8000-000000000040'::UUID, 'Servicios'),
    ('00000000-0000-4000-8000-000000000046'::UUID, 'Compras'),
    ('00000000-0000-4000-8000-000000000047'::UUID, 'Educación'),
    ('00000000-0000-4000-8000-000000000048'::UUID, 'Deudas y obligaciones'),
    ('00000000-0000-4000-8000-000000000049'::UUID, 'Viajes'),
    ('00000000-0000-4000-8000-000000000050'::UUID, 'Impuestos')
  );

  IF seed_count <> 15 THEN
    RAISE EXCEPTION 'FAIL deterministic seed Categories are not fully readable';
  END IF;

  RAISE NOTICE 'PASS Category ids and names are readable without order dependence';
  RAISE NOTICE 'PASS all deterministic seed Categories are readable';
END;
$$;

RESET ROLE;

SELECT 'PASS Phase 2 Category read SQL checks completed' AS result;
SELECT 'PASS Phase 2 Category read fixtures will now be rolled back' AS result;

ROLLBACK;
