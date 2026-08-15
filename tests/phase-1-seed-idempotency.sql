BEGIN;

-- Run with:
-- psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f tests/phase-1-seed-idempotency.sql
-- \ir resolves the seed path relative to this test file.

\ir ../database/seeds/0001_initial_seed.sql

CREATE TEMP TABLE phase_1_seed_households_before ON COMMIT DROP AS
SELECT id, name, created_at
FROM public.tb_households
WHERE id = '00000000-0000-4000-8000-000000000001';

CREATE TEMP TABLE phase_1_seed_users_before ON COMMIT DROP AS
SELECT id, display_name, external_identifier, created_at
FROM public.tb_users
WHERE id IN (
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000012'
);

CREATE TEMP TABLE phase_1_seed_members_before ON COMMIT DROP AS
SELECT id, household_id, user_id, display_name, created_at
FROM public.tb_household_members
WHERE id IN (
  '00000000-0000-4000-8000-000000000021',
  '00000000-0000-4000-8000-000000000022'
);

CREATE TEMP TABLE phase_1_seed_categories_before ON COMMIT DROP AS
SELECT id, name, description, created_at
FROM public.tb_categories
WHERE id IN (
  '00000000-0000-4000-8000-000000000031',
  '00000000-0000-4000-8000-000000000032',
  '00000000-0000-4000-8000-000000000033',
  '00000000-0000-4000-8000-000000000034',
  '00000000-0000-4000-8000-000000000035',
  '00000000-0000-4000-8000-000000000036',
  '00000000-0000-4000-8000-000000000037',
  '00000000-0000-4000-8000-000000000038',
  '00000000-0000-4000-8000-000000000039',
  '00000000-0000-4000-8000-000000000040',
  '00000000-0000-4000-8000-000000000046',
  '00000000-0000-4000-8000-000000000047',
  '00000000-0000-4000-8000-000000000048',
  '00000000-0000-4000-8000-000000000049',
  '00000000-0000-4000-8000-000000000050'
);

CREATE TEMP TABLE phase_1_seed_rules_before ON COMMIT DROP AS
SELECT id, household_id, name, description, created_at, updated_at
FROM public.tb_sharing_rules
WHERE id IN (
  '00000000-0000-4000-8000-000000000041',
  '00000000-0000-4000-8000-000000000042'
);

CREATE TEMP TABLE phase_1_seed_rule_members_before ON COMMIT DROP AS
SELECT id, sharing_rule_id, household_member_id, percentage
FROM public.tb_sharing_rule_members
WHERE id IN (
  '00000000-0000-4000-8000-000000000051',
  '00000000-0000-4000-8000-000000000052',
  '00000000-0000-4000-8000-000000000053',
  '00000000-0000-4000-8000-000000000054'
);

\ir ../database/seeds/0001_initial_seed.sql

SET CONSTRAINTS ALL IMMEDIATE;

DO $$
DECLARE
  fixed_timestamp CONSTANT TIMESTAMPTZ := '2026-01-01 00:00:00+00';
BEGIN
  IF (
    SELECT COUNT(*)
    FROM public.tb_households
    WHERE id = '00000000-0000-4000-8000-000000000001'
      AND name = 'Hogar Demo'
      AND created_at = fixed_timestamp
  ) <> 1 THEN
    RAISE EXCEPTION 'Seed household count or values changed after second execution';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM public.tb_users
    WHERE created_at = fixed_timestamp
      AND (
        (
          id = '00000000-0000-4000-8000-000000000011'
          AND display_name = 'Felipe'
          AND external_identifier = 'seed-user-felipe'
        )
        OR (
          id = '00000000-0000-4000-8000-000000000012'
          AND display_name = 'Pareja'
          AND external_identifier = 'seed-user-pareja'
        )
      )
  ) <> 2 THEN
    RAISE EXCEPTION 'Seed user count or values changed after second execution';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM public.tb_household_members
    WHERE household_id = '00000000-0000-4000-8000-000000000001'
      AND created_at = fixed_timestamp
      AND (
        (
          id = '00000000-0000-4000-8000-000000000021'
          AND user_id = '00000000-0000-4000-8000-000000000011'
          AND display_name = 'Felipe'
        )
        OR (
          id = '00000000-0000-4000-8000-000000000022'
          AND user_id = '00000000-0000-4000-8000-000000000012'
          AND display_name = 'Pareja'
        )
      )
  ) <> 2 THEN
    RAISE EXCEPTION 'Seed member count, relationships or values changed after second execution';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM (
      VALUES
        ('00000000-0000-4000-8000-000000000031', 'Alimentación', 'Compras de alimentos'),
        ('00000000-0000-4000-8000-000000000032', 'Otros', 'Registros sin categoría específica'),
        ('00000000-0000-4000-8000-000000000033', 'Salario', 'Ingresos salariales'),
        ('00000000-0000-4000-8000-000000000034', 'Honorarios', 'Ingresos por servicios profesionales'),
        ('00000000-0000-4000-8000-000000000035', 'Vivienda', 'Arriendo, hipoteca, reparaciones y mantenimiento del hogar'),
        ('00000000-0000-4000-8000-000000000036', 'Transporte', 'Gasolina, transporte público, parqueadero y mantenimiento'),
        ('00000000-0000-4000-8000-000000000037', 'Salud', 'Consultas, medicamentos y tratamientos'),
        ('00000000-0000-4000-8000-000000000038', 'Mascotas', 'Veterinario, alimento y accesorios'),
        ('00000000-0000-4000-8000-000000000039', 'Ocio', 'Cine, entretenimiento, actividades y salidas'),
        ('00000000-0000-4000-8000-000000000040', 'Servicios', 'Energía, agua, internet, telefonía y suscripciones básicas'),
        ('00000000-0000-4000-8000-000000000046', 'Compras', 'Ropa, artículos personales y compras generales'),
        ('00000000-0000-4000-8000-000000000047', 'Educación', 'Matrículas, cursos, libros y materiales'),
        ('00000000-0000-4000-8000-000000000048', 'Deudas y obligaciones', 'Cuotas, créditos y obligaciones financieras'),
        ('00000000-0000-4000-8000-000000000049', 'Viajes', 'Alojamiento, vuelos y gastos de viaje'),
        ('00000000-0000-4000-8000-000000000050', 'Impuestos', 'Impuestos, tasas y contribuciones')
    ) AS expected(id, name, description)
    JOIN public.tb_categories AS category
      ON category.id::TEXT = expected.id
     AND category.name = expected.name
     AND category.description = expected.description
     AND category.created_at = fixed_timestamp
  ) <> 15 THEN
    RAISE EXCEPTION 'Seed category count or values changed after second execution';
  END IF;

  IF NOT (
    SELECT COUNT(*) = 15 AND COUNT(DISTINCT name) = 15
    FROM public.tb_categories
    WHERE id IN (
      '00000000-0000-4000-8000-000000000031',
      '00000000-0000-4000-8000-000000000032',
      '00000000-0000-4000-8000-000000000033',
      '00000000-0000-4000-8000-000000000034',
      '00000000-0000-4000-8000-000000000035',
      '00000000-0000-4000-8000-000000000036',
      '00000000-0000-4000-8000-000000000037',
      '00000000-0000-4000-8000-000000000038',
      '00000000-0000-4000-8000-000000000039',
      '00000000-0000-4000-8000-000000000040',
      '00000000-0000-4000-8000-000000000046',
      '00000000-0000-4000-8000-000000000047',
      '00000000-0000-4000-8000-000000000048',
      '00000000-0000-4000-8000-000000000049',
      '00000000-0000-4000-8000-000000000050'
    )
  ) THEN
    RAISE EXCEPTION 'Seed category names are not all present or unique';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM public.tb_sharing_rules
    WHERE id = '00000000-0000-4000-8000-000000000041'
      AND household_id = '00000000-0000-4000-8000-000000000001'
      AND name = '50 / 50'
      AND description = 'Distribución equitativa entre los dos integrantes'
      AND created_at = fixed_timestamp
      AND updated_at = fixed_timestamp
  ) <> 1 THEN
    RAISE EXCEPTION 'Seed sharing rule count, relationship, values or timestamps changed';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM public.tb_sharing_rule_members
    WHERE sharing_rule_id = '00000000-0000-4000-8000-000000000041'
      AND percentage = 50.00
      AND (
        (
          id = '00000000-0000-4000-8000-000000000051'
          AND household_member_id = '00000000-0000-4000-8000-000000000021'
        )
        OR (
          id = '00000000-0000-4000-8000-000000000052'
          AND household_member_id = '00000000-0000-4000-8000-000000000022'
        )
      )
  ) <> 2 THEN
    RAISE EXCEPTION 'Seed rule-member count, relationships or percentages changed';
  END IF;

  IF (
    SELECT SUM(percentage)
    FROM public.tb_sharing_rule_members
    WHERE sharing_rule_id = '00000000-0000-4000-8000-000000000041'
  ) <> 100.00 THEN
    RAISE EXCEPTION 'Seed sharing rule percentages do not sum to 100';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM public.tb_sharing_rules
    WHERE id = '00000000-0000-4000-8000-000000000042'
      AND household_id = '00000000-0000-4000-8000-000000000001'
      AND name = '100 / 0'
      AND description = 'Distribución completamente propia para Felipe'
      AND created_at = fixed_timestamp
      AND updated_at = fixed_timestamp
  ) <> 1 THEN
    RAISE EXCEPTION 'Seed 100 / 0 sharing rule values or timestamps changed';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM public.tb_sharing_rule_members
    WHERE sharing_rule_id = '00000000-0000-4000-8000-000000000042'
      AND (
        (
          id = '00000000-0000-4000-8000-000000000053'
          AND household_member_id = '00000000-0000-4000-8000-000000000021'
          AND percentage = 100.00
        )
        OR (
          id = '00000000-0000-4000-8000-000000000054'
          AND household_member_id = '00000000-0000-4000-8000-000000000022'
          AND percentage = 0.00
        )
      )
  ) <> 2 THEN
    RAISE EXCEPTION 'Seed 100 / 0 rule-member values changed';
  END IF;

  IF (
    SELECT SUM(percentage)
    FROM public.tb_sharing_rule_members
    WHERE sharing_rule_id = '00000000-0000-4000-8000-000000000042'
  ) <> 100.00 THEN
    RAISE EXCEPTION 'Seed 100 / 0 percentages do not sum to 100';
  END IF;

  IF EXISTS (
    (SELECT * FROM pg_temp.phase_1_seed_households_before
     EXCEPT
     SELECT id, name, created_at
     FROM public.tb_households
     WHERE id = '00000000-0000-4000-8000-000000000001')
    UNION ALL
    (SELECT id, name, created_at
     FROM public.tb_households
     WHERE id = '00000000-0000-4000-8000-000000000001'
     EXCEPT
     SELECT * FROM pg_temp.phase_1_seed_households_before)
  ) THEN
    RAISE EXCEPTION 'Household changed between first and second seed execution';
  END IF;

  IF EXISTS (
    (SELECT * FROM pg_temp.phase_1_seed_users_before
     EXCEPT
     SELECT id, display_name, external_identifier, created_at
     FROM public.tb_users
     WHERE id IN (
       '00000000-0000-4000-8000-000000000011',
       '00000000-0000-4000-8000-000000000012'
     ))
    UNION ALL
    (SELECT id, display_name, external_identifier, created_at
     FROM public.tb_users
     WHERE id IN (
       '00000000-0000-4000-8000-000000000011',
       '00000000-0000-4000-8000-000000000012'
     )
     EXCEPT
     SELECT * FROM pg_temp.phase_1_seed_users_before)
  ) THEN
    RAISE EXCEPTION 'Users changed between first and second seed execution';
  END IF;

  IF EXISTS (
    (SELECT * FROM pg_temp.phase_1_seed_members_before
     EXCEPT
     SELECT id, household_id, user_id, display_name, created_at
     FROM public.tb_household_members
     WHERE id IN (
       '00000000-0000-4000-8000-000000000021',
       '00000000-0000-4000-8000-000000000022'
     ))
    UNION ALL
    (SELECT id, household_id, user_id, display_name, created_at
     FROM public.tb_household_members
     WHERE id IN (
       '00000000-0000-4000-8000-000000000021',
       '00000000-0000-4000-8000-000000000022'
     )
     EXCEPT
     SELECT * FROM pg_temp.phase_1_seed_members_before)
  ) THEN
    RAISE EXCEPTION 'Members changed between first and second seed execution';
  END IF;

  IF EXISTS (
    (SELECT * FROM pg_temp.phase_1_seed_categories_before
     EXCEPT
     SELECT id, name, description, created_at
     FROM public.tb_categories
     WHERE id IN (
       '00000000-0000-4000-8000-000000000031',
       '00000000-0000-4000-8000-000000000032',
       '00000000-0000-4000-8000-000000000033',
       '00000000-0000-4000-8000-000000000034',
       '00000000-0000-4000-8000-000000000035',
       '00000000-0000-4000-8000-000000000036',
       '00000000-0000-4000-8000-000000000037',
       '00000000-0000-4000-8000-000000000038',
       '00000000-0000-4000-8000-000000000039',
       '00000000-0000-4000-8000-000000000040',
       '00000000-0000-4000-8000-000000000046',
       '00000000-0000-4000-8000-000000000047',
       '00000000-0000-4000-8000-000000000048',
       '00000000-0000-4000-8000-000000000049',
       '00000000-0000-4000-8000-000000000050'
     ))
    UNION ALL
    (SELECT id, name, description, created_at
     FROM public.tb_categories
     WHERE id IN (
       '00000000-0000-4000-8000-000000000031',
       '00000000-0000-4000-8000-000000000032',
       '00000000-0000-4000-8000-000000000033',
       '00000000-0000-4000-8000-000000000034',
       '00000000-0000-4000-8000-000000000035',
       '00000000-0000-4000-8000-000000000036',
       '00000000-0000-4000-8000-000000000037',
       '00000000-0000-4000-8000-000000000038',
       '00000000-0000-4000-8000-000000000039',
       '00000000-0000-4000-8000-000000000040',
       '00000000-0000-4000-8000-000000000046',
       '00000000-0000-4000-8000-000000000047',
       '00000000-0000-4000-8000-000000000048',
       '00000000-0000-4000-8000-000000000049',
       '00000000-0000-4000-8000-000000000050'
     )
     EXCEPT
     SELECT * FROM pg_temp.phase_1_seed_categories_before)
  ) THEN
    RAISE EXCEPTION 'Categories changed between first and second seed execution';
  END IF;

  IF EXISTS (
    (SELECT * FROM pg_temp.phase_1_seed_rules_before
     EXCEPT
     SELECT id, household_id, name, description, created_at, updated_at
     FROM public.tb_sharing_rules
     WHERE id IN (
       '00000000-0000-4000-8000-000000000041',
       '00000000-0000-4000-8000-000000000042'
     ))
    UNION ALL
    (SELECT id, household_id, name, description, created_at, updated_at
     FROM public.tb_sharing_rules
     WHERE id IN (
       '00000000-0000-4000-8000-000000000041',
       '00000000-0000-4000-8000-000000000042'
     )
     EXCEPT
     SELECT * FROM pg_temp.phase_1_seed_rules_before)
  ) THEN
    RAISE EXCEPTION 'Sharing rule changed between first and second seed execution';
  END IF;

  IF EXISTS (
    (SELECT * FROM pg_temp.phase_1_seed_rule_members_before
     EXCEPT
     SELECT id, sharing_rule_id, household_member_id, percentage
     FROM public.tb_sharing_rule_members
     WHERE id IN (
       '00000000-0000-4000-8000-000000000051',
       '00000000-0000-4000-8000-000000000052',
       '00000000-0000-4000-8000-000000000053',
       '00000000-0000-4000-8000-000000000054'
     ))
    UNION ALL
    (SELECT id, sharing_rule_id, household_member_id, percentage
     FROM public.tb_sharing_rule_members
     WHERE id IN (
       '00000000-0000-4000-8000-000000000051',
       '00000000-0000-4000-8000-000000000052',
       '00000000-0000-4000-8000-000000000053',
       '00000000-0000-4000-8000-000000000054'
     )
     EXCEPT
     SELECT * FROM pg_temp.phase_1_seed_rule_members_before)
  ) THEN
    RAISE EXCEPTION 'Sharing rule members changed between seed executions';
  END IF;

  RAISE NOTICE 'PASS: seed executed twice without duplicates or record changes';
  RAISE NOTICE 'PASS: UUIDs, values, relationships, timestamps and percentages are exact';
END;
$$;

SELECT 'PASS: Phase 1 seed idempotency verified; rolling back test transaction' AS result;

ROLLBACK;
