BEGIN;

ALTER TYPE public.agent_category_draft_status
  ADD VALUE IF NOT EXISTS 'AWAITING_OPERATION';

ALTER TYPE public.agent_category_draft_status
  ADD VALUE IF NOT EXISTS 'AWAITING_DETAILS';

COMMIT;

-- PostgreSQL requires newly added enum values to be committed before they
-- can be referenced by subsequent expressions such as this CHECK constraint.
BEGIN;

ALTER TABLE public.tb_agent_category_drafts
  ALTER COLUMN operation_type DROP NOT NULL;

ALTER TABLE public.tb_agent_category_drafts
  DROP CONSTRAINT ck_agent_category_drafts_operation_type;

ALTER TABLE public.tb_agent_category_drafts
  ADD CONSTRAINT ck_agent_category_drafts_operation_type
  CHECK (
    (status = 'AWAITING_OPERATION' AND operation_type IS NULL)
    OR
    (
      status IN ('AWAITING_DETAILS', 'AWAITING_CATEGORY')
      AND operation_type IS NOT NULL
      AND operation_type IN ('CREATE_EXPENSE', 'CREATE_INCOME')
    )
  );

COMMIT;
