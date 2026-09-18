BEGIN;

ALTER TYPE public.pending_proposal_status
  ADD VALUE IF NOT EXISTS 'COMPLETED';

ALTER TYPE public.pending_proposal_status
  ADD VALUE IF NOT EXISTS 'REJECTED';

COMMIT;

BEGIN;

ALTER TABLE public.tb_pending_proposals
  ADD COLUMN resolved_at TIMESTAMPTZ;

ALTER TABLE public.tb_pending_proposals
  ADD COLUMN expense_id UUID;

ALTER TABLE public.tb_pending_proposals
  ADD COLUMN income_id UUID;

ALTER TABLE public.tb_incomes
  ADD CONSTRAINT uq_tb_incomes_household_id
  UNIQUE (household_id, id);

ALTER TABLE public.tb_pending_proposals
  ADD CONSTRAINT fk_tb_pending_proposals_expense_household
  FOREIGN KEY (household_id, expense_id)
  REFERENCES public.tb_expenses (household_id, id)
  ON DELETE RESTRICT
  ON UPDATE NO ACTION;

ALTER TABLE public.tb_pending_proposals
  ADD CONSTRAINT fk_tb_pending_proposals_income_household
  FOREIGN KEY (household_id, income_id)
  REFERENCES public.tb_incomes (household_id, id)
  ON DELETE RESTRICT
  ON UPDATE NO ACTION;

ALTER TABLE public.tb_pending_proposals
  ADD CONSTRAINT ck_tb_pending_proposals_status_resolution
  CHECK (
    (
      status = 'AWAITING_CONFIRMATION'
      AND resolved_at IS NULL
      AND expense_id IS NULL
      AND income_id IS NULL
    )
    OR
    (
      status = 'REJECTED'
      AND resolved_at IS NOT NULL
      AND expense_id IS NULL
      AND income_id IS NULL
    )
    OR
    (
      status = 'COMPLETED'
      AND resolved_at IS NOT NULL
      AND (
        (
          operation_type = 'CREATE_EXPENSE'
          AND expense_id IS NOT NULL
          AND income_id IS NULL
        )
        OR
        (
          operation_type = 'CREATE_INCOME'
          AND expense_id IS NULL
          AND income_id IS NOT NULL
        )
      )
    )
  );

ALTER TABLE public.tb_pending_proposals
  ADD CONSTRAINT ck_tb_pending_proposals_operation_reference
  CHECK (
    (
      operation_type = 'CREATE_EXPENSE'
      AND income_id IS NULL
    )
    OR
    (
      operation_type = 'CREATE_INCOME'
      AND expense_id IS NULL
    )
    OR
    (
      operation_type IN (
        'UPDATE_EXPENSE',
        'DELETE_EXPENSE',
        'UPDATE_INCOME',
        'DELETE_INCOME'
      )
      AND expense_id IS NULL
      AND income_id IS NULL
    )
  );

COMMIT;
