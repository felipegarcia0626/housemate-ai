BEGIN;

DO $$
<<context>>
DECLARE
  household_id CONSTANT UUID := '00000000-0000-4000-8000-000000000001';
  actor_one CONSTANT UUID := '00000000-0000-4000-8000-000000000021';
  actor_two CONSTANT UUID := '00000000-0000-4000-8000-000000000022';
  actor_three CONSTANT UUID := '00000000-0000-4000-8000-000000000023';
  conversation_key CONSTANT TEXT := '2q1-context';
  proposal_one CONSTANT UUID := '30000000-0000-4000-8000-000000000201';
  proposal_two CONSTANT UUID := '30000000-0000-4000-8000-000000000202';
  proposal_three CONSTANT UUID := '30000000-0000-4000-8000-000000000203';
  draft_one CONSTANT UUID := '30000000-0000-4000-8000-000000000211';
  draft_two CONSTANT UUID := '30000000-0000-4000-8000-000000000212';
  draft_three CONSTANT UUID := '30000000-0000-4000-8000-000000000213';
  duplicate_failed BOOLEAN := FALSE;
  proposal_count BIGINT;
  draft_count BIGINT;
BEGIN
  INSERT INTO public.tb_pending_proposals (
    id,
    household_id,
    conversation_key,
    actor_member_id,
    source,
    operation_type,
    payload,
    status
  )
  VALUES (
    proposal_one,
    household_id,
    conversation_key,
    actor_one,
    'WEB',
    'CREATE_EXPENSE',
    jsonb_build_object('actorMemberId', actor_one::TEXT, 'source', 'WEB'),
    'AWAITING_CONFIRMATION'
  );

  INSERT INTO public.tb_pending_proposals (
    id,
    household_id,
    conversation_key,
    actor_member_id,
    source,
    operation_type,
    payload,
    status
  )
  VALUES (
    proposal_two,
    household_id,
    conversation_key,
    actor_two,
    'WEB',
    'CREATE_EXPENSE',
    jsonb_build_object('actorMemberId', actor_two::TEXT, 'source', 'WEB'),
    'AWAITING_CONFIRMATION'
  ), (
    proposal_three,
    household_id,
    conversation_key,
    actor_one,
    'WHATSAPP',
    'CREATE_INCOME',
    jsonb_build_object('actorMemberId', actor_one::TEXT, 'source', 'WHATSAPP'),
    'AWAITING_CONFIRMATION'
  );

  SELECT count(*) INTO proposal_count
    FROM public.tb_pending_proposals AS proposal_row
   WHERE proposal_row.household_id = context.household_id
     AND proposal_row.conversation_key = context.conversation_key
     AND proposal_row.status = 'AWAITING_CONFIRMATION';

  IF proposal_count <> 3 THEN
    RAISE EXCEPTION 'FAIL foreign actor/source proposals did not coexist: %', proposal_count;
  END IF;

  BEGIN
    INSERT INTO public.tb_pending_proposals (
      id,
      household_id,
      conversation_key,
      actor_member_id,
      source,
      operation_type,
      payload,
      status
    )
    VALUES (
      '30000000-0000-4000-8000-000000000204',
      household_id,
      conversation_key,
      actor_one,
      'WEB',
      'CREATE_INCOME',
      jsonb_build_object('actorMemberId', actor_one::TEXT, 'source', 'WEB'),
      'AWAITING_CONFIRMATION'
    );
  EXCEPTION WHEN unique_violation THEN
    duplicate_failed := TRUE;
  END;

  IF NOT duplicate_failed THEN
    RAISE EXCEPTION 'FAIL duplicate exact Proposal context was accepted';
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
    draft_one,
    household_id,
    actor_one,
    conversation_key,
    'WEB',
    NULL,
    '{}'::JSONB,
    'AWAITING_OPERATION'
  ), (
    draft_two,
    household_id,
    actor_two,
    conversation_key,
    'WEB',
    NULL,
    '{}'::JSONB,
    'AWAITING_OPERATION'
  ), (
    draft_three,
    household_id,
    actor_one,
    conversation_key,
    'WHATSAPP',
    NULL,
    '{}'::JSONB,
    'AWAITING_OPERATION'
  );

  SELECT count(*) INTO draft_count
    FROM public.tb_agent_category_drafts AS draft_row
   WHERE draft_row.household_id = context.household_id
     AND draft_row.actor_member_id = context.actor_three
     AND draft_row.conversation_key = context.conversation_key
     AND draft_row.source = 'WEB';

  IF draft_count <> 0 THEN
    RAISE EXCEPTION 'FAIL foreign actor Draft was visible';
  END IF;

  SELECT count(*) INTO draft_count
    FROM public.tb_agent_category_drafts AS draft_row
   WHERE draft_row.household_id = context.household_id
     AND draft_row.actor_member_id = context.actor_one
     AND draft_row.conversation_key = context.conversation_key
     AND draft_row.source = 'WEB';

  IF draft_count <> 1 THEN
    RAISE EXCEPTION 'FAIL exact Web Draft context was not isolated';
  END IF;

  SELECT count(*) INTO draft_count
    FROM public.tb_agent_category_drafts AS draft_row
   WHERE draft_row.household_id = context.household_id
     AND draft_row.actor_member_id = context.actor_one
     AND draft_row.conversation_key = context.conversation_key
     AND draft_row.source = 'WHATSAPP';

  IF draft_count <> 1 THEN
    RAISE EXCEPTION 'FAIL exact WhatsApp Draft context was not isolated';
  END IF;

  duplicate_failed := FALSE;
  BEGIN
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
      '30000000-0000-4000-8000-000000000214',
      household_id,
      actor_one,
      conversation_key,
      'WEB',
      NULL,
      '{}'::JSONB,
      'AWAITING_OPERATION'
    );
  EXCEPTION WHEN unique_violation THEN
    duplicate_failed := TRUE;
  END;

  IF NOT duplicate_failed THEN
    RAISE EXCEPTION 'FAIL duplicate exact Draft context was accepted';
  END IF;
END;
$$;

SELECT 'PASS 2Q.1 contextual Proposal and Draft isolation SQL checks completed' AS result;

ROLLBACK;
