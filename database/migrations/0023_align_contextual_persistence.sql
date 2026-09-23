BEGIN;

ALTER TABLE public.tb_pending_proposals
  ADD COLUMN actor_member_id UUID,
  ADD COLUMN source public.expense_source;

ALTER TABLE public.tb_agent_category_drafts
  ADD COLUMN source public.expense_source;

UPDATE public.tb_pending_proposals
   SET actor_member_id = CASE
         WHEN payload ->> 'actorMemberId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           THEN (payload ->> 'actorMemberId')::UUID
         ELSE NULL
       END,
       source = CASE payload ->> 'source'
         WHEN 'WEB' THEN 'WEB'::public.expense_source
         WHEN 'WHATSAPP' THEN 'WHATSAPP'::public.expense_source
         WHEN 'RECEIPT' THEN 'RECEIPT'::public.expense_source
         ELSE NULL
       END
 WHERE actor_member_id IS NULL
    OR source IS NULL;

UPDATE public.tb_agent_category_drafts
   SET source = CASE payload ->> 'source'
         WHEN 'WEB' THEN 'WEB'::public.expense_source
         WHEN 'WHATSAPP' THEN 'WHATSAPP'::public.expense_source
         WHEN 'RECEIPT' THEN 'RECEIPT'::public.expense_source
         ELSE NULL
       END
 WHERE source IS NULL;

CREATE OR REPLACE FUNCTION public.fn_sync_pending_proposal_context()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.actor_member_id IS NULL
     AND NEW.payload ->> 'actorMemberId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    NEW.actor_member_id := (NEW.payload ->> 'actorMemberId')::UUID;
  END IF;

  IF NEW.source IS NULL THEN
    NEW.source := CASE NEW.payload ->> 'source'
      WHEN 'WEB' THEN 'WEB'::public.expense_source
      WHEN 'WHATSAPP' THEN 'WHATSAPP'::public.expense_source
      WHEN 'RECEIPT' THEN 'RECEIPT'::public.expense_source
      ELSE NULL
    END;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_tb_pending_proposals_sync_context
BEFORE INSERT OR UPDATE OF payload, actor_member_id, source
ON public.tb_pending_proposals
FOR EACH ROW
EXECUTE FUNCTION public.fn_sync_pending_proposal_context();

DROP INDEX public.uq_tb_pending_proposals_active_conversation;

CREATE UNIQUE INDEX uq_tb_pending_proposals_active_context
  ON public.tb_pending_proposals (
    household_id,
    conversation_key,
    actor_member_id,
    source
  )
  WHERE status = 'AWAITING_CONFIRMATION'
    AND actor_member_id IS NOT NULL
    AND source IS NOT NULL;

ALTER TABLE public.tb_agent_category_drafts
  DROP CONSTRAINT uq_agent_category_drafts_context;

CREATE UNIQUE INDEX uq_agent_category_drafts_context_source
  ON public.tb_agent_category_drafts (
    household_id,
    actor_member_id,
    conversation_key,
    source
  )
  WHERE source IS NOT NULL;

COMMIT;
