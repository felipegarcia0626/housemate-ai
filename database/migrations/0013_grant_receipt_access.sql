GRANT SELECT (
  id,
  household_id,
  conversation_key,
  expense_id,
  storage_path,
  original_filename,
  mime_type,
  uploaded_at,
  processing_status,
  analysis_payload
)
ON TABLE public.tb_receipts
TO service_role;

GRANT INSERT (
  id,
  household_id,
  conversation_key,
  storage_path,
  original_filename,
  mime_type,
  processing_status,
  analysis_payload
)
ON TABLE public.tb_receipts
TO service_role;

GRANT UPDATE (
  processing_status,
  analysis_payload
)
ON TABLE public.tb_receipts
TO service_role;

GRANT DELETE
ON TABLE public.tb_receipts
TO service_role;
