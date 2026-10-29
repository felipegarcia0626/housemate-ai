BEGIN;

-- Local Auth fixture only. Production migration never manufactures auth.users.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users(id UUID PRIMARY KEY, email TEXT);
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_confirmed_at TIMESTAMPTZ;
INSERT INTO auth.users(id,email,email_confirmed_at)
VALUES ('42000000-0042-4000-8000-000000000001','eligible@example.test',now());
UPDATE public.tb_users SET auth_user_id='42000000-0042-4000-8000-000000000001'
WHERE id='00000000-0000-4000-8000-000000000011';

CREATE FUNCTION pg_temp.expect_financial_denial(statement TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE before_income BIGINT; before_expense BIGINT; denial_detail TEXT;
BEGIN
  SELECT count(*) INTO before_income FROM public.tb_incomes;
  SELECT count(*) INTO before_expense FROM public.tb_expenses;
  BEGIN
    EXECUTE statement;
    RAISE EXCEPTION 'Expected financial denial';
  EXCEPTION WHEN insufficient_privilege THEN
    GET STACKED DIAGNOSTICS denial_detail = PG_EXCEPTION_DETAIL;
    IF SQLERRM <> 'Financial access is unavailable' OR denial_detail IS DISTINCT FROM 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1' THEN RAISE; END IF;
  END;
  IF before_income <> (SELECT count(*) FROM public.tb_incomes)
     OR before_expense <> (SELECT count(*) FROM public.tb_expenses) THEN
    RAISE EXCEPTION 'Denied operation changed financial data';
  END IF;
END;
$$;

DO $$
DECLARE income_id UUID; v_expense_id UUID; row_income JSONB; denied TEXT; expense_statement TEXT;
BEGIN
  denied := $q$SELECT public.fn_create_income_eligible(
    '42000000-0042-4000-8000-000000000001','00000000-0000-4000-8000-000000000021',
    '00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000021',42,current_date,'Eligibility test',NULL)$q$;
  UPDATE auth.users SET email=NULL WHERE id='42000000-0042-4000-8000-000000000001';
  PERFORM pg_temp.expect_financial_denial(denied);
  UPDATE auth.users SET email='eligible@example.test',email_confirmed_at=NULL;
  PERFORM pg_temp.expect_financial_denial(denied);
  UPDATE auth.users SET email_confirmed_at=now();
  PERFORM pg_temp.expect_financial_denial(replace(denied,'42000000-0042-4000-8000-000000000001','42000000-0042-4000-8000-000000000002'));
  PERFORM pg_temp.expect_financial_denial(replace(denied,'00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000022'));
  PERFORM pg_temp.expect_financial_denial(replace(denied,'00000000-0000-4000-8000-000000000001','42000000-0042-4000-8000-000000000099'));
  UPDATE public.tb_household_members SET status='LEFT' WHERE id='00000000-0000-4000-8000-000000000021';
  PERFORM pg_temp.expect_financial_denial(denied);
  UPDATE public.tb_household_members SET status='ACTIVE' WHERE id='00000000-0000-4000-8000-000000000021';

  EXECUTE denied;
  -- Composite result from SELECT is easier to inspect directly below.
  SELECT id INTO income_id FROM public.tb_incomes WHERE description='Eligibility test';
  IF income_id IS NULL THEN RAISE EXCEPTION 'Eligible income was not created'; END IF;
  row_income := public.fn_update_income_eligible('42000000-0042-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000001',income_id,'{"amount":43,"category_id":null}');
  IF (row_income->>'amount')::numeric <> 43 THEN RAISE EXCEPTION 'Income update failed'; END IF;
  UPDATE auth.users SET email_confirmed_at=NULL WHERE id='42000000-0042-4000-8000-000000000001';
  PERFORM pg_temp.expect_financial_denial(format($q$SELECT public.fn_update_income_eligible(
    '42000000-0042-4000-8000-000000000001','00000000-0000-4000-8000-000000000021',
    '00000000-0000-4000-8000-000000000001',%L,'{"amount":99}')$q$,income_id));
  PERFORM pg_temp.expect_financial_denial(format($q$SELECT public.fn_delete_income_eligible(
    '42000000-0042-4000-8000-000000000001','00000000-0000-4000-8000-000000000021',
    '00000000-0000-4000-8000-000000000001',%L)$q$,income_id));
  IF NOT EXISTS(SELECT 1 FROM public.tb_incomes WHERE id=income_id AND amount=43) THEN
    RAISE EXCEPTION 'Denied income mutation altered the existing row';
  END IF;
  UPDATE auth.users SET email_confirmed_at=now() WHERE id='42000000-0042-4000-8000-000000000001';
  IF public.fn_delete_income_eligible('42000000-0042-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000001',income_id) IS DISTINCT FROM income_id THEN
    RAISE EXCEPTION 'Income delete failed';
  END IF;

  INSERT INTO public.tb_receipts(id,household_id,conversation_key,storage_path,original_filename,mime_type,processing_status,analysis_payload)
    VALUES('42000000-0042-4000-8000-000000000088','00000000-0000-4000-8000-000000000001',
      'eligibility-receipt','receipts/eligibility.jpg','eligibility.jpg','image/jpeg','PROCESSED','{}');
  expense_statement := $call$SELECT public.fn_create_expense_eligible(
    p_auth_user_id=>'42000000-0042-4000-8000-000000000001',
    p_actor_member_id=>'00000000-0000-4000-8000-000000000021',
    p_household_id=>'00000000-0000-4000-8000-000000000001',
    p_created_by=>'00000000-0000-4000-8000-000000000021',
    p_paid_by=>'00000000-0000-4000-8000-000000000021',p_category_id=>NULL,p_receipt_id=>'42000000-0042-4000-8000-000000000088',
    p_merchant=>NULL,p_total_amount=>42,p_expense_date=>current_date,p_description=>'Eligibility expense',
    p_source=>'RECEIPT',p_items=>'[]',p_distributions=>'[{"householdMemberId":"00000000-0000-4000-8000-000000000021","amount":42,"percentage":100}]')$call$;
  UPDATE auth.users SET email_confirmed_at=NULL WHERE id='42000000-0042-4000-8000-000000000001';
  PERFORM pg_temp.expect_financial_denial(expense_statement);
  IF EXISTS(SELECT 1 FROM public.tb_receipts WHERE id='42000000-0042-4000-8000-000000000088' AND expense_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Denied receipt-derived expense changed receipt';
  END IF;
  UPDATE auth.users SET email_confirmed_at=now() WHERE id='42000000-0042-4000-8000-000000000001';
  EXECUTE expense_statement INTO v_expense_id;
  IF NOT EXISTS(SELECT 1 FROM public.tb_receipts WHERE id='42000000-0042-4000-8000-000000000088' AND expense_id=v_expense_id) THEN
    RAISE EXCEPTION 'Protected expense failed to associate receipt';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.tb_expense_distributions WHERE tb_expense_distributions.expense_id=v_expense_id) THEN
    RAISE EXCEPTION 'Expense distributions missing';
  END IF;
  PERFORM public.fn_update_expense_eligible('42000000-0042-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000001',
    v_expense_id,true,'Updated eligible merchant',false,NULL,NULL,NULL,NULL,false,NULL,NULL,NULL);
  IF NOT EXISTS(SELECT 1 FROM public.tb_expenses e WHERE e.id=v_expense_id AND e.merchant='Updated eligible merchant') THEN
    RAISE EXCEPTION 'Protected expense update failed';
  END IF;
  PERFORM public.fn_delete_expense_eligible('42000000-0042-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000001',v_expense_id);
  IF NOT EXISTS(SELECT 1 FROM public.tb_expenses e WHERE e.id=v_expense_id AND e.status='CANCELLED') THEN
    RAISE EXCEPTION 'Expense cancellation failed';
  END IF;
END;
$$;

DO $$
DECLARE proposal_id UUID; version TIMESTAMPTZ; result JSONB; movement TEXT; channel TEXT;
  call_sql TEXT; row_count_before BIGINT; expense_count_before BIGINT;
  lease UUID := gen_random_uuid(); epoch BIGINT;
BEGIN
  SELECT (public.fn_acquire_whatsapp_context_lease('00000000-0000-4000-8000-000000000011',lease)->>'epoch')::BIGINT INTO epoch;
  PERFORM public.fn_transition_whatsapp_household_context('00000000-0000-4000-8000-000000000011','eligibility-phone',lease,epoch,
    'SET_SELECTION','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000021');
  FOREACH channel IN ARRAY ARRAY['WEB','WHATSAPP'] LOOP
  FOREACH movement IN ARRAY ARRAY['expense','income'] LOOP
    proposal_id := gen_random_uuid();
    INSERT INTO public.tb_pending_proposals(id,household_id,conversation_key,operation_type,payload,status)
    VALUES(proposal_id,'00000000-0000-4000-8000-000000000001','eligibility-'||movement||channel,
      ('CREATE_'||upper(movement))::public.pending_operation_type,
      jsonb_build_object('actorMemberId','00000000-0000-4000-8000-000000000021','source',channel),
      'AWAITING_CONFIRMATION') RETURNING updated_at INTO version;
    call_sql := format($q$SELECT public.fn_confirm_pending_%s_eligible(
      p_auth_user_id=>'42000000-0042-4000-8000-000000000001',
      p_proposal_id=>%L,p_household_id=>'00000000-0000-4000-8000-000000000001',
      p_conversation_key=>%L,p_actor_member_id=>'00000000-0000-4000-8000-000000000021',
      p_context_source=>%L,p_expected_updated_at=>%L,
      p_created_by=>'00000000-0000-4000-8000-000000000021',%s)$q$,
      movement,proposal_id,'eligibility-'||movement||channel,channel,version,
      CASE movement WHEN 'income' THEN $args$p_member_id=>'00000000-0000-4000-8000-000000000021',
        p_amount=>42,p_income_date=>current_date,p_description=>'Eligibility confirmation'$args$
      ELSE $args$p_paid_by=>'00000000-0000-4000-8000-000000000021',p_total_amount=>42,
        p_expense_date=>current_date,p_source=>'WEB',p_items=>'[]',
        p_distributions=>'[{"householdMemberId":"00000000-0000-4000-8000-000000000021","amount":42,"percentage":100}]'$args$ END
        || CASE WHEN channel='WHATSAPP' THEN format(',p_whatsapp_user_id=>%L,p_whatsapp_lease_id=>%L,p_whatsapp_lease_epoch=>%L',
          '00000000-0000-4000-8000-000000000011',lease,epoch) ELSE '' END);
    UPDATE auth.users SET email_confirmed_at=NULL WHERE id='42000000-0042-4000-8000-000000000001';
    PERFORM pg_temp.expect_financial_denial(call_sql);
    IF NOT EXISTS(SELECT 1 FROM public.tb_pending_proposals WHERE id=proposal_id AND status='AWAITING_CONFIRMATION') THEN
      RAISE EXCEPTION 'Denied confirmation changed proposal';
    END IF;
    UPDATE auth.users SET email_confirmed_at=now() WHERE id='42000000-0042-4000-8000-000000000001';
    SET LOCAL ROLE service_role;
    EXECUTE call_sql INTO result;
    IF result->>'status' <> 'CREATED' THEN RAISE EXCEPTION 'Eligible confirmation failed'; END IF;
    SELECT count(*) INTO row_count_before FROM public.tb_incomes;
    SELECT count(*) INTO expense_count_before FROM public.tb_expenses;
    EXECUTE call_sql INTO result;
    IF result->>'status' <> 'ALREADY_COMPLETED' OR row_count_before <> (SELECT count(*) FROM public.tb_incomes)
       OR expense_count_before <> (SELECT count(*) FROM public.tb_expenses) THEN
      RAISE EXCEPTION 'Confirmation retry was not idempotent';
    END IF;
    RESET ROLE;
  END LOOP;
  END LOOP;
END;
$$;

DO $$
DECLARE f RECORD;
BEGIN
  FOR f IN SELECT p.oid,p.proname,p.prosecdef,p.proconfig,p.proowner,r.rolname FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
    WHERE n.nspname='public' AND (p.proname LIKE '%_eligible' OR p.proname='fn_require_financial_eligibility') LOOP
    IF NOT f.prosecdef OR f.rolname <> 'postgres' OR f.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog'] THEN
      RAISE EXCEPTION 'Unsafe financial function configuration';
    END IF;
    IF EXISTS(SELECT 1 FROM aclexplode(COALESCE((SELECT proacl FROM pg_proc WHERE oid=f.oid),acldefault('f',f.proowner))) a
      WHERE a.grantee=0 AND a.privilege_type='EXECUTE') THEN RAISE EXCEPTION 'PUBLIC financial access'; END IF;
    IF has_function_privilege('service_role',f.oid,'EXECUTE') IS DISTINCT FROM (f.proname <> 'fn_require_financial_eligibility') THEN
      RAISE EXCEPTION 'Wrong service_role financial access';
    END IF;
  END LOOP;
  -- Explicitly record the additive transition: legacy writes are NOT closed yet.
  IF NOT has_table_privilege('service_role','public.tb_incomes','INSERT') THEN
    RAISE EXCEPTION 'Additive migration unexpectedly removed legacy privileges';
  END IF;
END;
$$;

CREATE ROLE financial_eligibility_client NOLOGIN;
SET LOCAL ROLE financial_eligibility_client;
DO $$
BEGIN
  IF has_function_privilege(current_user,'public.fn_create_income_eligible(uuid,uuid,uuid,uuid,numeric,date,text,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'Client can execute protected financial write';
  END IF;
  BEGIN
    PERFORM public.fn_create_income_eligible(NULL,NULL,NULL,NULL,1,current_date,'denied',NULL);
    RAISE EXCEPTION 'Client invoked financial write';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM = 'Financial access is unavailable' THEN RAISE EXCEPTION 'Client reached internal authorization'; END IF;
  END;
END;
$$;
RESET ROLE;
ROLLBACK;
