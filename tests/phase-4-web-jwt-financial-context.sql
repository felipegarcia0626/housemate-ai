BEGIN;

-- The disposable runner has PostgreSQL only. These functions model the
-- request claims set by PostgREST; they do not verify a real JWT.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.role',true),'')
$$;
GRANT USAGE ON SCHEMA auth TO authenticated;
INSERT INTO auth.users(id,email,email_confirmed_at) VALUES
  ('48000000-0048-4000-8000-000000000001','web-a@example.test',now()),
  ('48000000-0048-4000-8000-000000000002','web-b@example.test',now());
UPDATE public.tb_users SET auth_user_id='48000000-0048-4000-8000-000000000001'
  WHERE id='00000000-0000-4000-8000-000000000011';
UPDATE public.tb_users SET auth_user_id='48000000-0048-4000-8000-000000000002'
  WHERE id='00000000-0000-4000-8000-000000000013';

DO $$
DECLARE entry regprocedure := 'public.fn_create_web_agent_draft(uuid,uuid,uuid,text,public.pending_operation_type,jsonb,public.agent_category_draft_status)'::regprocedure;
  helper regprocedure := 'public.fn_require_web_financial_context(uuid,uuid)'::regprocedure;
BEGIN
  IF NOT has_function_privilege('authenticated',entry,'EXECUTE')
     OR has_function_privilege('anon',entry,'EXECUTE')
     OR has_function_privilege('service_role',entry,'EXECUTE')
     OR EXISTS (SELECT 1 FROM aclexplode((SELECT proacl FROM pg_proc WHERE oid=entry)) WHERE grantee=0) THEN
    RAISE EXCEPTION 'Web entry ACL is incorrect';
  END IF;
  IF has_function_privilege('authenticated',helper,'EXECUTE')
     OR has_function_privilege('anon',helper,'EXECUTE')
     OR has_function_privilege('service_role',helper,'EXECUTE')
     OR EXISTS (SELECT 1 FROM aclexplode((SELECT proacl FROM pg_proc WHERE oid=helper)) WHERE grantee=0) THEN
    RAISE EXCEPTION 'Web helper is externally executable';
  END IF;
  IF (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid=entry) <> 'postgres'
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid=entry)
     OR NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) setting
                    WHERE p.oid=entry AND setting='search_path=pg_catalog') THEN
    RAISE EXCEPTION 'Web entry owner or definer configuration is incorrect';
  END IF;
END;
$$;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','48000000-0048-4000-8000-000000000001',true);
DO $$
DECLARE r public.tb_agent_category_drafts; denied boolean;
BEGIN
  r:=public.fn_create_web_agent_draft('48000000-0048-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000021',
    'web-jwt-stage-one','CREATE_EXPENSE','{}','AWAITING_CATEGORY');
  IF r.source IS DISTINCT FROM 'WEB' OR r.actor_member_id IS DISTINCT FROM '00000000-0000-4000-8000-000000000021'::uuid
     OR auth.uid() IS DISTINCT FROM '48000000-0048-4000-8000-000000000001'::uuid
     OR auth.role() IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION 'Web identity or draft result differs';
  END IF;
  r:=public.fn_create_web_agent_draft('48000000-0048-4000-8000-000000000017',
    '00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000021',
    'web-operation-choice',NULL,'{}','AWAITING_OPERATION');
  IF r.operation_type IS NOT NULL OR r.status IS DISTINCT FROM 'AWAITING_OPERATION' THEN
    RAISE EXCEPTION 'Web operation-choice draft differs';
  END IF;
  denied:=false;
  BEGIN
    PERFORM public.fn_require_web_financial_context(
      '00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000021');
  EXCEPTION WHEN insufficient_privilege THEN denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Authenticated role executed private helper'; END IF;
  denied:=false;
  BEGIN
    PERFORM public.fn_create_web_agent_draft('48000000-0048-4000-8000-000000000011',
      '0054e516-6236-4856-88f1-b8c11ee5329f','180d3596-f601-4844-9683-e46b0c21da28',
      'foreign-web','CREATE_EXPENSE','{}','AWAITING_CATEGORY');
  EXCEPTION WHEN insufficient_privilege THEN denied:=true;
  END;
  IF NOT denied THEN
    RAISE EXCEPTION 'Foreign household was not denied';
  END IF;
END;
$$;
RESET ROLE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.tb_agent_category_drafts WHERE id='48000000-0048-4000-8000-000000000011') THEN
    RAISE EXCEPTION 'Denied draft was persisted';
  END IF;
END $$;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','48000000-0048-4000-8000-000000000002',true);
DO $$ DECLARE denied boolean:=false; BEGIN
  BEGIN PERFORM public.fn_create_web_agent_draft('48000000-0048-4000-8000-000000000018',
    '00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000021',
    'foreign-user-web','CREATE_EXPENSE','{}','AWAITING_CATEGORY');
  EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
  IF NOT denied THEN RAISE EXCEPTION 'User B entered user A household'; END IF;
END $$;
RESET ROLE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.tb_agent_category_drafts WHERE id='48000000-0048-4000-8000-000000000018') THEN
    RAISE EXCEPTION 'User B denied draft was persisted';
  END IF;
END $$;

UPDATE auth.users SET email_confirmed_at=NULL WHERE id='48000000-0048-4000-8000-000000000001';
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','48000000-0048-4000-8000-000000000001',true);
DO $$ DECLARE denied boolean:=false; BEGIN
  BEGIN PERFORM public.fn_create_web_agent_draft('48000000-0048-4000-8000-000000000012',
    '00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000021',
    'unconfirmed-web','CREATE_EXPENSE','{}','AWAITING_CATEGORY');
  EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
  IF NOT denied THEN RAISE EXCEPTION 'Unconfirmed email was admitted'; END IF;
END $$;
RESET ROLE;

UPDATE auth.users SET email_confirmed_at=now() WHERE id='48000000-0048-4000-8000-000000000001';
UPDATE public.tb_household_members SET status='LEFT' WHERE id='00000000-0000-4000-8000-000000000021';
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','48000000-0048-4000-8000-000000000001',true);
DO $$ DECLARE denied boolean:=false; BEGIN
  BEGIN PERFORM public.fn_create_web_agent_draft('48000000-0048-4000-8000-000000000013',
    '00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000021',
    'inactive-web','CREATE_EXPENSE','{}','AWAITING_CATEGORY');
  EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
  IF NOT denied THEN RAISE EXCEPTION 'Inactive membership was admitted'; END IF;
END $$;
RESET ROLE;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','',true);
DO $$ DECLARE denied boolean:=false; BEGIN
  BEGIN PERFORM public.fn_create_web_agent_draft('48000000-0048-4000-8000-000000000014',
    '00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000021',
    'no-session-web','CREATE_EXPENSE','{}','AWAITING_CATEGORY');
  EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
  IF NOT denied THEN RAISE EXCEPTION 'Missing request identity was admitted'; END IF;
END $$;
RESET ROLE;

SET ROLE anon;
DO $$ DECLARE denied boolean:=false; BEGIN
  BEGIN PERFORM public.fn_create_web_agent_draft('48000000-0048-4000-8000-000000000015',
    '00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000021',
    'anon-web','CREATE_EXPENSE','{}','AWAITING_CATEGORY');
  EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
  IF NOT denied THEN RAISE EXCEPTION 'Anonymous role executed Web entry'; END IF;
END $$;
RESET ROLE;

SET ROLE service_role;
DO $$ DECLARE denied boolean:=false; BEGIN
  BEGIN
    PERFORM public.fn_require_web_financial_context(
      '00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000021');
  EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
  IF NOT denied THEN RAISE EXCEPTION 'Service role executed private Web helper'; END IF;
  denied:=false;
  BEGIN PERFORM public.fn_create_web_agent_draft('48000000-0048-4000-8000-000000000016',
    '00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000021',
    'service-web','CREATE_EXPENSE','{}','AWAITING_CATEGORY');
  EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
  IF NOT denied THEN RAISE EXCEPTION 'Service role executed Web entry'; END IF;
END $$;
RESET ROLE;

ROLLBACK;
