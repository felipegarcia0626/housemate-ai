BEGIN;

ALTER TABLE public.tb_household_invitations
  ADD COLUMN creator_user_id UUID REFERENCES public.tb_users(id) ON DELETE RESTRICT,
  ADD COLUMN idempotency_key UUID,
  ADD CONSTRAINT ck_tb_invitations_correlation_pair CHECK (
    (creator_user_id IS NULL AND idempotency_key IS NULL) OR
    (creator_user_id IS NOT NULL AND idempotency_key IS NOT NULL)
  );
CREATE UNIQUE INDEX uq_tb_invitations_actor_key
  ON public.tb_household_invitations(creator_user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Preserve the historical RPC signature, but never lazily delete correlated rows.
CREATE OR REPLACE FUNCTION public.fn_create_household_invitation(
  p_household_id UUID, p_inviter_member_id UUID, p_invitee_email_normalized TEXT,
  p_token_hash TEXT, p_expires_at TIMESTAMPTZ
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_invitation_id UUID; v_recipient_user_id UUID;
  v_household_name TEXT; v_inviter_name TEXT;
BEGIN
  IF p_household_id IS NULL OR p_inviter_member_id IS NULL
     OR p_invitee_email_normalized IS NULL OR p_invitee_email_normalized = ''
     OR p_token_hash IS NULL OR p_token_hash = '' OR p_expires_at IS NULL OR p_expires_at <= now() THEN
    RAISE EXCEPTION 'Invalid invitation input' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tb_household_members
    WHERE id = p_inviter_member_id AND household_id = p_household_id) THEN
    RAISE EXCEPTION 'Invitation creator is not a household member' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.tb_household_invitations
   WHERE household_id = p_household_id AND invitee_email_normalized = p_invitee_email_normalized
     AND status = 'PENDING' AND expires_at <= now() AND idempotency_key IS NULL;
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

CREATE FUNCTION public.fn_create_household_invitation(
  p_auth_user_id UUID, p_household_id UUID, p_invitee_email_normalized TEXT,
  p_token_hash TEXT, p_expires_at TIMESTAMPTZ, p_idempotency_key UUID
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor_user_id UUID; v_member_id UUID; v_existing RECORD;
  v_invitation_id UUID; v_recipient_user_id UUID; v_email TEXT;
  v_household_name TEXT; v_inviter_name TEXT; v_result JSONB;
BEGIN
  v_email := lower(btrim(p_invitee_email_normalized));
  IF p_auth_user_id IS NULL OR p_household_id IS NULL OR v_email IS NULL OR v_email = '' THEN
    RAISE EXCEPTION 'Invalid invitation input' USING ERRCODE = '22023';
  END IF;
  -- Serialize an actor's operations across households, including equal-key retries.
  SELECT id INTO v_actor_user_id FROM public.tb_users
   WHERE auth_user_id = p_auth_user_id FOR UPDATE;
  IF v_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'Application user unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT id INTO v_member_id FROM public.tb_household_members
   WHERE user_id = v_actor_user_id AND household_id = p_household_id AND status = 'ACTIVE'
   FOR UPDATE;
  IF v_member_id IS NULL THEN
    RAISE EXCEPTION 'Invitation access unavailable' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.tb_household_invitations
     WHERE creator_user_id = v_actor_user_id AND idempotency_key = p_idempotency_key FOR UPDATE;
    IF FOUND THEN
      IF v_existing.household_id <> p_household_id OR v_existing.invitee_email_normalized <> v_email THEN
        RAISE EXCEPTION 'Idempotency key conflict' USING ERRCODE = 'P0004';
      END IF;
      RETURN jsonb_build_object('outcome', 'RECOVERED', 'status', v_existing.status, 'invitationId', v_existing.id);
    END IF;
    -- Read-only recovery probe; absence never reserves a key or writes a resource.
    IF p_token_hash IS NULL AND p_expires_at IS NULL THEN
      RETURN jsonb_build_object('outcome', 'NEEDS_CREATION');
    END IF;
  ELSE
    v_result := public.fn_create_household_invitation(p_household_id, v_member_id, v_email, p_token_hash, p_expires_at);
    RETURN v_result || jsonb_build_object('outcome', 'CREATED');
  END IF;
  IF p_token_hash IS NULL OR p_token_hash = '' OR p_expires_at IS NULL OR p_expires_at <= now() THEN
    RAISE EXCEPTION 'Invalid invitation input' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.tb_household_invitations
   WHERE household_id = p_household_id AND invitee_email_normalized = v_email
     AND status = 'PENDING' AND expires_at <= now() AND idempotency_key IS NULL;
  INSERT INTO public.tb_household_invitations
    (household_id, inviter_member_id, invitee_email_normalized, token_hash, status, expires_at, creator_user_id, idempotency_key)
  VALUES (p_household_id, v_member_id, v_email, p_token_hash, 'PENDING', p_expires_at, v_actor_user_id, p_idempotency_key)
  RETURNING id INTO v_invitation_id;
  IF to_regclass('auth.users') IS NOT NULL THEN
    EXECUTE 'SELECT u.id FROM public.tb_users u JOIN auth.users a ON a.id = u.auth_user_id WHERE lower(a.email) = $1'
      INTO v_recipient_user_id USING v_email;
  END IF;
  SELECT h.name, m.display_name INTO v_household_name, v_inviter_name
    FROM public.tb_households h JOIN public.tb_household_members m ON m.id = v_member_id
   WHERE h.id = p_household_id;
  IF v_recipient_user_id IS NOT NULL THEN
    INSERT INTO public.tb_notifications
      (recipient_user_id, household_id, type, title, body, metadata, source_entity_type, source_entity_id, deduplication_key)
    VALUES (v_recipient_user_id, p_household_id, 'HOUSEHOLD_INVITATION_RECEIVED', 'Nueva invitación',
      coalesce(v_inviter_name, 'Un miembro') || ' te invitó a ' || coalesce(v_household_name, 'un household'),
      jsonb_build_object('invitationId', v_invitation_id), 'HOUSEHOLD_INVITATION', v_invitation_id,
      'invitation:' || v_invitation_id || ':received');
  END IF;
  RETURN jsonb_build_object('outcome', 'CREATED', 'status', 'PENDING', 'invitationId', v_invitation_id);
END; $$;

REVOKE EXECUTE ON FUNCTION public.fn_create_household_invitation(UUID,UUID,TEXT,TEXT,TIMESTAMPTZ,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_create_household_invitation(UUID,UUID,TEXT,TEXT,TIMESTAMPTZ,UUID) TO service_role;

COMMIT;
