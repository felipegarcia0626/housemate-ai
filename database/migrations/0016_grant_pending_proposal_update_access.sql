BEGIN;

GRANT UPDATE
ON TABLE public.tb_pending_proposals
TO service_role;

COMMIT;
