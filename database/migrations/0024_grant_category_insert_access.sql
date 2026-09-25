BEGIN;

GRANT INSERT
ON TABLE public.tb_categories
TO service_role;

COMMIT;
