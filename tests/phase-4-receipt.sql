BEGIN;

INSERT INTO public.tb_households (id, name)
VALUES ('91000000-0000-4000-8000-000000000001', 'Receipt SQL Test Household');

SET LOCAL ROLE service_role;

DO $$
DECLARE
  household_id UUID := '91000000-0000-4000-8000-000000000001';
  receipt_id UUID := '91000000-0000-4000-8000-000000000002';
  status public.receipt_processing_status;
BEGIN
  INSERT INTO public.tb_receipts (
    id,
    household_id,
    conversation_key,
    storage_path,
    original_filename,
    mime_type,
    processing_status,
    analysis_payload
  ) VALUES (
    receipt_id,
    household_id,
    'receipt-sql-test',
    'receipts/sql-test.jpg',
    'sql-test.jpg',
    'image/jpeg',
    'PENDING',
    '{"merchant":null,"date":null,"totalAmount":null,"items":[],"missingFields":["merchant","date","totalAmount"]}'::jsonb
  );

  SELECT r.processing_status INTO status
  FROM public.tb_receipts AS r
  WHERE r.id = receipt_id AND r.household_id = household_id;
  IF status <> 'PENDING' THEN
    RAISE EXCEPTION 'Receipt must start in PENDING';
  END IF;

  UPDATE public.tb_receipts AS r
  SET processing_status = 'PROCESSED',
      analysis_payload = '{"merchant":"Fixture","date":"2026-08-12","totalAmount":100,"items":[],"missingFields":[]}'::jsonb
  WHERE r.id = receipt_id AND r.household_id = household_id;

  SELECT r.processing_status INTO status
  FROM public.tb_receipts AS r
  WHERE r.id = receipt_id AND r.household_id = household_id;
  IF status <> 'PROCESSED' THEN
    RAISE EXCEPTION 'Receipt must transition to PROCESSED';
  END IF;

  UPDATE public.tb_receipts AS r
  SET processing_status = 'FAILED'
  WHERE r.id = receipt_id AND r.household_id = household_id;

  SELECT r.processing_status INTO status
  FROM public.tb_receipts AS r
  WHERE r.id = receipt_id AND r.household_id = household_id;
  IF status <> 'FAILED' THEN
    RAISE EXCEPTION 'Receipt must support FAILED retry state';
  END IF;

  DELETE FROM public.tb_receipts AS r
  WHERE r.id = receipt_id AND r.household_id = household_id;

  IF EXISTS (
    SELECT 1
    FROM public.tb_receipts AS r
    WHERE r.id = receipt_id AND r.household_id = household_id
  ) THEN
    RAISE EXCEPTION 'Receipt DELETE did not remove the fixture';
  END IF;

END $$;

RESET ROLE;

DO $$
BEGIN
  IF NOT has_column_privilege('service_role', 'public.tb_receipts', 'id', 'SELECT')
     OR NOT has_column_privilege('service_role', 'public.tb_receipts', 'expense_id', 'SELECT')
     OR NOT has_column_privilege('service_role', 'public.tb_receipts', 'analysis_payload', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.tb_receipts', 'DELETE')
     OR NOT has_column_privilege('service_role', 'public.tb_receipts', 'id', 'INSERT')
     OR NOT has_column_privilege('service_role', 'public.tb_receipts', 'household_id', 'INSERT')
     OR NOT has_column_privilege('service_role', 'public.tb_receipts', 'processing_status', 'UPDATE')
     OR NOT has_column_privilege('service_role', 'public.tb_receipts', 'analysis_payload', 'UPDATE') THEN
    RAISE EXCEPTION 'service_role receipt privileges are incomplete';
  END IF;
  IF has_column_privilege('service_role', 'public.tb_receipts', 'household_id', 'UPDATE') THEN
    RAISE EXCEPTION 'service_role must not update receipt ownership';
  END IF;
  IF has_table_privilege('service_role', 'public.tb_receipts', 'TRUNCATE') THEN
    RAISE EXCEPTION 'service_role must not receive TRUNCATE';
  END IF;
END $$;

ROLLBACK;
