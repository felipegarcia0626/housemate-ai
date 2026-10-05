-- HouseMate AI - administrative fixture for authenticated Direct Split E2E
-- Run manually in the Supabase SQL Editor only after replacing both UUIDs.
-- This script does not create or modify auth.users.

BEGIN;

DO $$
DECLARE
  -- Replace these NULL values with the UUIDs created in Supabase Auth.
  v_auth_user_a UUID := '44a5ffe5-3eda-4638-889f-97b52ca37299';
  v_auth_user_b UUID := 'e080b07e-d744-44c9-a84b-9762dcc6a568';
  v_user_a UUID;
  v_user_b UUID;
  v_household_id UUID;
  v_member_a UUID;
  v_member_b UUID;
  v_household_count INTEGER;
  v_membership_count INTEGER;
  v_auth_exists BOOLEAN;
BEGIN
  IF v_auth_user_a IS NULL OR v_auth_user_b IS NULL THEN
    RAISE EXCEPTION
      'Replace v_auth_user_a and v_auth_user_b with the two Supabase Auth UUIDs before running this fixture.';
  END IF;

  IF v_auth_user_a = v_auth_user_b THEN
    RAISE EXCEPTION 'The two E2E Auth UUIDs must be different.';
  END IF;

  SELECT EXISTS (SELECT 1 FROM auth.users WHERE id = v_auth_user_a)
    INTO v_auth_exists;
  IF NOT v_auth_exists THEN
    RAISE EXCEPTION 'E2E Auth user A does not exist in auth.users: %', v_auth_user_a;
  END IF;

  SELECT EXISTS (SELECT 1 FROM auth.users WHERE id = v_auth_user_b)
    INTO v_auth_exists;
  IF NOT v_auth_exists THEN
    RAISE EXCEPTION 'E2E Auth user B does not exist in auth.users: %', v_auth_user_b;
  END IF;

  SELECT count(*)::INTEGER
    INTO v_household_count
    FROM public.tb_households
   WHERE name = 'HouseMate E2E Test Household';

  IF v_household_count > 1 THEN
    RAISE EXCEPTION
      'More than one household has the technical fixture name; refusing ambiguous reuse.';
  ELSIF v_household_count = 1 THEN
    SELECT id INTO v_household_id
      FROM public.tb_households
     WHERE name = 'HouseMate E2E Test Household';
  ELSE
    INSERT INTO public.tb_households (name)
    VALUES ('HouseMate E2E Test Household')
    RETURNING id INTO v_household_id;
  END IF;

  SELECT id INTO v_user_a
    FROM public.tb_users
   WHERE auth_user_id = v_auth_user_a;
  IF v_user_a IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.tb_users
       WHERE external_identifier = 'supabase:' || v_auth_user_a::TEXT
    ) THEN
      RAISE EXCEPTION 'User A external_identifier is already linked to another application user.';
    END IF;
    INSERT INTO public.tb_users (display_name, external_identifier, auth_user_id)
    VALUES ('E2E Test User', 'supabase:' || v_auth_user_a::TEXT, v_auth_user_a)
    RETURNING id INTO v_user_a;
  END IF;

  SELECT id INTO v_user_b
    FROM public.tb_users
   WHERE auth_user_id = v_auth_user_b;
  IF v_user_b IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.tb_users
       WHERE external_identifier = 'supabase:' || v_auth_user_b::TEXT
    ) THEN
      RAISE EXCEPTION 'User B external_identifier is already linked to another application user.';
    END IF;
    INSERT INTO public.tb_users (display_name, external_identifier, auth_user_id)
    VALUES ('E2E Split Member', 'supabase:' || v_auth_user_b::TEXT, v_auth_user_b)
    RETURNING id INTO v_user_b;
  END IF;

  SELECT id INTO v_member_a
    FROM public.tb_household_members
   WHERE household_id = v_household_id AND user_id = v_user_a;
  IF v_member_a IS NULL THEN
    INSERT INTO public.tb_household_members (household_id, user_id, display_name)
    VALUES (v_household_id, v_user_a, 'E2E Test User')
    RETURNING id INTO v_member_a;
  END IF;

  SELECT id INTO v_member_b
    FROM public.tb_household_members
   WHERE household_id = v_household_id AND user_id = v_user_b;
  IF v_member_b IS NULL THEN
    INSERT INTO public.tb_household_members (household_id, user_id, display_name)
    VALUES (v_household_id, v_user_b, 'E2E Split Member')
    RETURNING id INTO v_member_b;
  END IF;

  SELECT count(*)::INTEGER
    INTO v_membership_count
    FROM public.tb_household_members
   WHERE household_id = v_household_id;
  IF v_membership_count <> 2 THEN
    RAISE EXCEPTION
      'The technical household must contain exactly two memberships; found %.',
      v_membership_count;
  END IF;
END;
$$;

COMMIT;

-- Verification: exactly two rows are expected.
SELECT
  h.id AS household_id,
  h.name AS household_name,
  u.auth_user_id,
  u.display_name AS user_name,
  hm.id AS household_member_id
FROM public.tb_households AS h
JOIN public.tb_household_members AS hm ON hm.household_id = h.id
JOIN public.tb_users AS u ON u.id = hm.user_id
WHERE h.name = 'HouseMate E2E Test Household'
ORDER BY u.display_name;

-- Verification: fixture memberships and Auth links.
SELECT
  hm.id AS household_member_id,
  hm.user_id,
  hm.display_name,
  u.auth_user_id,
  u.external_identifier
FROM public.tb_household_members AS hm
JOIN public.tb_users AS u ON u.id = hm.user_id
JOIN public.tb_households AS h ON h.id = hm.household_id
WHERE h.name = 'HouseMate E2E Test Household'
ORDER BY hm.display_name;

-- Verification: memberships for the two technical application users across households.
-- Existing memberships outside this fixture are reported, never modified.
SELECT
  u.auth_user_id,
  h.id AS household_id,
  h.name AS household_name,
  hm.id AS household_member_id
FROM public.tb_users AS u
JOIN public.tb_household_members AS hm ON hm.user_id = u.id
JOIN public.tb_households AS h ON h.id = hm.household_id
WHERE u.external_identifier LIKE 'supabase:%'
  AND u.display_name IN ('E2E Test User', 'E2E Split Member')
ORDER BY u.display_name, h.name;

-- ============================================================
-- OPTIONAL CLEANUP
-- DO NOT RUN AUTOMATICALLY
-- ============================================================
-- Replace the placeholders with the actual fixture household/member/user UUIDs.
-- Do not delete auth.users from SQL. Remove the Auth accounts from the Supabase
-- Dashboard only after the application records have been removed.
--
-- BEGIN;
-- DELETE FROM public.tb_pending_proposals WHERE household_id = '<HOUSEHOLD_UUID>'::uuid;
-- DELETE FROM public.tb_agent_category_drafts WHERE household_id = '<HOUSEHOLD_UUID>'::uuid;
-- DELETE FROM public.tb_expense_distributions
--  WHERE expense_id IN (SELECT id FROM public.tb_expenses WHERE household_id = '<HOUSEHOLD_UUID>'::uuid);
-- DELETE FROM public.tb_expense_items
--  WHERE expense_id IN (SELECT id FROM public.tb_expenses WHERE household_id = '<HOUSEHOLD_UUID>'::uuid);
-- DELETE FROM public.tb_expenses WHERE household_id = '<HOUSEHOLD_UUID>'::uuid;
-- DELETE FROM public.tb_household_members WHERE household_id = '<HOUSEHOLD_UUID>'::uuid;
-- DELETE FROM public.tb_households WHERE id = '<HOUSEHOLD_UUID>'::uuid;
-- DELETE FROM public.tb_users WHERE id IN ('<USER_A_UUID>'::uuid, '<USER_B_UUID>'::uuid);
-- COMMIT;
