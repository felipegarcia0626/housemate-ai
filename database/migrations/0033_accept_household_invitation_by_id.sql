BEGIN;

CREATE OR REPLACE FUNCTION public.fn_accept_household_invitation_internal(
  p_auth_user_id UUID, p_email_normalized TEXT, p_token_hash TEXT DEFAULT NULL, p_invitation_id UUID DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user_id UUID; v_invitation RECORD; v_member_id UUID; v_existing_role TEXT;
  v_inviter_user_id UUID; v_inviter_name TEXT; v_acceptor_name TEXT; v_household_name TEXT;
BEGIN
  SELECT id, display_name INTO v_user_id, v_acceptor_name FROM public.tb_users WHERE auth_user_id = p_auth_user_id;
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Application user not found' USING ERRCODE = 'P0002'; END IF;
  IF p_invitation_id IS NOT NULL THEN
    SELECT * INTO v_invitation FROM public.tb_household_invitations WHERE id = p_invitation_id FOR UPDATE;
  ELSE
    SELECT * INTO v_invitation FROM public.tb_household_invitations WHERE token_hash = p_token_hash FOR UPDATE;
  END IF;
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
    FROM public.tb_household_members m JOIN public.tb_users u ON u.id = m.user_id WHERE m.id = v_invitation.inviter_member_id;
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

CREATE OR REPLACE FUNCTION public.fn_accept_household_invitation(p_auth_user_id UUID, p_email_normalized TEXT, p_token_hash TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN public.fn_accept_household_invitation_internal(p_auth_user_id, p_email_normalized, p_token_hash, NULL);
END; $$;

CREATE OR REPLACE FUNCTION public.fn_accept_household_invitation_by_id(p_auth_user_id UUID, p_invitation_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_email TEXT;
BEGIN
  SELECT lower(a.email) INTO v_email FROM auth.users a JOIN public.tb_users u ON u.auth_user_id = a.id WHERE a.id = p_auth_user_id;
  IF v_email IS NULL THEN RAISE EXCEPTION 'Application user not found' USING ERRCODE = 'P0002'; END IF;
  RETURN public.fn_accept_household_invitation_internal(p_auth_user_id, v_email, NULL, p_invitation_id);
END; $$;

REVOKE EXECUTE ON FUNCTION public.fn_accept_household_invitation_internal(UUID,TEXT,TEXT,UUID), public.fn_accept_household_invitation_by_id(UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_accept_household_invitation_internal(UUID,TEXT,TEXT,UUID), public.fn_accept_household_invitation_by_id(UUID,UUID) TO service_role;

COMMIT;
