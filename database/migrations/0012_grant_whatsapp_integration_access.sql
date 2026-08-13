BEGIN;

GRANT SELECT
ON TABLE public.tb_users
TO service_role;

GRANT INSERT
ON TABLE public.tb_processed_whatsapp_events
TO service_role;

COMMIT;
