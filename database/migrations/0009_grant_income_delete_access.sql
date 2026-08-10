BEGIN;

GRANT DELETE
ON TABLE public.tb_incomes
TO service_role;

COMMIT;
