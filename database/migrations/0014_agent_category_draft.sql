BEGIN;

CREATE TYPE public.agent_category_draft_status AS ENUM (
  'AWAITING_CATEGORY'
);

CREATE TABLE public.tb_agent_category_drafts (
  id UUID CONSTRAINT pk_tb_agent_category_drafts PRIMARY KEY,
  household_id UUID NOT NULL,
  actor_member_id UUID NOT NULL,
  conversation_key TEXT NOT NULL,
  operation_type public.pending_operation_type NOT NULL,
  payload JSONB NOT NULL,
  status public.agent_category_draft_status NOT NULL DEFAULT 'AWAITING_CATEGORY',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_agent_category_drafts_household
    FOREIGN KEY (household_id)
    REFERENCES public.tb_households (id)
    ON DELETE RESTRICT,
  CONSTRAINT fk_agent_category_drafts_actor_household
    FOREIGN KEY (household_id, actor_member_id)
    REFERENCES public.tb_household_members (household_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT ck_agent_category_drafts_operation_type
    CHECK (operation_type IN ('CREATE_EXPENSE', 'CREATE_INCOME')),
  CONSTRAINT uq_agent_category_drafts_context
    UNIQUE (household_id, actor_member_id, conversation_key)
);

CREATE INDEX idx_agent_category_drafts_updated_at
  ON public.tb_agent_category_drafts (updated_at);

CREATE TRIGGER trg_agent_category_drafts_set_updated_at
BEFORE UPDATE ON public.tb_agent_category_drafts
FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE public.tb_agent_category_drafts
TO service_role;

COMMIT;
