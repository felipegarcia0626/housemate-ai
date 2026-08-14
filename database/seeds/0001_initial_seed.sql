-- A single DO statement keeps the seed atomic both when executed directly and
-- when included inside the rollback-only idempotency integration test.
DO $seed$
BEGIN

INSERT INTO public.tb_households (id, name, created_at)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  'Hogar Demo',
  '2026-01-01 00:00:00+00'
)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    created_at = EXCLUDED.created_at;

INSERT INTO public.tb_users (
  id,
  display_name,
  external_identifier,
  created_at
)
VALUES
  (
    '00000000-0000-4000-8000-000000000011',
    'Felipe',
    'seed-user-felipe',
    '2026-01-01 00:00:00+00'
  ),
  (
    '00000000-0000-4000-8000-000000000012',
    'Alejandra',
    'seed-user-alejandra',
    '2026-01-01 00:00:00+00'
  )
ON CONFLICT (id) DO UPDATE
SET display_name = EXCLUDED.display_name,
    external_identifier = EXCLUDED.external_identifier,
    created_at = EXCLUDED.created_at;

INSERT INTO public.tb_household_members (
  id,
  household_id,
  user_id,
  display_name,
  created_at
)
VALUES
  (
    '00000000-0000-4000-8000-000000000021',
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000011',
    'Felipe',
    '2026-01-01 00:00:00+00'
  ),
  (
    '00000000-0000-4000-8000-000000000022',
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000012',
    'Alejandra',
    '2026-01-01 00:00:00+00'
  )
ON CONFLICT (id) DO UPDATE
SET household_id = EXCLUDED.household_id,
    user_id = EXCLUDED.user_id,
    display_name = EXCLUDED.display_name,
    created_at = EXCLUDED.created_at;

INSERT INTO public.tb_categories (id, name, description, created_at)
VALUES
  (
    '00000000-0000-4000-8000-000000000031',
    'Alimentación',
    'Compras de alimentos',
    '2026-01-01 00:00:00+00'
  ),
  (
    '00000000-0000-4000-8000-000000000032',
    'Otros',
    'Registros sin categoría específica',
    '2026-01-01 00:00:00+00'
  ),
  (
    '00000000-0000-4000-8000-000000000033',
    'Salario',
    'Ingresos salariales',
    '2026-01-01 00:00:00+00'
  ),
  (
    '00000000-0000-4000-8000-000000000034',
    'Honorarios',
    'Ingresos por servicios profesionales',
    '2026-01-01 00:00:00+00'
  )
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    description = EXCLUDED.description,
    created_at = EXCLUDED.created_at;

INSERT INTO public.tb_sharing_rules AS existing_rule (
  id,
  household_id,
  name,
  description,
  created_at,
  updated_at
)
VALUES (
  '00000000-0000-4000-8000-000000000041',
  '00000000-0000-4000-8000-000000000001',
  '50 / 50',
  'Distribución equitativa entre los dos integrantes',
  '2026-01-01 00:00:00+00',
  '2026-01-01 00:00:00+00'
)
ON CONFLICT (id) DO UPDATE
SET household_id = EXCLUDED.household_id,
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at
WHERE (
  existing_rule.household_id,
  existing_rule.name,
  existing_rule.description,
  existing_rule.created_at,
  existing_rule.updated_at
) IS DISTINCT FROM (
  EXCLUDED.household_id,
  EXCLUDED.name,
  EXCLUDED.description,
  EXCLUDED.created_at,
  EXCLUDED.updated_at
);

INSERT INTO public.tb_sharing_rules AS existing_rule (
  id,
  household_id,
  name,
  description,
  created_at,
  updated_at
)
VALUES (
  '00000000-0000-4000-8000-000000000042',
  '00000000-0000-4000-8000-000000000001',
  '100 / 0',
  'Distribución completamente propia para Felipe',
  '2026-01-01 00:00:00+00',
  '2026-01-01 00:00:00+00'
)
ON CONFLICT (id) DO UPDATE
SET household_id = EXCLUDED.household_id,
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at
WHERE (
  existing_rule.household_id,
  existing_rule.name,
  existing_rule.description,
  existing_rule.created_at,
  existing_rule.updated_at
) IS DISTINCT FROM (
  EXCLUDED.household_id,
  EXCLUDED.name,
  EXCLUDED.description,
  EXCLUDED.created_at,
  EXCLUDED.updated_at
);

INSERT INTO public.tb_sharing_rule_members (
  id,
  sharing_rule_id,
  household_member_id,
  percentage
)
VALUES
  (
    '00000000-0000-4000-8000-000000000051',
    '00000000-0000-4000-8000-000000000041',
    '00000000-0000-4000-8000-000000000021',
    50.00
  ),
  (
    '00000000-0000-4000-8000-000000000052',
    '00000000-0000-4000-8000-000000000041',
    '00000000-0000-4000-8000-000000000022',
    50.00
  )
ON CONFLICT (id) DO UPDATE
SET sharing_rule_id = EXCLUDED.sharing_rule_id,
    household_member_id = EXCLUDED.household_member_id,
    percentage = EXCLUDED.percentage;

INSERT INTO public.tb_sharing_rule_members (
  id,
  sharing_rule_id,
  household_member_id,
  percentage
)
VALUES
  (
    '00000000-0000-4000-8000-000000000053',
    '00000000-0000-4000-8000-000000000042',
    '00000000-0000-4000-8000-000000000021',
    100.00
  ),
  (
    '00000000-0000-4000-8000-000000000054',
    '00000000-0000-4000-8000-000000000042',
    '00000000-0000-4000-8000-000000000022',
    0.00
  )
ON CONFLICT (id) DO UPDATE
SET sharing_rule_id = EXCLUDED.sharing_rule_id,
    household_member_id = EXCLUDED.household_member_id,
    percentage = EXCLUDED.percentage;

END;
$seed$;
