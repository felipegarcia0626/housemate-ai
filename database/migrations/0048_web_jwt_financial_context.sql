BEGIN;

-- Web entry points derive identity from the PostgREST request JWT. Existing
-- service_role paths remain available until the separately authorized cut.
CREATE FUNCTION public.fn_require_web_financial_context(
  p_household_id uuid, p_actor_member_id uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_auth_user_id uuid; v_user_id uuid; v_email text; v_confirmed timestamptz;
BEGIN
  v_auth_user_id := auth.uid();
  IF v_auth_user_id IS NULL OR auth.role() IS DISTINCT FROM 'authenticated'
     OR p_household_id IS NULL OR p_actor_member_id IS NULL THEN
    RAISE EXCEPTION 'Financial access is unavailable' USING ERRCODE='42501', DETAIL='HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
  END IF;
  SELECT email,email_confirmed_at INTO v_email,v_confirmed
    FROM auth.users WHERE id=v_auth_user_id FOR SHARE;
  IF NOT FOUND OR nullif(btrim(v_email),'') IS NULL OR v_confirmed IS NULL THEN
    RAISE EXCEPTION 'Financial access is unavailable' USING ERRCODE='42501', DETAIL='HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
  END IF;
  PERFORM 1 FROM public.tb_households WHERE id=p_household_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial access is unavailable' USING ERRCODE='42501', DETAIL='HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
  END IF;
  SELECT id INTO v_user_id FROM public.tb_users WHERE auth_user_id=v_auth_user_id FOR SHARE;
  IF NOT FOUND OR NOT public.fn_lock_whatsapp_active_membership(v_user_id,p_household_id,p_actor_member_id) THEN
    RAISE EXCEPTION 'Financial access is unavailable' USING ERRCODE='42501', DETAIL='HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
  END IF;
  RETURN v_user_id;
END;
$$;

-- The first migrated Web write is draft creation. No WhatsApp or receipt
-- arguments are accepted; the source is fixed in SQL.
CREATE FUNCTION public.fn_create_web_agent_draft(
  p_id uuid, p_household_id uuid, p_actor_member_id uuid,
  p_conversation_key text, p_operation_type public.pending_operation_type,
  p_payload jsonb, p_status public.agent_category_draft_status
) RETURNS public.tb_agent_category_drafts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_row public.tb_agent_category_drafts;
BEGIN
  PERFORM public.fn_require_web_financial_context(p_household_id,p_actor_member_id);
  IF p_id IS NULL OR nullif(btrim(p_conversation_key),'') IS NULL
     OR p_payload IS NULL OR p_status IS NULL THEN
    RAISE EXCEPTION 'Invalid Web draft' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.tb_agent_category_drafts
    (id,household_id,actor_member_id,conversation_key,source,operation_type,payload,status)
  VALUES (p_id,p_household_id,p_actor_member_id,p_conversation_key,'WEB',p_operation_type,p_payload,p_status)
  RETURNING * INTO v_row;
  RETURN v_row;
END;
$$;

ALTER FUNCTION public.fn_require_web_financial_context(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.fn_create_web_agent_draft(uuid,uuid,uuid,text,public.pending_operation_type,jsonb,public.agent_category_draft_status) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_require_web_financial_context(uuid,uuid) FROM PUBLIC,service_role;
REVOKE ALL ON FUNCTION public.fn_create_web_agent_draft(uuid,uuid,uuid,text,public.pending_operation_type,jsonb,public.agent_category_draft_status) FROM PUBLIC,service_role;
REVOKE ALL ON FUNCTION public.fn_require_web_financial_context(uuid,uuid) FROM anon,authenticated;
REVOKE ALL ON FUNCTION public.fn_create_web_agent_draft(uuid,uuid,uuid,text,public.pending_operation_type,jsonb,public.agent_category_draft_status) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_create_web_agent_draft(uuid,uuid,uuid,text,public.pending_operation_type,jsonb,public.agent_category_draft_status) TO authenticated;

COMMIT;
