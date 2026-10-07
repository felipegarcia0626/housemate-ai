BEGIN;

ALTER TABLE public.tb_household_members
  ADD COLUMN role TEXT,
  ADD COLUMN status TEXT;

DO $$
DECLARE
  mapping RECORD;
  household_count INTEGER;
  membership_count INTEGER;
BEGIN
  CREATE TEMP TABLE _household_owner_mapping(household_id UUID, member_id UUID) ON COMMIT DROP;
  INSERT INTO _household_owner_mapping VALUES
    ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000021'),
    ('0054e516-6236-4856-88f1-b8c11ee5329f','180d3596-f601-4844-9683-e46b0c21da28'),
    ('158e678a-e3fb-42cf-9b81-404c137e3b49','9f70aaf7-2140-49d4-8bb9-acb3ddde4422'),
    ('560e94bb-5869-4b5c-ba1f-0b1dffbe4756','11c9d7e3-b9ef-4b29-b484-7fbb664b8634'),
    ('013951d0-a5cb-4ad6-8780-4367338fa117','56fe1eba-505f-4ca4-8f43-a7c74ff5eb21'),
    ('ecc7d433-6dde-4bd7-ad07-f23309fc95c8','b95b73cc-7112-495e-a09a-6ceb8cf9f661');
  SELECT count(*) INTO household_count FROM public.tb_households;
  IF household_count <> 6 OR (SELECT count(*) FROM _household_owner_mapping) <> 6 THEN RAISE EXCEPTION 'Unexpected household inventory'; END IF;
  IF EXISTS (SELECT 1 FROM public.tb_households h LEFT JOIN _household_owner_mapping m ON m.household_id=h.id WHERE m.household_id IS NULL)
     OR EXISTS (SELECT 1 FROM _household_owner_mapping m LEFT JOIN public.tb_households h ON h.id=m.household_id WHERE h.id IS NULL) THEN RAISE EXCEPTION 'Incomplete household mapping'; END IF;
  IF EXISTS (SELECT 1 FROM _household_owner_mapping m LEFT JOIN public.tb_household_members x ON x.id=m.member_id AND x.household_id=m.household_id WHERE x.id IS NULL) THEN RAISE EXCEPTION 'Invalid owner membership mapping'; END IF;
  UPDATE public.tb_household_members SET role='MEMBER', status='ACTIVE';
  FOR mapping IN SELECT * FROM _household_owner_mapping LOOP
    UPDATE public.tb_household_members SET role='OWNER', status='ACTIVE' WHERE id=mapping.member_id AND household_id=mapping.household_id;
  END LOOP;
  SELECT count(*) INTO membership_count FROM public.tb_household_members WHERE role IS NULL OR status IS NULL;
  IF membership_count <> 0 THEN RAISE EXCEPTION 'Membership backfill incomplete'; END IF;
END $$;

ALTER TABLE public.tb_household_members ALTER COLUMN role SET NOT NULL, ALTER COLUMN status SET NOT NULL;
ALTER TABLE public.tb_household_members ALTER COLUMN role SET DEFAULT 'MEMBER', ALTER COLUMN status SET DEFAULT 'ACTIVE';
ALTER TABLE public.tb_household_members
  ADD CONSTRAINT ck_tb_household_members_role CHECK (role IN ('OWNER','MEMBER')),
  ADD CONSTRAINT ck_tb_household_members_status CHECK (status IN ('ACTIVE','LEFT','REMOVED'));
CREATE UNIQUE INDEX uq_tb_household_members_active_owner ON public.tb_household_members(household_id) WHERE role='OWNER' AND status='ACTIVE';

CREATE OR REPLACE FUNCTION public.fn_create_household_for_authenticated_user(p_auth_user_id UUID,p_household_name TEXT,p_idempotency_key UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_user_id UUID; v_household_id UUID; v_member_id UUID; v_name TEXT:=btrim(p_household_name); v_existing RECORD;
BEGIN
  IF p_auth_user_id IS NULL OR p_idempotency_key IS NULL OR v_name='' OR length(v_name)>120 THEN RAISE EXCEPTION 'Invalid household input' USING ERRCODE='22023'; END IF;
  SELECT id INTO v_user_id FROM public.tb_users WHERE auth_user_id=p_auth_user_id;
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Application user not found' USING ERRCODE='P0002'; END IF;
  INSERT INTO public.tb_household_creation_idempotency(auth_user_id,idempotency_key,household_id,member_id,household_name) VALUES(p_auth_user_id,p_idempotency_key,gen_random_uuid(),gen_random_uuid(),v_name) ON CONFLICT (auth_user_id,idempotency_key) DO NOTHING;
  SELECT * INTO v_existing FROM public.tb_household_creation_idempotency WHERE auth_user_id=p_auth_user_id AND idempotency_key=p_idempotency_key FOR UPDATE;
  IF v_existing.household_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.tb_households WHERE id=v_existing.household_id) THEN RETURN jsonb_build_object('householdId',v_existing.household_id,'householdName',v_existing.household_name,'memberId',v_existing.member_id,'idempotent',true); END IF;
  INSERT INTO public.tb_households(name) VALUES(v_name) RETURNING id INTO v_household_id;
  INSERT INTO public.tb_household_members(household_id,user_id,display_name,role,status) SELECT v_household_id,id,display_name,'OWNER','ACTIVE' FROM public.tb_users WHERE id=v_user_id RETURNING id INTO v_member_id;
  UPDATE public.tb_household_creation_idempotency SET household_id=v_household_id,member_id=v_member_id,household_name=v_name WHERE auth_user_id=p_auth_user_id AND idempotency_key=p_idempotency_key;
  RETURN jsonb_build_object('householdId',v_household_id,'householdName',v_name,'memberId',v_member_id,'idempotent',false);
END; $$;

CREATE OR REPLACE FUNCTION public.fn_accept_household_invitation(p_auth_user_id UUID,p_email_normalized TEXT,p_token_hash TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_user_id UUID; v_invitation RECORD; v_member_id UUID; v_existing_role TEXT;
BEGIN
  SELECT id INTO v_user_id FROM public.tb_users WHERE auth_user_id=p_auth_user_id; IF v_user_id IS NULL THEN RAISE EXCEPTION 'Application user not found' USING ERRCODE='P0002'; END IF;
  SELECT * INTO v_invitation FROM public.tb_household_invitations WHERE token_hash=p_token_hash FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Invitation not found' USING ERRCODE='P0003'; END IF;
  IF v_invitation.status='ACCEPTED' THEN IF v_invitation.accepted_user_id=v_user_id THEN RETURN jsonb_build_object('status','ACCEPTED','alreadyAccepted',true,'householdId',v_invitation.household_id,'memberId',v_invitation.accepted_member_id); END IF; RAISE EXCEPTION 'Invitation is no longer available' USING ERRCODE='P0003'; END IF;
  IF v_invitation.expires_at<=now() THEN RAISE EXCEPTION 'Invitation is no longer available' USING ERRCODE='P0003'; END IF;
  IF p_email_normalized<>v_invitation.invitee_email_normalized THEN RAISE EXCEPTION 'Invitation is no longer available' USING ERRCODE='42501'; END IF;
  SELECT id, role INTO v_member_id, v_existing_role FROM public.tb_household_members WHERE household_id=v_invitation.household_id AND user_id=v_user_id FOR UPDATE;
  IF v_member_id IS NULL THEN
    INSERT INTO public.tb_household_members(household_id,user_id,display_name,role,status)
    SELECT v_invitation.household_id,id,display_name,'MEMBER','ACTIVE' FROM public.tb_users WHERE id=v_user_id
    ON CONFLICT(household_id,user_id) DO NOTHING RETURNING id INTO v_member_id;
    IF v_member_id IS NULL THEN
      SELECT id, role INTO v_member_id, v_existing_role FROM public.tb_household_members WHERE household_id=v_invitation.household_id AND user_id=v_user_id FOR UPDATE;
    END IF;
  ELSIF v_existing_role <> 'OWNER' THEN
    UPDATE public.tb_household_members SET role='MEMBER',status='ACTIVE' WHERE id=v_member_id;
  END IF;
  IF v_member_id IS NULL THEN SELECT id INTO v_member_id FROM public.tb_household_members WHERE household_id=v_invitation.household_id AND user_id=v_user_id; END IF;
  UPDATE public.tb_household_invitations SET status='ACCEPTED',accepted_user_id=v_user_id,accepted_member_id=v_member_id,accepted_at=now(),updated_at=now() WHERE id=v_invitation.id;
  RETURN jsonb_build_object('status','ACCEPTED','alreadyAccepted',false,'householdId',v_invitation.household_id,'memberId',v_member_id);
END; $$;

CREATE OR REPLACE FUNCTION public.fn_transfer_household_owner(p_auth_user_id UUID,p_household_id UUID,p_target_member_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_user UUID; v_actor UUID; v_target RECORD;
BEGIN
  SELECT id INTO v_user FROM public.tb_users WHERE auth_user_id=p_auth_user_id; IF v_user IS NULL THEN RAISE EXCEPTION 'Application user not found' USING ERRCODE='P0002'; END IF;
  PERFORM 1 FROM public.tb_households WHERE id=p_household_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Household not found' USING ERRCODE='P0003'; END IF;
  SELECT m.id INTO v_actor FROM public.tb_household_members m WHERE m.household_id=p_household_id AND m.user_id=v_user AND m.role='OWNER' AND m.status='ACTIVE' FOR UPDATE; IF v_actor IS NULL THEN RAISE EXCEPTION 'Not household owner' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_target FROM public.tb_household_members m WHERE m.id=p_target_member_id AND m.household_id=p_household_id FOR UPDATE; IF NOT FOUND OR v_target.status<>'ACTIVE' OR v_target.id=v_actor THEN RAISE EXCEPTION 'Invalid transfer target' USING ERRCODE='P0004'; END IF;
  UPDATE public.tb_household_members SET role='MEMBER' WHERE id=v_actor; UPDATE public.tb_household_members SET role='OWNER' WHERE id=v_target.id;
  RETURN jsonb_build_object('householdId',p_household_id,'ownerMemberId',v_target.id);
END; $$;

CREATE OR REPLACE FUNCTION public.fn_remove_household_member(p_auth_user_id UUID,p_household_id UUID,p_target_member_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_user UUID; v_actor UUID; v_target RECORD;
BEGIN
 SELECT id INTO v_user FROM public.tb_users WHERE auth_user_id=p_auth_user_id; IF v_user IS NULL THEN RAISE EXCEPTION 'Application user not found' USING ERRCODE='P0002'; END IF;
 PERFORM 1 FROM public.tb_households WHERE id=p_household_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Household not found' USING ERRCODE='P0003'; END IF;
 SELECT id INTO v_actor FROM public.tb_household_members WHERE household_id=p_household_id AND user_id=v_user AND role='OWNER' AND status='ACTIVE' FOR UPDATE; IF v_actor IS NULL THEN RAISE EXCEPTION 'Not household owner' USING ERRCODE='42501'; END IF;
 SELECT * INTO v_target FROM public.tb_household_members WHERE id=p_target_member_id AND household_id=p_household_id FOR UPDATE; IF NOT FOUND OR v_target.role='OWNER' OR v_target.status<>'ACTIVE' THEN RAISE EXCEPTION 'Invalid removal target' USING ERRCODE='P0004'; END IF;
 UPDATE public.tb_household_members SET status='REMOVED' WHERE id=v_target.id; RETURN jsonb_build_object('memberId',v_target.id,'status','REMOVED');
END; $$;

CREATE OR REPLACE FUNCTION public.fn_leave_household(p_auth_user_id UUID,p_household_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_user UUID; v_member RECORD;
BEGIN
 SELECT id INTO v_user FROM public.tb_users WHERE auth_user_id=p_auth_user_id; IF v_user IS NULL THEN RAISE EXCEPTION 'Application user not found' USING ERRCODE='P0002'; END IF;
 PERFORM 1 FROM public.tb_households WHERE id=p_household_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Household not found' USING ERRCODE='P0003'; END IF;
 SELECT * INTO v_member FROM public.tb_household_members WHERE household_id=p_household_id AND user_id=v_user AND status='ACTIVE' FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Membership not found' USING ERRCODE='P0003'; END IF;
 IF v_member.role='OWNER' THEN RAISE EXCEPTION 'Owner must transfer ownership first' USING ERRCODE='P0004'; END IF;
 UPDATE public.tb_household_members SET status='LEFT' WHERE id=v_member.id; RETURN jsonb_build_object('memberId',v_member.id,'status','LEFT');
END; $$;

REVOKE EXECUTE ON FUNCTION public.fn_transfer_household_owner(UUID,UUID,UUID), public.fn_remove_household_member(UUID,UUID,UUID), public.fn_leave_household(UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_transfer_household_owner(UUID,UUID,UUID), public.fn_remove_household_member(UUID,UUID,UUID), public.fn_leave_household(UUID,UUID) TO service_role;
COMMIT;
