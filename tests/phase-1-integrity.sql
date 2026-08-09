BEGIN;

-- Phase 1 integration test for PostgreSQL/Supabase.
-- Every fixture and cleanup operation is rolled back at the end.

DO $$
DECLARE
  required_table TEXT;
  required_tables CONSTANT TEXT[] := ARRAY[
    'tb_users',
    'tb_households',
    'tb_household_members',
    'tb_categories',
    'tb_sharing_rules',
    'tb_sharing_rule_members',
    'tb_expenses',
    'tb_expense_items',
    'tb_expense_distributions',
    'tb_incomes',
    'tb_receipts',
    'tb_pending_proposals',
    'tb_processed_whatsapp_events'
  ];
BEGIN
  FOREACH required_table IN ARRAY required_tables LOOP
    IF to_regclass(format('public.%I', required_table)) IS NULL THEN
      RAISE EXCEPTION 'Missing required table public.%', required_table;
    END IF;
  END LOOP;

  IF (
    SELECT COUNT(*)
    FROM pg_type AS type
    JOIN pg_namespace AS namespace ON namespace.oid = type.typnamespace
    WHERE namespace.nspname = 'public'
      AND type.typname IN (
        'expense_status',
        'expense_source',
        'receipt_processing_status',
        'pending_operation_type',
        'pending_proposal_status'
      )
  ) <> 5 THEN
    RAISE EXCEPTION 'Missing one or more required enum types';
  END IF;

  IF ARRAY(
    SELECT source_value::TEXT
    FROM unnest(enum_range(NULL::public.expense_source)) AS source_value
  ) <> ARRAY['WEB', 'WHATSAPP', 'RECEIPT']::TEXT[] THEN
    RAISE EXCEPTION 'expense_source has unexpected values';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM pg_trigger
    WHERE NOT tgisinternal
      AND tgname IN (
        'trg_tb_expenses_set_updated_at',
        'trg_tb_incomes_set_updated_at',
        'trg_tb_sharing_rules_set_updated_at',
        'trg_tb_pending_proposals_set_updated_at',
        'trg_tb_expense_items_validate_total',
        'trg_tb_expenses_validate_item_total',
        'trg_tb_expense_distributions_validate',
        'trg_tb_expenses_validate_distributions',
        'trg_tb_sharing_rule_members_validate',
        'trg_tb_sharing_rules_validate_members'
      )
  ) <> 10 THEN
    RAISE EXCEPTION 'Missing one or more required triggers';
  END IF;

  RAISE NOTICE 'PASS schema: 13 tables, 5 enums and 10 triggers found';
END;
$$;

CREATE FUNCTION pg_temp.expect_sqlstate(
  test_name TEXT,
  statement TEXT,
  expected_state TEXT,
  force_deferred_constraints BOOLEAN DEFAULT FALSE
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

    IF force_deferred_constraints THEN
      SET CONSTRAINTS ALL IMMEDIATE;
      SET CONSTRAINTS ALL DEFERRED;
    END IF;
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

-- Remove fixtures left by an interrupted previous execution. The cleanup itself
-- remains inside this transaction and therefore cannot remove persistent data
-- when this script reaches its final ROLLBACK.
DELETE FROM public.tb_receipts
WHERE id::TEXT LIKE '10000000-0000-4000-8000-%'
   OR conversation_key LIKE 'phase-1-test-%';

DELETE FROM public.tb_pending_proposals
WHERE id::TEXT LIKE '10000000-0000-4000-8000-%'
   OR conversation_key LIKE 'phase-1-test-%';

DELETE FROM public.tb_processed_whatsapp_events
WHERE id::TEXT LIKE '10000000-0000-4000-8000-%'
   OR external_event_id LIKE 'phase-1-test-%';

DELETE FROM public.tb_incomes
WHERE id::TEXT LIKE '10000000-0000-4000-8000-%';

DELETE FROM public.tb_expense_items
WHERE id::TEXT LIKE '10000000-0000-4000-8000-%'
   OR expense_id::TEXT LIKE '10000000-0000-4000-8000-%';

DELETE FROM public.tb_expense_distributions
WHERE id::TEXT LIKE '10000000-0000-4000-8000-%'
   OR expense_id::TEXT LIKE '10000000-0000-4000-8000-%';

DELETE FROM public.tb_expenses
WHERE id::TEXT LIKE '10000000-0000-4000-8000-%';

DELETE FROM public.tb_sharing_rule_members
WHERE id::TEXT LIKE '10000000-0000-4000-8000-%'
   OR sharing_rule_id::TEXT LIKE '10000000-0000-4000-8000-%';

DELETE FROM public.tb_sharing_rules
WHERE id::TEXT LIKE '10000000-0000-4000-8000-%';

DELETE FROM public.tb_categories
WHERE id::TEXT LIKE '10000000-0000-4000-8000-%'
   OR name LIKE 'Phase 1 Test %';

DELETE FROM public.tb_household_members
WHERE id::TEXT LIKE '10000000-0000-4000-8000-%';

DELETE FROM public.tb_users
WHERE id::TEXT LIKE '10000000-0000-4000-8000-%'
   OR external_identifier LIKE 'phase-1-test-%';

DELETE FROM public.tb_households
WHERE id::TEXT LIKE '10000000-0000-4000-8000-%';

SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

SELECT 'PASS cleanup: residual Phase 1 fixtures removed inside transaction' AS result;

-- Valid fixture graph. SharingRule is intentionally inserted before its members.
INSERT INTO public.tb_households (id, name, created_at)
VALUES
  (
    '10000000-0000-4000-8000-000000000001',
    'Phase 1 Test Household One',
    '2000-01-01 00:00:00+00'
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    'Phase 1 Test Household Two',
    '2000-01-01 00:00:00+00'
  );

INSERT INTO public.tb_users (
  id,
  display_name,
  external_identifier,
  created_at
)
VALUES
  (
    '10000000-0000-4000-8000-000000000011',
    'Phase 1 Test User One',
    'phase-1-test-user-one',
    '2000-01-01 00:00:00+00'
  ),
  (
    '10000000-0000-4000-8000-000000000012',
    'Phase 1 Test User Two',
    'phase-1-test-user-two',
    '2000-01-01 00:00:00+00'
  ),
  (
    '10000000-0000-4000-8000-000000000013',
    'Phase 1 Test User Three',
    'phase-1-test-user-three',
    '2000-01-01 00:00:00+00'
  );

INSERT INTO public.tb_household_members (
  id,
  household_id,
  user_id,
  display_name,
  created_at
)
VALUES
  (
    '10000000-0000-4000-8000-000000000021',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000011',
    'Member One',
    '2000-01-01 00:00:00+00'
  ),
  (
    '10000000-0000-4000-8000-000000000022',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000012',
    'Member Two',
    '2000-01-01 00:00:00+00'
  ),
  (
    '10000000-0000-4000-8000-000000000023',
    '10000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000013',
    'Other Household Member',
    '2000-01-01 00:00:00+00'
  );

INSERT INTO public.tb_categories (id, name, description, created_at)
VALUES (
  '10000000-0000-4000-8000-000000000031',
  'Phase 1 Test Category',
  'Temporary integration-test category',
  '2000-01-01 00:00:00+00'
);

INSERT INTO public.tb_sharing_rules (
  id,
  household_id,
  name,
  description,
  created_at,
  updated_at
)
VALUES (
  '10000000-0000-4000-8000-000000000041',
  '10000000-0000-4000-8000-000000000001',
  'Phase 1 Test 50 / 50',
  'Temporary valid rule',
  '2000-01-01 00:00:00+00',
  '2000-01-01 00:00:00+00'
);

INSERT INTO public.tb_sharing_rule_members (
  id,
  sharing_rule_id,
  household_member_id,
  percentage
)
VALUES
  (
    '10000000-0000-4000-8000-000000000051',
    '10000000-0000-4000-8000-000000000041',
    '10000000-0000-4000-8000-000000000021',
    50.00
  ),
  (
    '10000000-0000-4000-8000-000000000052',
    '10000000-0000-4000-8000-000000000041',
    '10000000-0000-4000-8000-000000000022',
    50.00
  );

INSERT INTO public.tb_expenses (
  id,
  household_id,
  created_by,
  paid_by,
  category_id,
  merchant,
  total_amount,
  currency,
  expense_date,
  description,
  status,
  source,
  created_at,
  updated_at
)
VALUES (
  '10000000-0000-4000-8000-000000000061',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000021',
  '10000000-0000-4000-8000-000000000022',
  '10000000-0000-4000-8000-000000000031',
  'Phase 1 Test Merchant',
  100.00,
  'COP',
  '2026-01-01',
  'Valid confirmed expense',
  'CONFIRMED',
  'WEB',
  '2000-01-01 00:00:00+00',
  '2000-01-01 00:00:00+00'
);

INSERT INTO public.tb_expense_items (
  id,
  expense_id,
  name,
  quantity,
  unit_price,
  total_amount,
  category_id,
  created_at
)
VALUES (
  '10000000-0000-4000-8000-000000000071',
  '10000000-0000-4000-8000-000000000061',
  'Valid item',
  1.000,
  40.00,
  40.00,
  '10000000-0000-4000-8000-000000000031',
  '2000-01-01 00:00:00+00'
);

INSERT INTO public.tb_expense_distributions (
  id,
  expense_id,
  household_member_id,
  amount,
  percentage
)
VALUES
  (
    '10000000-0000-4000-8000-000000000081',
    '10000000-0000-4000-8000-000000000061',
    '10000000-0000-4000-8000-000000000021',
    50.00,
    50.00
  ),
  (
    '10000000-0000-4000-8000-000000000082',
    '10000000-0000-4000-8000-000000000061',
    '10000000-0000-4000-8000-000000000022',
    50.00,
    50.00
  );

INSERT INTO public.tb_incomes (
  id,
  household_id,
  created_by,
  member_id,
  amount,
  income_date,
  description,
  category_id,
  created_at,
  updated_at
)
VALUES (
  '10000000-0000-4000-8000-000000000091',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000021',
  '10000000-0000-4000-8000-000000000022',
  500.00,
  '2026-01-01',
  'Valid income',
  '10000000-0000-4000-8000-000000000031',
  '2000-01-01 00:00:00+00',
  '2000-01-01 00:00:00+00'
);

INSERT INTO public.tb_pending_proposals (
  id,
  household_id,
  conversation_key,
  operation_type,
  payload,
  status,
  created_at,
  updated_at
)
VALUES (
  '10000000-0000-4000-8000-000000000101',
  '10000000-0000-4000-8000-000000000001',
  'phase-1-test-proposal',
  'CREATE_EXPENSE',
  '{}'::JSONB,
  'AWAITING_CONFIRMATION',
  '2000-01-01 00:00:00+00',
  '2000-01-01 00:00:00+00'
);

SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

SELECT 'PASS valid graph: deferred constraints accepted valid fixtures' AS result;

-- PK, FK, UNIQUE, enum and CHECK constraints.
SELECT pg_temp.expect_sqlstate(
  'duplicate primary key',
  $sql$INSERT INTO public.tb_users (id, display_name, external_identifier)
       VALUES (
         '10000000-0000-4000-8000-000000000011',
         'Duplicate PK',
         'phase-1-test-duplicate-pk'
       )$sql$,
  '23505'
);

SELECT pg_temp.expect_sqlstate(
  'duplicate external_identifier',
  $sql$INSERT INTO public.tb_users (display_name, external_identifier)
       VALUES ('Duplicate external identifier', 'phase-1-test-user-one')$sql$,
  '23505'
);

SELECT pg_temp.expect_sqlstate(
  'foreign key references missing household',
  $sql$INSERT INTO public.tb_household_members (
         household_id, user_id, display_name
       ) VALUES (
         'ffffffff-ffff-4fff-8fff-ffffffffffff',
         '10000000-0000-4000-8000-000000000011',
         'Missing household'
       )$sql$,
  '23503'
);

SELECT pg_temp.expect_sqlstate(
  'expense created_by belongs to another household',
  $sql$INSERT INTO public.tb_expenses (
         household_id, created_by, paid_by, merchant, total_amount,
         expense_date, status, source
       ) VALUES (
         '10000000-0000-4000-8000-000000000001',
         '10000000-0000-4000-8000-000000000023',
         '10000000-0000-4000-8000-000000000021',
         'Invalid creator', 10.00, '2026-01-01', 'PENDING', 'WEB'
       )$sql$,
  '23503'
);

SELECT pg_temp.expect_sqlstate(
  'expense paid_by belongs to another household',
  $sql$INSERT INTO public.tb_expenses (
         household_id, created_by, paid_by, merchant, total_amount,
         expense_date, status, source
       ) VALUES (
         '10000000-0000-4000-8000-000000000001',
         '10000000-0000-4000-8000-000000000021',
         '10000000-0000-4000-8000-000000000023',
         'Invalid payer', 10.00, '2026-01-01', 'PENDING', 'WEB'
       )$sql$,
  '23503'
);

SELECT pg_temp.expect_sqlstate(
  'income member belongs to another household',
  $sql$INSERT INTO public.tb_incomes (
         household_id, created_by, member_id, amount, income_date, description
       ) VALUES (
         '10000000-0000-4000-8000-000000000001',
         '10000000-0000-4000-8000-000000000021',
         '10000000-0000-4000-8000-000000000023',
         10.00, '2026-01-01', 'Invalid member'
       )$sql$,
  '23503'
);

SELECT pg_temp.expect_sqlstate(
  'expense amount must be positive',
  $sql$INSERT INTO public.tb_expenses (
         household_id, created_by, paid_by, merchant, total_amount,
         expense_date, status, source
       ) VALUES (
         '10000000-0000-4000-8000-000000000001',
         '10000000-0000-4000-8000-000000000021',
         '10000000-0000-4000-8000-000000000021',
         'Invalid amount', 0, '2026-01-01', 'PENDING', 'WEB'
       )$sql$,
  '23514'
);

SELECT pg_temp.expect_sqlstate(
  'income amount must be positive',
  $sql$INSERT INTO public.tb_incomes (
         household_id, created_by, member_id, amount, income_date, description
       ) VALUES (
         '10000000-0000-4000-8000-000000000001',
         '10000000-0000-4000-8000-000000000021',
         '10000000-0000-4000-8000-000000000021',
         -1.00, '2026-01-01', 'Invalid amount'
       )$sql$,
  '23514'
);

SELECT pg_temp.expect_sqlstate(
  'sharing percentage outside range',
  $sql$INSERT INTO public.tb_sharing_rule_members (
         sharing_rule_id, household_member_id, percentage
       ) VALUES (
         '10000000-0000-4000-8000-000000000041',
         '10000000-0000-4000-8000-000000000023',
         100.01
       )$sql$,
  '23514'
);

SELECT pg_temp.expect_sqlstate(
  'expense_source rejects undocumented value',
  $sql$INSERT INTO public.tb_expenses (
         household_id, created_by, paid_by, merchant, total_amount,
         expense_date, status, source
       ) VALUES (
         '10000000-0000-4000-8000-000000000001',
         '10000000-0000-4000-8000-000000000021',
         '10000000-0000-4000-8000-000000000021',
         'Invalid enum', 10.00, '2026-01-01', 'PENDING', 'INVALID_SOURCE'
       )$sql$,
  '22P02'
);

SELECT pg_temp.expect_sqlstate(
  'receipt cannot reference expense from another household',
  $sql$INSERT INTO public.tb_receipts (
         household_id, conversation_key, expense_id, storage_path,
         original_filename, mime_type, processing_status
       ) VALUES (
         '10000000-0000-4000-8000-000000000002',
         'phase-1-test-cross-household-receipt',
         '10000000-0000-4000-8000-000000000061',
         'phase-1/cross-household.jpg',
         'cross-household.jpg',
         'image/jpeg',
         'PROCESSED'
       )$sql$,
  '23503'
);

SELECT pg_temp.expect_sqlstate(
  'receipt must be PROCESSED before expense association',
  $sql$INSERT INTO public.tb_receipts (
         household_id, conversation_key, expense_id, storage_path,
         original_filename, mime_type, processing_status
       ) VALUES (
         '10000000-0000-4000-8000-000000000001',
         'phase-1-test-unprocessed-receipt',
         '10000000-0000-4000-8000-000000000061',
         'phase-1/unprocessed.jpg',
         'unprocessed.jpg',
         'image/jpeg',
         'PENDING'
       )$sql$,
  '23514'
);

INSERT INTO public.tb_receipts (
  id,
  household_id,
  conversation_key,
  storage_path,
  original_filename,
  mime_type,
  processing_status
)
VALUES (
  '10000000-0000-4000-8000-000000000111',
  '10000000-0000-4000-8000-000000000001',
  'phase-1-test-active-receipt',
  'phase-1/active.jpg',
  'active.jpg',
  'image/jpeg',
  'FAILED'
);

SELECT pg_temp.expect_sqlstate(
  'only one active receipt per household conversation',
  $sql$INSERT INTO public.tb_receipts (
         household_id, conversation_key, storage_path,
         original_filename, mime_type, processing_status
       ) VALUES (
         '10000000-0000-4000-8000-000000000001',
         'phase-1-test-active-receipt',
         'phase-1/second.jpg',
         'second.jpg',
         'image/jpeg',
         'PENDING'
       )$sql$,
  '23505'
);

SELECT pg_temp.expect_sqlstate(
  'only one pending proposal per household conversation',
  $sql$INSERT INTO public.tb_pending_proposals (
         household_id, conversation_key, operation_type, payload
       ) VALUES (
         '10000000-0000-4000-8000-000000000001',
         'phase-1-test-proposal',
         'CREATE_INCOME',
         '{}'::JSONB
       )$sql$,
  '23505'
);

INSERT INTO public.tb_processed_whatsapp_events (
  id,
  external_event_id,
  processed_at
)
VALUES (
  '10000000-0000-4000-8000-000000000121',
  'phase-1-test-event',
  '2000-01-01 00:00:00+00'
);

SELECT pg_temp.expect_sqlstate(
  'WhatsApp event idempotency',
  $sql$INSERT INTO public.tb_processed_whatsapp_events (external_event_id)
       VALUES ('phase-1-test-event')$sql$,
  '23505'
);

-- Deferred constraint triggers. Each test forces pending checks inside the
-- helper's exception block, so an expected failure cannot abort this script.
INSERT INTO public.tb_expenses (
  id,
  household_id,
  created_by,
  paid_by,
  merchant,
  total_amount,
  expense_date,
  status,
  source
)
VALUES
  (
    '10000000-0000-4000-8000-000000000131',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000021',
    '10000000-0000-4000-8000-000000000021',
    'Item sum test',
    100.00,
    '2026-01-01',
    'PENDING',
    'WEB'
  ),
  (
    '10000000-0000-4000-8000-000000000132',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000021',
    '10000000-0000-4000-8000-000000000021',
    'Distribution sum test',
    100.00,
    '2026-01-01',
    'PENDING',
    'WEB'
  ),
  (
    '10000000-0000-4000-8000-000000000133',
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000021',
    '10000000-0000-4000-8000-000000000021',
    'Distribution household test',
    100.00,
    '2026-01-01',
    'PENDING',
    'WEB'
  );

SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

SELECT pg_temp.expect_sqlstate(
  'ExpenseItem sum cannot exceed Expense total',
  $sql$INSERT INTO public.tb_expense_items (
         expense_id, name, total_amount
       ) VALUES (
         '10000000-0000-4000-8000-000000000131',
         'Too expensive item',
         100.01
       )$sql$,
  '23514',
  TRUE
);

INSERT INTO public.tb_expense_distributions (
  expense_id,
  household_member_id,
  amount,
  percentage
)
VALUES (
  '10000000-0000-4000-8000-000000000132',
  '10000000-0000-4000-8000-000000000021',
  90.00,
  90.00
);

SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

SELECT pg_temp.expect_sqlstate(
  'confirmed Expense distributions must equal Expense total',
  $sql$UPDATE public.tb_expenses
          SET status = 'CONFIRMED'
        WHERE id = '10000000-0000-4000-8000-000000000132'$sql$,
  '23514',
  TRUE
);

SELECT pg_temp.expect_sqlstate(
  'ExpenseDistribution member must belong to Expense household',
  $sql$INSERT INTO public.tb_expense_distributions (
         expense_id, household_member_id, amount, percentage
       ) VALUES (
         '10000000-0000-4000-8000-000000000133',
         '10000000-0000-4000-8000-000000000023',
         100.00,
         100.00
       )$sql$,
  '23514',
  TRUE
);

SELECT pg_temp.expect_sqlstate(
  'SharingRule percentages must sum to 100',
  $sql$UPDATE public.tb_sharing_rule_members
          SET percentage = 40.00
        WHERE id = '10000000-0000-4000-8000-000000000051'$sql$,
  '23514',
  TRUE
);

SELECT pg_temp.expect_sqlstate(
  'SharingRule member must belong to rule household',
  $sql$UPDATE public.tb_sharing_rule_members
          SET household_member_id = '10000000-0000-4000-8000-000000000023'
        WHERE id = '10000000-0000-4000-8000-000000000051'$sql$,
  '23514',
  TRUE
);

-- updated_at triggers on every table that defines them in the migration.
UPDATE public.tb_expenses
SET description = 'Updated expense'
WHERE id = '10000000-0000-4000-8000-000000000061';

UPDATE public.tb_incomes
SET description = 'Updated income'
WHERE id = '10000000-0000-4000-8000-000000000091';

UPDATE public.tb_sharing_rules
SET description = 'Updated sharing rule'
WHERE id = '10000000-0000-4000-8000-000000000041';

UPDATE public.tb_pending_proposals
SET payload = '{"updated": true}'::JSONB
WHERE id = '10000000-0000-4000-8000-000000000101';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT updated_at FROM public.tb_expenses
      WHERE id = '10000000-0000-4000-8000-000000000061'
      UNION ALL
      SELECT updated_at FROM public.tb_incomes
      WHERE id = '10000000-0000-4000-8000-000000000091'
      UNION ALL
      SELECT updated_at FROM public.tb_sharing_rules
      WHERE id = '10000000-0000-4000-8000-000000000041'
      UNION ALL
      SELECT updated_at FROM public.tb_pending_proposals
      WHERE id = '10000000-0000-4000-8000-000000000101'
    ) AS timestamps
    WHERE updated_at <= '2000-01-01 00:00:00+00'::TIMESTAMPTZ
  ) THEN
    RAISE EXCEPTION 'One or more updated_at triggers did not advance the timestamp';
  END IF;

  RAISE NOTICE 'PASS updated_at: all four tables advanced automatically';
END;
$$;

SET CONSTRAINTS ALL IMMEDIATE;

SELECT 'PASS: all Phase 1 PostgreSQL integrity checks completed' AS result;
SELECT 'PASS: all test data and cleanup operations will now be rolled back' AS result;

ROLLBACK;
