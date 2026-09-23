BEGIN;

DO $$
DECLARE
  v_household_id CONSTANT UUID := '00000000-0000-4000-8000-000000000001';
  v_actor_one CONSTANT UUID := '00000000-0000-4000-8000-000000000021';
  v_actor_two CONSTANT UUID := '00000000-0000-4000-8000-000000000022';
  v_draft_id CONSTANT UUID := '50000000-0000-4000-8000-000000000001';
  v_foreign_draft_id CONSTANT UUID := '50000000-0000-4000-8000-000000000002';
  v_conversation_key CONSTANT TEXT := '2r1-draft-cas';
  version_one TIMESTAMPTZ;
  version_two TIMESTAMPTZ;
  deleted_id UUID;
  remaining_payload JSONB;
BEGIN
  INSERT INTO public.tb_agent_category_drafts (
    id,
    household_id,
    actor_member_id,
    conversation_key,
    source,
    operation_type,
    payload,
    status,
    updated_at
  )
  VALUES (
    v_draft_id,
    v_household_id,
    v_actor_one,
    v_conversation_key,
    'WEB',
    NULL,
    jsonb_build_object('amount', NULL, 'version', 'v1'),
    'AWAITING_OPERATION',
    '2026-08-12T12:00:00.000Z'
  );

  SELECT updated_at
    INTO version_one
    FROM public.tb_agent_category_drafts
   WHERE id = v_draft_id;

  UPDATE public.tb_agent_category_drafts
     SET payload = jsonb_build_object('amount', NULL, 'version', 'v2')
   WHERE id = v_draft_id
     AND updated_at = version_one;

  SELECT updated_at
    INTO version_two
    FROM public.tb_agent_category_drafts
   WHERE id = v_draft_id;

  deleted_id := NULL;
  DELETE FROM public.tb_agent_category_drafts AS draft
   WHERE draft.id = v_draft_id
     AND draft.household_id = v_household_id
     AND draft.actor_member_id = v_actor_one
     AND draft.conversation_key = v_conversation_key
     AND draft.source = 'WEB'
     AND draft.updated_at = version_one
  RETURNING draft.id INTO deleted_id;

  IF deleted_id IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL stale draft delete removed a newer version';
  END IF;

  SELECT payload
    INTO remaining_payload
    FROM public.tb_agent_category_drafts
   WHERE id = v_draft_id;

  IF remaining_payload ->> 'version' <> 'v2' THEN
    RAISE EXCEPTION 'FAIL stale draft delete did not preserve version v2';
  END IF;

  deleted_id := NULL;
  DELETE FROM public.tb_agent_category_drafts AS draft
   WHERE draft.id = v_draft_id
     AND draft.household_id = v_household_id
     AND draft.actor_member_id = v_actor_one
     AND draft.conversation_key = v_conversation_key
     AND draft.source = 'WEB'
     AND draft.updated_at = version_two
  RETURNING draft.id INTO deleted_id;

  IF deleted_id IS DISTINCT FROM v_draft_id THEN
    RAISE EXCEPTION 'FAIL current draft delete did not remove exactly one row';
  END IF;

  INSERT INTO public.tb_agent_category_drafts (
    id,
    household_id,
    actor_member_id,
    conversation_key,
    source,
    operation_type,
    payload,
    status
  )
  VALUES (
    v_draft_id,
    v_household_id,
    v_actor_one,
    v_conversation_key,
    'WEB',
    NULL,
    jsonb_build_object('version', 'owned'),
    'AWAITING_OPERATION'
  ), (
    v_foreign_draft_id,
    v_household_id,
    v_actor_two,
    v_conversation_key,
    'WEB',
    NULL,
    jsonb_build_object('version', 'foreign'),
    'AWAITING_OPERATION'
  );

  SELECT updated_at
    INTO version_one
    FROM public.tb_agent_category_drafts
   WHERE id = v_draft_id;

  deleted_id := NULL;
  DELETE FROM public.tb_agent_category_drafts AS draft
   WHERE draft.id = v_draft_id
     AND draft.household_id = v_household_id
     AND draft.actor_member_id = v_actor_two
     AND draft.conversation_key = v_conversation_key
     AND draft.source = 'WEB'
     AND draft.updated_at = version_one
  RETURNING draft.id INTO deleted_id;

  IF deleted_id IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL foreign actor deleted the owned draft';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.tb_agent_category_drafts
     WHERE id = v_draft_id
  ) OR NOT EXISTS (
    SELECT 1
      FROM public.tb_agent_category_drafts
     WHERE id = v_foreign_draft_id
  ) THEN
    RAISE EXCEPTION 'FAIL contextual isolation removed a protected draft';
  END IF;
END;
$$;

SELECT 'PASS 2R.1 AgentDraft optimistic delete concurrency checks completed' AS result;

ROLLBACK;
