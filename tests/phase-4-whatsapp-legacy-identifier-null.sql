BEGIN;

-- The disposable SQL runner has no Supabase-managed Auth schema. Create the
-- minimal transactional fixture needed by the existing linking RPCs.
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
  END IF;
END;
$auth_fixture$;

INSERT INTO auth.users(id, email, email_confirmed_at)
VALUES (
  '00500000-0000-4000-8000-000000000001',
  'verified-link-target@example.test',
  clock_timestamp()
);

INSERT INTO public.tb_users(id, auth_user_id, display_name, external_identifier)
VALUES (
  '00500000-0000-4000-8000-000000000002',
  '00500000-0000-4000-8000-000000000001',
  'Verified link target',
  'supabase:00500000-0000-4000-8000-000000000001'
);

-- Keep representative household and financial references to the seeded MVP
-- account while testing the change to its legacy identifier.
INSERT INTO public.tb_expenses(
  id, household_id, created_by, paid_by, merchant, total_amount,
  expense_date, source
)
VALUES (
  '00500000-0000-4000-8000-000000000101',
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000021',
  '00000000-0000-4000-8000-000000000021',
  'Nullable identifier test expense', 1, current_date, 'WHATSAPP'
);

INSERT INTO public.tb_expense_distributions(
  id, expense_id, household_member_id, amount, percentage
)
VALUES (
  '00500000-0000-4000-8000-000000000102',
  '00500000-0000-4000-8000-000000000101',
  '00000000-0000-4000-8000-000000000021',
  1, 100
);

INSERT INTO public.tb_incomes(
  id, household_id, created_by, member_id, amount, income_date, description
)
VALUES (
  '00500000-0000-4000-8000-000000000103',
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000021',
  '00000000-0000-4000-8000-000000000021',
  1, current_date, 'Nullable identifier test income'
);

DO $legacy_identifier_null$
DECLARE
  v_mvp UUID := '00000000-0000-4000-8000-000000000011';
  v_mvp_member UUID := '00000000-0000-4000-8000-000000000021';
  v_sender TEXT := '19995550001';
  v_auth UUID := '00500000-0000-4000-8000-000000000001';
  v_target UUID := '00500000-0000-4000-8000-000000000002';
  v_challenge UUID := '00500000-0000-4000-8000-000000000201';
  v_idempotency UUID := '00500000-0000-4000-8000-000000000202';
  v_before_user JSONB;
  v_before_members JSONB;
  v_before_expenses JSONB;
  v_before_distributions JSONB;
  v_before_incomes JSONB;
  v_after_user JSONB;
  v_after_members JSONB;
  v_after_expenses JSONB;
  v_after_distributions JSONB;
  v_after_incomes JSONB;
  v_result JSONB;
  v_identity JSONB;
  v_constraint TEXT;
  v_not_null BOOLEAN;
BEGIN
  SELECT a.attnotnull INTO v_not_null
  FROM pg_catalog.pg_attribute a
  WHERE a.attrelid = 'public.tb_users'::regclass
    AND a.attname = 'external_identifier'
    AND NOT a.attisdropped;
  IF v_not_null IS DISTINCT FROM false THEN
    RAISE EXCEPTION '0050 did not make external_identifier nullable';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'public.tb_users'::regclass
      AND c.conname = 'uq_tb_users_external_identifier'
      AND c.contype = 'u'
  ) THEN
    RAISE EXCEPTION 'The external_identifier UNIQUE constraint was removed';
  END IF;

  SELECT to_jsonb(u) INTO v_before_user
  FROM public.tb_users u
  WHERE u.id = v_mvp AND u.external_identifier = 'seed-user-felipe';
  IF v_before_user IS NULL THEN
    RAISE EXCEPTION 'Expected seeded MVP identity is missing';
  END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.id), '[]'::jsonb)
    INTO v_before_members
  FROM public.tb_household_members m
  WHERE m.user_id = v_mvp;
  IF NOT EXISTS (
    SELECT 1 FROM public.tb_household_members m
    WHERE m.id = v_mvp_member AND m.user_id = v_mvp
  ) THEN
    RAISE EXCEPTION 'Expected MVP household membership is missing';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.id), '[]'::jsonb)
    INTO v_before_expenses
  FROM public.tb_expenses e
  WHERE e.created_by = v_mvp_member OR e.paid_by = v_mvp_member;
  SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.id), '[]'::jsonb)
    INTO v_before_distributions
  FROM public.tb_expense_distributions d
  WHERE d.household_member_id = v_mvp_member;
  SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.id), '[]'::jsonb)
    INTO v_before_incomes
  FROM public.tb_incomes i
  WHERE i.created_by = v_mvp_member OR i.member_id = v_mvp_member;

  INSERT INTO public.tb_users(display_name, external_identifier)
  VALUES ('Non-null uniqueness fixture', 'nullable-identifier-duplicate-test');
  BEGIN
    INSERT INTO public.tb_users(display_name, external_identifier)
    VALUES ('Duplicate non-null fixture', 'nullable-identifier-duplicate-test');
    RAISE EXCEPTION 'Duplicate non-null external_identifier was accepted';
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint IS DISTINCT FROM 'uq_tb_users_external_identifier' THEN
      RAISE EXCEPTION 'Duplicate was rejected by an unexpected constraint: %', v_constraint;
    END IF;
  END;

  -- Existing non-null resolution remains legacy and 0043 refuses promotion.
  UPDATE public.tb_users SET external_identifier = v_sender WHERE id = v_mvp;
  SELECT public.fn_resolve_whatsapp_sender(v_sender) INTO v_identity;
  IF v_identity->>'status' IS DISTINCT FROM 'RESOLVED'
     OR v_identity->>'origin' IS DISTINCT FROM 'LEGACY'
     OR (v_identity->>'userId')::uuid IS DISTINCT FROM v_mvp THEN
    RAISE EXCEPTION 'Non-null legacy sender no longer resolves to its existing owner';
  END IF;
  v_result := public.fn_start_whatsapp_link_challenge(
    v_auth, v_challenge, v_sender, repeat('a', 64), v_idempotency
  );
  IF v_result->>'status' IS DISTINCT FROM 'UNAVAILABLE'
     OR EXISTS (
       SELECT 1 FROM public.tb_whatsapp_link_challenges c
       WHERE c.id = v_challenge OR c.user_id = v_target
     ) THEN
    RAISE EXCEPTION '0043 did not refuse the existing legacy sender';
  END IF;

  -- The compatibility change only removes the lookup value from this row.
  UPDATE public.tb_users SET external_identifier = NULL WHERE id = v_mvp;
  IF NOT EXISTS (
    SELECT 1 FROM public.tb_users
    WHERE id = v_mvp AND external_identifier IS NULL
  ) THEN
    RAISE EXCEPTION 'MVP legacy identifier was not cleared in the test fixture';
  END IF;
  INSERT INTO public.tb_users(id, display_name, external_identifier)
  VALUES
    ('00500000-0000-4000-8000-000000000005', 'Null identifier fixture one', NULL),
    ('00500000-0000-4000-8000-000000000006', 'Null identifier fixture two', NULL);
  IF (SELECT count(*) FROM public.tb_users WHERE external_identifier IS NULL) < 3 THEN
    RAISE EXCEPTION 'Multiple NULL external_identifier values were not accepted';
  END IF;
  SELECT public.fn_resolve_whatsapp_sender(v_sender) INTO v_identity;
  IF v_identity->>'status' IS DISTINCT FROM 'UNAVAILABLE' THEN
    RAISE EXCEPTION 'A removed legacy identifier still resolves';
  END IF;

  SELECT to_jsonb(u) INTO v_after_user FROM public.tb_users u WHERE u.id = v_mvp;
  SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.id), '[]'::jsonb)
    INTO v_after_members
  FROM public.tb_household_members m WHERE m.user_id = v_mvp;
  SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.id), '[]'::jsonb)
    INTO v_after_expenses
  FROM public.tb_expenses e
  WHERE e.created_by = v_mvp_member OR e.paid_by = v_mvp_member;
  SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.id), '[]'::jsonb)
    INTO v_after_distributions
  FROM public.tb_expense_distributions d
  WHERE d.household_member_id = v_mvp_member;
  SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY i.id), '[]'::jsonb)
    INTO v_after_incomes
  FROM public.tb_incomes i
  WHERE i.created_by = v_mvp_member OR i.member_id = v_mvp_member;

  IF (v_after_user - 'external_identifier')
       IS DISTINCT FROM (v_before_user - 'external_identifier')
     OR (v_after_members IS DISTINCT FROM v_before_members)
     OR (v_after_expenses IS DISTINCT FROM v_before_expenses)
     OR (v_after_distributions IS DISTINCT FROM v_before_distributions)
     OR (v_after_incomes IS DISTINCT FROM v_before_incomes) THEN
    RAISE EXCEPTION 'Removing the legacy identifier changed MVP identity or relationships';
  END IF;
END;
$legacy_identifier_null$;

-- The webhook's PostgREST client uses service_role. Exercise the same idempotent
-- retry through that role, not only through the runner's postgres connection.
SET LOCAL ROLE service_role;
DO $service_role_redelivery$
DECLARE
  v_auth UUID := '00500000-0000-4000-8000-000000000001';
  v_target UUID := '00500000-0000-4000-8000-000000000002';
  v_sender TEXT := '19995550001';
  v_challenge UUID := '00500000-0000-4000-8000-000000000201';
  v_idempotency UUID := '00500000-0000-4000-8000-000000000202';
  v_event TEXT := 'nullable-identifier-redelivery';
  v_result JSONB;
  v_replay JSONB;
  v_identity JSONB;
BEGIN
  v_result := public.fn_start_whatsapp_link_challenge(
    v_auth, v_challenge, v_sender, repeat('a', 64), v_idempotency
  );
  IF v_result->>'status' IS DISTINCT FROM 'PENDING' THEN
    RAISE EXCEPTION 'service_role could not start a challenge after legacy identifier removal';
  END IF;

  v_replay := public.fn_start_whatsapp_link_challenge(
    v_auth, v_challenge, v_sender, repeat('a', 64), v_idempotency
  );
  IF v_replay IS DISTINCT FROM v_result THEN
    RAISE EXCEPTION 'service_role challenge retry changed the original result';
  END IF;

  v_result := public.fn_complete_whatsapp_link_event(
    v_event, v_sender, '1234567890', repeat('b', 64), v_challenge, repeat('a', 64)
  );
  IF v_result->>'status' IS DISTINCT FROM 'READY' THEN
    RAISE EXCEPTION 'service_role could not complete the verified link event';
  END IF;

  v_replay := public.fn_complete_whatsapp_link_event(
    v_event, v_sender, '1234567890', repeat('b', 64), v_challenge, repeat('a', 64)
  );
  IF v_replay IS DISTINCT FROM v_result THEN
    RAISE EXCEPTION 'service_role event redelivery changed the persisted result';
  END IF;

  v_replay := public.fn_start_whatsapp_link_challenge(
    v_auth, v_challenge, v_sender, repeat('a', 64), v_idempotency
  );
  IF v_replay->>'status' IS DISTINCT FROM 'CONSUMED' THEN
    RAISE EXCEPTION 'service_role retry did not return the persisted consumed challenge';
  END IF;

  v_identity := public.fn_resolve_whatsapp_sender(v_sender);
  IF v_identity->>'status' IS DISTINCT FROM 'RESOLVED'
     OR v_identity->>'origin' IS DISTINCT FROM 'VERIFIED'
     OR (v_identity->>'userId')::uuid IS DISTINCT FROM v_target THEN
    RAISE EXCEPTION 'service_role resolved the verified sender incorrectly';
  END IF;
END;
$service_role_redelivery$;
RESET ROLE;

DO $redelivery_state$
BEGIN
  IF (SELECT count(*) FROM public.tb_whatsapp_links
      WHERE sender = '19995550001' AND status = 'ACTIVE'
        AND user_id = '00500000-0000-4000-8000-000000000002') <> 1
     OR (SELECT count(*) FROM public.tb_whatsapp_link_events
         WHERE external_event_id = 'nullable-identifier-redelivery') <> 1
     OR (SELECT count(*) FROM public.tb_whatsapp_event_receipts
         WHERE external_event_id = 'nullable-identifier-redelivery') <> 1
     OR (SELECT count(*) FROM public.tb_whatsapp_link_challenges
         WHERE id = '00500000-0000-4000-8000-000000000201'
           AND status = 'CONSUMED') <> 1 THEN
    RAISE EXCEPTION 'service_role redelivery duplicated or re-consumed the link';
  END IF;
END;
$redelivery_state$;

SELECT 'PASS nullable legacy identifier, preserved UNIQUE behavior, 0043 refusal, verified linking and replay' AS result;
ROLLBACK;
