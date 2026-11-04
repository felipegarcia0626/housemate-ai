BEGIN;

-- These wrappers add event fencing/checkpoints, not financial calculations.
CREATE FUNCTION public.fn_require_whatsapp_event_conversation(p_event_id TEXT,p_token UUID,p_epoch BIGINT,p_conversation_key TEXT)
RETURNS public.tb_whatsapp_event_receipts LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public.tb_whatsapp_event_receipts; digest TEXT;
BEGIN
  r:=public.fn_require_whatsapp_event(p_event_id,p_token,p_epoch,true);
  IF p_conversation_key IS NULL OR length(p_conversation_key) NOT BETWEEN 1 AND 1024 THEN RAISE EXCEPTION 'Invalid conversation' USING ERRCODE='22023'; END IF;
  digest:=encode(sha256(convert_to(p_conversation_key,'UTF8')),'hex');
  IF r.conversation_digest IS NOT NULL AND r.conversation_digest<>digest THEN RAISE EXCEPTION 'WhatsApp event conversation changed' USING ERRCODE='40001'; END IF;
  UPDATE public.tb_whatsapp_event_receipts SET conversation_digest=digest WHERE external_event_id=p_event_id;
  RETURN r;
END;
$$;

CREATE FUNCTION public.fn_create_whatsapp_proposal_event(p_event_id TEXT,p_token UUID,p_epoch BIGINT,p_id UUID,p_conversation_key TEXT,p_operation_type public.pending_operation_type,p_payload JSONB)
RETURNS public.tb_pending_proposals LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public.tb_whatsapp_event_receipts; proposal public.tb_pending_proposals;
BEGIN
  r:=public.fn_require_whatsapp_event_conversation(p_event_id,p_token,p_epoch,p_conversation_key);
  proposal:=public.fn_create_whatsapp_pending_proposal(p_id,r.household_id,p_conversation_key,r.actor_member_id,p_operation_type,p_payload,r.user_id,r.context_lease_id,r.context_epoch);
  UPDATE public.tb_whatsapp_event_receipts SET artifacts=artifacts||jsonb_build_object(p_id::text,jsonb_build_object('updatedAt',proposal.updated_at,'operation',p_operation_type)),updated_at=clock_timestamp() WHERE external_event_id=p_event_id;
  RETURN proposal;
END;
$$;

CREATE FUNCTION public.fn_update_whatsapp_proposal_event(p_event_id TEXT,p_token UUID,p_epoch BIGINT,p_id UUID,p_conversation_key TEXT,p_operation_type public.pending_operation_type,p_payload JSONB,p_expected_updated_at TIMESTAMPTZ)
RETURNS public.tb_pending_proposals LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public.tb_whatsapp_event_receipts;
BEGIN
  r:=public.fn_require_whatsapp_event_conversation(p_event_id,p_token,p_epoch,p_conversation_key);
  RETURN public.fn_update_whatsapp_pending_proposal(p_id,r.household_id,p_conversation_key,r.actor_member_id,p_operation_type,p_payload,p_expected_updated_at,r.user_id,r.context_lease_id,r.context_epoch);
END;
$$;

CREATE FUNCTION public.fn_reject_whatsapp_proposal_event(p_event_id TEXT,p_token UUID,p_epoch BIGINT,p_proposal_id UUID,p_conversation_key TEXT,p_operation_type public.pending_operation_type)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public.tb_whatsapp_event_receipts;
BEGIN
  r:=public.fn_require_whatsapp_event_conversation(p_event_id,p_token,p_epoch,p_conversation_key);
  RETURN public.fn_reject_whatsapp_pending_proposal(p_proposal_id,r.household_id,p_conversation_key,r.actor_member_id,p_operation_type,r.user_id,r.context_lease_id,r.context_epoch);
END;
$$;

CREATE FUNCTION public.fn_compensate_whatsapp_proposal_event(p_event_id TEXT,p_token UUID,p_epoch BIGINT,p_proposal_id UUID,p_conversation_key TEXT,p_operation_type public.pending_operation_type)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public.tb_whatsapp_event_receipts; proposal public.tb_pending_proposals; artifact JSONB;
BEGIN
  r:=public.fn_require_whatsapp_event_conversation(p_event_id,p_token,p_epoch,p_conversation_key);
  artifact:=r.artifacts->p_proposal_id::text;
  IF artifact IS NULL OR artifact->>'operation' IS DISTINCT FROM p_operation_type::text THEN RAISE EXCEPTION 'Proposal creator is unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO proposal FROM public.tb_pending_proposals WHERE id=p_proposal_id AND household_id=r.household_id
    AND actor_member_id=r.actor_member_id AND conversation_key=p_conversation_key AND source='WHATSAPP' AND operation_type=p_operation_type FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','NOT_FOUND'); END IF;
  IF proposal.status<>'AWAITING_CONFIRMATION' OR proposal.updated_at IS DISTINCT FROM (artifact->>'updatedAt')::timestamptz THEN
    RETURN jsonb_build_object('status','VERSION_CONFLICT');
  END IF;
  DELETE FROM public.tb_pending_proposals WHERE id=proposal.id;
  RETURN jsonb_build_object('status','REMOVED');
END;
$$;

CREATE FUNCTION public.fn_create_whatsapp_draft_event(p_event_id TEXT,p_token UUID,p_epoch BIGINT,p_id UUID,p_conversation_key TEXT,p_operation_type public.pending_operation_type,p_payload JSONB,p_status public.agent_category_draft_status)
RETURNS public.tb_agent_category_drafts LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public.tb_whatsapp_event_receipts;
BEGIN
  r:=public.fn_require_whatsapp_event_conversation(p_event_id,p_token,p_epoch,p_conversation_key);
  RETURN public.fn_create_whatsapp_agent_draft(p_id,r.household_id,r.actor_member_id,p_conversation_key,p_operation_type,p_payload,p_status,r.user_id,r.context_lease_id,r.context_epoch);
END;
$$;

CREATE FUNCTION public.fn_update_whatsapp_draft_event(p_event_id TEXT,p_token UUID,p_epoch BIGINT,p_id UUID,p_conversation_key TEXT,p_operation_type public.pending_operation_type,p_payload JSONB,p_status public.agent_category_draft_status,p_expected_updated_at TIMESTAMPTZ)
RETURNS public.tb_agent_category_drafts LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public.tb_whatsapp_event_receipts;
BEGIN
  r:=public.fn_require_whatsapp_event_conversation(p_event_id,p_token,p_epoch,p_conversation_key);
  RETURN public.fn_update_whatsapp_agent_draft(p_id,r.household_id,r.actor_member_id,p_conversation_key,p_operation_type,p_payload,p_status,p_expected_updated_at,r.user_id,r.context_lease_id,r.context_epoch);
END;
$$;

CREATE FUNCTION public.fn_delete_whatsapp_draft_event(p_event_id TEXT,p_token UUID,p_epoch BIGINT,p_id UUID,p_conversation_key TEXT,p_expected_updated_at TIMESTAMPTZ)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public.tb_whatsapp_event_receipts;
BEGIN
  r:=public.fn_require_whatsapp_event_conversation(p_event_id,p_token,p_epoch,p_conversation_key);
  RETURN public.fn_delete_whatsapp_agent_draft(p_id,r.household_id,r.actor_member_id,p_conversation_key,p_expected_updated_at,r.user_id,r.context_lease_id,r.context_epoch);
END;
$$;

CREATE FUNCTION public.fn_confirm_whatsapp_expense_event(
  p_event_id TEXT,p_token UUID,p_epoch BIGINT,p_proposal_id UUID,p_conversation_key TEXT,p_expected_updated_at TIMESTAMPTZ,
  p_paid_by UUID,p_category_id UUID,p_receipt_id UUID,p_merchant TEXT,p_total_amount NUMERIC,p_expense_date DATE,p_description TEXT,p_items JSONB,p_distributions JSONB
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public.tb_whatsapp_event_receipts; outcome JSONB; digest TEXT;
BEGIN
  r:=public.fn_require_whatsapp_event_conversation(p_event_id,p_token,p_epoch,p_conversation_key);
  digest:=encode(sha256(convert_to(jsonb_build_array('EXPENSE',p_proposal_id,p_expected_updated_at,p_paid_by,p_category_id,p_receipt_id,p_merchant,p_total_amount,p_expense_date,p_description,p_items,p_distributions)::text,'UTF8')),'hex');
  IF r.business_result IS NOT NULL THEN
    IF r.operation_digest IS DISTINCT FROM digest THEN RAISE EXCEPTION 'Event operation changed' USING ERRCODE='40001'; END IF;
    RETURN r.business_result;
  END IF;
  outcome:=public.fn_confirm_pending_expense_eligible(NULL,p_proposal_id,r.household_id,p_conversation_key,r.actor_member_id,'WHATSAPP',p_expected_updated_at,
    r.actor_member_id,p_paid_by,p_category_id,p_receipt_id,p_merchant,p_total_amount,p_expense_date,p_description,'WHATSAPP',p_items,p_distributions,r.user_id,r.context_lease_id,r.context_epoch);
  IF outcome->>'status' IN ('CREATED','ALREADY_COMPLETED') AND outcome->>'expense_id' IS NOT NULL THEN
    UPDATE public.tb_whatsapp_event_receipts SET business_result=outcome,operation_digest=digest,delivery_state='READY',
      reply_template='EXPENSE_CONFIRMED_V1',reply_text='Gasto confirmado.',reply_guard='{"financial":true}',
      reply_expires_at=clock_timestamp()+interval '72 hours',updated_at=clock_timestamp() WHERE external_event_id=p_event_id;
  END IF;
  RETURN outcome;
END;
$$;

CREATE FUNCTION public.fn_confirm_whatsapp_income_event(
  p_event_id TEXT,p_token UUID,p_epoch BIGINT,p_proposal_id UUID,p_conversation_key TEXT,p_expected_updated_at TIMESTAMPTZ,
  p_member_id UUID,p_amount NUMERIC,p_income_date DATE,p_description TEXT,p_category_id UUID
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public.tb_whatsapp_event_receipts; outcome JSONB; digest TEXT;
BEGIN
  r:=public.fn_require_whatsapp_event_conversation(p_event_id,p_token,p_epoch,p_conversation_key);
  digest:=encode(sha256(convert_to(jsonb_build_array('INCOME',p_proposal_id,p_expected_updated_at,p_member_id,p_amount,p_income_date,p_description,p_category_id)::text,'UTF8')),'hex');
  IF r.business_result IS NOT NULL THEN
    IF r.operation_digest IS DISTINCT FROM digest THEN RAISE EXCEPTION 'Event operation changed' USING ERRCODE='40001'; END IF;
    RETURN r.business_result;
  END IF;
  outcome:=public.fn_confirm_pending_income_eligible(NULL,p_proposal_id,r.household_id,p_conversation_key,r.actor_member_id,'WHATSAPP',p_expected_updated_at,
    r.actor_member_id,p_member_id,p_amount,p_income_date,p_description,p_category_id,r.user_id,r.context_lease_id,r.context_epoch);
  IF outcome->>'status' IN ('CREATED','ALREADY_COMPLETED') AND outcome->>'income_id' IS NOT NULL THEN
    UPDATE public.tb_whatsapp_event_receipts SET business_result=outcome,operation_digest=digest,delivery_state='READY',
      reply_template='INCOME_CONFIRMED_V1',reply_text='Ingreso confirmado.',reply_guard='{"financial":true}',
      reply_expires_at=clock_timestamp()+interval '72 hours',updated_at=clock_timestamp() WHERE external_event_id=p_event_id;
  END IF;
  RETURN outcome;
END;
$$;

CREATE FUNCTION public.fn_insert_whatsapp_category_event(p_event_id TEXT,p_token UUID,p_epoch BIGINT,p_id UUID,p_name TEXT,p_movement_type TEXT,p_parent_id UUID)
RETURNS public.tb_categories LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE category public.tb_categories;
BEGIN
  PERFORM public.fn_require_whatsapp_event(p_event_id,p_token,p_epoch,true);
  PERFORM 1 FROM public.tb_categories WHERE id=p_parent_id AND level='MACRO' AND movement_type=p_movement_type AND is_active FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'Category parent is unavailable' USING ERRCODE='22023'; END IF;
  INSERT INTO public.tb_categories(id,movement_type,level,parent_id,name,description,is_active)
    VALUES(p_id,p_movement_type,'MICRO',p_parent_id,p_name,NULL,true) RETURNING * INTO category;
  RETURN category;
END;
$$;

CREATE FUNCTION public.fn_transition_whatsapp_event_context(p_event_id TEXT,p_token UUID,p_epoch BIGINT,p_phone_number_id TEXT,p_action TEXT,
  p_household_id UUID DEFAULT NULL,p_member_id UUID DEFAULT NULL,p_household_ids UUID[] DEFAULT NULL,p_option_number INTEGER DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r public.tb_whatsapp_event_receipts;
BEGIN
  r:=public.fn_require_whatsapp_event(p_event_id,p_token,p_epoch,false);
  IF r.processing_state<>'RUNNING' OR r.household_id IS NOT NULL THEN RAISE EXCEPTION 'Event cannot change household context' USING ERRCODE='40001'; END IF;
  RETURN public.fn_transition_whatsapp_household_context(r.user_id,p_phone_number_id,r.context_lease_id,r.context_epoch,p_action,p_household_id,p_member_id,p_household_ids,p_option_number);
END;
$$;

DO $$
DECLARE f RECORD; role_name TEXT;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS signature,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('fn_require_whatsapp_event_conversation','fn_create_whatsapp_proposal_event',
      'fn_update_whatsapp_proposal_event','fn_reject_whatsapp_proposal_event','fn_compensate_whatsapp_proposal_event',
      'fn_create_whatsapp_draft_event','fn_update_whatsapp_draft_event','fn_delete_whatsapp_draft_event',
      'fn_confirm_whatsapp_expense_event','fn_confirm_whatsapp_income_event','fn_transition_whatsapp_event_context','fn_insert_whatsapp_category_event') LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',f.signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,service_role',f.signature);
    FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f.signature,role_name);
    END LOOP;
    IF f.proname<>'fn_require_whatsapp_event_conversation' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature); END IF;
  END LOOP;
END;
$$;

COMMIT;
