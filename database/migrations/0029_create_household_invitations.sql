BEGIN;

CREATE TABLE public.tb_household_invitations (
  id UUID CONSTRAINT pk_tb_household_invitations PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL,
  inviter_member_id UUID NOT NULL,
  invitee_email_normalized TEXT NOT NULL,
  token_hash TEXT NOT NULL CONSTRAINT uq_tb_household_invitations_token_hash UNIQUE,
  status TEXT NOT NULL CONSTRAINT ck_tb_household_invitations_status CHECK (status IN ('PENDING', 'ACCEPTED')),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_user_id UUID,
  accepted_member_id UUID,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_tb_household_invitations_household
    FOREIGN KEY (household_id) REFERENCES public.tb_households (id) ON DELETE RESTRICT,
  CONSTRAINT fk_tb_household_invitations_inviter
    FOREIGN KEY (inviter_member_id) REFERENCES public.tb_household_members (id) ON DELETE RESTRICT,
  CONSTRAINT fk_tb_household_invitations_accepted_user
    FOREIGN KEY (accepted_user_id) REFERENCES public.tb_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_tb_household_invitations_accepted_member
    FOREIGN KEY (household_id, accepted_member_id)
    REFERENCES public.tb_household_members (household_id, id) ON DELETE RESTRICT
);

CREATE INDEX idx_tb_household_invitations_household_status
  ON public.tb_household_invitations (household_id, status);

CREATE UNIQUE INDEX uq_tb_household_invitations_pending_email
  ON public.tb_household_invitations (household_id, invitee_email_normalized)
  WHERE status = 'PENDING';

ALTER TABLE public.tb_household_invitations ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.fn_create_household_invitation(
  p_household_id UUID,
  p_inviter_member_id UUID,
  p_invitee_email_normalized TEXT,
  p_token_hash TEXT,
  p_expires_at TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_invitation_id UUID;
BEGIN
  IF p_household_id IS NULL OR p_inviter_member_id IS NULL
     OR p_invitee_email_normalized = '' OR p_token_hash = ''
     OR p_expires_at <= now() THEN
    RAISE EXCEPTION 'Invalid invitation input' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.tb_household_members
    WHERE id = p_inviter_member_id AND household_id = p_household_id
  ) THEN
    RAISE EXCEPTION 'Invitation creator is not a household member' USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.tb_household_invitations
   WHERE household_id = p_household_id
     AND invitee_email_normalized = p_invitee_email_normalized
     AND status = 'PENDING'
     AND expires_at <= now();

  INSERT INTO public.tb_household_invitations
    (household_id, inviter_member_id, invitee_email_normalized, token_hash, status, expires_at)
  VALUES
    (p_household_id, p_inviter_member_id, p_invitee_email_normalized, p_token_hash, 'PENDING', p_expires_at)
  ON CONFLICT (household_id, invitee_email_normalized) WHERE status = 'PENDING'
  DO NOTHING
  RETURNING id INTO v_invitation_id;

  IF v_invitation_id IS NULL THEN
    RAISE EXCEPTION 'An active invitation already exists' USING ERRCODE = '23505';
  END IF;

  RETURN jsonb_build_object('status', 'PENDING', 'invitationId', v_invitation_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_accept_household_invitation(
  p_auth_user_id UUID,
  p_email_normalized TEXT,
  p_token_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id UUID;
  v_invitation RECORD;
  v_member_id UUID;
BEGIN
  SELECT id INTO v_user_id FROM public.tb_users WHERE auth_user_id = p_auth_user_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Application user not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_invitation
    FROM public.tb_household_invitations
   WHERE token_hash = p_token_hash
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = 'P0003';
  END IF;

  IF v_invitation.status = 'ACCEPTED' THEN
    IF v_invitation.accepted_user_id = v_user_id THEN
      RETURN jsonb_build_object('status', 'ACCEPTED', 'alreadyAccepted', true,
        'householdId', v_invitation.household_id, 'memberId', v_invitation.accepted_member_id);
    END IF;
    RAISE EXCEPTION 'Invitation is no longer available' USING ERRCODE = 'P0003';
  END IF;

  IF v_invitation.expires_at <= now() THEN
    RAISE EXCEPTION 'Invitation is no longer available' USING ERRCODE = 'P0003';
  END IF;

  IF p_email_normalized <> v_invitation.invitee_email_normalized THEN
    RAISE EXCEPTION 'Invitation is no longer available' USING ERRCODE = '42501';
  END IF;

  SELECT id INTO v_member_id
    FROM public.tb_household_members
   WHERE household_id = v_invitation.household_id AND user_id = v_user_id;
  IF v_member_id IS NULL THEN
    INSERT INTO public.tb_household_members (household_id, user_id, display_name)
    SELECT v_invitation.household_id, id, display_name
      FROM public.tb_users WHERE id = v_user_id
    ON CONFLICT (household_id, user_id) DO NOTHING
    RETURNING id INTO v_member_id;
    IF v_member_id IS NULL THEN
      SELECT id INTO v_member_id FROM public.tb_household_members
       WHERE household_id = v_invitation.household_id AND user_id = v_user_id;
    END IF;
  END IF;

  UPDATE public.tb_household_invitations
     SET status = 'ACCEPTED', accepted_user_id = v_user_id,
         accepted_member_id = v_member_id, accepted_at = now(), updated_at = now()
   WHERE id = v_invitation.id;

  RETURN jsonb_build_object('status', 'ACCEPTED', 'alreadyAccepted', false,
    'householdId', v_invitation.household_id, 'memberId', v_member_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_create_household_invitation(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_create_household_invitation(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ) TO service_role;
REVOKE EXECUTE ON FUNCTION public.fn_accept_household_invitation(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_accept_household_invitation(UUID, TEXT, TEXT) TO service_role;

COMMIT;
