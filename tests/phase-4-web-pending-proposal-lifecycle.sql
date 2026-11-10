BEGIN;

-- Claims and SET ROLE below exercise the SQL authorization boundary only; they
-- do not represent a signed JWT transported through Next.js and PostgREST.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY,
  email text,
  email_confirmed_at timestamptz
);
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.role', true), '')
$$;
GRANT USAGE ON SCHEMA auth TO authenticated, anon, service_role;

DO $fixtures$
DECLARE
  household_id CONSTANT uuid := '55000000-0055-4000-8000-000000000010';
  other_household_id CONSTANT uuid := '55000000-0055-4000-8000-000000000011';
  actor_user_id CONSTANT uuid := '55000000-0055-4000-8000-000000000021';
  other_user_id CONSTANT uuid := '55000000-0055-4000-8000-000000000022';
  no_member_user_id CONSTANT uuid := '55000000-0055-4000-8000-000000000023';
  unconfirmed_user_id CONSTANT uuid := '55000000-0055-4000-8000-000000000024';
  actor_auth_id CONSTANT uuid := '55000000-0055-4000-8000-000000000001';
  other_auth_id CONSTANT uuid := '55000000-0055-4000-8000-000000000002';
  no_member_auth_id CONSTANT uuid := '55000000-0055-4000-8000-000000000003';
  unconfirmed_auth_id CONSTANT uuid := '55000000-0055-4000-8000-000000000004';
  actor_member_id CONSTANT uuid := '55000000-0055-4000-8000-000000000031';
  other_member_id CONSTANT uuid := '55000000-0055-4000-8000-000000000032';
  unconfirmed_member_id CONSTANT uuid := '55000000-0055-4000-8000-000000000033';
  expense_macro_id CONSTANT uuid := '55000000-0055-4000-8000-000000000041';
  expense_category_id CONSTANT uuid := '55000000-0055-4000-8000-000000000042';
  income_macro_id CONSTANT uuid := '55000000-0055-4000-8000-000000000043';
  income_category_id CONSTANT uuid := '55000000-0055-4000-8000-000000000044';
BEGIN
  INSERT INTO public.tb_households(id,name) VALUES
    (household_id,'0055 Web proposals'),
    (other_household_id,'0055 other household');
  INSERT INTO public.tb_users(id,display_name,external_identifier,auth_user_id) VALUES
    (actor_user_id,'0055 actor','0055-actor',actor_auth_id),
    (other_user_id,'0055 other','0055-other',other_auth_id),
    (no_member_user_id,'0055 no member','0055-no-member',no_member_auth_id),
    (unconfirmed_user_id,'0055 unconfirmed','0055-unconfirmed',unconfirmed_auth_id);
  INSERT INTO public.tb_household_members(
    id,household_id,user_id,display_name,role,status
  ) VALUES
    (actor_member_id,household_id,actor_user_id,'0055 actor','OWNER','ACTIVE'),
    (other_member_id,household_id,other_user_id,'0055 other','MEMBER','ACTIVE'),
    (unconfirmed_member_id,household_id,unconfirmed_user_id,'0055 unconfirmed','MEMBER','ACTIVE');
  INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
    (actor_auth_id,'0055-actor@example.test',clock_timestamp()),
    (other_auth_id,'0055-other@example.test',clock_timestamp()),
    (no_member_auth_id,'0055-no-member@example.test',clock_timestamp()),
    (unconfirmed_auth_id,'0055-unconfirmed@example.test',NULL);
  INSERT INTO public.tb_categories(id,name,movement_type,level,parent_id,is_active) VALUES
    (expense_macro_id,'0055 expense macro','EXPENSE','MACRO',NULL,true),
    (expense_category_id,'0055 expense micro','EXPENSE','MICRO',expense_macro_id,true),
    (income_macro_id,'0055 income macro','INCOME','MACRO',NULL,true),
    (income_category_id,'0055 income micro','INCOME','MICRO',income_macro_id,true);
END;
$fixtures$;

CREATE TEMP TABLE test_0055_state (
  proposal_id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  version bigint NOT NULL,
  initial_version bigint NOT NULL,
  expense_count_before_confirmation bigint,
  proposal_before_confirmation jsonb
);
GRANT ALL ON TABLE test_0055_state TO authenticated;

-- 0056 exposes bigint versions as decimal text in JSONB so JavaScript clients
-- cannot lose precision. Rehydrate those RPC results for concise SQL asserts.
CREATE FUNCTION public.test_0056_proposal_row(p_row jsonb)
RETURNS public.tb_pending_proposals
LANGUAGE sql IMMUTABLE AS $$
  SELECT pg_catalog.jsonb_populate_record(NULL::public.tb_pending_proposals,p_row)
$$;

CREATE FUNCTION public.test_0055_expense_payload(
  p_household_id uuid,
  p_actor_member_id uuid,
  p_claimed_actor_id uuid,
  p_category_id uuid,
  p_description text,
  p_total numeric
) RETURNS jsonb LANGUAGE sql AS $$
  WITH presented AS (
    SELECT pg_catalog.jsonb_build_object(
      'paidByMemberId',p_actor_member_id,
      'totalAmount',p_total,
      'expenseDate','2026-11-09',
      'description',p_description,
      'categoryId',p_category_id,
      'receiptId',NULL,
      'merchant','0055 grocery',
      'items','[]'::jsonb,
      'splits',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'householdMemberId',p_actor_member_id,'percentage',100.00
      ))
    ) AS value
  ), persistence AS (
    SELECT pg_catalog.jsonb_build_object(
      'householdId',p_household_id,
      'createdBy',p_actor_member_id,
      'paidByMemberId',p_actor_member_id,
      'categoryId',p_category_id,
      'receiptId',NULL,
      'merchant','0055 grocery',
      'totalAmount',p_total,
      'expenseDate','2026-11-09',
      'description',p_description,
      'source','WEB',
      'items','[]'::jsonb,
      'distributions',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'householdMemberId',p_actor_member_id,'amount',p_total,'percentage',100.00
      ))
    ) AS value
  )
  SELECT pg_catalog.jsonb_build_object(
    'actorMemberId',p_claimed_actor_id,
    'source','WHATSAPP',
    'expense',presented.value,
    '_web_confirmation',pg_catalog.jsonb_build_object(
      'presented',presented.value,'persistence',persistence.value
    )
  )
  FROM presented CROSS JOIN persistence
$$;

CREATE FUNCTION public.test_0055_income_payload(
  p_household_id uuid,
  p_actor_member_id uuid,
  p_claimed_actor_id uuid,
  p_category_id uuid,
  p_description text,
  p_amount numeric
) RETURNS jsonb LANGUAGE sql AS $$
  WITH presented AS (
    SELECT pg_catalog.jsonb_build_object(
      'memberId',p_actor_member_id,
      'amount',p_amount,
      'incomeDate','2026-11-09',
      'description',p_description,
      'categoryId',p_category_id
    ) AS value
  ), persistence AS (
    SELECT pg_catalog.jsonb_build_object(
      'householdId',p_household_id,
      'createdBy',p_actor_member_id,
      'memberId',p_actor_member_id,
      'amount',p_amount,
      'incomeDate','2026-11-09',
      'description',p_description,
      'categoryId',p_category_id
    ) AS value
  )
  SELECT pg_catalog.jsonb_build_object(
    'actorMemberId',p_claimed_actor_id,
    'source','WHATSAPP',
    'income',presented.value,
    '_web_confirmation',pg_catalog.jsonb_build_object(
      'presented',presented.value,'persistence',persistence.value
    )
  )
  FROM presented CROSS JOIN persistence
$$;

DO $acl$
DECLARE
  entry regprocedure;
  helper regprocedure := 'public.fn_assert_web_pending_proposal_snapshot(uuid,uuid,public.pending_operation_type,jsonb)'::regprocedure;
  version_trigger_function regprocedure := 'public.fn_set_pending_proposal_version()'::regprocedure;
  private_helpers regprocedure[] := ARRAY[
    'public.fn_web_pending_proposal_json(public.tb_pending_proposals)'::regprocedure,
    'public.fn_lock_web_pending_proposal_for_confirmation(uuid,uuid)'::regprocedure
  ];
  entries regprocedure[] := ARRAY[
    'public.fn_create_web_pending_proposal(uuid,text,public.pending_operation_type,jsonb)'::regprocedure,
    'public.fn_get_web_pending_proposal(uuid,uuid,text,public.pending_operation_type)'::regprocedure,
    'public.fn_get_web_active_pending_proposal(uuid,text)'::regprocedure,
    'public.fn_get_web_latest_terminal_pending_proposal(uuid,text)'::regprocedure,
    'public.fn_update_web_pending_proposal(uuid,uuid,text,public.pending_operation_type,bigint,jsonb)'::regprocedure,
    'public.fn_compensate_web_pending_proposal(uuid,uuid,text,public.pending_operation_type,timestamp with time zone,bigint)'::regprocedure
  ];
  required_table_privilege text;
BEGIN
  FOREACH entry IN ARRAY entries LOOP
    IF (SELECT proowner FROM pg_catalog.pg_proc WHERE oid=entry) <> 'postgres'::regrole
       OR NOT (SELECT prosecdef FROM pg_catalog.pg_proc WHERE oid=entry)
       OR (SELECT proconfig FROM pg_catalog.pg_proc WHERE oid=entry)
          IS DISTINCT FROM ARRAY['search_path=pg_catalog']
       OR NOT has_function_privilege('authenticated',entry,'EXECUTE')
       OR has_function_privilege('anon',entry,'EXECUTE')
       OR has_function_privilege('service_role',entry,'EXECUTE')
       OR EXISTS (
         SELECT 1 FROM pg_catalog.aclexplode(
           coalesce((SELECT proacl FROM pg_catalog.pg_proc WHERE oid=entry),
                    pg_catalog.acldefault('f',(SELECT proowner FROM pg_catalog.pg_proc WHERE oid=entry)))
         ) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
       ) THEN
      RAISE EXCEPTION 'Unsafe Web proposal lifecycle RPC ACL/configuration: %',entry;
    END IF;
  END LOOP;

  IF pg_catalog.to_regprocedure('public.fn_update_web_pending_proposal(uuid,uuid,text,public.pending_operation_type,timestamptz,jsonb)') IS NOT NULL
     OR pg_catalog.to_regprocedure('public.fn_compensate_web_pending_proposal(uuid,uuid,text,public.pending_operation_type,timestamptz,timestamptz)') IS NOT NULL THEN
    RAISE EXCEPTION 'Timestamp-based Web correction or compensation overload remains callable';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_attribute
        WHERE attrelid='public.tb_pending_proposals'::regclass
          AND attname='version' AND atttypid='bigint'::regtype
          AND attnotnull AND NOT attisdropped
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_constraint
        WHERE conrelid='public.tb_pending_proposals'::regclass
          AND conname='ck_tb_pending_proposals_version_positive'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_trigger
        WHERE tgrelid='public.tb_pending_proposals'::regclass
          AND tgname='trg_tb_pending_proposals_set_monotonic_version'
          AND NOT tgisinternal
     ) THEN
    RAISE EXCEPTION 'Monotonic proposal version column, constraint, or trigger is missing';
  END IF;
  IF (SELECT proowner FROM pg_catalog.pg_proc WHERE oid=version_trigger_function) <> 'postgres'::regrole
     OR (SELECT prosecdef FROM pg_catalog.pg_proc WHERE oid=version_trigger_function)
     OR (SELECT proconfig FROM pg_catalog.pg_proc WHERE oid=version_trigger_function)
          IS DISTINCT FROM ARRAY['search_path=pg_catalog']
     OR has_function_privilege('authenticated',version_trigger_function,'EXECUTE')
     OR has_function_privilege('anon',version_trigger_function,'EXECUTE')
     OR has_function_privilege('service_role',version_trigger_function,'EXECUTE')
     OR EXISTS (
       SELECT 1 FROM pg_catalog.aclexplode(
         coalesce((SELECT proacl FROM pg_catalog.pg_proc WHERE oid=version_trigger_function),
                  pg_catalog.acldefault('f',(SELECT proowner FROM pg_catalog.pg_proc WHERE oid=version_trigger_function)))
       ) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Version trigger helper is not private and invoker-only';
  END IF;
  FOREACH entry IN ARRAY private_helpers LOOP
    IF (SELECT proowner FROM pg_catalog.pg_proc WHERE oid=entry) <> 'postgres'::regrole
       OR (SELECT prosecdef FROM pg_catalog.pg_proc WHERE oid=entry)
       OR (SELECT proconfig FROM pg_catalog.pg_proc WHERE oid=entry)
            IS DISTINCT FROM ARRAY['search_path=pg_catalog']
       OR has_function_privilege('authenticated',entry,'EXECUTE')
       OR has_function_privilege('anon',entry,'EXECUTE')
       OR has_function_privilege('service_role',entry,'EXECUTE')
       OR EXISTS (
         SELECT 1 FROM pg_catalog.aclexplode(
           coalesce((SELECT proacl FROM pg_catalog.pg_proc WHERE oid=entry),
                    pg_catalog.acldefault('f',(SELECT proowner FROM pg_catalog.pg_proc WHERE oid=entry)))
         ) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
       ) THEN
      RAISE EXCEPTION 'Versioned Web proposal helper is not private and invoker-only: %',entry;
    END IF;
  END LOOP;

  IF (SELECT proowner FROM pg_catalog.pg_proc WHERE oid=helper) <> 'postgres'::regrole
     OR (SELECT prosecdef FROM pg_catalog.pg_proc WHERE oid=helper)
     OR (SELECT proconfig FROM pg_catalog.pg_proc WHERE oid=helper)
          IS DISTINCT FROM ARRAY['search_path=pg_catalog']
     OR has_function_privilege('authenticated',helper,'EXECUTE')
     OR has_function_privilege('anon',helper,'EXECUTE')
     OR has_function_privilege('service_role',helper,'EXECUTE')
     OR EXISTS (
       SELECT 1 FROM pg_catalog.aclexplode(
         coalesce((SELECT proacl FROM pg_catalog.pg_proc WHERE oid=helper),
                  pg_catalog.acldefault('f',(SELECT proowner FROM pg_catalog.pg_proc WHERE oid=helper)))
       ) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Web proposal snapshot helper is not private/invoker-only';
  END IF;

  FOREACH required_table_privilege IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'] LOOP
    IF has_table_privilege('authenticated','public.tb_pending_proposals',required_table_privilege)
       OR has_table_privilege('anon','public.tb_pending_proposals',required_table_privilege) THEN
      RAISE EXCEPTION 'Direct pending proposal table privilege remains: %',required_table_privilege;
    END IF;
  END LOOP;
  IF has_any_column_privilege('authenticated','public.tb_pending_proposals','SELECT')
     OR has_any_column_privilege('authenticated','public.tb_pending_proposals','INSERT')
     OR has_any_column_privilege('authenticated','public.tb_pending_proposals','UPDATE')
     OR has_any_column_privilege('anon','public.tb_pending_proposals','SELECT')
     OR has_any_column_privilege('anon','public.tb_pending_proposals','INSERT')
     OR has_any_column_privilege('anon','public.tb_pending_proposals','UPDATE') THEN
    RAISE EXCEPTION 'Direct pending proposal column privilege remains';
  END IF;
  IF NOT has_table_privilege('service_role','public.tb_pending_proposals','SELECT')
     OR NOT has_table_privilege('service_role','public.tb_pending_proposals','INSERT')
     OR NOT has_table_privilege('service_role','public.tb_pending_proposals','UPDATE')
     OR NOT has_table_privilege('service_role','public.tb_pending_proposals','DELETE')
     OR NOT has_function_privilege('service_role','public.fn_create_whatsapp_proposal_event(text,uuid,bigint,uuid,text,public.pending_operation_type,jsonb)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.fn_update_whatsapp_proposal_event(text,uuid,bigint,uuid,text,public.pending_operation_type,jsonb,timestamptz)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.fn_compensate_whatsapp_proposal_event(text,uuid,bigint,uuid,text,public.pending_operation_type)','EXECUTE') THEN
    RAISE EXCEPTION 'Legacy service_role or WhatsApp compatibility grants changed';
  END IF;
  RAISE NOTICE 'PASS Web proposal lifecycle ACLs are authenticated-only; table ACLs and WhatsApp grants remain scoped';
END;
$acl$;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','55000000-0055-4000-8000-000000000001',true);

DO $create_and_read$
DECLARE
  household_id CONSTANT uuid := '55000000-0055-4000-8000-000000000010';
  actor_member_id CONSTANT uuid := '55000000-0055-4000-8000-000000000031';
  other_member_id CONSTANT uuid := '55000000-0055-4000-8000-000000000032';
  category_id CONSTANT uuid := '55000000-0055-4000-8000-000000000042';
  conversation_key text := 'web:55000000-0055-4000-8000-000000000010:55000000-0055-4000-8000-000000000031';
  payload jsonb;
  proposal public.tb_pending_proposals%ROWTYPE;
  result public.tb_pending_proposals%ROWTYPE;
  duplicate_state text;
  direct_state text;
BEGIN
  payload := public.test_0055_expense_payload(
    household_id,actor_member_id,other_member_id,category_id,'Initial Web expense',100.00
  );
  proposal := public.test_0056_proposal_row(public.fn_create_web_pending_proposal(
    household_id,conversation_key,'CREATE_EXPENSE',payload
  ));
  IF proposal.id IS NULL
     OR proposal.actor_member_id IS DISTINCT FROM actor_member_id
     OR proposal.source IS DISTINCT FROM 'WEB'
     OR proposal.conversation_key IS DISTINCT FROM conversation_key
     OR proposal.payload ->> 'actorMemberId' IS DISTINCT FROM actor_member_id::text
     OR proposal.payload ->> 'source' IS DISTINCT FROM 'WEB'
     OR proposal.operation_type IS DISTINCT FROM 'CREATE_EXPENSE'
     OR proposal.status IS DISTINCT FROM 'AWAITING_CONFIRMATION'
     OR proposal.version IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Web creation did not derive identity/source/conversation in SQL';
  END IF;
  PERFORM pg_catalog.set_config(
    'housemate.test.versioned_proposal_id',proposal.id::text,true
  );
  IF pg_catalog.jsonb_typeof(public.fn_get_web_pending_proposal(
       proposal.id,household_id,conversation_key,'CREATE_EXPENSE'
     ) -> 'version') IS DISTINCT FROM 'string'
     OR public.fn_get_web_pending_proposal(
       proposal.id,household_id,conversation_key,'CREATE_EXPENSE'
     ) ->> 'version' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'Web proposal RPC did not serialize bigint version as decimal text';
  END IF;
  INSERT INTO pg_temp.test_0055_state(
    proposal_id,created_at,updated_at,version,initial_version
  ) VALUES(proposal.id,proposal.created_at,proposal.updated_at,proposal.version,proposal.version);

  direct_state := NULL;
  BEGIN
    UPDATE public.tb_pending_proposals SET version=999 WHERE id=proposal.id;
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS direct_state = RETURNED_SQLSTATE;
  END;
  IF direct_state IS DISTINCT FROM '42501' THEN
    RAISE EXCEPTION 'authenticated could directly assign the proposal version: %',direct_state;
  END IF;

  result := public.test_0056_proposal_row(public.fn_get_web_pending_proposal(
    proposal.id,household_id,conversation_key,'CREATE_EXPENSE'
  ));
  IF result.id IS DISTINCT FROM proposal.id THEN RAISE EXCEPTION 'By-id Web read failed'; END IF;
  result := public.test_0056_proposal_row(public.fn_get_web_active_pending_proposal(household_id,conversation_key));
  IF result.id IS DISTINCT FROM proposal.id THEN RAISE EXCEPTION 'Active Web read failed'; END IF;
  duplicate_state := NULL;
  BEGIN
    PERFORM public.fn_get_web_pending_proposal(
      proposal.id,household_id,'web:forged','CREATE_EXPENSE'
    );
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS duplicate_state = RETURNED_SQLSTATE;
  END;
  IF duplicate_state IS DISTINCT FROM '42501' THEN
    RAISE EXCEPTION 'Non-canonical conversation selector was not denied: %',duplicate_state;
  END IF;

  duplicate_state := NULL;
  BEGIN
    PERFORM public.fn_create_web_pending_proposal(
      household_id,conversation_key,'CREATE_EXPENSE',payload
    );
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS duplicate_state = RETURNED_SQLSTATE;
  END;
  IF duplicate_state IS DISTINCT FROM '23505' THEN
    RAISE EXCEPTION 'A duplicate active proposal did not conflict: %',duplicate_state;
  END IF;
  RAISE NOTICE 'PASS Web creation fixes actor/source/conversation and scopes active reads';
END;
$create_and_read$;

DO $update_and_compensate_conflict$
DECLARE
  household_id CONSTANT uuid := '55000000-0055-4000-8000-000000000010';
  actor_member_id CONSTANT uuid := '55000000-0055-4000-8000-000000000031';
  other_member_id CONSTANT uuid := '55000000-0055-4000-8000-000000000032';
  category_id CONSTANT uuid := '55000000-0055-4000-8000-000000000042';
  conversation_key text := 'web:55000000-0055-4000-8000-000000000010:55000000-0055-4000-8000-000000000031';
  v_proposal_id uuid;
  created_at timestamptz;
  original_version bigint;
  original_updated_at timestamptz;
  proposal public.tb_pending_proposals%ROWTYPE;
  payload jsonb;
  state_text text;
  outcome jsonb;
BEGIN
  SELECT test.proposal_id,test.created_at,test.initial_version,test.updated_at
    INTO v_proposal_id,created_at,original_version,original_updated_at FROM pg_temp.test_0055_state AS test;
  payload := public.test_0055_expense_payload(
    household_id,actor_member_id,other_member_id,category_id,'Corrected Web expense',100.00
  );
  proposal := public.test_0056_proposal_row(public.fn_update_web_pending_proposal(
    v_proposal_id,household_id,conversation_key,'CREATE_EXPENSE',original_version,payload
  ));
  IF proposal.id IS DISTINCT FROM v_proposal_id
     OR proposal.version IS DISTINCT FROM original_version + 1
     OR proposal.updated_at IS DISTINCT FROM original_updated_at
     OR proposal.payload -> 'expense' ->> 'description' IS DISTINCT FROM 'Corrected Web expense'
     OR proposal.payload ->> 'actorMemberId' IS DISTINCT FROM actor_member_id::text
     OR proposal.payload ->> 'source' IS DISTINCT FROM 'WEB' THEN
    RAISE EXCEPTION 'Versioned Web correction failed';
  END IF;
  UPDATE pg_temp.test_0055_state SET updated_at=proposal.updated_at,version=proposal.version
   WHERE test_0055_state.proposal_id=v_proposal_id;

  -- The complete SQL file runs in one transaction, so now() leaves updated_at
  -- unchanged. The monotonic row version must still reject the old token.
  state_text := NULL;
  BEGIN
    PERFORM public.fn_update_web_pending_proposal(
      v_proposal_id,household_id,conversation_key,'CREATE_EXPENSE',
      original_version,payload
    );
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS state_text = RETURNED_SQLSTATE;
  END;
  IF state_text IS DISTINCT FROM '40001' THEN
    RAISE EXCEPTION 'Stale Web correction was not classified as a conflict: %',state_text;
  END IF;
  IF proposal.updated_at IS DISTINCT FROM original_updated_at THEN
    RAISE EXCEPTION 'Regression setup did not preserve updated_at within the transaction';
  END IF;

  payload := pg_catalog.jsonb_set(
    payload,'{_web_confirmation,persistence,totalAmount}','99.00'::jsonb
  );
  state_text := NULL;
  BEGIN
    PERFORM public.fn_update_web_pending_proposal(
      v_proposal_id,household_id,conversation_key,'CREATE_EXPENSE',
      proposal.version,payload
    );
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS state_text = RETURNED_SQLSTATE;
  END;
  IF state_text IS DISTINCT FROM '22023' THEN
    RAISE EXCEPTION 'Inconsistent Web snapshot did not fail before update: %',state_text;
  END IF;

  outcome := public.fn_compensate_web_pending_proposal(
    v_proposal_id,household_id,conversation_key,'CREATE_EXPENSE',created_at,
    original_version
  );
  IF outcome ->> 'status' IS DISTINCT FROM 'VERSION_CONFLICT' THEN
    RAISE EXCEPTION 'Compensation accepted a stale version token: %',outcome;
  END IF;
  proposal := public.test_0056_proposal_row(public.fn_get_web_pending_proposal(
    v_proposal_id,household_id,conversation_key,'CREATE_EXPENSE'
  ));
  IF proposal.id IS DISTINCT FROM v_proposal_id
     OR proposal.status IS DISTINCT FROM 'AWAITING_CONFIRMATION'
     OR proposal.version IS DISTINCT FROM original_version + 1
     OR proposal.payload -> 'expense' ->> 'description'
        IS DISTINCT FROM 'Corrected Web expense' THEN
    RAISE EXCEPTION 'Failed correction or compensation changed persisted proposal';
  END IF;
  RAISE NOTICE 'PASS Web correction is optimistic, validates snapshots and fences compensation';
END;
$update_and_compensate_conflict$;

RESET ROLE;

-- Capture the financial and proposal state as the privileged test connection.
-- The confirmation itself below still runs only after SET LOCAL ROLE authenticated.
DO $capture_pre_confirmation_state$
DECLARE
  v_proposal_id uuid;
  v_expense_count bigint;
  v_proposal jsonb;
BEGIN
  SELECT test.proposal_id INTO v_proposal_id
    FROM pg_temp.test_0055_state AS test;
  SELECT count(*) INTO v_expense_count FROM public.tb_expenses;
  SELECT pg_catalog.to_jsonb(proposal) INTO v_proposal
    FROM public.tb_pending_proposals AS proposal
   WHERE proposal.id=v_proposal_id;

  IF v_proposal IS NULL THEN
    RAISE EXCEPTION 'Corrected proposal disappeared before stale confirmation';
  END IF;

  UPDATE pg_temp.test_0055_state
     SET expense_count_before_confirmation=v_expense_count,
         proposal_before_confirmation=v_proposal
   WHERE proposal_id=v_proposal_id;

  RAISE NOTICE 'PASS privileged test captured the pre-confirmation state';
END;
$capture_pre_confirmation_state$;

-- Re-establish the authenticated SQL role and claims explicitly after privileged
-- observation so neither the role reset nor test reads can change the RPC context.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','55000000-0055-4000-8000-000000000001',true);

DO $stale_confirmation_as_authenticated$
DECLARE
  household_id CONSTANT uuid := '55000000-0055-4000-8000-000000000010';
  v_proposal_id uuid;
  stale_version bigint;
  state_text text;
BEGIN
  SELECT test.proposal_id,test.initial_version
    INTO v_proposal_id,stale_version
    FROM pg_temp.test_0055_state AS test;

  state_text := NULL;
  BEGIN
    PERFORM public.fn_confirm_web_pending_expense(
      v_proposal_id,household_id,stale_version
    );
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS state_text = RETURNED_SQLSTATE;
  END;

  IF state_text IS DISTINCT FROM '40001' THEN
    RAISE EXCEPTION 'Stale confirmation was not rejected as authenticated: %',state_text;
  END IF;
  RAISE NOTICE 'PASS authenticated stale confirmation returned SQLSTATE 40001';
END;
$stale_confirmation_as_authenticated$;

RESET ROLE;

DO $assert_stale_confirmation_atomicity$
DECLARE
  v_proposal_id uuid;
  v_expected_count bigint;
  v_expense_count bigint;
  v_expected_proposal jsonb;
  v_proposal jsonb;
  v_expected_version bigint;
BEGIN
  SELECT test.proposal_id,test.expense_count_before_confirmation,
         test.proposal_before_confirmation,test.version
    INTO v_proposal_id,v_expected_count,v_expected_proposal,v_expected_version
    FROM pg_temp.test_0055_state AS test;

  SELECT count(*) INTO v_expense_count FROM public.tb_expenses;
  SELECT pg_catalog.to_jsonb(proposal) INTO v_proposal
    FROM public.tb_pending_proposals AS proposal
   WHERE proposal.id=v_proposal_id;

  IF v_expected_count IS NULL
     OR v_expense_count IS DISTINCT FROM v_expected_count
     OR v_proposal IS DISTINCT FROM v_expected_proposal
     OR v_proposal ->> 'status' IS DISTINCT FROM 'AWAITING_CONFIRMATION'
     OR v_proposal ->> 'version' IS DISTINCT FROM v_expected_version::text THEN
    RAISE EXCEPTION 'Stale confirmation changed financial rows or proposal state/version';
  END IF;

  RAISE NOTICE 'PASS stale confirmation created no expense and preserved the proposal row';
END;
$assert_stale_confirmation_atomicity$;

UPDATE public.tb_pending_proposals
   SET status='REJECTED',resolved_at=clock_timestamp()
 WHERE id=(SELECT proposal_id FROM pg_temp.test_0055_state);
-- service_role retains legacy table UPDATE for WhatsApp compatibility, but
-- even that privileged writer cannot choose the monotonic version value.
SET LOCAL ROLE service_role;
UPDATE public.tb_pending_proposals
   SET version=999
 WHERE id=current_setting('housemate.test.versioned_proposal_id')::uuid;
RESET ROLE;
DO $service_role_cannot_choose_version$
DECLARE
  current_version bigint;
BEGIN
  SELECT proposal.version INTO current_version
    FROM public.tb_pending_proposals AS proposal
   WHERE proposal.id=current_setting('housemate.test.versioned_proposal_id')::uuid;
  IF current_version IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'service_role chose a version instead of advancing exactly once: %',current_version;
  END IF;
  RAISE NOTICE 'PASS trigger overrides direct service_role version assignments';
END;
$service_role_cannot_choose_version$;

SET LOCAL ROLE authenticated;
DO $terminal_read_and_no_active$
DECLARE
  household_id CONSTANT uuid := '55000000-0055-4000-8000-000000000010';
  conversation_key text := 'web:55000000-0055-4000-8000-000000000010:55000000-0055-4000-8000-000000000031';
  terminal public.tb_pending_proposals%ROWTYPE;
  active public.tb_pending_proposals%ROWTYPE;
BEGIN
  terminal := public.test_0056_proposal_row(public.fn_get_web_latest_terminal_pending_proposal(household_id,conversation_key));
  active := public.test_0056_proposal_row(public.fn_get_web_active_pending_proposal(household_id,conversation_key));
  IF terminal.id IS NULL OR terminal.status IS DISTINCT FROM 'REJECTED' OR active.id IS NOT NULL THEN
    RAISE EXCEPTION 'Terminal result or active proposal read is incorrect';
  END IF;
  active := public.test_0056_proposal_row(public.fn_get_web_pending_proposal(
    terminal.id,household_id,conversation_key,'CREATE_EXPENSE'
  ));
  IF active.id IS NOT NULL THEN RAISE EXCEPTION 'Resolved proposal was returned as active by id'; END IF;
  IF public.fn_compensate_web_pending_proposal(
       terminal.id,household_id,conversation_key,'CREATE_EXPENSE',
       terminal.created_at,terminal.version
     ) ->> 'status' IS DISTINCT FROM 'VERSION_CONFLICT' THEN
    RAISE EXCEPTION 'Compensation removed a terminal proposal';
  END IF;
  active := public.test_0056_proposal_row(public.fn_get_web_latest_terminal_pending_proposal(household_id,conversation_key));
  IF active.id IS DISTINCT FROM terminal.id OR active.status IS DISTINCT FROM 'REJECTED' THEN
    RAISE EXCEPTION 'Terminal proposal disappeared after compensation attempt';
  END IF;
  RAISE NOTICE 'PASS Web can retrieve only its latest terminal result after resolution';
END;
$terminal_read_and_no_active$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','55000000-0055-4000-8000-000000000001',true);
DO $income_create_and_compensation$
DECLARE
  household_id CONSTANT uuid := '55000000-0055-4000-8000-000000000010';
  actor_member_id CONSTANT uuid := '55000000-0055-4000-8000-000000000031';
  other_member_id CONSTANT uuid := '55000000-0055-4000-8000-000000000032';
  category_id CONSTANT uuid := '55000000-0055-4000-8000-000000000044';
  conversation_key text := 'web:55000000-0055-4000-8000-000000000010:55000000-0055-4000-8000-000000000031';
  proposal public.tb_pending_proposals%ROWTYPE;
  terminal public.tb_pending_proposals%ROWTYPE;
  corrected public.tb_pending_proposals%ROWTYPE;
  corrected_payload jsonb;
  outcome jsonb;
  state_text text;
BEGIN
  proposal := public.test_0056_proposal_row(public.fn_create_web_pending_proposal(
    household_id,conversation_key,'CREATE_INCOME',
    public.test_0055_income_payload(
      household_id,actor_member_id,other_member_id,category_id,'Web salary',250.00
    )
  ));
  IF proposal.id IS NULL OR proposal.operation_type IS DISTINCT FROM 'CREATE_INCOME'
     OR proposal.actor_member_id IS DISTINCT FROM actor_member_id
     OR proposal.source IS DISTINCT FROM 'WEB'
     OR proposal.version IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'Web Income proposal creation failed';
  END IF;
  terminal := public.test_0056_proposal_row(public.fn_get_web_pending_proposal(
    proposal.id,household_id,conversation_key,'CREATE_INCOME'
  ));
  IF terminal.id IS DISTINCT FROM proposal.id THEN RAISE EXCEPTION 'Web Income read failed'; END IF;

  corrected_payload := public.test_0055_income_payload(
    household_id,actor_member_id,other_member_id,category_id,'Corrected Web salary',250.00
  );
  corrected := public.test_0056_proposal_row(public.fn_update_web_pending_proposal(
    proposal.id,household_id,conversation_key,'CREATE_INCOME',proposal.version,corrected_payload
  ));
  IF corrected.version IS DISTINCT FROM 2
     OR corrected.payload -> 'income' ->> 'description' IS DISTINCT FROM 'Corrected Web salary' THEN
    RAISE EXCEPTION 'Web Income correction did not advance its version exactly once';
  END IF;
  outcome := public.fn_compensate_web_pending_proposal(
    proposal.id,household_id,conversation_key,'CREATE_INCOME',proposal.created_at,proposal.version
  );
  IF outcome ->> 'status' IS DISTINCT FROM 'VERSION_CONFLICT' THEN
    RAISE EXCEPTION 'Stale Income compensation removed a corrected proposal';
  END IF;

  outcome := public.fn_compensate_web_pending_proposal(
    proposal.id,household_id,conversation_key,'CREATE_INCOME',corrected.created_at,corrected.version
  );
  IF outcome ->> 'status' IS DISTINCT FROM 'REMOVED' THEN
    RAISE EXCEPTION 'Fresh Web proposal compensation failed: %',outcome;
  END IF;
  outcome := public.fn_compensate_web_pending_proposal(
    proposal.id,household_id,conversation_key,'CREATE_INCOME',corrected.created_at,corrected.version
  );
  IF outcome ->> 'status' IS DISTINCT FROM 'NOT_FOUND' THEN
    RAISE EXCEPTION 'Web proposal compensation is not idempotent: %',outcome;
  END IF;
  state_text := NULL;
  BEGIN
    PERFORM public.fn_create_web_pending_proposal(
      household_id,'web:55000000-0055-4000-8000-000000000011:55000000-0055-4000-8000-000000000031',
      'CREATE_INCOME',public.test_0055_income_payload(
        household_id,actor_member_id,actor_member_id,category_id,'Bad conversation',250.00
      )
    );
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS state_text = RETURNED_SQLSTATE;
  END;
  IF state_text IS DISTINCT FROM '42501' THEN
    RAISE EXCEPTION 'Forged conversation did not fail closed: %',state_text;
  END IF;
  RAISE NOTICE 'PASS Web Income creation and version-fenced compensation are idempotent';
END;
$income_create_and_compensation$;
RESET ROLE;

-- A separate authenticated user in the same household cannot read the first
-- actor's proposal by ID or through the terminal/active conversation scope.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','55000000-0055-4000-8000-000000000002',true);
DO $other_actor_isolation$
DECLARE
  household_id CONSTANT uuid := '55000000-0055-4000-8000-000000000010';
  proposal_id uuid := (SELECT proposal_id FROM pg_temp.test_0055_state);
  result public.tb_pending_proposals%ROWTYPE;
BEGIN
  result := public.test_0056_proposal_row(public.fn_get_web_pending_proposal(
    proposal_id,household_id,
    'web:55000000-0055-4000-8000-000000000010:55000000-0055-4000-8000-000000000032',
    'CREATE_EXPENSE'
  ));
  IF result.id IS NOT NULL THEN RAISE EXCEPTION 'Other active household member read a Web proposal'; END IF;
  result := public.test_0056_proposal_row(public.fn_get_web_active_pending_proposal(
    household_id,'web:55000000-0055-4000-8000-000000000010:55000000-0055-4000-8000-000000000032'
  ));
  IF result.id IS NOT NULL THEN RAISE EXCEPTION 'Other household member saw active proposal'; END IF;
  RAISE NOTICE 'PASS Web reads isolate the authenticated actor within a shared household';
END;
$other_actor_isolation$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','55000000-0055-4000-8000-000000000003',true);
DO $no_membership$
DECLARE
  state_text text;
BEGIN
  BEGIN
    PERFORM public.fn_get_web_active_pending_proposal(
      '55000000-0055-4000-8000-000000000010',
      'web:55000000-0055-4000-8000-000000000010:55000000-0055-4000-8000-000000000031'
    );
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS state_text = RETURNED_SQLSTATE;
  END;
  IF state_text IS DISTINCT FROM '42501' THEN
    RAISE EXCEPTION 'User without membership was not rejected: %',state_text;
  END IF;
  state_text := NULL;
  BEGIN
    PERFORM public.fn_get_web_active_pending_proposal(
      '55000000-0055-4000-8000-000000000011',
      'web:55000000-0055-4000-8000-000000000011:55000000-0055-4000-8000-000000000031'
    );
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS state_text = RETURNED_SQLSTATE;
  END;
  IF state_text IS DISTINCT FROM '42501' THEN
    RAISE EXCEPTION 'Foreign household selector was not rejected: %',state_text;
  END IF;
END;
$no_membership$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','',true);
DO $missing_identity$
DECLARE state_text text;
BEGIN
  BEGIN
    PERFORM public.fn_get_web_active_pending_proposal(
      '55000000-0055-4000-8000-000000000010',
      'web:55000000-0055-4000-8000-000000000010:55000000-0055-4000-8000-000000000031'
    );
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS state_text = RETURNED_SQLSTATE;
  END;
  IF state_text IS DISTINCT FROM '42501' THEN RAISE EXCEPTION 'Missing auth.uid was not denied: %',state_text; END IF;
END;
$missing_identity$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','55000000-0055-4000-8000-000000000004',true);
DO $unconfirmed_email$
DECLARE state_text text;
BEGIN
  BEGIN
    PERFORM public.fn_get_web_active_pending_proposal(
      '55000000-0055-4000-8000-000000000010',
      'web:55000000-0055-4000-8000-000000000010:55000000-0055-4000-8000-000000000033'
    );
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS state_text = RETURNED_SQLSTATE;
  END;
  IF state_text IS DISTINCT FROM '42501' THEN RAISE EXCEPTION 'Unconfirmed Auth user was not denied: %',state_text; END IF;
END;
$unconfirmed_email$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','55000000-0055-4000-8000-000000000001',true);
DO $direct_table_access_denied$
DECLARE
  state_text text;
BEGIN
  BEGIN
    PERFORM id FROM public.tb_pending_proposals LIMIT 1;
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS state_text = RETURNED_SQLSTATE;
  END;
  IF state_text IS DISTINCT FROM '42501' THEN
    RAISE EXCEPTION 'authenticated can read proposals directly: %',state_text;
  END IF;
END;
$direct_table_access_denied$;
RESET ROLE;

SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claim.role','anon',true);
DO $anon_denied$
DECLARE state_text text;
BEGIN
  BEGIN
    PERFORM public.fn_get_web_active_pending_proposal(
      '55000000-0055-4000-8000-000000000010',
      'web:55000000-0055-4000-8000-000000000010:55000000-0055-4000-8000-000000000031'
    );
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS state_text = RETURNED_SQLSTATE;
  END;
  IF state_text IS DISTINCT FROM '42501' THEN RAISE EXCEPTION 'anon lifecycle RPC was not denied: %',state_text; END IF;
END;
$anon_denied$;
RESET ROLE;

SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role','service_role',true);
DO $service_role_denied$
DECLARE state_text text;
BEGIN
  BEGIN
    PERFORM public.fn_get_web_active_pending_proposal(
      '55000000-0055-4000-8000-000000000010',
      'web:55000000-0055-4000-8000-000000000010:55000000-0055-4000-8000-000000000031'
    );
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS state_text = RETURNED_SQLSTATE;
  END;
  IF state_text IS DISTINCT FROM '42501' THEN RAISE EXCEPTION 'service_role lifecycle RPC was not denied: %',state_text; END IF;
END;
$service_role_denied$;
RESET ROLE;

ROLLBACK;
