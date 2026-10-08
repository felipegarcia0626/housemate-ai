BEGIN;

GRANT SELECT ON TABLE public.tb_household_invitations TO service_role;

COMMIT;
