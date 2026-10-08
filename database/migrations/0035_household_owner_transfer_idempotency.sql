BEGIN;

CREATE TABLE public.tb_household_owner_transfer_operations (
  id UUID CONSTRAINT pk_tb_household_owner_transfer_operations PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL,
  actor_member_id UUID NOT NULL,
  target_member_id UUID NOT NULL,
  idempotency_key UUID NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_tb_owner_transfer_ops_household FOREIGN KEY (household_id) REFERENCES public.tb_households(id) ON DELETE RESTRICT,
  CONSTRAINT fk_tb_owner_transfer_ops_actor FOREIGN KEY (household_id, actor_member_id) REFERENCES public.tb_household_members(household_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_tb_owner_transfer_ops_target FOREIGN KEY (household_id, target_member_id) REFERENCES public.tb_household_members(household_id, id) ON DELETE RESTRICT,
  CONSTRAINT uq_tb_owner_transfer_ops_household_key UNIQUE (household_id, idempotency_key)
);

CREATE OR REPLACE FUNCTION public.fn_transfer_household_owner(p_auth_user_id UUID,p_household_id UUID,p_target_member_id UUID,p_idempotency_key UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_user UUID; v_actor RECORD; v_target RECORD; v_existing RECORD; v_result JSONB; v_name TEXT; v_key TEXT;
BEGIN
  SELECT id INTO v_user FROM public.tb_users WHERE auth_user_id=p_auth_user_id;
  IF v_user IS NULL THEN RAISE EXCEPTION 'Application user not found' USING ERRCODE='P0002'; END IF;
  PERFORM 1 FROM public.tb_households WHERE id=p_household_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Household not found' USING ERRCODE='P0003'; END IF;
  SELECT m.id,m.user_id,m.role,m.status INTO v_actor
    FROM public.tb_household_members m
   WHERE m.household_id=p_household_id AND m.user_id=v_user
   FOR UPDATE;
  IF v_actor.id IS NULL THEN RAISE EXCEPTION 'Not household member' USING ERRCODE='P0003'; END IF;
  SELECT * INTO v_existing FROM public.tb_household_owner_transfer_operations WHERE household_id=p_household_id AND idempotency_key=p_idempotency_key FOR UPDATE;
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.actor_member_id<>v_actor.id OR v_existing.target_member_id<>p_target_member_id THEN
      RAISE EXCEPTION 'Idempotency key conflict' USING ERRCODE='P0004';
    END IF;
    RETURN v_existing.result;
  END IF;
  SELECT m.id,m.user_id,m.role,m.status INTO v_target FROM public.tb_household_members m WHERE m.id=p_target_member_id AND m.household_id=p_household_id FOR UPDATE;
  IF v_actor.role<>'OWNER' OR v_actor.status<>'ACTIVE' THEN RAISE EXCEPTION 'Not household owner' USING ERRCODE='42501'; END IF;
  IF v_target.id IS NULL OR v_target.role<>'MEMBER' OR v_target.status<>'ACTIVE' OR v_target.id=v_actor.id THEN RAISE EXCEPTION 'Invalid transfer target' USING ERRCODE='P0004'; END IF;
  SELECT name INTO v_name FROM public.tb_households WHERE id=p_household_id;
  UPDATE public.tb_household_members SET role='MEMBER' WHERE id=v_actor.id;
  UPDATE public.tb_household_members SET role='OWNER' WHERE id=v_target.id;
  v_result:=jsonb_build_object('householdId',p_household_id,'ownerMemberId',v_target.id);
  v_key:='ownership:'||p_household_id||':'||p_idempotency_key;
  INSERT INTO public.tb_notifications(recipient_user_id,household_id,type,title,body,metadata,source_entity_type,source_entity_id,deduplication_key)
  VALUES(v_actor.user_id,p_household_id,'HOUSEHOLD_OWNERSHIP_TRANSFERRED','Ownership transferido','Ya no eres owner de '||coalesce(v_name,'este household'),jsonb_build_object('previousOwnerMemberId',v_actor.id,'newOwnerMemberId',v_target.id),'HOUSEHOLD',p_household_id,v_key);
  INSERT INTO public.tb_notifications(recipient_user_id,household_id,type,title,body,metadata,source_entity_type,source_entity_id,deduplication_key)
  VALUES(v_target.user_id,p_household_id,'HOUSEHOLD_OWNERSHIP_TRANSFERRED','Ownership transferido','Ahora eres owner de '||coalesce(v_name,'este household'),jsonb_build_object('previousOwnerMemberId',v_actor.id,'newOwnerMemberId',v_target.id),'HOUSEHOLD',p_household_id,v_key);
  INSERT INTO public.tb_household_owner_transfer_operations(household_id,actor_member_id,target_member_id,idempotency_key,result) VALUES(p_household_id,v_actor.id,v_target.id,p_idempotency_key,v_result);
  RETURN v_result;
END; $$;

CREATE OR REPLACE FUNCTION public.fn_transfer_household_owner(p_auth_user_id UUID,p_household_id UUID,p_target_member_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  RETURN public.fn_transfer_household_owner(p_auth_user_id,p_household_id,p_target_member_id,gen_random_uuid());
END; $$;

ALTER TABLE public.tb_household_owner_transfer_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tb_household_owner_transfer_operations FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_transfer_household_owner(UUID,UUID,UUID,UUID), public.fn_transfer_household_owner(UUID,UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_transfer_household_owner(UUID,UUID,UUID,UUID), public.fn_transfer_household_owner(UUID,UUID,UUID) TO service_role;

COMMIT;
