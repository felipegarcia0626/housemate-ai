BEGIN;

-- Supabase provides auth.users. The disposable embedded SQL runner does not;
-- create a minimal transactional fixture only when the relation is absent.
DO $$
BEGIN
  IF to_regclass('auth.users') IS NULL THEN
    IF to_regnamespace('auth') IS NULL THEN
      EXECUTE 'CREATE SCHEMA auth';
    END IF;
    EXECUTE 'CREATE TABLE auth.users (
      id UUID PRIMARY KEY,
      email TEXT,
      email_confirmed_at TIMESTAMPTZ
    )';
  END IF;
  IF to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'Required base object auth.users is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    RAISE EXCEPTION 'Runner must prepare anon and authenticated before migration 0043';
  END IF;
END;
$$;
INSERT INTO auth.users(id, email, email_confirmed_at)
SELECT ('43000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, 'link-' || i || '@example.test', now()
FROM generate_series(1, 8) i;
INSERT INTO public.tb_users(id, auth_user_id, display_name, external_identifier)
SELECT id, id, 'Link fixture', 'supabase:' || id FROM auth.users WHERE id::text LIKE '43000000-%';

CREATE FUNCTION pg_temp.link_status(actual JSONB, expected TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF actual->>'status' IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'Unexpected linking status: expected %, received %', expected, actual->>'status';
  END IF;
END;
$$;

SET LOCAL ROLE service_role;
DO $$
DECLARE
  a UUID := '43000000-0000-4000-8000-000000000001';
  b UUID := '43000000-0000-4000-8000-000000000002';
  c UUID := '43000000-0000-4000-8000-000000000003';
  d UUID := '43000000-0000-4000-8000-000000000004';
  e UUID := '43000000-0000-4000-8000-000000000005';
  f UUID := '43000000-0000-4000-8000-000000000006';
  g UUID := '43000000-0000-4000-8000-000000000007';
  result JSONB; replay JSONB; i INTEGER;
BEGIN
  PERFORM pg_temp.link_status(public.fn_start_whatsapp_link_challenge(a,a,'19990000001',repeat('a',64),a),'PENDING');
  PERFORM pg_temp.link_status(public.fn_start_whatsapp_link_challenge(a,a,'19990000001',repeat('a',64),a),'PENDING');
  PERFORM pg_temp.link_status(public.fn_start_whatsapp_link_challenge(a,b,'19990000001',repeat('b',64),a),'IDEMPOTENCY_CONFLICT');
  PERFORM pg_temp.link_status(public.fn_start_whatsapp_link_challenge(a,b,'19990000001',repeat('b',64),b),'RATE_LIMITED');
  -- A foreign sender cannot consume or burn the victim's challenge attempts.
  PERFORM pg_temp.link_status(public.fn_complete_whatsapp_link_challenge(a,'19990000009',repeat('a',64),'link-wrong-sender'),'INVALID');
  result := public.fn_complete_whatsapp_link_challenge(a,'19990000001',repeat('a',64),'link-success');
  PERFORM pg_temp.link_status(result,'LINKED');
  replay := public.fn_complete_whatsapp_link_challenge(a,'19990000001',repeat('a',64),'link-success');
  IF result IS DISTINCT FROM replay THEN RAISE EXCEPTION 'Event replay changed result'; END IF;
  PERFORM pg_temp.link_status(public.fn_complete_whatsapp_link_challenge(a,'19990000001',repeat('b',64),'link-success'),'EVENT_CONFLICT');
  PERFORM pg_temp.link_status(public.fn_complete_whatsapp_link_challenge(a,'19990000001',repeat('a',64),'link-consumed'),'INVALID');
  IF (public.fn_get_whatsapp_link_state(a)->'link'->>'id') IS DISTINCT FROM result->>'linkId' THEN RAISE EXCEPTION 'Missing own link state'; END IF;
  IF public.fn_get_whatsapp_link_state(b)->'link' <> 'null'::jsonb THEN RAISE EXCEPTION 'State crossed account'; END IF;
  PERFORM pg_temp.link_status(public.fn_start_whatsapp_link_challenge(b,b,'19990000001',repeat('b',64),b),'UNAVAILABLE');
  PERFORM pg_temp.link_status(public.fn_start_whatsapp_link_challenge(b,b,'19990000002',repeat('b',64),b),'PENDING');
  PERFORM pg_temp.link_status(public.fn_cancel_whatsapp_link_challenge(c,b),'NOT_FOUND');
  PERFORM pg_temp.link_status(public.fn_cancel_whatsapp_link_challenge(b,b),'CANCELLED');
  PERFORM pg_temp.link_status(public.fn_complete_whatsapp_link_challenge(b,'19990000002',repeat('b',64),'link-cancelled'),'INVALID');
  PERFORM pg_temp.link_status(public.fn_start_whatsapp_link_challenge(c,c,'19990000003',repeat('c',64),c),'PENDING');
  FOR i IN 1..5 LOOP
    PERFORM pg_temp.link_status(public.fn_complete_whatsapp_link_challenge(c,'19990000003',repeat('0',64),'link-wrong-'||i),'INVALID');
  END LOOP;
  IF public.fn_get_whatsapp_link_state(c)->'challenge'->>'status' <> 'EXHAUSTED' THEN RAISE EXCEPTION 'Attempts not exhausted'; END IF;
  PERFORM pg_temp.link_status(public.fn_complete_whatsapp_link_challenge(c,'19990000003',repeat('c',64),'link-exhausted'),'INVALID');
  PERFORM pg_temp.link_status(public.fn_start_whatsapp_link_challenge(d,d,'19990000004',repeat('d',64),d),'PENDING');
  PERFORM pg_temp.link_status(public.fn_start_whatsapp_link_challenge(e,e,'19990000005',repeat('e',64),e),'PENDING');
  PERFORM pg_temp.link_status(public.fn_start_whatsapp_link_challenge(f,f,'19990000006',repeat('f',64),f),'PENDING');
  FOR i IN 1..20 LOOP
    PERFORM pg_temp.link_status(public.fn_complete_whatsapp_link_challenge(g,'19990000007',repeat('0',64),'link-unknown-'||i),'INVALID');
  END LOOP;
  PERFORM pg_temp.link_status(public.fn_complete_whatsapp_link_challenge(g,'19990000007',repeat('0',64),'link-unknown-limit'),'RATE_LIMITED');
  BEGIN
    PERFORM public.fn_get_whatsapp_link_state(NULL);
    RAISE EXCEPTION 'Null Auth accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'WhatsApp linking is unavailable' THEN RAISE; END IF;
  END;
END;
$$;
RESET ROLE;

-- Cancellation/replacement must not reset creation history or frequency limits.
DO $$
DECLARE u UUID := '43000000-0000-4000-8000-000000000007'; c UUID; i INTEGER;
BEGIN
  FOR i IN 1..3 LOOP
    c := ('43000000-0000-4000-8000-' || lpad((100+i)::text,12,'0'))::uuid;
    PERFORM pg_temp.link_status(public.fn_start_whatsapp_link_challenge(u,c,'19990000007',lpad(i::text,64,'0'),c),'PENDING');
    IF i < 3 THEN
      -- Age only this fixture, keeping the exact expiry interval.
      UPDATE public.tb_whatsapp_link_challenges SET created_at=created_at-interval '61 seconds', expires_at=expires_at-interval '61 seconds' WHERE user_id=u;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.tb_whatsapp_link_challenges WHERE user_id=u AND status='PENDING') <> 1 THEN RAISE EXCEPTION 'Replacement left multiple pending challenges'; END IF;
  PERFORM public.fn_cancel_whatsapp_link_challenge(u,c);
  UPDATE public.tb_whatsapp_link_challenges SET created_at=created_at-interval '61 seconds', expires_at=expires_at-interval '61 seconds' WHERE user_id=u;
  PERFORM pg_temp.link_status(public.fn_start_whatsapp_link_challenge(u,'43000000-0000-4000-8000-000000000104','19990000007',repeat('8',64),'43000000-0000-4000-8000-000000000104'),'RATE_LIMITED');
END;
$$;

-- Force time/conflicts only in this disposable fixture; production has no clock input.
UPDATE public.tb_whatsapp_link_challenges SET created_at=now()-interval '11 minutes', expires_at=now()-interval '1 minute'
WHERE id='43000000-0000-4000-8000-000000000004';
UPDATE public.tb_users SET external_identifier='19990000005' WHERE id='43000000-0000-4000-8000-000000000008';
UPDATE auth.users SET email_confirmed_at=NULL WHERE id='43000000-0000-4000-8000-000000000006';
SET LOCAL ROLE service_role;
DO $$
BEGIN
  PERFORM pg_temp.link_status(public.fn_complete_whatsapp_link_challenge('43000000-0000-4000-8000-000000000004','19990000004',repeat('d',64),'link-expired'),'INVALID');
  PERFORM pg_temp.link_status(public.fn_complete_whatsapp_link_challenge('43000000-0000-4000-8000-000000000005','19990000005',repeat('e',64),'link-legacy'),'UNAVAILABLE');
  BEGIN
    PERFORM public.fn_complete_whatsapp_link_challenge('43000000-0000-4000-8000-000000000006','19990000006',repeat('f',64),'link-auth-denial');
    RAISE EXCEPTION 'Unconfirmed Auth accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'WhatsApp linking is unavailable' THEN RAISE; END IF;
  END;
END;
$$;
RESET ROLE;

DO $$
DECLARE r TEXT; t TEXT; f RECORD;
BEGIN
  IF (SELECT count(*) FROM public.tb_whatsapp_links) <> 1 THEN RAISE EXCEPTION 'Unexpected or duplicate links'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tb_whatsapp_link_challenges WHERE id='43000000-0000-4000-8000-000000000003' AND attempts=5 AND status='EXHAUSTED') THEN RAISE EXCEPTION 'Wrong-code attempts not persisted'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tb_whatsapp_link_challenges WHERE id='43000000-0000-4000-8000-000000000004' AND status='EXPIRED') THEN RAISE EXCEPTION 'Expired challenge not closed'; END IF;
  IF EXISTS (SELECT 1 FROM public.tb_processed_whatsapp_events WHERE external_event_id='link-auth-denial') THEN RAISE EXCEPTION 'Failed transaction reserved event'; END IF;
  BEGIN
    INSERT INTO public.tb_whatsapp_links(user_id,sender,status,authorization_version,verified_at)
    VALUES('43000000-0000-4000-8000-000000000002','19990000001','ACTIVE',1,now());
    RAISE EXCEPTION 'Duplicate active sender accepted';
  EXCEPTION WHEN unique_violation THEN
    IF SQLERRM NOT LIKE '%uq_whatsapp_links_active_sender%' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO public.tb_whatsapp_links(user_id,sender,status,authorization_version,verified_at)
    VALUES('43000000-0000-4000-8000-000000000001','19990000008','ACTIVE',2,now());
    RAISE EXCEPTION 'Duplicate active user accepted';
  EXCEPTION WHEN unique_violation THEN
    IF SQLERRM NOT LIKE '%uq_whatsapp_links_active_user%' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO public.tb_whatsapp_link_challenges SELECT gen_random_uuid(),user_id,expected_sender,repeat('9',64),gen_random_uuid(),status,attempts,created_at,expires_at,resolved_at
      FROM public.tb_whatsapp_link_challenges WHERE id='43000000-0000-4000-8000-000000000005';
    RAISE EXCEPTION 'Two pending challenges accepted';
  EXCEPTION WHEN unique_violation THEN
    IF SQLERRM NOT LIKE '%uq_whatsapp_challenge_pending%' THEN RAISE; END IF;
  END;
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    FOREACH t IN ARRAY ARRAY['tb_whatsapp_links','tb_whatsapp_link_challenges','tb_whatsapp_link_events','tb_whatsapp_link_attempt_buckets'] LOOP
      IF has_table_privilege(r,'public.'||t,'SELECT,INSERT,UPDATE,DELETE') THEN RAISE EXCEPTION 'Unexpected direct privilege'; END IF;
    END LOOP;
  END LOOP;
  FOR f IN SELECT p.* FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
    AND p.proname IN ('fn_whatsapp_link_account','fn_start_whatsapp_link_challenge','fn_cancel_whatsapp_link_challenge','fn_get_whatsapp_link_state','fn_complete_whatsapp_link_challenge') LOOP
    IF pg_get_userbyid(f.proowner) <> 'postgres' OR NOT f.prosecdef OR f.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog'] THEN RAISE EXCEPTION 'Unsafe function configuration'; END IF;
    IF has_function_privilege('anon',f.oid,'EXECUTE') OR has_function_privilege('authenticated',f.oid,'EXECUTE')
       OR EXISTS(SELECT 1 FROM aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) WHERE grantee=0 AND privilege_type='EXECUTE') THEN RAISE EXCEPTION 'Public function access'; END IF;
    IF has_function_privilege('service_role',f.oid,'EXECUTE') <> (f.proname <> 'fn_whatsapp_link_account') THEN RAISE EXCEPTION 'Wrong backend access'; END IF;
  END LOOP;
END;
$$;

-- History is retained, while revoked rows cannot be projected as active links.
UPDATE public.tb_whatsapp_links SET status='REVOKED', revoked_at=clock_timestamp();
DO $$
BEGIN
  IF public.fn_get_whatsapp_link_state('43000000-0000-4000-8000-000000000001')->'link' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'Revoked link authorizes state';
  END IF;
  IF (SELECT count(*) FROM public.tb_whatsapp_links WHERE status='REVOKED') <> 1 THEN RAISE EXCEPTION 'Revoked history lost'; END IF;
END;
$$;

SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.fn_get_whatsapp_link_state('43000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'Client RPC access accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE '%permission denied%' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO public.tb_whatsapp_link_attempt_buckets VALUES(repeat('0',64),now(),1);
    RAISE EXCEPTION 'Client table write accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE '%permission denied%' THEN RAISE; END IF;
  END;
END;
$$;
RESET ROLE;

SET LOCAL ROLE anon;
DO $$
BEGIN
  BEGIN
    PERFORM public.fn_start_whatsapp_link_challenge(NULL,NULL,NULL,NULL,NULL);
    RAISE EXCEPTION 'Anonymous RPC access accepted';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE '%permission denied%' THEN RAISE; END IF;
  END;
END;
$$;
RESET ROLE;

SELECT 'PASS WhatsApp linking single-use, expiry, attempts, replay, conflicts and ACL' AS result;
ROLLBACK;
