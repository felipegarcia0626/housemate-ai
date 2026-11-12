BEGIN;

DO $auth_fixture$
BEGIN
  IF to_regnamespace('auth') IS NULL THEN
    EXECUTE 'CREATE SCHEMA auth';
  END IF;
  IF to_regclass('auth.users') IS NULL THEN
    EXECUTE 'CREATE TABLE auth.users (
      id UUID PRIMARY KEY,
      email TEXT,
      email_confirmed_at TIMESTAMPTZ
    )';
  ELSE
    ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email TEXT;
    ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_confirmed_at TIMESTAMPTZ;
  END IF;
END;
$auth_fixture$;

INSERT INTO auth.users(id, email, email_confirmed_at)
VALUES
  ('00610000-0060-4000-8000-000000000001', 'legacy-owner-a@example.test', clock_timestamp()),
  ('00610000-0060-4000-8000-000000000003', 'legacy-owner-b@example.test', clock_timestamp()),
  ('00610000-0060-4000-8000-000000000006', 'legacy-owner-c@example.test', clock_timestamp());

INSERT INTO public.tb_users(id, auth_user_id, display_name, external_identifier)
VALUES
  ('00610000-0060-4000-8000-000000000002', '00610000-0060-4000-8000-000000000001', 'Legacy owner A', '19996600101'),
  ('00610000-0060-4000-8000-000000000004', '00610000-0060-4000-8000-000000000003', 'Legacy owner B', '19996600103'),
  ('00610000-0060-4000-8000-000000000005', NULL, 'Legacy without Auth', '19996600105'),
  ('00610000-0060-4000-8000-000000000007', '00610000-0060-4000-8000-000000000006', 'Legacy owner C', '19996600106');

INSERT INTO public.tb_households(id, name)
VALUES ('00610000-0060-4000-8000-000000000101', 'Identity transition household');
INSERT INTO public.tb_household_members(id, household_id, user_id, display_name, role, status)
VALUES
  ('00610000-0060-4000-8000-000000000111', '00610000-0060-4000-8000-000000000101', '00610000-0060-4000-8000-000000000002', 'Legacy owner A', 'OWNER', 'ACTIVE'),
  ('00610000-0060-4000-8000-000000000112', '00610000-0060-4000-8000-000000000101', '00610000-0060-4000-8000-000000000004', 'Legacy owner B', 'MEMBER', 'ACTIVE');
INSERT INTO public.tb_whatsapp_user_contexts(user_id, selected_household_id, selected_member_id)
VALUES
  ('00610000-0060-4000-8000-000000000002', '00610000-0060-4000-8000-000000000101', '00610000-0060-4000-8000-000000000111'),
  ('00610000-0060-4000-8000-000000000004', '00610000-0060-4000-8000-000000000101', '00610000-0060-4000-8000-000000000112');

CREATE TEMP TABLE whatsapp_identity_before AS
SELECT u.id AS user_id, to_jsonb(u) AS user_row, to_jsonb(h) AS household_row,
       to_jsonb(m) AS member_row, to_jsonb(c) AS context_row
FROM public.tb_users AS u
JOIN public.tb_household_members AS m ON m.user_id = u.id
JOIN public.tb_households AS h ON h.id = m.household_id
JOIN public.tb_whatsapp_user_contexts AS c ON c.user_id = u.id
WHERE u.id IN (
  '00610000-0060-4000-8000-000000000002',
  '00610000-0060-4000-8000-000000000004'
);

-- Robustness check, not a concurrent race: controlled privileged fixture DML
-- changes the LEGACY owner after challenge creation and before completion.
SET LOCAL ROLE service_role;
DO $ownership_change_start$
DECLARE v_result JSONB;
BEGIN
  v_result := public.fn_start_whatsapp_link_challenge(
    '00610000-0060-4000-8000-000000000006',
    '00610000-0060-4000-8000-000000000241',
    '19996600106', repeat('5', 64), '00610000-0060-4000-8000-000000000242'
  );
  IF v_result->>'status' IS DISTINCT FROM 'PENDING' THEN
    RAISE EXCEPTION 'Original LEGACY owner could not start the challenge before controlled fixture mutation: %', v_result;
  END IF;
END;
$ownership_change_start$;
RESET ROLE;

-- Release the unique LEGACY identifier, then assign it to a different fixture user.
UPDATE public.tb_users
SET external_identifier = 'external-system:owner-c-fixture'
WHERE id = '00610000-0060-4000-8000-000000000007';
UPDATE public.tb_users
SET external_identifier = '19996600106'
WHERE id = '00610000-0060-4000-8000-000000000004';

SET LOCAL ROLE service_role;
DO $ownership_change_complete$
DECLARE v_result JSONB;
BEGIN
  v_result := public.fn_complete_whatsapp_link_event(
    'legacy-owner-change-finalize', '19996600106', '1234567890', repeat('c', 64),
    '00610000-0060-4000-8000-000000000241', repeat('5', 64)
  );
  IF v_result->>'status' IS DISTINCT FROM 'READY' THEN
    RAISE EXCEPTION 'Completion wrapper did not process the changed-owner fixture: %', v_result;
  END IF;
END;
$ownership_change_complete$;
RESET ROLE;

DO $ownership_change_assertions$
BEGIN
  IF (SELECT receipt.business_result->>'status'
      FROM public.tb_whatsapp_event_receipts AS receipt
      WHERE receipt.external_event_id = 'legacy-owner-change-finalize') IS DISTINCT FROM 'UNAVAILABLE'
     OR (SELECT link_event.result->>'status'
         FROM public.tb_whatsapp_link_events AS link_event
         WHERE link_event.external_event_id = 'legacy-owner-change-finalize') IS DISTINCT FROM 'UNAVAILABLE' THEN
    RAISE EXCEPTION 'Finalization did not persist the changed-owner rejection';
  END IF;
  IF (SELECT challenge.status
      FROM public.tb_whatsapp_link_challenges AS challenge
      WHERE challenge.id = '00610000-0060-4000-8000-000000000241') IS DISTINCT FROM 'PENDING'
     OR EXISTS (
       SELECT 1 FROM public.tb_whatsapp_links AS link
       WHERE link.user_id = '00610000-0060-4000-8000-000000000007'
          OR link.sender = '19996600106'
     )
     OR EXISTS (
       SELECT 1 FROM public.tb_whatsapp_legacy_identity_retirements AS retirement
       WHERE retirement.user_id = '00610000-0060-4000-8000-000000000007'
     ) THEN
    RAISE EXCEPTION 'Changed-owner rejection created a VERIFIED link or partial retirement marker';
  END IF;
END;
$ownership_change_assertions$;

-- Restore both generic identifiers before the independent transition scenarios.
UPDATE public.tb_users
SET external_identifier = '19996600103'
WHERE id = '00610000-0060-4000-8000-000000000004';
UPDATE public.tb_users
SET external_identifier = '19996600106'
WHERE id = '00610000-0060-4000-8000-000000000007';

SET LOCAL ROLE service_role;
DO $transition$
DECLARE
  v_result JSONB;
  v_replay JSONB;
  v_state JSONB;
  v_link UUID;
  v_identity JSONB;
BEGIN
  -- A different Auth account cannot claim a sender owned by A's legacy row.
  v_result := public.fn_start_whatsapp_link_challenge(
    '00610000-0060-4000-8000-000000000003',
    '00610000-0060-4000-8000-000000000201',
    '19996600101', repeat('1', 64), '00610000-0060-4000-8000-000000000202'
  );
  IF v_result->>'status' IS DISTINCT FROM 'UNAVAILABLE' THEN
    RAISE EXCEPTION 'A different Auth account claimed another account''s legacy number: %', v_result;
  END IF;

  -- The exact Auth-mapped owner may prove possession and promote its own P.
  v_result := public.fn_start_whatsapp_link_challenge(
    '00610000-0060-4000-8000-000000000001',
    '00610000-0060-4000-8000-000000000211',
    '19996600101', repeat('2', 64), '00610000-0060-4000-8000-000000000212'
  );
  IF v_result->>'status' IS DISTINCT FROM 'PENDING' THEN
    RAISE EXCEPTION 'The Auth-mapped legacy owner could not start a possession challenge: %', v_result;
  END IF;
  v_result := public.fn_complete_whatsapp_link_event(
    'legacy-promote-own-number', '19996600101', '1234567890', repeat('a', 64),
    '00610000-0060-4000-8000-000000000211', repeat('2', 64)
  );
  IF v_result->>'status' IS DISTINCT FROM 'READY' THEN
    RAISE EXCEPTION 'Owner promotion event did not complete: %', v_result;
  END IF;
  v_replay := public.fn_complete_whatsapp_link_event(
    'legacy-promote-own-number', '19996600101', '1234567890', repeat('a', 64),
    '00610000-0060-4000-8000-000000000211', repeat('2', 64)
  );
  IF v_replay IS DISTINCT FROM v_result THEN
    RAISE EXCEPTION 'Link event redelivery changed the promotion result';
  END IF;
  v_state := public.fn_get_whatsapp_link_state('00610000-0060-4000-8000-000000000001');
  v_link := (v_state->'link'->>'id')::uuid;
  IF v_link IS NULL THEN RAISE EXCEPTION 'Promoted legacy number is not VERIFIED'; END IF;
  v_identity := public.fn_resolve_whatsapp_sender('19996600101');
  IF v_identity->>'status' IS DISTINCT FROM 'RESOLVED'
     OR v_identity->>'origin' IS DISTINCT FROM 'VERIFIED'
     OR (v_identity->>'userId')::uuid IS DISTINCT FROM '00610000-0060-4000-8000-000000000002' THEN
    RAISE EXCEPTION 'Promoted number resolved to the wrong identity: %', v_identity;
  END IF;
  v_result := public.fn_revoke_whatsapp_link('00610000-0060-4000-8000-000000000001', v_link, 1);
  IF v_result->>'status' IS DISTINCT FROM 'REVOKED' THEN
    RAISE EXCEPTION 'Could not revoke the test promotion: %', v_result;
  END IF;
  v_identity := public.fn_resolve_whatsapp_sender('19996600101');
  IF v_identity->>'status' IS DISTINCT FROM 'UNAVAILABLE' THEN
    RAISE EXCEPTION 'Legacy P reappeared after its verified link was revoked: %', v_identity;
  END IF;

  -- Verifying another free number Q retires the account's distinct legacy P.
  v_result := public.fn_start_whatsapp_link_challenge(
    '00610000-0060-4000-8000-000000000003',
    '00610000-0060-4000-8000-000000000221',
    '19996600104', repeat('3', 64), '00610000-0060-4000-8000-000000000222'
  );
  IF v_result->>'status' IS DISTINCT FROM 'PENDING' THEN
    RAISE EXCEPTION 'A free new number could not start verification: %', v_result;
  END IF;
  v_result := public.fn_complete_whatsapp_link_event(
    'legacy-retire-old-p', '19996600104', '1234567890', repeat('b', 64),
    '00610000-0060-4000-8000-000000000221', repeat('3', 64)
  );
  IF v_result->>'status' IS DISTINCT FROM 'READY' THEN
    RAISE EXCEPTION 'New-number verification event did not complete: %', v_result;
  END IF;
  v_replay := public.fn_complete_whatsapp_link_event(
    'legacy-retire-old-p', '19996600104', '1234567890', repeat('b', 64),
    '00610000-0060-4000-8000-000000000221', repeat('3', 64)
  );
  IF v_replay IS DISTINCT FROM v_result THEN
    RAISE EXCEPTION 'Redelivery changed the Q verification result';
  END IF;
  v_identity := public.fn_resolve_whatsapp_sender('19996600104');
  IF v_identity->>'origin' IS DISTINCT FROM 'VERIFIED'
     OR (v_identity->>'userId')::uuid IS DISTINCT FROM '00610000-0060-4000-8000-000000000004' THEN
    RAISE EXCEPTION 'New number Q did not resolve VERIFIED to its owner: %', v_identity;
  END IF;
  v_identity := public.fn_resolve_whatsapp_sender('19996600103');
  IF v_identity->>'status' IS DISTINCT FROM 'UNAVAILABLE' THEN
    RAISE EXCEPTION 'Old legacy P resolved after verifying Q: %', v_identity;
  END IF;
  v_state := public.fn_get_whatsapp_link_state('00610000-0060-4000-8000-000000000003');
  v_link := (v_state->'link'->>'id')::uuid;
  v_result := public.fn_revoke_whatsapp_link('00610000-0060-4000-8000-000000000003', v_link, 1);
  IF v_result->>'status' IS DISTINCT FROM 'REVOKED' THEN
    RAISE EXCEPTION 'Could not revoke Q after verification: %', v_result;
  END IF;
  FOREACH v_identity IN ARRAY ARRAY[
    public.fn_resolve_whatsapp_sender('19996600103'),
    public.fn_resolve_whatsapp_sender('19996600104')
  ] LOOP
    IF v_identity->>'status' IS DISTINCT FROM 'UNAVAILABLE' THEN
      RAISE EXCEPTION 'Legacy P or revoked Q became authorized after revocation: %', v_identity;
    END IF;
  END LOOP;

  -- A legacy-only internal row cannot be adopted without an Auth mapping.
  BEGIN
    PERFORM public.fn_start_whatsapp_link_challenge(
      NULL, '00610000-0060-4000-8000-000000000231', '19996600105', repeat('4', 64),
      '00610000-0060-4000-8000-000000000232'
    );
    RAISE EXCEPTION 'Account without auth_user_id was adopted by phone match';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'WhatsApp linking is unavailable' THEN RAISE; END IF;
  END;
END;
$transition$;
RESET ROLE;

DO $persisted_state$
DECLARE
  v_user_a UUID := '00610000-0060-4000-8000-000000000002';
  v_user_b UUID := '00610000-0060-4000-8000-000000000004';
  v_role TEXT;
  v_user_count INTEGER;
BEGIN
  IF EXISTS (
    SELECT 1 FROM whatsapp_identity_before AS before_row
    LEFT JOIN public.tb_users AS u ON u.id = before_row.user_id
    LEFT JOIN public.tb_household_members AS m ON m.user_id = before_row.user_id
    LEFT JOIN public.tb_households AS h ON h.id = m.household_id
    LEFT JOIN public.tb_whatsapp_user_contexts AS c ON c.user_id = before_row.user_id
    WHERE to_jsonb(u) IS DISTINCT FROM before_row.user_row
       OR to_jsonb(h) IS DISTINCT FROM before_row.household_row
       OR to_jsonb(m) IS DISTINCT FROM before_row.member_row
       OR to_jsonb(c) IS DISTINCT FROM before_row.context_row
  ) OR (SELECT count(*) FROM whatsapp_identity_before) <> 2 THEN
    RAISE EXCEPTION 'Identity transition changed users, homes, memberships, actors or persisted selection';
  END IF;

  IF (SELECT count(*) FROM public.tb_whatsapp_legacy_identity_retirements WHERE user_id IN (v_user_a, v_user_b)) <> 2
     OR EXISTS (
       SELECT 1 FROM public.tb_whatsapp_legacy_identity_retirements AS retirement
       JOIN public.tb_whatsapp_links AS link ON link.user_id = retirement.user_id
       WHERE retirement.user_id IN (v_user_a, v_user_b)
         AND retirement.first_verified_at IS DISTINCT FROM (
           SELECT min(link_history.verified_at)
           FROM public.tb_whatsapp_links AS link_history
           WHERE link_history.user_id = retirement.user_id
         )
     ) THEN
    RAISE EXCEPTION 'Retirement marker was missing or changed during revocation';
  END IF;
  IF (SELECT count(*) FROM public.tb_whatsapp_link_events WHERE external_event_id IN ('legacy-promote-own-number','legacy-retire-old-p')) <> 2
     OR (SELECT count(*) FROM public.tb_whatsapp_event_receipts WHERE external_event_id IN ('legacy-promote-own-number','legacy-retire-old-p')) <> 2
     OR (SELECT count(*) FROM public.tb_whatsapp_link_challenges WHERE id IN (
       '00610000-0060-4000-8000-000000000211','00610000-0060-4000-8000-000000000221'
     ) AND status = 'CONSUMED') <> 2 THEN
    RAISE EXCEPTION 'Link event replay duplicated or failed to consume exactly one challenge';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tb_whatsapp_link_events AS event_row
    WHERE event_row.external_event_id IN ('legacy-promote-own-number','legacy-retire-old-p')
      AND event_row.result->>'status' IS DISTINCT FROM 'LINKED'
  ) THEN
    RAISE EXCEPTION 'Persisted link event did not record the successful transition';
  END IF;
  IF (SELECT count(*) FROM public.tb_whatsapp_links WHERE user_id IN (v_user_a, v_user_b)) <> 2
     OR EXISTS (SELECT 1 FROM public.tb_whatsapp_links WHERE user_id IN (v_user_a, v_user_b) AND status = 'ACTIVE') THEN
    RAISE EXCEPTION 'Promotion/revocation changed the expected link history';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tb_users WHERE id = '00610000-0060-4000-8000-000000000002' AND external_identifier <> '19996600101')
     OR EXISTS (SELECT 1 FROM public.tb_users WHERE id = '00610000-0060-4000-8000-000000000004' AND external_identifier <> '19996600103') THEN
    RAISE EXCEPTION 'Transition modified the generic external_identifier';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tb_whatsapp_links WHERE user_id = '00610000-0060-4000-8000-000000000005')
     OR EXISTS (SELECT 1 FROM public.tb_whatsapp_legacy_identity_retirements WHERE user_id = '00610000-0060-4000-8000-000000000005')
     OR EXISTS (SELECT 1 FROM public.tb_whatsapp_link_challenges WHERE expected_sender = '19996600105') THEN
    RAISE EXCEPTION 'Auth-less legacy account was adopted by the linking flow';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'public.tb_whatsapp_legacy_identity_retirements'::regclass)
     OR pg_catalog.pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class WHERE oid = 'public.tb_whatsapp_legacy_identity_retirements'::regclass)) <> 'postgres' THEN
    RAISE EXCEPTION 'Retirement table ownership or RLS is unsafe';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF has_table_privilege(v_role, 'public.tb_whatsapp_legacy_identity_retirements', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
      RAISE EXCEPTION 'Role % has direct retirement-table privileges', v_role;
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM aclexplode(coalesce(
      (SELECT c.relacl FROM pg_catalog.pg_class AS c WHERE c.oid = 'public.tb_whatsapp_legacy_identity_retirements'::regclass),
      acldefault('r', (SELECT c.relowner FROM pg_catalog.pg_class AS c WHERE c.oid = 'public.tb_whatsapp_legacy_identity_retirements'::regclass))
    )) AS acl
    WHERE acl.grantee = 0 AND acl.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')
  ) THEN
    RAISE EXCEPTION 'PUBLIC has direct retirement-table privileges';
  END IF;
  IF has_function_privilege('service_role', 'public.fn_start_whatsapp_link_challenge(uuid,uuid,text,text,uuid)', 'EXECUTE') IS DISTINCT FROM true
     OR has_function_privilege('service_role', 'public.fn_complete_whatsapp_link_challenge(uuid,text,text,text)', 'EXECUTE') IS DISTINCT FROM true
     OR has_function_privilege('service_role', 'public.fn_resolve_whatsapp_identity_locked(text)', 'EXECUTE') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Linking RPC grants changed unexpectedly';
  END IF;
  SELECT count(*) INTO v_user_count FROM public.tb_users WHERE id IN (v_user_a, v_user_b);
  IF v_user_count <> 2 THEN RAISE EXCEPTION 'Transition changed internal user identity'; END IF;
  IF EXISTS (SELECT 1 FROM public.tb_whatsapp_link_challenges WHERE id = '00610000-0060-4000-8000-000000000201') THEN
    RAISE EXCEPTION 'Foreign-account claim created a challenge';
  END IF;
END;
$persisted_state$;

SELECT 'PASS WhatsApp legacy promotion, permanent retirement, replay, Auth mapping, isolation and ACL' AS result;
ROLLBACK;
