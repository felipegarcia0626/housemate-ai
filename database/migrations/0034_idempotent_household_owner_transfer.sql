BEGIN;

CREATE OR REPLACE FUNCTION public.fn_transfer_household_owner(p_auth_user_id UUID,p_household_id UUID,p_target_member_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_user UUID; v_actor RECORD; v_target RECORD; v_household_name TEXT; v_key TEXT;
  v_previous_owner_user UUID; v_new_owner_user UUID;
BEGIN
  SELECT id INTO v_user FROM public.tb_users WHERE auth_user_id=p_auth_user_id;
  IF v_user IS NULL THEN RAISE EXCEPTION 'Application user not found' USING ERRCODE='P0002'; END IF;

  PERFORM 1 FROM public.tb_households WHERE id=p_household_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Household not found' USING ERRCODE='P0003'; END IF;

  SELECT m.id,m.user_id,m.role,m.status,u.display_name
    INTO v_actor
    FROM public.tb_household_members m
    JOIN public.tb_users u ON u.id=m.user_id
   WHERE m.household_id=p_household_id AND m.user_id=v_user
   FOR UPDATE;

  SELECT m.id,m.user_id,m.role,m.status,u.display_name
    INTO v_target
    FROM public.tb_household_members m
    JOIN public.tb_users u ON u.id=m.user_id
   WHERE m.id=p_target_member_id AND m.household_id=p_household_id
   FOR UPDATE;

  IF v_actor.id IS NULL THEN RAISE EXCEPTION 'Not household member' USING ERRCODE='P0003'; END IF;

  IF v_actor.role='OWNER' AND v_actor.status='ACTIVE' THEN
    IF v_target.id IS NULL OR v_target.status<>'ACTIVE' OR v_target.role<>'MEMBER' OR v_target.id=v_actor.id THEN
      RAISE EXCEPTION 'Invalid transfer target' USING ERRCODE='P0004';
    END IF;

    v_previous_owner_user := v_actor.user_id;
    v_new_owner_user := v_target.user_id;
    SELECT name INTO v_household_name FROM public.tb_households WHERE id=p_household_id;
    UPDATE public.tb_household_members SET role='MEMBER' WHERE id=v_actor.id;
    UPDATE public.tb_household_members SET role='OWNER' WHERE id=v_target.id;
    v_key := 'ownership:'||p_household_id||':'||v_actor.id||':'||v_target.id;
    INSERT INTO public.tb_notifications(recipient_user_id,household_id,type,title,body,metadata,source_entity_type,source_entity_id,deduplication_key)
    VALUES(v_previous_owner_user,p_household_id,'HOUSEHOLD_OWNERSHIP_TRANSFERRED','Ownership transferido','Ya no eres owner de '||coalesce(v_household_name,'este household'),jsonb_build_object('previousOwnerMemberId',v_actor.id,'newOwnerMemberId',v_target.id),'HOUSEHOLD',p_household_id,v_key);
    INSERT INTO public.tb_notifications(recipient_user_id,household_id,type,title,body,metadata,source_entity_type,source_entity_id,deduplication_key)
    VALUES(v_new_owner_user,p_household_id,'HOUSEHOLD_OWNERSHIP_TRANSFERRED','Ownership transferido','Ahora eres owner de '||coalesce(v_household_name,'este household'),jsonb_build_object('previousOwnerMemberId',v_actor.id,'newOwnerMemberId',v_target.id),'HOUSEHOLD',p_household_id,v_key);
    RETURN jsonb_build_object('householdId',p_household_id,'ownerMemberId',v_target.id);
  END IF;

  IF v_actor.role='MEMBER' AND v_actor.status='ACTIVE'
     AND v_target.id IS NOT NULL AND v_target.role='OWNER' AND v_target.status='ACTIVE' THEN
    IF EXISTS (
      SELECT 1 FROM public.tb_notifications n
       WHERE n.household_id=p_household_id
         AND n.type='HOUSEHOLD_OWNERSHIP_TRANSFERRED'
         AND n.source_entity_type='HOUSEHOLD'
         AND n.source_entity_id=p_household_id
         AND n.metadata->>'previousOwnerMemberId'=v_actor.id::TEXT
         AND n.metadata->>'newOwnerMemberId'=v_target.id::TEXT
    ) THEN
      RETURN jsonb_build_object('householdId',p_household_id,'ownerMemberId',v_target.id);
    END IF;
  END IF;

  RAISE EXCEPTION 'Not household owner' USING ERRCODE='42501';
END; $$;

REVOKE EXECUTE ON FUNCTION public.fn_transfer_household_owner(UUID,UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_transfer_household_owner(UUID,UUID,UUID) TO service_role;

COMMIT;
