BEGIN;

DO $$
DECLARE
  v_auth_a UUID := '00000000-0000-4000-8000-000000009901';
  v_auth_b UUID := '00000000-0000-4000-8000-000000009902';
  v_user_a UUID;
  v_user_b UUID;
  v_household UUID := '00000000-0000-4000-8000-000000009903';
  v_member_a UUID;
  v_invitation JSONB;
  v_accepted JSONB;
BEGIN
  INSERT INTO public.tb_users (id, display_name, external_identifier, auth_user_id)
  VALUES
    ('00000000-0000-4000-8000-000000009904', 'Invitation Sender', 'invitation-sender', v_auth_a),
    ('00000000-0000-4000-8000-000000009905', 'Invitation Recipient', 'invitation-recipient', v_auth_b);
  SELECT id INTO v_user_a FROM public.tb_users WHERE auth_user_id = v_auth_a;
  SELECT id INTO v_user_b FROM public.tb_users WHERE auth_user_id = v_auth_b;
  INSERT INTO public.tb_households (id, name) VALUES (v_household, 'Invitation Household');
  INSERT INTO public.tb_household_members (id, household_id, user_id, display_name)
  VALUES ('00000000-0000-4000-8000-000000009906', v_household, v_user_a, 'Invitation Sender')
  RETURNING id INTO v_member_a;

  v_invitation := public.fn_create_household_invitation(
    v_household, v_member_a, 'recipient@example.com', 'hash-invitation-1', now() + interval '7 days'
  );
  IF v_invitation->>'status' <> 'PENDING' THEN RAISE EXCEPTION 'invitation was not pending'; END IF;
  IF (SELECT count(*) FROM public.tb_household_invitations WHERE token_hash = 'hash-invitation-1') <> 1 THEN
    RAISE EXCEPTION 'invitation token was not stored as a hash';
  END IF;

  BEGIN
    PERFORM public.fn_create_household_invitation(v_household, v_member_a, 'recipient@example.com', 'hash-invitation-2', now() + interval '7 days');
    RAISE EXCEPTION 'duplicate pending invitation should fail';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  v_accepted := public.fn_accept_household_invitation(v_auth_b, 'recipient@example.com', 'hash-invitation-1');
  IF v_accepted->>'status' <> 'ACCEPTED' OR (v_accepted->>'alreadyAccepted')::boolean THEN RAISE EXCEPTION 'invitation was not accepted'; END IF;
  IF (SELECT count(*) FROM public.tb_household_members WHERE household_id = v_household AND user_id = v_user_b) <> 1 THEN
    RAISE EXCEPTION 'membership was not created';
  END IF;
  v_accepted := public.fn_accept_household_invitation(v_auth_b, 'recipient@example.com', 'hash-invitation-1');
  IF NOT (v_accepted->>'alreadyAccepted')::boolean THEN RAISE EXCEPTION 'acceptance was not idempotent'; END IF;

  PERFORM public.fn_create_household_invitation(v_household, v_member_a, 'expired@example.com', 'hash-invitation-expired', now() + interval '7 days');
  UPDATE public.tb_household_invitations SET expires_at = now() - interval '1 minute' WHERE token_hash = 'hash-invitation-expired';
  BEGIN
    PERFORM public.fn_accept_household_invitation(v_auth_b, 'expired@example.com', 'hash-invitation-expired');
    RAISE EXCEPTION 'expired invitation should fail';
  EXCEPTION WHEN SQLSTATE 'P0003' THEN NULL;
  END;
  v_invitation := public.fn_create_household_invitation(
    v_household, v_member_a, 'expired@example.com', 'hash-invitation-expired-retry', now() + interval '7 days'
  );
  IF v_invitation->>'status' <> 'PENDING' THEN RAISE EXCEPTION 'expired invitation did not become retryable'; END IF;

  PERFORM public.fn_create_household_invitation(v_household, v_member_a, 'other@example.com', 'hash-invitation-mismatch', now() + interval '7 days');
  BEGIN
    PERFORM public.fn_accept_household_invitation(v_auth_b, 'wrong@example.com', 'hash-invitation-mismatch');
    RAISE EXCEPTION 'email mismatch should fail';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;

ROLLBACK;
