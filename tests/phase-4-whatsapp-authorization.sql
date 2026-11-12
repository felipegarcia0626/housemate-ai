BEGIN;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users(id UUID PRIMARY KEY,email TEXT);
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_confirmed_at TIMESTAMPTZ;
DO $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END;
$$;
INSERT INTO auth.users(id,email,email_confirmed_at)
SELECT ('44000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'authorization@example.test',now() FROM generate_series(1,4) i;
INSERT INTO public.tb_users(id,auth_user_id,display_name,external_identifier)
SELECT id,id,'Authorization fixture',CASE WHEN right(id::text,1)='1' THEN '19990000201' ELSE 'supabase:'||id END
FROM auth.users WHERE id::text LIKE '44000000-%';
INSERT INTO public.tb_households(id,name) VALUES('44000000-0000-4000-8000-000000000099','Authorization fixture');
INSERT INTO public.tb_household_members(id,user_id,household_id,display_name,role,status)
SELECT id,id,'44000000-0000-4000-8000-000000000099','Authorization fixture',CASE WHEN right(id::text,1)='1' THEN 'OWNER' ELSE 'MEMBER' END,'ACTIVE'
FROM public.tb_users WHERE id::text LIKE '44000000-%';

CREATE FUNCTION pg_temp.authorization_status(result JSONB, expected TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
 IF result->>'status' IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Unexpected authorization status: %',result->>'status'; END IF;
END;
$$;

SET LOCAL ROLE service_role;
DO $$
DECLARE u UUID := '44000000-0000-4000-8000-000000000001'; v UUID := '44000000-0000-4000-8000-000000000002'; r JSONB; e BIGINT; l UUID; stmt TEXT;
BEGIN
  r := public.fn_resolve_whatsapp_sender('19990000201');
  PERFORM pg_temp.authorization_status(r,'RESOLVED');
  IF r->>'origin' <> 'LEGACY' OR (r->>'userId')::uuid IS DISTINCT FROM u THEN RAISE EXCEPTION 'Wrong legacy identity'; END IF;
  r := public.fn_admit_whatsapp_sender('19990000201',u);
  PERFORM pg_temp.authorization_status(r,'ADMITTED'); e := (r->>'epoch')::bigint;
  IF NOT public.fn_assert_whatsapp_context_lease(u,u,e) THEN RAISE EXCEPTION 'Legacy lease rejected'; END IF;
  PERFORM pg_temp.authorization_status(public.fn_transition_whatsapp_household_context(u,'test-emitter',u,e,'SET_SELECTION','44000000-0000-4000-8000-000000000099',u),'SELECTED');
  PERFORM public.fn_require_whatsapp_active_context(u,u,e,'44000000-0000-4000-8000-000000000099',u);
  IF NOT public.fn_release_whatsapp_context_lease(u,u,e) THEN RAISE EXCEPTION 'Legacy release rejected'; END IF;
  PERFORM pg_temp.authorization_status(public.fn_admit_whatsapp_sender('19990000209',u),'UNAVAILABLE');
  PERFORM pg_temp.authorization_status(public.fn_start_whatsapp_link_challenge(v,v,'19990000202',repeat('2',64),v),'PENDING');
  r := public.fn_complete_whatsapp_link_challenge(v,'19990000202',repeat('2',64),'authorization-link');
  PERFORM pg_temp.authorization_status(r,'LINKED'); l := (r->>'linkId')::uuid;
  r := public.fn_resolve_whatsapp_sender('19990000202');
  IF r->>'origin' <> 'VERIFIED' OR (r->>'userId')::uuid IS DISTINCT FROM v OR (r->>'linkId')::uuid IS DISTINCT FROM l THEN RAISE EXCEPTION 'Wrong verified resolution'; END IF;
  -- The old user-ID admission cannot bypass verified authorization.
  IF (public.fn_acquire_whatsapp_context_lease(v,v)->>'acquired')::boolean THEN RAISE EXCEPTION 'Historical entry bypass'; END IF;
  r := public.fn_admit_whatsapp_sender('19990000202',v); e := (r->>'epoch')::bigint;
  PERFORM pg_temp.authorization_status(r,'ADMITTED');
  PERFORM pg_temp.authorization_status(public.fn_admit_whatsapp_sender('19990000202',u),'BUSY');
  IF NOT public.fn_renew_whatsapp_context_lease(v,v,e) THEN RAISE EXCEPTION 'Valid renewal rejected'; END IF;
  PERFORM pg_temp.authorization_status(public.fn_transition_whatsapp_household_context(v,'test-emitter',v,e,'SET_SELECTION','44000000-0000-4000-8000-000000000099',v),'SELECTED');
  PERFORM pg_temp.authorization_status(public.fn_revoke_whatsapp_link(u,l,1),'NOT_FOUND');
  PERFORM pg_temp.authorization_status(public.fn_revoke_whatsapp_link(v,l,NULL),'STALE');
  PERFORM pg_temp.authorization_status(public.fn_revoke_whatsapp_link(v,l,1),'REVOKED');
  IF public.fn_renew_whatsapp_context_lease(v,v,e) OR public.fn_assert_whatsapp_context_lease(v,v,e) THEN RAISE EXCEPTION 'Revoked lease authorized'; END IF;
  PERFORM pg_temp.authorization_status(public.fn_admit_whatsapp_sender('19990000202',u),'UNAVAILABLE');
  BEGIN
    PERFORM public.fn_require_whatsapp_active_context(v,v,e,'44000000-0000-4000-8000-000000000099',v);
    RAISE EXCEPTION 'Revoked protected operation accepted';
  EXCEPTION WHEN serialization_failure THEN
    IF SQLERRM <> 'WhatsApp context lease is no longer current' THEN RAISE; END IF;
  END;
  -- Draft/context entries still execute their lease guard. Proposal mutation
  -- delegates are no longer callable directly by service_role; their event
  -- wrappers are covered by the recovery and lifecycle harnesses.
  FOREACH stmt IN ARRAY ARRAY[
    format('SELECT public.fn_create_whatsapp_agent_draft(%1$L,%2$L,%1$L,%3$L,''CREATE_INCOME'',''{}'',''AWAITING_DETAILS'',%1$L,%1$L,%4$s)',v,'44000000-0000-4000-8000-000000000099','authorization-draft',e),
    format('SELECT public.fn_update_whatsapp_agent_draft(%1$L,%2$L,%1$L,%3$L,''CREATE_INCOME'',''{}'',''AWAITING_DETAILS'',NULL,%1$L,%1$L,%4$s)',v,'44000000-0000-4000-8000-000000000099','authorization-draft',e),
    format('SELECT public.fn_delete_whatsapp_agent_draft(%1$L,%2$L,%1$L,%3$L,now(),%1$L,%1$L,%4$s)',v,'44000000-0000-4000-8000-000000000099','authorization-draft',e),
    format('SELECT public.fn_transition_whatsapp_household_context(%1$L,''test-emitter'',%1$L,%2$s,''CLEAR_SELECTION'')',v,e)
  ] LOOP
    BEGIN
      EXECUTE stmt;
      RAISE EXCEPTION 'Revoked write entry accepted';
    EXCEPTION WHEN serialization_failure THEN
      IF SQLERRM <> 'WhatsApp context lease is no longer current' THEN RAISE; END IF;
    END;
  END LOOP;

  FOREACH stmt IN ARRAY ARRAY[
    format('SELECT public.fn_create_whatsapp_pending_proposal(%1$L,%2$L,%3$L,%1$L,''CREATE_INCOME'',''{}'',%1$L,%1$L,%4$s)',v,'44000000-0000-4000-8000-000000000099','authorization-draft',e),
    format('SELECT public.fn_update_whatsapp_pending_proposal(%1$L,%2$L,%3$L,%1$L,''CREATE_INCOME'',''{}'',now(),%1$L,%1$L,%4$s)',v,'44000000-0000-4000-8000-000000000099','authorization-draft',e),
    format('SELECT public.fn_reject_whatsapp_pending_proposal(%1$L,%2$L,%3$L,%1$L,''CREATE_INCOME'',%1$L,%1$L,%4$s)',v,'44000000-0000-4000-8000-000000000099','authorization-draft',e)
  ] LOOP
    BEGIN
      EXECUTE stmt;
      RAISE EXCEPTION 'Direct service_role proposal delegate execution accepted';
    EXCEPTION WHEN insufficient_privilege THEN
      IF SQLERRM NOT LIKE 'permission denied for function %' THEN RAISE; END IF;
    END;
  END LOOP;
END;
$$;
RESET ROLE;

-- Ambiguous sources fail closed; same owner deterministically chooses VERIFIED.
DO $$
DECLARE a UUID := '44000000-0000-4000-8000-000000000003'; b UUID := '44000000-0000-4000-8000-000000000004'; r JSONB; l UUID;
BEGIN
  PERFORM public.fn_start_whatsapp_link_challenge(a,a,'19990000203',repeat('3',64),a);
  r:=public.fn_complete_whatsapp_link_challenge(a,'19990000203',repeat('3',64),'authorization-conflict'); l:=(r->>'linkId')::uuid;
  UPDATE public.tb_users SET external_identifier='19990000203' WHERE id=b;
  PERFORM pg_temp.authorization_status(public.fn_resolve_whatsapp_sender('19990000203'),'UNAVAILABLE');
  UPDATE public.tb_users SET external_identifier='supabase:'||id WHERE id=b;
  UPDATE public.tb_users SET external_identifier='19990000203' WHERE id=a;
  r:=public.fn_resolve_whatsapp_sender('19990000203');
  IF r->>'origin' IS DISTINCT FROM 'VERIFIED' THEN RAISE EXCEPTION 'Same-user precedence failed'; END IF;
  r:=public.fn_admit_whatsapp_sender('19990000203',a);
  PERFORM pg_temp.authorization_status(r,'ADMITTED');
  UPDATE public.tb_whatsapp_user_contexts SET authorization_version=2 WHERE user_id=a;
  IF public.fn_assert_whatsapp_context_lease(a,a,(r->>'epoch')::bigint) THEN RAISE EXCEPTION 'Wrong active-link version accepted'; END IF;
  UPDATE public.tb_whatsapp_user_contexts SET authorization_version=1 WHERE user_id=a;
  IF NOT public.fn_assert_whatsapp_context_lease(a,a,(r->>'epoch')::bigint) THEN RAISE EXCEPTION 'Valid version restoration failed'; END IF;
  PERFORM public.fn_revoke_whatsapp_link(a,l,1);
  PERFORM pg_temp.authorization_status(public.fn_resolve_whatsapp_sender('19990000203'),'UNAVAILABLE');
  IF (public.fn_acquire_whatsapp_context_lease(a,a)->>'acquired')::boolean THEN RAISE EXCEPTION 'Revoked legacy fallback'; END IF;
END;
$$;

DO $$
DECLARE r TEXT; f RECORD;
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN
    ('fn_transition_whatsapp_household_context','fn_require_whatsapp_active_context','fn_confirm_pending_expense_consistent','fn_confirm_pending_income_consistent','fn_confirm_pending_expense_eligible','fn_confirm_pending_income_eligible','fn_resolve_whatsapp_identity_locked','fn_resolve_whatsapp_sender','fn_admit_whatsapp_identity_locked','fn_admit_whatsapp_sender','fn_acquire_whatsapp_context_lease','fn_whatsapp_lease_authorized','fn_assert_whatsapp_context_lease','fn_renew_whatsapp_context_lease','fn_release_whatsapp_context_lease','fn_revoke_whatsapp_link','fn_whatsapp_link_account','fn_start_whatsapp_link_challenge','fn_cancel_whatsapp_link_challenge','fn_get_whatsapp_link_state','fn_complete_whatsapp_link_challenge',
    'fn_create_whatsapp_agent_draft','fn_update_whatsapp_agent_draft','fn_delete_whatsapp_agent_draft','fn_create_whatsapp_pending_proposal','fn_update_whatsapp_pending_proposal','fn_reject_whatsapp_pending_proposal','fn_assert_whatsapp_active_context')) <> 28 THEN RAISE EXCEPTION 'Missing or overloaded protected RPC'; END IF;
  IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
    AND c.relname IN ('tb_whatsapp_links','tb_whatsapp_link_challenges','tb_whatsapp_link_events','tb_whatsapp_link_attempt_buckets')
    AND c.relrowsecurity AND pg_get_userbyid(c.relowner)='postgres') <> 4
    OR EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename IN ('tb_whatsapp_links','tb_whatsapp_link_challenges','tb_whatsapp_link_events','tb_whatsapp_link_attempt_buckets')) THEN RAISE EXCEPTION 'Unsafe linking table security'; END IF;
  IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) acl
    WHERE n.nspname='public' AND c.relname IN ('tb_whatsapp_links','tb_whatsapp_link_challenges','tb_whatsapp_link_events','tb_whatsapp_link_attempt_buckets') AND acl.grantee=0) THEN RAISE EXCEPTION 'Public linking table access'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.tb_whatsapp_user_contexts WHERE user_id='44000000-0000-4000-8000-000000000002'
    AND authorization_origin='VERIFIED' AND authorization_version=1 AND authorization_link_id IS NOT NULL) THEN RAISE EXCEPTION 'Authorization snapshot not persisted'; END IF;
  BEGIN
    UPDATE public.tb_whatsapp_user_contexts SET authorization_version=NULL WHERE user_id='44000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION 'NULL verified version accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%ck_whatsapp_lease_authorization%' THEN RAISE; END IF;
  END;
  FOREACH r IN ARRAY ARRAY['service_role','anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
      AND c.relname IN ('tb_whatsapp_links','tb_whatsapp_link_challenges','tb_whatsapp_link_events','tb_whatsapp_link_attempt_buckets')
      AND has_table_privilege(r,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) THEN RAISE EXCEPTION 'Direct linking table access'; END IF;
  END LOOP;
  FOR f IN SELECT p.* FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN
    ('fn_transition_whatsapp_household_context','fn_require_whatsapp_active_context','fn_confirm_pending_expense_consistent','fn_confirm_pending_income_consistent','fn_confirm_pending_expense_eligible','fn_confirm_pending_income_eligible','fn_resolve_whatsapp_identity_locked','fn_resolve_whatsapp_sender','fn_admit_whatsapp_identity_locked','fn_admit_whatsapp_sender','fn_acquire_whatsapp_context_lease','fn_whatsapp_lease_authorized','fn_assert_whatsapp_context_lease','fn_renew_whatsapp_context_lease','fn_release_whatsapp_context_lease','fn_revoke_whatsapp_link','fn_whatsapp_link_account','fn_start_whatsapp_link_challenge','fn_cancel_whatsapp_link_challenge','fn_get_whatsapp_link_state','fn_complete_whatsapp_link_challenge') LOOP
    IF pg_get_userbyid(f.proowner)<>'postgres' OR NOT f.prosecdef OR f.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog'] THEN RAISE EXCEPTION 'Unsafe authorization function'; END IF;
    IF has_function_privilege('anon',f.oid,'EXECUTE') OR has_function_privilege('authenticated',f.oid,'EXECUTE')
      OR EXISTS(SELECT 1 FROM aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) WHERE grantee=0 AND privilege_type='EXECUTE') THEN RAISE EXCEPTION 'Public authorization access'; END IF;
    IF has_function_privilege('service_role',f.oid,'EXECUTE') <> (f.proname NOT IN ('fn_resolve_whatsapp_identity_locked','fn_admit_whatsapp_identity_locked','fn_whatsapp_lease_authorized','fn_whatsapp_link_account','fn_confirm_pending_expense_consistent','fn_confirm_pending_income_consistent')) THEN RAISE EXCEPTION 'Wrong helper privileges'; END IF;
  END LOOP;
  FOR f IN SELECT p.* FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN
    ('fn_create_whatsapp_agent_draft','fn_update_whatsapp_agent_draft','fn_delete_whatsapp_agent_draft','fn_create_whatsapp_pending_proposal','fn_update_whatsapp_pending_proposal','fn_reject_whatsapp_pending_proposal','fn_assert_whatsapp_active_context') LOOP
    IF has_function_privilege('service_role',f.oid,'EXECUTE') <>
       (f.proname NOT IN ('fn_create_whatsapp_pending_proposal','fn_update_whatsapp_pending_proposal','fn_reject_whatsapp_pending_proposal'))
      OR has_function_privilege('anon',f.oid,'EXECUTE') OR has_function_privilege('authenticated',f.oid,'EXECUTE')
      OR EXISTS(SELECT 1 FROM aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) WHERE grantee=0 AND privilege_type='EXECUTE') THEN
      RAISE EXCEPTION 'Unsafe dependent RPC privileges';
    END IF;
    IF position('fn_require_whatsapp_active_context' IN f.prosrc)=0 THEN RAISE EXCEPTION 'Dependent RPC bypasses authorization guard'; END IF;
  END LOOP;
END;
$$;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.fn_admit_whatsapp_sender('19990000201','44000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'Client admission accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE '%permission denied%' THEN RAISE; END IF;
  END;
END;
$$;
RESET ROLE;
-- Existing pre-0044 leases have no authorization snapshot: fail closed, no backfill.
DO $$
DECLARE u UUID := '44000000-0000-4000-8000-000000000001'; e BIGINT; before_row JSONB;
BEGIN
  e:=(public.fn_acquire_whatsapp_context_lease(u,u)->>'epoch')::bigint;
  IF e IS NULL THEN RAISE EXCEPTION 'Fixture lease not acquired'; END IF;
  UPDATE public.tb_whatsapp_user_contexts SET authorization_origin=NULL,authorization_sender=NULL,authorization_link_id=NULL,authorization_version=NULL WHERE user_id=u;
  SELECT to_jsonb(t) INTO before_row FROM public.tb_whatsapp_user_contexts t WHERE user_id=u;
  IF public.fn_assert_whatsapp_context_lease(u,u,e) OR public.fn_renew_whatsapp_context_lease(u,u,e) THEN RAISE EXCEPTION 'Pre-0044 lease authorized'; END IF;
  BEGIN
    PERFORM public.fn_transition_whatsapp_household_context(u,'test-emitter',u,e,'CLEAR_SELECTION');
    RAISE EXCEPTION 'Pre-0044 selection accepted';
  EXCEPTION WHEN serialization_failure THEN
    IF SQLERRM <> 'WhatsApp context lease is no longer current' THEN RAISE; END IF;
  END;
  IF before_row IS DISTINCT FROM (SELECT to_jsonb(t) FROM public.tb_whatsapp_user_contexts t WHERE user_id=u) THEN RAISE EXCEPTION 'Pre-0044 rejection changed context'; END IF;
END;
$$;

-- A fresh proof may bind a revoked sender to another account; no history transfer.
DO $$
DECLARE a UUID := '44000000-0000-4000-8000-000000000003'; b UUID := '44000000-0000-4000-8000-000000000004'; r JSONB; old_links JSONB; old_context JSONB;
BEGIN
  UPDATE public.tb_users SET external_identifier='supabase:'||id WHERE id=a;
  SELECT jsonb_agg(to_jsonb(t) ORDER BY id) INTO old_links FROM public.tb_whatsapp_links t WHERE user_id=a;
  SELECT to_jsonb(t) INTO old_context FROM public.tb_whatsapp_user_contexts t WHERE user_id=a;
  PERFORM pg_temp.authorization_status(public.fn_start_whatsapp_link_challenge(b,b,'19990000203',repeat('4',64),b),'PENDING');
  PERFORM pg_temp.authorization_status(public.fn_complete_whatsapp_link_challenge(b,'19990000203',repeat('4',64),'authorization-number-reuse'),'LINKED');
  r:=public.fn_resolve_whatsapp_sender('19990000203');
  IF r->>'userId' IS DISTINCT FROM b::text OR r->>'origin' IS DISTINCT FROM 'VERIFIED' THEN RAISE EXCEPTION 'Reused sender resolves wrong owner'; END IF;
  IF public.fn_assert_whatsapp_context_lease(a,a,(old_context->>'processing_epoch')::bigint) THEN RAISE EXCEPTION 'Old sender owner still authorized'; END IF;
  IF old_links IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.tb_whatsapp_links t WHERE user_id=a)
    OR old_context IS DISTINCT FROM (SELECT to_jsonb(t) FROM public.tb_whatsapp_user_contexts t WHERE user_id=a) THEN RAISE EXCEPTION 'Sender reuse changed old account history'; END IF;
END;
$$;
SELECT 'PASS WhatsApp sender resolution, versioned leases, revocation and permissions' AS result;
ROLLBACK;
