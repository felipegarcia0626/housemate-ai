BEGIN;

CREATE OR REPLACE FUNCTION public.fn_create_household_invitation(
  p_household_id UUID, p_inviter_member_id UUID, p_invitee_email_normalized TEXT,
  p_token_hash TEXT, p_expires_at TIMESTAMPTZ
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_invitation_id UUID;
  v_recipient_user_id UUID;
  v_household_name TEXT;
  v_inviter_name TEXT;
BEGIN
  IF p_household_id IS NULL OR p_inviter_member_id IS NULL
     OR p_invitee_email_normalized = '' OR p_token_hash = ''
     OR p_expires_at <= now() THEN
    RAISE EXCEPTION 'Invalid invitation input' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tb_household_members
    WHERE id = p_inviter_member_id AND household_id = p_household_id) THEN
    RAISE EXCEPTION 'Invitation creator is not a household member' USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.tb_household_invitations
   WHERE household_id = p_household_id AND invitee_email_normalized = p_invitee_email_normalized
     AND status = 'PENDING' AND expires_at <= now();
  INSERT INTO public.tb_household_invitations
    (household_id, inviter_member_id, invitee_email_normalized, token_hash, status, expires_at)
  VALUES (p_household_id, p_inviter_member_id, p_invitee_email_normalized, p_token_hash, 'PENDING', p_expires_at)
  ON CONFLICT (household_id, invitee_email_normalized) WHERE status = 'PENDING'
  DO NOTHING RETURNING id INTO v_invitation_id;
  IF v_invitation_id IS NULL THEN
    RAISE EXCEPTION 'An active invitation already exists' USING ERRCODE = '23505';
  END IF;

  IF to_regclass('auth.users') IS NOT NULL THEN
    EXECUTE 'SELECT u.id FROM public.tb_users u JOIN auth.users a ON a.id = u.auth_user_id WHERE lower(a.email) = $1'
      INTO v_recipient_user_id USING p_invitee_email_normalized;
  END IF;
  SELECT h.name, m.display_name INTO v_household_name, v_inviter_name
    FROM public.tb_households h JOIN public.tb_household_members m ON m.id = p_inviter_member_id
   WHERE h.id = p_household_id;
  IF v_recipient_user_id IS NOT NULL THEN
    INSERT INTO public.tb_notifications
      (recipient_user_id, household_id, type, title, body, metadata, source_entity_type, source_entity_id, deduplication_key)
    VALUES (v_recipient_user_id, p_household_id, 'HOUSEHOLD_INVITATION_RECEIVED', 'Nueva invitación',
      coalesce(v_inviter_name, 'Un miembro') || ' te invitó a ' || coalesce(v_household_name, 'un household'),
      jsonb_build_object('invitationId', v_invitation_id), 'HOUSEHOLD_INVITATION', v_invitation_id,
      'invitation:' || v_invitation_id || ':received');
  END IF;
  RETURN jsonb_build_object('status', 'PENDING', 'invitationId', v_invitation_id);
END; $$;

CREATE OR REPLACE FUNCTION public.fn_accept_household_invitation(
  p_auth_user_id UUID, p_email_normalized TEXT, p_token_hash TEXT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user_id UUID; v_invitation RECORD; v_member_id UUID; v_existing_role TEXT;
  v_inviter_user_id UUID; v_inviter_name TEXT; v_acceptor_name TEXT; v_household_name TEXT;
BEGIN
  SELECT id, display_name INTO v_user_id, v_acceptor_name FROM public.tb_users WHERE auth_user_id = p_auth_user_id;
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Application user not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO v_invitation FROM public.tb_household_invitations WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invitation not found' USING ERRCODE = 'P0003'; END IF;
  IF v_invitation.status = 'ACCEPTED' THEN
    IF v_invitation.accepted_user_id = v_user_id THEN
      RETURN jsonb_build_object('status','ACCEPTED','alreadyAccepted',true,'householdId',v_invitation.household_id,'memberId',v_invitation.accepted_member_id);
    END IF;
    RAISE EXCEPTION 'Invitation is no longer available' USING ERRCODE = 'P0003';
  END IF;
  IF v_invitation.expires_at <= now() THEN RAISE EXCEPTION 'Invitation is no longer available' USING ERRCODE = 'P0003'; END IF;
  IF p_email_normalized <> v_invitation.invitee_email_normalized THEN RAISE EXCEPTION 'Invitation is no longer available' USING ERRCODE = '42501'; END IF;
  SELECT m.user_id, u.display_name INTO v_inviter_user_id, v_inviter_name
    FROM public.tb_household_members m JOIN public.tb_users u ON u.id = m.user_id
   WHERE m.id = v_invitation.inviter_member_id;
  SELECT name INTO v_household_name FROM public.tb_households WHERE id = v_invitation.household_id;
  SELECT id, role INTO v_member_id, v_existing_role FROM public.tb_household_members
   WHERE household_id = v_invitation.household_id AND user_id = v_user_id FOR UPDATE;
  IF v_member_id IS NULL THEN
    INSERT INTO public.tb_household_members(household_id,user_id,display_name,role,status)
    SELECT v_invitation.household_id,id,display_name,'MEMBER','ACTIVE' FROM public.tb_users WHERE id=v_user_id
    ON CONFLICT(household_id,user_id) DO NOTHING RETURNING id INTO v_member_id;
    IF v_member_id IS NULL THEN
      SELECT id, role INTO v_member_id, v_existing_role FROM public.tb_household_members
       WHERE household_id=v_invitation.household_id AND user_id=v_user_id FOR UPDATE;
    END IF;
  ELSIF v_existing_role <> 'OWNER' THEN
    UPDATE public.tb_household_members SET role='MEMBER',status='ACTIVE' WHERE id=v_member_id;
  END IF;
  IF v_member_id IS NULL THEN SELECT id INTO v_member_id FROM public.tb_household_members WHERE household_id=v_invitation.household_id AND user_id=v_user_id; END IF;
  UPDATE public.tb_household_invitations SET status='ACCEPTED',accepted_user_id=v_user_id,accepted_member_id=v_member_id,accepted_at=now(),updated_at=now() WHERE id=v_invitation.id;
  INSERT INTO public.tb_notifications
    (recipient_user_id, household_id, type, title, body, metadata, source_entity_type, source_entity_id, deduplication_key)
  VALUES (v_inviter_user_id, v_invitation.household_id, 'HOUSEHOLD_INVITATION_ACCEPTED', 'Invitación aceptada',
    coalesce(v_acceptor_name, 'Un usuario') || ' aceptó tu invitación a ' || coalesce(v_household_name, 'un household'),
    jsonb_build_object('invitationId', v_invitation.id, 'acceptedMemberId', v_member_id), 'HOUSEHOLD_INVITATION', v_invitation.id,
    'invitation:' || v_invitation.id || ':accepted');
  RETURN jsonb_build_object('status','ACCEPTED','alreadyAccepted',false,'householdId',v_invitation.household_id,'memberId',v_member_id);
END; $$;

CREATE OR REPLACE FUNCTION public.fn_remove_household_member(p_auth_user_id UUID,p_household_id UUID,p_target_member_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_user UUID; v_actor UUID; v_target RECORD; v_household_name TEXT;
BEGIN
 SELECT id INTO v_user FROM public.tb_users WHERE auth_user_id=p_auth_user_id; IF v_user IS NULL THEN RAISE EXCEPTION 'Application user not found' USING ERRCODE='P0002'; END IF;
 PERFORM 1 FROM public.tb_households WHERE id=p_household_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Household not found' USING ERRCODE='P0003'; END IF;
 SELECT id INTO v_actor FROM public.tb_household_members WHERE household_id=p_household_id AND user_id=v_user AND role='OWNER' AND status='ACTIVE' FOR UPDATE; IF v_actor IS NULL THEN RAISE EXCEPTION 'Not household owner' USING ERRCODE='42501'; END IF;
 SELECT * INTO v_target FROM public.tb_household_members WHERE id=p_target_member_id AND household_id=p_household_id FOR UPDATE; IF NOT FOUND OR v_target.role='OWNER' OR v_target.status<>'ACTIVE' THEN RAISE EXCEPTION 'Invalid removal target' USING ERRCODE='P0004'; END IF;
 SELECT name INTO v_household_name FROM public.tb_households WHERE id=p_household_id;
 UPDATE public.tb_household_members SET status='REMOVED' WHERE id=v_target.id;
 INSERT INTO public.tb_notifications(recipient_user_id,household_id,type,title,body,metadata,source_entity_type,source_entity_id,deduplication_key)
 VALUES(v_target.user_id,p_household_id,'HOUSEHOLD_MEMBER_REMOVED','Fuiste removido','Ya no formas parte de '||coalesce(v_household_name,'este household'),jsonb_build_object('removedMemberId',v_target.id),'HOUSEHOLD_MEMBER',v_target.id,'membership:'||v_target.id||':removed');
 RETURN jsonb_build_object('memberId',v_target.id,'status','REMOVED');
END; $$;

CREATE OR REPLACE FUNCTION public.fn_leave_household(p_auth_user_id UUID,p_household_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_user UUID; v_member RECORD; v_owner_user UUID; v_actor_name TEXT; v_household_name TEXT;
BEGIN
 SELECT id, display_name INTO v_user, v_actor_name FROM public.tb_users WHERE auth_user_id=p_auth_user_id; IF v_user IS NULL THEN RAISE EXCEPTION 'Application user not found' USING ERRCODE='P0002'; END IF;
 PERFORM 1 FROM public.tb_households WHERE id=p_household_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Household not found' USING ERRCODE='P0003'; END IF;
 SELECT * INTO v_member FROM public.tb_household_members WHERE household_id=p_household_id AND user_id=v_user AND status='ACTIVE' FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Membership not found' USING ERRCODE='P0003'; END IF;
 IF v_member.role='OWNER' THEN RAISE EXCEPTION 'Owner must transfer ownership first' USING ERRCODE='P0004'; END IF;
 SELECT m.user_id INTO v_owner_user FROM public.tb_household_members m WHERE m.household_id=p_household_id AND m.role='OWNER' AND m.status='ACTIVE' FOR UPDATE;
 IF v_owner_user IS NULL THEN RAISE EXCEPTION 'Household owner not found' USING ERRCODE='P0004'; END IF;
 SELECT name INTO v_household_name FROM public.tb_households WHERE id=p_household_id;
 UPDATE public.tb_household_members SET status='LEFT' WHERE id=v_member.id;
 INSERT INTO public.tb_notifications(recipient_user_id,household_id,type,title,body,metadata,source_entity_type,source_entity_id,deduplication_key)
 VALUES(v_owner_user,p_household_id,'HOUSEHOLD_MEMBER_LEFT','Un miembro salió',coalesce(v_actor_name,'Un miembro')||' salió de '||coalesce(v_household_name,'este household'),jsonb_build_object('leftMemberId',v_member.id),'HOUSEHOLD_MEMBER',v_member.id,'membership:'||v_member.id||':left');
 RETURN jsonb_build_object('memberId',v_member.id,'status','LEFT');
END; $$;

CREATE OR REPLACE FUNCTION public.fn_transfer_household_owner(p_auth_user_id UUID,p_household_id UUID,p_target_member_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_user UUID; v_actor UUID; v_target RECORD; v_previous_owner_user UUID; v_new_owner_user UUID; v_previous_name TEXT; v_target_name TEXT; v_household_name TEXT; v_key TEXT;
BEGIN
 SELECT id INTO v_user FROM public.tb_users WHERE auth_user_id=p_auth_user_id; IF v_user IS NULL THEN RAISE EXCEPTION 'Application user not found' USING ERRCODE='P0002'; END IF;
 PERFORM 1 FROM public.tb_households WHERE id=p_household_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Household not found' USING ERRCODE='P0003'; END IF;
 SELECT m.id,m.user_id,u.display_name INTO v_actor,v_previous_owner_user,v_previous_name FROM public.tb_household_members m JOIN public.tb_users u ON u.id=m.user_id WHERE m.household_id=p_household_id AND m.user_id=v_user AND m.role='OWNER' AND m.status='ACTIVE' FOR UPDATE; IF v_actor IS NULL THEN RAISE EXCEPTION 'Not household owner' USING ERRCODE='42501'; END IF;
 SELECT m.*,u.display_name INTO v_target FROM public.tb_household_members m JOIN public.tb_users u ON u.id=m.user_id WHERE m.id=p_target_member_id AND m.household_id=p_household_id FOR UPDATE; IF NOT FOUND OR v_target.status<>'ACTIVE' OR v_target.id=v_actor THEN RAISE EXCEPTION 'Invalid transfer target' USING ERRCODE='P0004'; END IF;
 v_new_owner_user := v_target.user_id; v_target_name := v_target.display_name;
 SELECT name INTO v_household_name FROM public.tb_households WHERE id=p_household_id;
 UPDATE public.tb_household_members SET role='MEMBER' WHERE id=v_actor; UPDATE public.tb_household_members SET role='OWNER' WHERE id=v_target.id;
 v_key := 'ownership:'||p_household_id||':'||v_actor||':'||v_target.id;
 INSERT INTO public.tb_notifications(recipient_user_id,household_id,type,title,body,metadata,source_entity_type,source_entity_id,deduplication_key)
 VALUES(v_previous_owner_user,p_household_id,'HOUSEHOLD_OWNERSHIP_TRANSFERRED','Ownership transferido','Ya no eres owner de '||coalesce(v_household_name,'este household'),jsonb_build_object('previousOwnerMemberId',v_actor,'newOwnerMemberId',v_target.id),'HOUSEHOLD',p_household_id,v_key);
 INSERT INTO public.tb_notifications(recipient_user_id,household_id,type,title,body,metadata,source_entity_type,source_entity_id,deduplication_key)
 VALUES(v_new_owner_user,p_household_id,'HOUSEHOLD_OWNERSHIP_TRANSFERRED','Ownership transferido','Ahora eres owner de '||coalesce(v_household_name,'este household'),jsonb_build_object('previousOwnerMemberId',v_actor,'newOwnerMemberId',v_target.id),'HOUSEHOLD',p_household_id,v_key);
 RETURN jsonb_build_object('householdId',p_household_id,'ownerMemberId',v_target.id);
END; $$;

REVOKE EXECUTE ON FUNCTION public.fn_create_household_invitation(UUID,UUID,TEXT,TEXT,TIMESTAMPTZ), public.fn_accept_household_invitation(UUID,TEXT,TEXT), public.fn_transfer_household_owner(UUID,UUID,UUID), public.fn_remove_household_member(UUID,UUID,UUID), public.fn_leave_household(UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_create_household_invitation(UUID,UUID,TEXT,TEXT,TIMESTAMPTZ), public.fn_accept_household_invitation(UUID,TEXT,TEXT), public.fn_transfer_household_owner(UUID,UUID,UUID), public.fn_remove_household_member(UUID,UUID,UUID), public.fn_leave_household(UUID,UUID) TO service_role;

COMMIT;
