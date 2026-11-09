BEGIN;

-- This SQL runner simulates PostgREST claims with request settings and SET ROLE.
-- It verifies the SQL boundary, not a signed JWT or real HTTP transport.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY,
  email text,
  email_confirmed_at timestamptz
);
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.role', true), '')
$$;
GRANT USAGE ON SCHEMA auth TO authenticated;

DO $fixtures$
DECLARE
  household_id CONSTANT uuid := '54000000-0054-4000-8000-000000000010';
  other_household_id CONSTANT uuid := '54000000-0054-4000-8000-000000000011';
  actor_user_id CONSTANT uuid := '54000000-0054-4000-8000-000000000021';
  other_user_id CONSTANT uuid := '54000000-0054-4000-8000-000000000022';
  no_member_user_id CONSTANT uuid := '54000000-0054-4000-8000-000000000023';
  inactive_user_id CONSTANT uuid := '54000000-0054-4000-8000-000000000024';
  split_user_id CONSTANT uuid := '54000000-0054-4000-8000-000000000025';
  actor_auth_id CONSTANT uuid := '54000000-0054-4000-8000-000000000001';
  other_auth_id CONSTANT uuid := '54000000-0054-4000-8000-000000000002';
  no_member_auth_id CONSTANT uuid := '54000000-0054-4000-8000-000000000003';
  inactive_auth_id CONSTANT uuid := '54000000-0054-4000-8000-000000000004';
  split_auth_id CONSTANT uuid := '54000000-0054-4000-8000-000000000005';
  actor_member_id CONSTANT uuid := '54000000-0054-4000-8000-000000000031';
  other_member_id CONSTANT uuid := '54000000-0054-4000-8000-000000000032';
  inactive_member_id CONSTANT uuid := '54000000-0054-4000-8000-000000000034';
  split_member_id CONSTANT uuid := '54000000-0054-4000-8000-000000000033';
  expense_category_id CONSTANT uuid := '54000000-0054-4000-8000-000000000042';
  income_category_id CONSTANT uuid := '54000000-0054-4000-8000-000000000044';
  failed_receipt_id CONSTANT uuid := '54000000-0054-4000-8000-000000000050';
BEGIN
  INSERT INTO public.tb_households(id,name) VALUES
    (household_id,'0054 Web proposal household'),
    (other_household_id,'0054 unrelated household');

  INSERT INTO public.tb_users(id,display_name,external_identifier,auth_user_id) VALUES
    (actor_user_id,'0054 actor','0054-actor',actor_auth_id),
    (other_user_id,'0054 other','0054-other',other_auth_id),
    (no_member_user_id,'0054 no member','0054-no-member',no_member_auth_id),
    (inactive_user_id,'0054 inactive','0054-inactive',inactive_auth_id),
    (split_user_id,'0054 split member','0054-split-member',split_auth_id);
  INSERT INTO public.tb_household_members(
    id,household_id,user_id,display_name,role,status
  ) VALUES
    (actor_member_id,household_id,actor_user_id,'0054 actor','OWNER','ACTIVE'),
    (other_member_id,household_id,other_user_id,'0054 other','MEMBER','ACTIVE'),
    (inactive_member_id,household_id,inactive_user_id,'0054 inactive','MEMBER','LEFT'),
    (split_member_id,household_id,split_user_id,'0054 split member','MEMBER','ACTIVE');

  INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
    (actor_auth_id,'0054-actor@example.test',clock_timestamp()),
    (other_auth_id,'0054-other@example.test',clock_timestamp()),
    (no_member_auth_id,'0054-no-member@example.test',clock_timestamp()),
    (inactive_auth_id,'0054-inactive@example.test',clock_timestamp()),
    (split_auth_id,'0054-split-member@example.test',clock_timestamp());

  INSERT INTO public.tb_categories(id,name,movement_type,level,parent_id,is_active) VALUES
    ('54000000-0054-4000-8000-000000000041','0054 expense macro','EXPENSE','MACRO',NULL,true),
    (expense_category_id,'0054 expense micro','EXPENSE','MICRO','54000000-0054-4000-8000-000000000041',true),
    ('54000000-0054-4000-8000-000000000043','0054 income macro','INCOME','MACRO',NULL,true),
    (income_category_id,'0054 income micro','INCOME','MICRO','54000000-0054-4000-8000-000000000043',true);

  INSERT INTO public.tb_receipts(
    id,household_id,conversation_key,storage_path,original_filename,mime_type,
    processing_status,analysis_payload
  ) VALUES (
    failed_receipt_id,household_id,'web:failed-receipt','0054/fail.jpg',
    'fail.jpg','image/jpeg','FAILED','{}'::jsonb
  );
END;
$fixtures$;

CREATE FUNCTION public.test_0054_reject_income_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.description='0054 rollback trigger' THEN
    RAISE EXCEPTION 'controlled 0054 Income failure' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER test_0054_reject_income_insert
  AFTER INSERT ON public.tb_incomes
  FOR EACH ROW EXECUTE FUNCTION public.test_0054_reject_income_insert();

DO $acl$
DECLARE
  entry regprocedure;
  role_name text;
  privilege_name text;
  target_column record;
  helper regprocedure := 'public.fn_require_web_financial_actor(uuid)'::regprocedure;
  split_helper regprocedure := 'public.fn_assert_web_expense_distribution_snapshot(jsonb,jsonb,jsonb,jsonb)'::regprocedure;
  generic_expense regprocedure := 'public.fn_confirm_pending_expense_eligible(uuid,uuid,uuid,text,uuid,public.expense_source,timestamp with time zone,uuid,uuid,uuid,uuid,text,numeric,date,text,public.expense_source,jsonb,jsonb,uuid,uuid,bigint)'::regprocedure;
  generic_income regprocedure := 'public.fn_confirm_pending_income_eligible(uuid,uuid,uuid,text,uuid,public.expense_source,timestamp with time zone,uuid,uuid,numeric,date,text,uuid,uuid,uuid,bigint)'::regprocedure;
  generic_reject regprocedure := 'public.fn_reject_pending_proposal(uuid,uuid,text,uuid,public.expense_source,public.pending_operation_type)'::regprocedure;
  entries regprocedure[] := ARRAY[
    'public.fn_confirm_web_pending_expense(uuid,uuid,timestamp with time zone)'::regprocedure,
    'public.fn_confirm_web_pending_income(uuid,uuid,timestamp with time zone)'::regprocedure,
    'public.fn_reject_web_pending_proposal(uuid,uuid,public.pending_operation_type)'::regprocedure
  ];
BEGIN
  FOREACH entry IN ARRAY entries LOOP
    IF (SELECT proowner FROM pg_catalog.pg_proc WHERE oid=entry) <> 'postgres'::regrole
       OR NOT (SELECT prosecdef FROM pg_catalog.pg_proc WHERE oid=entry)
       OR (SELECT proconfig FROM pg_catalog.pg_proc WHERE oid=entry)
            IS DISTINCT FROM ARRAY['search_path=pg_catalog'] THEN
      RAISE EXCEPTION 'Unsafe Web proposal RPC configuration: %',entry;
    END IF;
    IF NOT has_function_privilege('authenticated',entry,'EXECUTE')
       OR has_function_privilege('anon',entry,'EXECUTE')
       OR has_function_privilege('service_role',entry,'EXECUTE')
       OR EXISTS (
         SELECT 1 FROM pg_catalog.aclexplode(
           coalesce(
             (SELECT proacl FROM pg_catalog.pg_proc WHERE oid=entry),
             pg_catalog.acldefault('f',(SELECT proowner FROM pg_catalog.pg_proc WHERE oid=entry))
           )
         ) acl
         WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
       ) THEN
      RAISE EXCEPTION 'Unexpected effective Web proposal RPC ACL: %',entry;
    END IF;
    IF (SELECT proargnames FROM pg_catalog.pg_proc WHERE oid=entry) && ARRAY[
      'p_auth_user_id','p_actor_member_id','p_user_id','p_source',
      'p_context_source','p_conversation_key','p_total_amount','p_amount',
      'p_items','p_distributions','p_receipt_id','p_whatsapp_user_id',
      'p_lease_id','p_event_id'
    ] THEN
      RAISE EXCEPTION 'Web proposal RPC exposes caller authority/data args: %',entry;
    END IF;
  END LOOP;

  IF has_function_privilege('authenticated',helper,'EXECUTE')
     OR has_function_privilege('anon',helper,'EXECUTE')
     OR has_function_privilege('service_role',helper,'EXECUTE')
     OR EXISTS (
       SELECT 1 FROM pg_catalog.aclexplode(
         coalesce((SELECT proacl FROM pg_catalog.pg_proc WHERE oid=helper),
                  pg_catalog.acldefault('f',(SELECT proowner FROM pg_catalog.pg_proc WHERE oid=helper)))
       ) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Web actor helper is directly executable';
  END IF;
  IF (SELECT proowner FROM pg_catalog.pg_proc WHERE oid=split_helper) <> 'postgres'::regrole
     OR (SELECT prosecdef FROM pg_catalog.pg_proc WHERE oid=split_helper)
     OR (SELECT proconfig FROM pg_catalog.pg_proc WHERE oid=split_helper)
          IS DISTINCT FROM ARRAY['search_path=pg_catalog']
     OR has_function_privilege('authenticated',split_helper,'EXECUTE')
     OR has_function_privilege('anon',split_helper,'EXECUTE')
     OR has_function_privilege('service_role',split_helper,'EXECUTE')
     OR EXISTS (
       SELECT 1 FROM pg_catalog.aclexplode(
         coalesce((SELECT proacl FROM pg_catalog.pg_proc WHERE oid=split_helper),
                  pg_catalog.acldefault('f',(SELECT proowner FROM pg_catalog.pg_proc WHERE oid=split_helper)))
       ) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Expense distribution snapshot helper is not private and invoker-only';
  END IF;
  IF NOT has_function_privilege('service_role',generic_expense,'EXECUTE')
     OR NOT has_function_privilege('service_role',generic_income,'EXECUTE')
     OR NOT has_function_privilege('service_role',generic_reject,'EXECUTE') THEN
    RAISE EXCEPTION 'Legacy service_role compatibility grants changed';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        coalesce(relation.relacl,pg_catalog.acldefault('r',relation.relowner))
      ) AS acl
     WHERE relation.oid='public.tb_pending_proposals'::regclass
       AND acl.grantee=0
       AND acl.privilege_type IN (
         'SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'
       )
  ) THEN
    RAISE EXCEPTION 'PUBLIC retains direct access to pending proposals';
  END IF;
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    FOREACH privilege_name IN ARRAY ARRAY[
      'SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'
    ] LOOP
      IF has_table_privilege(role_name,'public.tb_pending_proposals',privilege_name) THEN
        RAISE EXCEPTION 'Role % retains effective % on pending proposals',role_name,privilege_name;
      END IF;
    END LOOP;
    FOR target_column IN
      SELECT attribute.attname
        FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid='public.tb_pending_proposals'::regclass
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
    LOOP
      IF has_column_privilege(role_name,'public.tb_pending_proposals',target_column.attname,'SELECT')
         OR has_column_privilege(role_name,'public.tb_pending_proposals',target_column.attname,'INSERT')
         OR has_column_privilege(role_name,'public.tb_pending_proposals',target_column.attname,'UPDATE')
         OR has_column_privilege(role_name,'public.tb_pending_proposals',target_column.attname,'REFERENCES') THEN
        RAISE EXCEPTION 'Role % retains effective column access to pending proposals',role_name;
      END IF;
    END LOOP;
  END LOOP;
  IF NOT has_table_privilege('service_role','public.tb_pending_proposals','SELECT')
     OR NOT has_table_privilege('service_role','public.tb_pending_proposals','INSERT')
     OR NOT has_table_privilege('service_role','public.tb_pending_proposals','UPDATE')
     OR NOT has_table_privilege('service_role','public.tb_pending_proposals','DELETE') THEN
    RAISE EXCEPTION 'service_role proposal repository privileges changed';
  END IF;
END;
$acl$;

-- The active proposal can be found only under the household and conversation
-- derived for the authenticated actor. The stored snapshot is the only source
-- of finance values; these RPCs accept no financial parameters.
DO $web_confirmations$
DECLARE
  actor_auth_id CONSTANT uuid := '54000000-0054-4000-8000-000000000001';
  actor_member_id CONSTANT uuid := '54000000-0054-4000-8000-000000000031';
  other_member_id CONSTANT uuid := '54000000-0054-4000-8000-000000000032';
  expense_category_id CONSTANT uuid := '54000000-0054-4000-8000-000000000042';
  income_category_id CONSTANT uuid := '54000000-0054-4000-8000-000000000044';
  failed_receipt_id CONSTANT uuid := '54000000-0054-4000-8000-000000000050';
  expense_proposal_id CONSTANT uuid := '54000000-0054-4000-8000-000000000101';
  other_proposal_id CONSTANT uuid := '54000000-0054-4000-8000-000000000102';
  wrong_conversation_proposal_id CONSTANT uuid := '54000000-0054-4000-8000-000000000103';
  income_proposal_id CONSTANT uuid := '54000000-0054-4000-8000-000000000104';
  reject_proposal_id CONSTANT uuid := '54000000-0054-4000-8000-000000000105';
  receipt_rollback_proposal_id CONSTANT uuid := '54000000-0054-4000-8000-000000000106';
  income_rollback_proposal_id CONSTANT uuid := '54000000-0054-4000-8000-000000000107';
  original_expense_payload jsonb;
  raw_expense jsonb;
  expense_persistence jsonb;
  raw_income jsonb;
  income_persistence jsonb;
  result jsonb;
  sqlstate_text text;
  case_row record;
  expected_version timestamptz;
  before_expenses bigint;
  before_incomes bigint;
  before_items bigint;
  before_distributions bigint;
  v_expense_id uuid;
  v_income_id uuid;
BEGIN
  raw_expense := jsonb_build_object(
    'paidByMemberId',actor_member_id,
    'totalAmount',12.50,
    'expenseDate','2026-11-05',
    'description','0054 confirmed expense',
    'categoryId',expense_category_id,
    'receiptId',NULL,
    'merchant','Market',
    'items',jsonb_build_array(jsonb_build_object(
      'name','Tea','quantity',1.000,'unitPrice',12.50,
      'totalAmount',12.50,'categoryId',NULL
    )),
    'splits',jsonb_build_array(jsonb_build_object(
      'householdMemberId',actor_member_id,'percentage',100.00
    ))
  );
  expense_persistence := jsonb_build_object(
    'householdId','54000000-0054-4000-8000-000000000010',
    'createdBy',actor_member_id,
    'paidByMemberId',actor_member_id,
    'categoryId',expense_category_id,
    'receiptId',NULL,
    'merchant','Market',
    'totalAmount',12.50,
    'expenseDate','2026-11-05',
    'description','0054 confirmed expense',
    'source','WEB',
    'items',raw_expense -> 'items',
    'distributions',jsonb_build_array(jsonb_build_object(
      'householdMemberId',actor_member_id,'amount',12.50,'percentage',100.00
    ))
  );
  original_expense_payload := jsonb_build_object(
    'actorMemberId',actor_member_id,'source','WEB','expense',raw_expense,
    '_web_confirmation',jsonb_build_object(
      'presented',raw_expense,'persistence',expense_persistence
    )
  );

  INSERT INTO public.tb_pending_proposals(
    id,household_id,conversation_key,actor_member_id,source,
    operation_type,payload,status,created_at,updated_at
  ) VALUES
    (expense_proposal_id,'54000000-0054-4000-8000-000000000010',
      'web:54000000-0054-4000-8000-000000000010:54000000-0054-4000-8000-000000000031',
      actor_member_id,'WEB','CREATE_EXPENSE',original_expense_payload,
      'AWAITING_CONFIRMATION','2026-11-06 10:00:00+00','2026-11-06 10:00:00+00'),
    (other_proposal_id,'54000000-0054-4000-8000-000000000010',
      'web:54000000-0054-4000-8000-000000000010:54000000-0054-4000-8000-000000000032',
      other_member_id,'WEB','CREATE_EXPENSE',
      jsonb_build_object('actorMemberId',other_member_id,'source','WEB','expense',raw_expense,
        '_web_confirmation',jsonb_build_object('presented',raw_expense,'persistence',expense_persistence)),
      'AWAITING_CONFIRMATION','2026-11-06 10:00:00+00','2026-11-06 10:00:00+00'),
    (wrong_conversation_proposal_id,'54000000-0054-4000-8000-000000000010',
      'web:untrusted-conversation-key',actor_member_id,'WEB','CREATE_EXPENSE',
      original_expense_payload,'AWAITING_CONFIRMATION',
      '2026-11-06 10:00:00+00','2026-11-06 10:00:00+00');

  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  PERFORM set_config('request.jwt.claim.sub',actor_auth_id::text,true);

  result := public.fn_confirm_web_pending_expense(
    expense_proposal_id,'54000000-0054-4000-8000-000000000010','2026-11-06 10:00:00+00'
  );
  IF result->>'status' IS DISTINCT FROM 'CREATED' THEN
    RAISE EXCEPTION 'Valid Web Expense confirmation failed: %',result;
  END IF;
  v_expense_id := (result->>'expense_id')::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM public.tb_expenses
     WHERE id=v_expense_id AND household_id='54000000-0054-4000-8000-000000000010'
       AND created_by=actor_member_id AND source='WEB' AND total_amount=12.50
  ) OR (SELECT count(*) FROM public.tb_expense_items WHERE expense_id=v_expense_id) <> 1
    OR (SELECT count(*) FROM public.tb_expense_distributions WHERE expense_id=v_expense_id) <> 1
    OR (SELECT status FROM public.tb_pending_proposals WHERE id=expense_proposal_id) <> 'COMPLETED' THEN
    RAISE EXCEPTION 'Web Expense confirmation did not persist one atomic result';
  END IF;
  result := public.fn_confirm_web_pending_expense(
    expense_proposal_id,'54000000-0054-4000-8000-000000000010','1900-01-01 00:00:00+00'
  );
  IF result->>'status' IS DISTINCT FROM 'ALREADY_COMPLETED'
     OR result->>'expense_id' IS DISTINCT FROM v_expense_id::text
     OR (SELECT count(*) FROM public.tb_expenses WHERE id=v_expense_id) <> 1 THEN
    RAISE EXCEPTION 'Completed Expense replay was not idempotent';
  END IF;

  -- Different household, actor proposal, and arbitrary conversation remain
  -- indistinguishable from an absent proposal to this authenticated actor.
  result := public.fn_confirm_web_pending_expense(
    other_proposal_id,'54000000-0054-4000-8000-000000000010','2026-11-06 10:00:00+00'
  );
  IF result->>'status' IS DISTINCT FROM 'NOT_FOUND' THEN
    RAISE EXCEPTION 'Other actor proposal was visible: %',result;
  END IF;
  result := public.fn_confirm_web_pending_expense(
    wrong_conversation_proposal_id,'54000000-0054-4000-8000-000000000010','2026-11-06 10:00:00+00'
  );
  IF result->>'status' IS DISTINCT FROM 'NOT_FOUND' THEN
    RAISE EXCEPTION 'Non-canonical conversation proposal was visible: %',result;
  END IF;

  raw_income := jsonb_build_object(
    'memberId',actor_member_id,'amount',27.75,'incomeDate','2026-11-05',
    'description','0054 confirmed income','categoryId',income_category_id
  );
  income_persistence := jsonb_build_object(
    'householdId','54000000-0054-4000-8000-000000000010',
    'createdBy',actor_member_id,'memberId',actor_member_id,'amount',27.75,
    'incomeDate','2026-11-05','description','0054 confirmed income',
    'categoryId',income_category_id
  );
  INSERT INTO public.tb_pending_proposals(
    id,household_id,conversation_key,actor_member_id,source,
    operation_type,payload,status,created_at,updated_at
  ) VALUES (
    income_proposal_id,'54000000-0054-4000-8000-000000000010',
    'web:54000000-0054-4000-8000-000000000010:54000000-0054-4000-8000-000000000031',
    actor_member_id,'WEB','CREATE_INCOME',
    jsonb_build_object('actorMemberId',actor_member_id,'source','WEB','income',raw_income,
      '_web_confirmation',jsonb_build_object('presented',raw_income,'persistence',income_persistence)),
    'AWAITING_CONFIRMATION','2026-11-06 10:01:00+00','2026-11-06 10:01:00+00'
  );
  result := public.fn_confirm_web_pending_expense(
    income_proposal_id,'54000000-0054-4000-8000-000000000010','2026-11-06 10:01:00+00'
  );
  IF result->>'status' IS DISTINCT FROM 'INVALID_OPERATION'
     OR (SELECT count(*) FROM public.tb_incomes WHERE description='0054 confirmed income') <> 0 THEN
    RAISE EXCEPTION 'Incompatible operation did not fail closed';
  END IF;
  result := public.fn_confirm_web_pending_income(
    income_proposal_id,'54000000-0054-4000-8000-000000000010','2026-11-06 10:01:00+00'
  );
  IF result->>'status' IS DISTINCT FROM 'CREATED' THEN
    RAISE EXCEPTION 'Valid Web Income confirmation failed: %',result;
  END IF;
  v_income_id := (result->>'income_id')::uuid;
  IF NOT EXISTS (
    SELECT 1 FROM public.tb_incomes
     WHERE id=v_income_id AND household_id='54000000-0054-4000-8000-000000000010'
       AND created_by=actor_member_id AND member_id=actor_member_id
       AND amount=27.75 AND category_id=income_category_id
  ) OR (SELECT status FROM public.tb_pending_proposals WHERE id=income_proposal_id) <> 'COMPLETED' THEN
    RAISE EXCEPTION 'Web Income confirmation did not persist one atomic result';
  END IF;
  result := public.fn_confirm_web_pending_income(
    income_proposal_id,'54000000-0054-4000-8000-000000000010','1900-01-01 00:00:00+00'
  );
  IF result->>'status' IS DISTINCT FROM 'ALREADY_COMPLETED'
     OR result->>'income_id' IS DISTINCT FROM v_income_id::text
     OR (SELECT count(*) FROM public.tb_incomes WHERE id=v_income_id) <> 1 THEN
    RAISE EXCEPTION 'Completed Income replay was not idempotent';
  END IF;

  INSERT INTO public.tb_pending_proposals(
    id,household_id,conversation_key,actor_member_id,source,
    operation_type,payload,status,created_at,updated_at
  ) VALUES (
    reject_proposal_id,'54000000-0054-4000-8000-000000000010',
    'web:54000000-0054-4000-8000-000000000010:54000000-0054-4000-8000-000000000031',
    actor_member_id,'WEB','CREATE_EXPENSE',original_expense_payload,
    'AWAITING_CONFIRMATION','2026-11-06 10:02:00+00','2026-11-06 10:02:00+00'
  );
  result := public.fn_reject_web_pending_proposal(
    reject_proposal_id,'54000000-0054-4000-8000-000000000010','CREATE_EXPENSE'
  );
  IF result->>'status' IS DISTINCT FROM 'REJECTED'
     OR (SELECT status FROM public.tb_pending_proposals WHERE id=reject_proposal_id) <> 'REJECTED'
     OR (SELECT count(*) FROM public.tb_expenses) <> 1 THEN
    RAISE EXCEPTION 'Web rejection wrote a movement or did not resolve the proposal';
  END IF;
  result := public.fn_reject_web_pending_proposal(
    reject_proposal_id,'54000000-0054-4000-8000-000000000010','CREATE_EXPENSE'
  );
  IF result->>'status' IS DISTINCT FROM 'REJECTED'
     OR (SELECT count(*) FROM public.tb_expenses) <> 1 THEN
    RAISE EXCEPTION 'Repeated Web rejection was not idempotent';
  END IF;
  result := public.fn_reject_web_pending_proposal(
    reject_proposal_id,'54000000-0054-4000-8000-000000000010','CREATE_INCOME'
  );
  IF result->>'status' IS DISTINCT FROM 'INVALID_OPERATION'
     OR (SELECT status FROM public.tb_pending_proposals WHERE id=reject_proposal_id) <> 'REJECTED'
     OR (SELECT count(*) FROM public.tb_expenses) <> 1 THEN
    RAISE EXCEPTION 'Web rejection ignored the caller operation selector';
  END IF;

  INSERT INTO public.tb_pending_proposals(
    id,household_id,conversation_key,actor_member_id,source,
    operation_type,payload,status,created_at,updated_at
  ) VALUES (
    receipt_rollback_proposal_id,'54000000-0054-4000-8000-000000000010',
    'web:54000000-0054-4000-8000-000000000031:receipt-rollback',
    actor_member_id,'WEB','CREATE_EXPENSE',
    jsonb_set(original_expense_payload,'{_web_confirmation,persistence,receiptId}',to_jsonb(failed_receipt_id)),
    'AWAITING_CONFIRMATION','2026-11-06 10:03:00+00','2026-11-06 10:03:00+00'
  );
  -- Use canonical key for the rollback fixture, then retain the receipt ID
  -- change consistently in both the presented payload and trusted snapshot.
  UPDATE public.tb_pending_proposals
     SET conversation_key='web:54000000-0054-4000-8000-000000000010:54000000-0054-4000-8000-000000000031',
         payload=jsonb_set(
           jsonb_set(
             jsonb_set(original_expense_payload,'{expense,receiptId}',to_jsonb(failed_receipt_id)),
             '{_web_confirmation,presented,receiptId}',to_jsonb(failed_receipt_id)
           ),
           '{_web_confirmation,persistence,receiptId}',to_jsonb(failed_receipt_id)
         )
   WHERE id=receipt_rollback_proposal_id;
  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  SELECT count(*) INTO before_expenses FROM public.tb_expenses;
  SELECT count(*) INTO before_items FROM public.tb_expense_items;
  SELECT count(*) INTO before_distributions FROM public.tb_expense_distributions;
  sqlstate_text := NULL;
  BEGIN
    PERFORM public.fn_confirm_web_pending_expense(
      receipt_rollback_proposal_id,
      '54000000-0054-4000-8000-000000000010',
      (SELECT updated_at FROM public.tb_pending_proposals WHERE id=receipt_rollback_proposal_id)
    );
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS sqlstate_text = RETURNED_SQLSTATE;
  END;
  IF sqlstate_text IS DISTINCT FROM '23514'
     OR (SELECT count(*) FROM public.tb_expenses) <> before_expenses
     OR (SELECT count(*) FROM public.tb_expense_items) <> before_items
     OR (SELECT count(*) FROM public.tb_expense_distributions) <> before_distributions
     OR (SELECT status FROM public.tb_pending_proposals WHERE id=receipt_rollback_proposal_id) <> 'AWAITING_CONFIRMATION'
     OR (SELECT expense_id FROM public.tb_receipts WHERE id=failed_receipt_id) IS NOT NULL THEN
    RAISE EXCEPTION 'Expense/receipt association failure was not atomic (state=%)',sqlstate_text;
  END IF;
  DELETE FROM public.tb_pending_proposals WHERE id=receipt_rollback_proposal_id;

  INSERT INTO public.tb_pending_proposals(
    id,household_id,conversation_key,actor_member_id,source,
    operation_type,payload,status,created_at,updated_at
  ) VALUES (
    income_rollback_proposal_id,'54000000-0054-4000-8000-000000000010',
    'web:54000000-0054-4000-8000-000000000031:income-rollback',
    actor_member_id,'WEB','CREATE_INCOME',
    jsonb_build_object('actorMemberId',actor_member_id,'source','WEB',
      'income',jsonb_set(raw_income,'{description}','"0054 rollback trigger"'::jsonb),
      '_web_confirmation',jsonb_build_object(
        'presented',jsonb_set(raw_income,'{description}','"0054 rollback trigger"'::jsonb),
        'persistence',jsonb_set(income_persistence,'{description}','"0054 rollback trigger"'::jsonb)
      )),
    'AWAITING_CONFIRMATION','2026-11-06 10:04:00+00','2026-11-06 10:04:00+00'
  );
  UPDATE public.tb_pending_proposals
     SET conversation_key='web:54000000-0054-4000-8000-000000000010:54000000-0054-4000-8000-000000000031'
   WHERE id=income_rollback_proposal_id;
  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  SELECT count(*) INTO before_incomes FROM public.tb_incomes;
  sqlstate_text := NULL;
  BEGIN
    PERFORM public.fn_confirm_web_pending_income(
      income_rollback_proposal_id,
      '54000000-0054-4000-8000-000000000010',
      (SELECT updated_at FROM public.tb_pending_proposals WHERE id=income_rollback_proposal_id)
    );
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS sqlstate_text = RETURNED_SQLSTATE;
  END;
  IF sqlstate_text IS DISTINCT FROM 'P0001'
     OR (SELECT count(*) FROM public.tb_incomes) <> before_incomes
     OR (SELECT status FROM public.tb_pending_proposals WHERE id=income_rollback_proposal_id) <> 'AWAITING_CONFIRMATION' THEN
    RAISE EXCEPTION 'Income failure was not atomic (state=%)',sqlstate_text;
  END IF;
  DELETE FROM public.tb_pending_proposals WHERE id=income_rollback_proposal_id;
END;
$web_confirmations$;

DROP TRIGGER test_0054_reject_income_insert ON public.tb_incomes;
DROP FUNCTION public.test_0054_reject_income_insert();

DO $expense_distribution_snapshot$
DECLARE
  household_id CONSTANT uuid := '54000000-0054-4000-8000-000000000010';
  actor_auth_id CONSTANT uuid := '54000000-0054-4000-8000-000000000001';
  actor_member_id CONSTANT uuid := '54000000-0054-4000-8000-000000000031';
  other_member_id CONSTANT uuid := '54000000-0054-4000-8000-000000000032';
  third_member_id CONSTANT uuid := '54000000-0054-4000-8000-000000000033';
  expense_category_id CONSTANT uuid := '54000000-0054-4000-8000-000000000042';
  proposal_id uuid;
  case_index integer := 0;
  case_value jsonb;
  splits_value jsonb;
  distributions_value jsonb;
  presented jsonb;
  persistence jsonb;
  result jsonb;
  state_text text;
  expected_allocation record;
  created_expense_id uuid;
  before_expenses bigint;
  before_items bigint;
  before_distributions bigint;
  before_receipt_links bigint;
BEGIN
  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  PERFORM set_config('request.jwt.claim.sub',actor_auth_id::text,true);

  FOR case_value IN
    SELECT entry.value
      FROM (VALUES
        (jsonb_build_object(
          'label','100.00 at 50/50 with 60/40 snapshot must fail',
          'total',100.00,
          'splits',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'percentage',50.00),
            jsonb_build_object('householdMemberId',other_member_id,'percentage',50.00)
          ),
          'distributions',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'amount',60.00,'percentage',50.00),
            jsonb_build_object('householdMemberId',other_member_id,'amount',40.00,'percentage',50.00)
          ),'expected_state','22023'
        )),
        (jsonb_build_object(
          'label','valid 100.00 at 50/50',
          'total',100.00,
          'splits',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'percentage',50.00),
            jsonb_build_object('householdMemberId',other_member_id,'percentage',50.00)
          ),
          'distributions',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'amount',50.00,'percentage',50.00),
            jsonb_build_object('householdMemberId',other_member_id,'amount',50.00,'percentage',50.00)
          ),'expected_state','CREATED',
          'expected_amounts',jsonb_build_array(
            jsonb_build_object('member',actor_member_id,'amount',50.00),
            jsonb_build_object('member',other_member_id,'amount',50.00)
          )
        )),
        (jsonb_build_object(
          'label','one cent 50/50 residual goes to lower member UUID',
          'total',0.01,
          'splits',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'percentage',50.00),
            jsonb_build_object('householdMemberId',other_member_id,'percentage',50.00)
          ),
          'distributions',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'amount',0.01,'percentage',50.00),
            jsonb_build_object('householdMemberId',other_member_id,'amount',0.00,'percentage',50.00)
          ),'expected_state','CREATED',
          'expected_amounts',jsonb_build_array(
            jsonb_build_object('member',actor_member_id,'amount',0.01),
            jsonb_build_object('member',other_member_id,'amount',0.00)
          )
        )),
        (jsonb_build_object(
          'label','three-member residual allocation matches calculateSplitAmounts',
          'total',0.05,
          'splits',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'percentage',33.34),
            jsonb_build_object('householdMemberId',other_member_id,'percentage',33.33),
            jsonb_build_object('householdMemberId',third_member_id,'percentage',33.33)
          ),
          'distributions',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'amount',0.02,'percentage',33.34),
            jsonb_build_object('householdMemberId',other_member_id,'amount',0.02,'percentage',33.33),
            jsonb_build_object('householdMemberId',third_member_id,'amount',0.01,'percentage',33.33)
          ),'expected_state','CREATED',
          'expected_amounts',jsonb_build_array(
            jsonb_build_object('member',actor_member_id,'amount',0.02),
            jsonb_build_object('member',other_member_id,'amount',0.02),
            jsonb_build_object('member',third_member_id,'amount',0.01)
          )
        )),
        (jsonb_build_object(
          'label','distribution amount precision exceeds cents',
          'total',100.00,
          'splits',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'percentage',50.00),
            jsonb_build_object('householdMemberId',other_member_id,'percentage',50.00)
          ),
          'distributions',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'amount',50.001,'percentage',50.00),
            jsonb_build_object('householdMemberId',other_member_id,'amount',49.999,'percentage',50.00)
          ),'expected_state','22023'
        )),
        (jsonb_build_object(
          'label','split percentage precision exceeds basis-point scale',
          'total',100.00,
          'splits',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'percentage',50.001),
            jsonb_build_object('householdMemberId',other_member_id,'percentage',49.999)
          ),
          'distributions',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'amount',50.00,'percentage',50.001),
            jsonb_build_object('householdMemberId',other_member_id,'amount',50.00,'percentage',49.999)
          ),'expected_state','22023'
        )),
        (jsonb_build_object(
          'label','split percentage outside 0..100',
          'total',100.00,
          'splits',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'percentage',100.01),
            jsonb_build_object('householdMemberId',other_member_id,'percentage',-0.01)
          ),
          'distributions',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'amount',100.00,'percentage',100.01),
            jsonb_build_object('householdMemberId',other_member_id,'amount',0.00,'percentage',-0.01)
          ),'expected_state','22023'
        )),
        (jsonb_build_object(
          'label','expense total precision exceeds cents',
          'total',100.001,
          'splits',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'percentage',50.00),
            jsonb_build_object('householdMemberId',other_member_id,'percentage',50.00)
          ),
          'distributions',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'amount',50.0005,'percentage',50.00),
            jsonb_build_object('householdMemberId',other_member_id,'amount',50.0005,'percentage',50.00)
          ),'expected_state','22023'
        )),
        (jsonb_build_object(
          'label','expense total exceeds NUMERIC(14,2)',
          'total',1000000000000.00,
          'splits',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'percentage',50.00),
            jsonb_build_object('householdMemberId',other_member_id,'percentage',50.00)
          ),
          'distributions',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'amount',500000000000.00,'percentage',50.00),
            jsonb_build_object('householdMemberId',other_member_id,'amount',500000000000.00,'percentage',50.00)
          ),'expected_state','22023'
        )),
        (jsonb_build_object(
          'label','distribution amount exceeds NUMERIC(14,2)',
          'total',100.00,
          'splits',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'percentage',50.00),
            jsonb_build_object('householdMemberId',other_member_id,'percentage',50.00)
          ),
          'distributions',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'amount',1000000000000.00,'percentage',50.00),
            jsonb_build_object('householdMemberId',other_member_id,'amount',-999999999900.00,'percentage',50.00)
          ),'expected_state','22023'
        )),
        (jsonb_build_object(
          'label','distribution amount NaN string is rejected as nonnumeric JSON',
          'total',100.00,
          'splits',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'percentage',50.00),
            jsonb_build_object('householdMemberId',other_member_id,'percentage',50.00)
          ),
          'distributions',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'amount','NaN','percentage',50.00),
            jsonb_build_object('householdMemberId',other_member_id,'amount',40.00,'percentage',50.00)
          ),'expected_state','22023'
        )),
        (jsonb_build_object(
          'label','distribution amount Infinity string is rejected as nonnumeric JSON',
          'total',100.00,
          'splits',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'percentage',50.00),
            jsonb_build_object('householdMemberId',other_member_id,'percentage',50.00)
          ),
          'distributions',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'amount','Infinity','percentage',50.00),
            jsonb_build_object('householdMemberId',other_member_id,'amount',40.00,'percentage',50.00)
          ),'expected_state','22023'
        )),
        (jsonb_build_object(
          'label','distribution amount -Infinity string is rejected as nonnumeric JSON',
          'total',100.00,
          'splits',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'percentage',50.00),
            jsonb_build_object('householdMemberId',other_member_id,'percentage',50.00)
          ),
          'distributions',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'amount','-Infinity','percentage',50.00),
            jsonb_build_object('householdMemberId',other_member_id,'amount',40.00,'percentage',50.00)
          ),'expected_state','22023'
        )),
        (jsonb_build_object(
          'label','distribution amount missing',
          'total',100.00,
          'splits',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'percentage',50.00),
            jsonb_build_object('householdMemberId',other_member_id,'percentage',50.00)
          ),
          'distributions',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'percentage',50.00),
            jsonb_build_object('householdMemberId',other_member_id,'amount',50.00,'percentage',50.00)
          ),'expected_state','22023'
        )),
        (jsonb_build_object(
          'label','distribution amount JSON null',
          'total',100.00,
          'splits',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'percentage',50.00),
            jsonb_build_object('householdMemberId',other_member_id,'percentage',50.00)
          ),
          'distributions',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'amount',NULL,'percentage',50.00),
            jsonb_build_object('householdMemberId',other_member_id,'amount',50.00,'percentage',50.00)
          ),'expected_state','22023'
        )),
        (jsonb_build_object(
          'label','distribution numeric string is rejected',
          'total',100.00,
          'splits',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'percentage',50.00),
            jsonb_build_object('householdMemberId',other_member_id,'percentage',50.00)
          ),
          'distributions',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'amount','60.00','percentage',50.00),
            jsonb_build_object('householdMemberId',other_member_id,'amount',40.00,'percentage',50.00)
          ),'expected_state','22023'
        )),
        (jsonb_build_object(
          'label','duplicate split member',
          'total',100.00,
          'splits',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'percentage',50.00),
            jsonb_build_object('householdMemberId',actor_member_id,'percentage',50.00)
          ),
          'distributions',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'amount',50.00,'percentage',50.00),
            jsonb_build_object('householdMemberId',actor_member_id,'amount',50.00,'percentage',50.00)
          ),'expected_state','22023'
        )),
        (jsonb_build_object(
          'label','missing distribution',
          'total',100.00,
          'splits',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'percentage',50.00),
            jsonb_build_object('householdMemberId',other_member_id,'percentage',50.00)
          ),
          'distributions',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'amount',50.00,'percentage',50.00)
          ),'expected_state','22023'
        )),
        (jsonb_build_object(
          'label','additional distribution',
          'total',100.00,
          'splits',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'percentage',50.00),
            jsonb_build_object('householdMemberId',other_member_id,'percentage',50.00)
          ),
          'distributions',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'amount',50.00,'percentage',50.00),
            jsonb_build_object('householdMemberId',other_member_id,'amount',50.00,'percentage',50.00),
            jsonb_build_object('householdMemberId',third_member_id,'amount',0.00,'percentage',0.00)
          ),'expected_state','22023'
        )),
        (jsonb_build_object(
          'label','distribution member does not match approved split',
          'total',100.00,
          'splits',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'percentage',50.00),
            jsonb_build_object('householdMemberId',other_member_id,'percentage',50.00)
          ),
          'distributions',jsonb_build_array(
            jsonb_build_object('householdMemberId',actor_member_id,'amount',50.00,'percentage',50.00),
            jsonb_build_object('householdMemberId',third_member_id,'amount',50.00,'percentage',50.00)
          ),'expected_state','22023'
        ))
      ) AS entry(value)
  LOOP
    case_index := case_index + 1;
    proposal_id := (
      '54000000-0054-4000-8000-' || pg_catalog.lpad((120 + case_index)::text,12,'0')
    )::uuid;
    splits_value := case_value -> 'splits';
    distributions_value := case_value -> 'distributions';
    presented := jsonb_build_object(
      'paidByMemberId',actor_member_id,
      'totalAmount',case_value -> 'total',
      'expenseDate','2026-11-05',
      'description',case_value ->> 'label',
      'categoryId',expense_category_id,
      'receiptId',NULL,
      'merchant',NULL,
      'items','[]'::jsonb,
      'splits',splits_value
    );
    persistence := jsonb_build_object(
      'householdId',household_id,
      'createdBy',actor_member_id,
      'paidByMemberId',actor_member_id,
      'categoryId',expense_category_id,
      'receiptId',NULL,
      'merchant',NULL,
      'totalAmount',case_value -> 'total',
      'expenseDate','2026-11-05',
      'description',case_value ->> 'label',
      'source','WEB',
      'items','[]'::jsonb,
      'distributions',distributions_value
    );
    INSERT INTO public.tb_pending_proposals(
      id,household_id,conversation_key,actor_member_id,source,
      operation_type,payload,status,created_at,updated_at
    ) VALUES (
      proposal_id,household_id,
      'web:54000000-0054-4000-8000-000000000010:54000000-0054-4000-8000-000000000031',
      actor_member_id,'WEB','CREATE_EXPENSE',
      jsonb_build_object(
        'actorMemberId',actor_member_id,'source','WEB','expense',presented,
        '_web_confirmation',jsonb_build_object('presented',presented,'persistence',persistence)
      ),
      'AWAITING_CONFIRMATION',clock_timestamp(),clock_timestamp()
    );

    SELECT count(*) INTO before_expenses FROM public.tb_expenses;
    SELECT count(*) INTO before_items FROM public.tb_expense_items;
    SELECT count(*) INTO before_distributions FROM public.tb_expense_distributions;
    SELECT count(*) INTO before_receipt_links
      FROM public.tb_receipts WHERE expense_id IS NOT NULL;
    state_text := NULL;
    IF case_value ->> 'expected_state' = 'CREATED' THEN
      result := public.fn_confirm_web_pending_expense(
        proposal_id,household_id,
        (SELECT updated_at FROM public.tb_pending_proposals WHERE id=proposal_id)
      );
      IF result ->> 'status' IS DISTINCT FROM 'CREATED' THEN
        RAISE EXCEPTION 'Valid split snapshot failed (%): %',case_value ->> 'label',result;
      END IF;
      created_expense_id := (result ->> 'expense_id')::uuid;
      IF (SELECT count(*) FROM public.tb_expenses AS expense WHERE expense.id=created_expense_id) <> 1
         OR (SELECT count(*) FROM public.tb_expenses) <> before_expenses + 1
         OR (SELECT count(*) FROM public.tb_expense_items) <> before_items
         OR (SELECT count(*) FROM public.tb_expense_distributions AS distribution
              WHERE distribution.expense_id=created_expense_id)
              <> pg_catalog.jsonb_array_length(case_value -> 'expected_amounts')
         OR (SELECT count(*) FROM public.tb_expense_distributions) <> before_distributions
              + pg_catalog.jsonb_array_length(case_value -> 'expected_amounts')
         OR (SELECT count(*) FROM public.tb_receipts WHERE expense_id IS NOT NULL)
              <> before_receipt_links
         OR (SELECT status FROM public.tb_pending_proposals WHERE id=proposal_id)
              IS DISTINCT FROM 'COMPLETED' THEN
        RAISE EXCEPTION 'Valid split snapshot did not persist atomically (%)',case_value ->> 'label';
      END IF;
      FOR expected_allocation IN
        SELECT value FROM pg_catalog.jsonb_array_elements(case_value -> 'expected_amounts')
      LOOP
        IF (SELECT count(*) FROM public.tb_expense_distributions AS distribution
             WHERE distribution.expense_id=created_expense_id
               AND distribution.household_member_id=(expected_allocation.value ->> 'member')::uuid
               AND distribution.amount=(expected_allocation.value ->> 'amount')::numeric) <> 1 THEN
          RAISE EXCEPTION 'Persisted residual allocation differs from expected (%)',case_value ->> 'label';
        END IF;
      END LOOP;
      IF (SELECT sum(distribution.amount)
            FROM public.tb_expense_distributions AS distribution
           WHERE distribution.expense_id=created_expense_id)
           IS DISTINCT FROM (case_value ->> 'total')::numeric THEN
        RAISE EXCEPTION 'Persisted split amounts do not sum to Expense total (%)',case_value ->> 'label';
      END IF;
    ELSE
      BEGIN
        PERFORM public.fn_confirm_web_pending_expense(
          proposal_id,household_id,
          (SELECT updated_at FROM public.tb_pending_proposals WHERE id=proposal_id)
        );
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS state_text = RETURNED_SQLSTATE;
      END;
      IF state_text IS DISTINCT FROM case_value ->> 'expected_state'
         OR (SELECT count(*) FROM public.tb_expenses) <> before_expenses
         OR (SELECT count(*) FROM public.tb_expense_items) <> before_items
         OR (SELECT count(*) FROM public.tb_expense_distributions) <> before_distributions
         OR (SELECT count(*) FROM public.tb_receipts WHERE expense_id IS NOT NULL)
              <> before_receipt_links
         OR (SELECT status FROM public.tb_pending_proposals WHERE id=proposal_id)
              IS DISTINCT FROM 'AWAITING_CONFIRMATION' THEN
        RAISE EXCEPTION 'Invalid split snapshot changed state or escaped validation (% state=%)',
          case_value ->> 'label',state_text;
      END IF;
      DELETE FROM public.tb_pending_proposals WHERE id=proposal_id;
    END IF;
  END LOOP;
END;
$expense_distribution_snapshot$;

DO $income_snapshot_validation$
DECLARE
  household_id CONSTANT uuid := '54000000-0054-4000-8000-000000000010';
  actor_auth_id CONSTANT uuid := '54000000-0054-4000-8000-000000000001';
  actor_member_id CONSTANT uuid := '54000000-0054-4000-8000-000000000031';
  income_category_id CONSTANT uuid := '54000000-0054-4000-8000-000000000044';
  proposal_id uuid;
  case_index integer := 0;
  case_value jsonb;
  presented jsonb;
  persistence jsonb;
  result jsonb;
  state_text text;
  income_id uuid;
  before_incomes bigint;
BEGIN
  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  PERFORM set_config('request.jwt.claim.sub',actor_auth_id::text,true);

  FOR case_value IN
    SELECT entry.value
      FROM (VALUES
        (jsonb_build_object(
          'label','valid finite Income amount',
          'presented_amount',1.23,'persistence_amount',1.23,'expected_state','CREATED'
        )),
        (jsonb_build_object(
          'label','Income snapshot amount differs from payload',
          'presented_amount',40.12,'persistence_amount',40.13,'expected_state','40001'
        )),
        (jsonb_build_object(
          'label','Income amount has precision beyond cents',
          'presented_amount',10.129,'persistence_amount',10.129,'expected_state','22023'
        )),
        (jsonb_build_object(
          'label','Income amount exceeds NUMERIC(14,2)',
          'presented_amount',1000000000000.00,
          'persistence_amount',1000000000000.00,'expected_state','22023'
        )),
        (jsonb_build_object(
          'label','Income NaN string is rejected as nonnumeric JSON',
          'presented_amount','NaN','persistence_amount','NaN','expected_state','22023'
        )),
        (jsonb_build_object(
          'label','Income Infinity string is rejected as nonnumeric JSON',
          'presented_amount','Infinity','persistence_amount','Infinity','expected_state','22023'
        )),
        (jsonb_build_object(
          'label','Income -Infinity string is rejected as nonnumeric JSON',
          'presented_amount','-Infinity','persistence_amount','-Infinity','expected_state','22023'
        ))
      ) AS entry(value)
  LOOP
    case_index := case_index + 1;
    proposal_id := (
      '54000000-0054-4000-8000-' || pg_catalog.lpad((220 + case_index)::text,12,'0')
    )::uuid;
    presented := jsonb_build_object(
      'memberId',actor_member_id,
      'amount',case_value -> 'presented_amount',
      'incomeDate','2026-11-05',
      'description',case_value ->> 'label',
      'categoryId',income_category_id
    );
    persistence := jsonb_build_object(
      'householdId',household_id,
      'createdBy',actor_member_id,
      'memberId',actor_member_id,
      'amount',case_value -> 'persistence_amount',
      'incomeDate','2026-11-05',
      'description',case_value ->> 'label',
      'categoryId',income_category_id
    );
    INSERT INTO public.tb_pending_proposals(
      id,household_id,conversation_key,actor_member_id,source,
      operation_type,payload,status,created_at,updated_at
    ) VALUES (
      proposal_id,household_id,
      'web:54000000-0054-4000-8000-000000000010:54000000-0054-4000-8000-000000000031',
      actor_member_id,'WEB','CREATE_INCOME',
      jsonb_build_object(
        'actorMemberId',actor_member_id,'source','WEB','income',presented,
        '_web_confirmation',jsonb_build_object('presented',presented,'persistence',persistence)
      ),
      'AWAITING_CONFIRMATION',clock_timestamp(),clock_timestamp()
    );
    SELECT count(*) INTO before_incomes FROM public.tb_incomes;
    state_text := NULL;
    IF case_value ->> 'expected_state' = 'CREATED' THEN
      result := public.fn_confirm_web_pending_income(
        proposal_id,household_id,
        (SELECT updated_at FROM public.tb_pending_proposals WHERE id=proposal_id)
      );
      IF result ->> 'status' IS DISTINCT FROM 'CREATED' THEN
        RAISE EXCEPTION 'Valid finite Income snapshot failed (%): %',case_value ->> 'label',result;
      END IF;
      income_id := (result ->> 'income_id')::uuid;
      IF (SELECT count(*) FROM public.tb_incomes) <> before_incomes + 1
         OR (SELECT amount FROM public.tb_incomes WHERE id=income_id)
              IS DISTINCT FROM (case_value ->> 'presented_amount')::numeric
         OR (SELECT status FROM public.tb_pending_proposals WHERE id=proposal_id)
              IS DISTINCT FROM 'COMPLETED' THEN
        RAISE EXCEPTION 'Valid finite Income did not persist atomically';
      END IF;
    ELSE
      BEGIN
        PERFORM public.fn_confirm_web_pending_income(
          proposal_id,household_id,
          (SELECT updated_at FROM public.tb_pending_proposals WHERE id=proposal_id)
        );
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS state_text = RETURNED_SQLSTATE;
      END;
      IF state_text IS DISTINCT FROM case_value ->> 'expected_state'
         OR (SELECT count(*) FROM public.tb_incomes) <> before_incomes
         OR (SELECT status FROM public.tb_pending_proposals WHERE id=proposal_id)
              IS DISTINCT FROM 'AWAITING_CONFIRMATION' THEN
        RAISE EXCEPTION 'Invalid Income snapshot changed state or escaped validation (%) state=%',
          case_value ->> 'label',state_text;
      END IF;
      DELETE FROM public.tb_pending_proposals WHERE id=proposal_id;
    END IF;
  END LOOP;
END;
$income_snapshot_validation$;

DO $payload_fidelity$
DECLARE
  household_id CONSTANT uuid := '54000000-0054-4000-8000-000000000010';
  actor_auth_id CONSTANT uuid := '54000000-0054-4000-8000-000000000001';
  actor_member_id CONSTANT uuid := '54000000-0054-4000-8000-000000000031';
  expense_category_id CONSTANT uuid := '54000000-0054-4000-8000-000000000042';
  proposal_id CONSTANT uuid := '54000000-0054-4000-8000-000000000108';
  raw_expense jsonb;
  persistence jsonb;
  original_payload jsonb;
  mutation record;
  state_text text;
  before_count bigint;
  expected_version timestamptz;
BEGIN
  raw_expense := jsonb_build_object(
    'paidByMemberId',actor_member_id,'totalAmount',8.00,'expenseDate','2026-11-05',
    'description','0054 payload fidelity','categoryId',expense_category_id,
    'receiptId',NULL,'merchant',NULL,'items',jsonb_build_array(jsonb_build_object(
      'name','Bread','quantity',1.000,'unitPrice',8.00,'totalAmount',8.00,'categoryId',NULL
    )), 'splits',jsonb_build_array(jsonb_build_object(
      'householdMemberId',actor_member_id,'percentage',100.00
    ))
  );
  persistence := jsonb_build_object(
    'householdId',household_id,'createdBy',actor_member_id,
    'paidByMemberId',actor_member_id,'categoryId',expense_category_id,
    'receiptId',NULL,'merchant',NULL,'totalAmount',8.00,'expenseDate','2026-11-05',
    'description','0054 payload fidelity','source','WEB','items',raw_expense->'items',
    'distributions',jsonb_build_array(jsonb_build_object(
      'householdMemberId',actor_member_id,'amount',8.00,'percentage',100.00
    ))
  );
  original_payload := jsonb_build_object(
    'actorMemberId',actor_member_id,'source','WEB','expense',raw_expense,
    '_web_confirmation',jsonb_build_object('presented',raw_expense,'persistence',persistence)
  );
  INSERT INTO public.tb_pending_proposals(
    id,household_id,conversation_key,actor_member_id,source,
    operation_type,payload,status,created_at,updated_at
  ) VALUES (
    proposal_id,household_id,
    'web:54000000-0054-4000-8000-000000000010:54000000-0054-4000-8000-000000000031',
    actor_member_id,'WEB','CREATE_EXPENSE',original_payload,
    'AWAITING_CONFIRMATION','2026-11-06 10:05:00+00','2026-11-06 10:05:00+00'
  );
  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  PERFORM set_config('request.jwt.claim.sub',actor_auth_id::text,true);
  SELECT count(*) INTO before_count FROM public.tb_expenses;
  FOR mutation IN
    SELECT path,value FROM (VALUES
      (ARRAY['expense','totalAmount']::text[],'99'::jsonb),
      (ARRAY['expense','categoryId']::text[],'"54000000-0054-4000-8000-000000000044"'::jsonb),
      (ARRAY['expense','paidByMemberId']::text[],'"54000000-0054-4000-8000-000000000032"'::jsonb),
      (ARRAY['expense','items','0','name']::text[],'"Changed item"'::jsonb),
      (ARRAY['expense','splits','0','percentage']::text[],'50'::jsonb)
    ) AS cases(path,value)
  LOOP
    UPDATE public.tb_pending_proposals
       SET payload=jsonb_set(original_payload,mutation.path,mutation.value)
     WHERE id=proposal_id;
    SELECT updated_at INTO expected_version FROM public.tb_pending_proposals WHERE id=proposal_id;
    state_text := NULL;
    BEGIN
      PERFORM public.fn_confirm_web_pending_expense(proposal_id,household_id,expected_version);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS state_text = RETURNED_SQLSTATE;
    END;
    IF state_text IS DISTINCT FROM '22023'
       OR (SELECT count(*) FROM public.tb_expenses) <> before_count
       OR (SELECT status FROM public.tb_pending_proposals WHERE id=proposal_id) <> 'AWAITING_CONFIRMATION' THEN
      RAISE EXCEPTION 'Tampered proposal field was accepted or changed state: %, %',mutation.path,state_text;
    END IF;
  END LOOP;
  UPDATE public.tb_pending_proposals SET payload=original_payload WHERE id=proposal_id;
  state_text := NULL;
  BEGIN
    PERFORM public.fn_confirm_web_pending_expense(proposal_id,household_id,'1900-01-01 00:00:00+00');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS state_text = RETURNED_SQLSTATE;
  END;
  IF state_text IS DISTINCT FROM '40001'
     OR (SELECT count(*) FROM public.tb_expenses) <> before_count THEN
    RAISE EXCEPTION 'Stale proposal version was not rejected atomically';
  END IF;
  DELETE FROM public.tb_pending_proposals WHERE id=proposal_id;

  -- Legacy Web proposals created before 0054 have no server-produced
  -- confirmation snapshot. They must fail closed without a financial write.
  INSERT INTO public.tb_pending_proposals(
    id,household_id,conversation_key,actor_member_id,source,
    operation_type,payload,status,created_at,updated_at
  ) VALUES (
    proposal_id,household_id,
    'web:54000000-0054-4000-8000-000000000010:54000000-0054-4000-8000-000000000031',
    actor_member_id,'WEB','CREATE_EXPENSE',
    jsonb_build_object('actorMemberId',actor_member_id,'source','WEB','expense',raw_expense),
    'AWAITING_CONFIRMATION','2026-11-06 10:06:00+00','2026-11-06 10:06:00+00'
  );
  SELECT count(*) INTO before_count FROM public.tb_expenses;
  state_text := NULL;
  BEGIN
    PERFORM public.fn_confirm_web_pending_expense(
      proposal_id,household_id,
      (SELECT updated_at FROM public.tb_pending_proposals WHERE id=proposal_id)
    );
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS state_text = RETURNED_SQLSTATE;
  END;
  IF state_text IS DISTINCT FROM '22023'
     OR (SELECT count(*) FROM public.tb_expenses) <> before_count
     OR (SELECT status FROM public.tb_pending_proposals WHERE id=proposal_id) <> 'AWAITING_CONFIRMATION' THEN
    RAISE EXCEPTION 'Legacy Web proposal without snapshot did not fail closed';
  END IF;
END;
$payload_fidelity$;

DO $authorization_denials$
DECLARE
  household_id CONSTANT uuid := '54000000-0054-4000-8000-000000000010';
  other_household_id CONSTANT uuid := '54000000-0054-4000-8000-000000000011';
  proposal_id CONSTANT uuid := '54000000-0054-4000-8000-000000000108';
  unauthenticated_ids uuid[] := ARRAY[
    '54000000-0054-4000-8000-000000000003'::uuid,
    '54000000-0054-4000-8000-000000000004'::uuid
  ];
  identity_id uuid;
  state_text text;
BEGIN
  UPDATE auth.users SET email_confirmed_at=NULL
   WHERE id='54000000-0054-4000-8000-000000000001';
  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  PERFORM set_config('request.jwt.claim.sub','54000000-0054-4000-8000-000000000001',true);
  state_text := NULL;
  BEGIN
    PERFORM public.fn_reject_web_pending_proposal(proposal_id,household_id,'CREATE_EXPENSE');
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS state_text = RETURNED_SQLSTATE;
  END;
  IF state_text IS DISTINCT FROM '42501' THEN
    RAISE EXCEPTION 'Unconfirmed email did not fail with eligibility denial: %',state_text;
  END IF;
  UPDATE auth.users SET email_confirmed_at=clock_timestamp()
   WHERE id='54000000-0054-4000-8000-000000000001';

  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  PERFORM set_config('request.jwt.claim.sub','54000000-0054-4000-8000-000000000001',true);
  state_text := NULL;
  BEGIN
    PERFORM public.fn_reject_web_pending_proposal(
      proposal_id,other_household_id,'CREATE_EXPENSE'
    );
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS state_text = RETURNED_SQLSTATE;
  END;
  IF state_text IS DISTINCT FROM '42501' THEN
    RAISE EXCEPTION 'Authenticated actor selected a household without active membership: %',state_text;
  END IF;

  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  PERFORM set_config('request.jwt.claim.sub','',true);
  state_text := NULL;
  BEGIN
    PERFORM public.fn_reject_web_pending_proposal(proposal_id,household_id,'CREATE_EXPENSE');
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS state_text = RETURNED_SQLSTATE;
  END;
  IF state_text IS DISTINCT FROM '42501' THEN
    RAISE EXCEPTION 'Missing auth.uid did not fail closed: %',state_text;
  END IF;

  FOREACH identity_id IN ARRAY unauthenticated_ids LOOP
    PERFORM set_config('request.jwt.claim.sub',identity_id::text,true);
    state_text := NULL;
    BEGIN
      PERFORM public.fn_reject_web_pending_proposal(proposal_id,household_id,'CREATE_EXPENSE');
    EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS state_text = RETURNED_SQLSTATE;
    END;
    IF state_text IS DISTINCT FROM '42501' THEN
      RAISE EXCEPTION 'User without an active membership was not denied: %',state_text;
    END IF;
  END LOOP;

  PERFORM set_config('request.jwt.claim.sub','54000000-0054-4000-8000-000000000001',true);
  PERFORM set_config('request.jwt.claim.role','anon',true);
  state_text := NULL;
  BEGIN
    PERFORM public.fn_reject_web_pending_proposal(proposal_id,household_id,'CREATE_EXPENSE');
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS state_text = RETURNED_SQLSTATE;
  END;
  IF state_text IS DISTINCT FROM '42501' THEN
    RAISE EXCEPTION 'anon can execute Web proposal RPC: %',state_text;
  END IF;

  PERFORM set_config('request.jwt.claim.role','service_role',true);
  state_text := NULL;
  BEGIN
    PERFORM public.fn_reject_web_pending_proposal(proposal_id,household_id,'CREATE_EXPENSE');
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS state_text = RETURNED_SQLSTATE;
  END;
  IF state_text IS DISTINCT FROM '42501' THEN
    RAISE EXCEPTION 'service_role can execute Web proposal RPC: %',state_text;
  END IF;
END;
$authorization_denials$;

-- Verify actual effective EXECUTE as authenticated, then negative calls under
-- anon and service_role. The successful calls are terminal idempotent replays.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','54000000-0054-4000-8000-000000000001',true);
DO $authenticated_table_write_denied$
DECLARE state_text text;
BEGIN
  BEGIN
    UPDATE public.tb_pending_proposals
       SET payload=jsonb_set(payload,'{_web_confirmation,presented,totalAmount}','999'::jsonb)
     WHERE id='54000000-0054-4000-8000-000000000105';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS state_text=RETURNED_SQLSTATE;
  END;
  IF state_text IS DISTINCT FROM '42501' THEN
    RAISE EXCEPTION 'authenticated can directly alter the stored proposal snapshot: %',state_text;
  END IF;
END;
$authenticated_table_write_denied$;
DO $authenticated_execute$
DECLARE r jsonb;
BEGIN
  r := public.fn_confirm_web_pending_expense(
    '54000000-0054-4000-8000-000000000101',
    '54000000-0054-4000-8000-000000000010','1900-01-01 00:00:00+00'
  );
  IF r->>'status' IS DISTINCT FROM 'ALREADY_COMPLETED' THEN RAISE EXCEPTION 'authenticated Expense RPC denied: %',r; END IF;
  r := public.fn_confirm_web_pending_income(
    '54000000-0054-4000-8000-000000000104',
    '54000000-0054-4000-8000-000000000010','1900-01-01 00:00:00+00'
  );
  IF r->>'status' IS DISTINCT FROM 'ALREADY_COMPLETED' THEN RAISE EXCEPTION 'authenticated Income RPC denied: %',r; END IF;
  r := public.fn_reject_web_pending_proposal(
    '54000000-0054-4000-8000-000000000105','54000000-0054-4000-8000-000000000010','CREATE_EXPENSE'
  );
  IF r->>'status' IS DISTINCT FROM 'REJECTED' THEN RAISE EXCEPTION 'authenticated reject RPC denied: %',r; END IF;
END;
$authenticated_execute$;
RESET ROLE;

SET LOCAL ROLE anon;
DO $anon_denied$
DECLARE state_text text;
BEGIN
  BEGIN
    PERFORM public.fn_reject_web_pending_proposal(
      '54000000-0054-4000-8000-000000000105','54000000-0054-4000-8000-000000000010','CREATE_EXPENSE'
    );
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS state_text = RETURNED_SQLSTATE;
  END;
  IF state_text IS DISTINCT FROM '42501' THEN RAISE EXCEPTION 'anon EXECUTE was not denied: %',state_text; END IF;
END;
$anon_denied$;
RESET ROLE;

SET LOCAL ROLE service_role;
DO $service_role_denied$
DECLARE state_text text;
BEGIN
  BEGIN
    PERFORM public.fn_reject_web_pending_proposal(
      '54000000-0054-4000-8000-000000000105','54000000-0054-4000-8000-000000000010','CREATE_EXPENSE'
    );
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS state_text = RETURNED_SQLSTATE;
  END;
  IF state_text IS DISTINCT FROM '42501' THEN RAISE EXCEPTION 'service_role EXECUTE was not denied: %',state_text; END IF;
END;
$service_role_denied$;
RESET ROLE;

ROLLBACK;
