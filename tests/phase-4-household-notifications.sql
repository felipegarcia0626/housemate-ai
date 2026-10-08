BEGIN;

DO $$
DECLARE
  v_household UUID := '00000000-0000-4000-8000-000000009930';
  v_owner_user UUID := '00000000-0000-4000-8000-000000009931';
  v_member_user UUID := '00000000-0000-4000-8000-000000009932';
  v_left_user UUID := '00000000-0000-4000-8000-000000009933';
  v_new_owner_user UUID := '00000000-0000-4000-8000-000000009934';
  v_owner_member UUID := '00000000-0000-4000-8000-000000009935';
  v_member_member UUID := '00000000-0000-4000-8000-000000009936';
  v_left_member UUID := '00000000-0000-4000-8000-000000009937';
  v_new_owner_member UUID := '00000000-0000-4000-8000-000000009938';
  v_invitation JSONB;
  v_result JSONB;
BEGIN
  INSERT INTO public.tb_users (id, display_name, external_identifier, auth_user_id)
  VALUES
    (v_owner_user, 'Notification Owner', 'notification-owner', '00000000-0000-4000-8000-000000009941'),
    (v_member_user, 'Notification Member', 'notification-member', '00000000-0000-4000-8000-000000009942'),
    (v_left_user, 'Notification Leaver', 'notification-leaver', '00000000-0000-4000-8000-000000009943'),
    (v_new_owner_user, 'Notification New Owner', 'notification-new-owner', '00000000-0000-4000-8000-000000009944');
  INSERT INTO public.tb_households (id, name) VALUES (v_household, 'Notification Household');
  INSERT INTO public.tb_household_members (id, household_id, user_id, display_name, role, status)
  VALUES
    (v_owner_member, v_household, v_owner_user, 'Notification Owner', 'OWNER', 'ACTIVE'),
    (v_member_member, v_household, v_member_user, 'Notification Member', 'MEMBER', 'ACTIVE'),
    (v_left_member, v_household, v_left_user, 'Notification Leaver', 'MEMBER', 'ACTIVE'),
    (v_new_owner_member, v_household, v_new_owner_user, 'Notification New Owner', 'MEMBER', 'ACTIVE');

  v_invitation := public.fn_create_household_invitation(
    v_household, v_owner_member, 'unknown-notification@example.com', 'notification-token-1', now() + interval '7 days'
  );
  IF (SELECT count(*) FROM public.tb_household_invitations WHERE id = (v_invitation->>'invitationId')::UUID) <> 1
     OR (SELECT count(*) FROM public.tb_notifications WHERE household_id = v_household) <> 0 THEN
    RAISE EXCEPTION 'unknown invitee must create invitation without notification';
  END IF;

  v_invitation := public.fn_create_household_invitation(
    v_household, v_owner_member, 'member-notification@example.com', 'notification-token-2', now() + interval '7 days'
  );
  v_result := public.fn_accept_household_invitation(
    '00000000-0000-4000-8000-000000009942', 'member-notification@example.com', 'notification-token-2'
  );
  IF v_result->>'status' <> 'ACCEPTED'
     OR (SELECT count(*) FROM public.tb_notifications WHERE type = 'HOUSEHOLD_INVITATION_ACCEPTED' AND recipient_user_id = v_owner_user) <> 1 THEN
    RAISE EXCEPTION 'invitation acceptance notification failed';
  END IF;

  INSERT INTO public.tb_notifications
    (recipient_user_id, household_id, type, title, body, metadata, source_entity_type, source_entity_id, deduplication_key)
  VALUES (v_member_user, v_household, 'HOUSEHOLD_MEMBER_REMOVED', 'Rollback sentinel', 'Rollback sentinel', '{}'::jsonb,
    'HOUSEHOLD_MEMBER', v_member_member, 'membership:' || v_member_member || ':removed');
  BEGIN
    PERFORM public.fn_remove_household_member(
      '00000000-0000-4000-8000-000000009941', v_household, v_member_member
    );
    RAISE EXCEPTION 'notification conflict should roll back member removal';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  IF (SELECT status FROM public.tb_household_members WHERE id = v_member_member) <> 'ACTIVE' THEN
    RAISE EXCEPTION 'member removal was not rolled back after notification failure';
  END IF;
  DELETE FROM public.tb_notifications
   WHERE recipient_user_id = v_member_user
     AND deduplication_key = 'membership:' || v_member_member || ':removed';

  PERFORM public.fn_remove_household_member(
    '00000000-0000-4000-8000-000000009941', v_household, v_member_member
  );
  IF (SELECT status FROM public.tb_household_members WHERE id = v_member_member) <> 'REMOVED'
     OR (SELECT count(*) FROM public.tb_notifications WHERE type = 'HOUSEHOLD_MEMBER_REMOVED' AND recipient_user_id = v_member_user) <> 1 THEN
    RAISE EXCEPTION 'member removal notification failed';
  END IF;

  PERFORM public.fn_leave_household(
    '00000000-0000-4000-8000-000000009943', v_household
  );
  IF (SELECT status FROM public.tb_household_members WHERE id = v_left_member) <> 'LEFT'
     OR (SELECT count(*) FROM public.tb_notifications WHERE type = 'HOUSEHOLD_MEMBER_LEFT' AND recipient_user_id = v_owner_user) <> 1 THEN
    RAISE EXCEPTION 'member leave notification failed';
  END IF;

  PERFORM public.fn_transfer_household_owner(
    '00000000-0000-4000-8000-000000009941', v_household, v_new_owner_member
  );
  IF (SELECT role FROM public.tb_household_members WHERE id = v_owner_member) <> 'MEMBER'
     OR (SELECT role FROM public.tb_household_members WHERE id = v_new_owner_member) <> 'OWNER'
     OR (SELECT count(*) FROM public.tb_notifications WHERE type = 'HOUSEHOLD_OWNERSHIP_TRANSFERRED' AND recipient_user_id IN (v_owner_user, v_new_owner_user)) <> 2 THEN
    RAISE EXCEPTION 'ownership transfer notifications failed';
  END IF;

  IF (SELECT count(*) FROM public.tb_notifications WHERE deduplication_key LIKE 'ownership:%') <> 2 THEN
    RAISE EXCEPTION 'ownership transfer deduplication keys are incorrect';
  END IF;
  RAISE NOTICE 'PASS household mutations and notifications share the RPC transaction';
END;
$$;

ROLLBACK;
