BEGIN;

-- Existing rows used to exercise the 0059 backfill. The first still has its
-- allowed source projection; the second models a prior 30-day tombstone.
INSERT INTO public.tb_processed_whatsapp_events(id, external_event_id, processed_at)
VALUES
  ('59000000-0059-4000-8000-000000000001', 'forensic-0059-history-complete', pg_catalog.clock_timestamp() - INTERVAL '10 days'),
  ('59000000-0059-4000-8000-000000000002', 'forensic-0059-history-partial', pg_catalog.clock_timestamp() - INTERVAL '45 days');

INSERT INTO public.tb_whatsapp_event_receipts(
  external_event_id, request_digest, event_kind, processing_state, delivery_state,
  identity_snapshot, admission_selection, context_lease_id, context_epoch,
  household_id, actor_member_id, conversation_digest, event_epoch,
  business_result, operation_digest, artifacts, reply_template, reply_text,
  reply_guard, reply_expires_at, delivery_epoch, delivery_attempts,
  http_status, provider_code, created_at, updated_at
)
VALUES (
  'forensic-0059-history-complete', repeat('a', 64), 'MESSAGE', 'COMPLETED', 'UNKNOWN',
  '{"sender":"199900005901","message":"forensic-sensitive-sentinel"}'::JSONB,
  '{"selected":"forensic-sensitive-sentinel"}'::JSONB,
  '59000000-0059-4000-8000-000000000010', 9,
  '59000000-0059-4000-8000-000000000011', '59000000-0059-4000-8000-000000000012',
  repeat('c', 64), 4,
  '{"status":"CREATED","expense_id":"59000000-0059-4000-8000-000000000013"}'::JSONB,
  repeat('d', 64),
  '{"59000000-0059-4000-8000-000000000014":{"version":"7","operation":"CREATE_EXPENSE","updatedAt":"2026-11-01T00:00:00Z","payload":"forensic-sensitive-sentinel"}}'::JSONB,
  'TEXT_V1', 'forensic-sensitive-sentinel', '{"sensitive":"forensic-sensitive-sentinel"}'::JSONB,
  pg_catalog.clock_timestamp() - INTERVAL '2 days', 3, 4, 503, 131047,
  pg_catalog.clock_timestamp() - INTERVAL '10 days', pg_catalog.clock_timestamp() - INTERVAL '9 days'
), (
  'forensic-0059-history-partial', repeat('b', 64), 'MESSAGE', 'UNCERTAIN', 'UNKNOWN',
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, 8,
  NULL, NULL, '{}'::JSONB, NULL, NULL, NULL, NULL,
  5, 0, NULL, NULL,
  pg_catalog.clock_timestamp() - INTERVAL '45 days',
  pg_catalog.clock_timestamp() - INTERVAL '40 days'
);

UPDATE public.tb_whatsapp_event_receipts
   SET tombstoned_at = pg_catalog.clock_timestamp() - INTERVAL '5 days'
 WHERE external_event_id = 'forensic-0059-history-partial';

COMMIT;
