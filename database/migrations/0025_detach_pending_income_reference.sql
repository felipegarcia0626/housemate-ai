BEGIN;

ALTER TABLE public.tb_pending_proposals
  DROP CONSTRAINT fk_tb_pending_proposals_income_household;

COMMIT;
