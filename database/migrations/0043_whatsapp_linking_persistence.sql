BEGIN;

-- Additive foundation only: no backfill, channel integration or legacy changes.
CREATE TABLE public.tb_whatsapp_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.tb_users(id) ON DELETE RESTRICT,
  sender TEXT NOT NULL CHECK (sender ~ '^[1-9][0-9]{7,14}$'),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  authorization_version BIGINT NOT NULL CHECK (authorization_version BETWEEN 1 AND 9007199254740991),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  verified_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CHECK ((status = 'ACTIVE' AND revoked_at IS NULL)
      OR (status = 'REVOKED' AND revoked_at IS NOT NULL AND revoked_at >= verified_at)),
  UNIQUE (user_id, authorization_version)
);
CREATE UNIQUE INDEX uq_whatsapp_links_active_user ON public.tb_whatsapp_links(user_id) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX uq_whatsapp_links_active_sender ON public.tb_whatsapp_links(sender) WHERE status = 'ACTIVE';

CREATE TABLE public.tb_whatsapp_link_challenges (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.tb_users(id) ON DELETE RESTRICT,
  expected_sender TEXT NOT NULL CHECK (expected_sender ~ '^[1-9][0-9]{7,14}$'),
  code_digest TEXT NOT NULL UNIQUE CHECK (code_digest ~ '^[0-9a-f]{64}$'),
  idempotency_key UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'CONSUMED', 'CANCELLED', 'EXPIRED', 'EXHAUSTED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  CHECK (expires_at = created_at + interval '10 minutes'),
  CHECK ((status = 'PENDING' AND resolved_at IS NULL AND attempts < 5)
      OR (status <> 'PENDING' AND resolved_at IS NOT NULL)),
  CHECK (status <> 'EXHAUSTED' OR attempts = 5),
  UNIQUE(user_id, idempotency_key)
);
CREATE UNIQUE INDEX uq_whatsapp_challenge_pending ON public.tb_whatsapp_link_challenges(user_id) WHERE status = 'PENDING';
CREATE INDEX idx_whatsapp_challenge_user_created ON public.tb_whatsapp_link_challenges(user_id, created_at);

-- Unknown codes cannot identify a challenge. Limit by HMAC-validated sender too.
CREATE TABLE public.tb_whatsapp_link_attempt_buckets (
  sender_digest TEXT PRIMARY KEY CHECK (sender_digest ~ '^[0-9a-f]{64}$'),
  window_started_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts BETWEEN 1 AND 20)
);
-- Separate result ledger; event reservation in the existing ledger is atomic.
CREATE TABLE public.tb_whatsapp_link_events (
  external_event_id TEXT PRIMARY KEY REFERENCES public.tb_processed_whatsapp_events(external_event_id) ON DELETE RESTRICT,
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION public.fn_whatsapp_link_account(p_auth_user_id UUID)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_user_id UUID;
BEGIN
  IF p_auth_user_id IS NULL THEN
    RAISE EXCEPTION 'WhatsApp linking is unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM auth.users WHERE id = p_auth_user_id
    AND nullif(btrim(email), '') IS NOT NULL AND email_confirmed_at IS NOT NULL FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WhatsApp linking is unavailable' USING ERRCODE = '42501';
  END IF;
  SELECT id INTO v_user_id FROM public.tb_users WHERE auth_user_id = p_auth_user_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WhatsApp linking is unavailable' USING ERRCODE = '42501';
  END IF;
  RETURN v_user_id;
END;
$$;

CREATE FUNCTION public.fn_start_whatsapp_link_challenge(
  p_auth_user_id UUID, p_challenge_id UUID, p_sender TEXT, p_code_digest TEXT, p_idempotency_key UUID
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_user UUID; v_existing public.tb_whatsapp_link_challenges; v_now TIMESTAMPTZ;
BEGIN
  -- One transaction-scoped gate for this small, infrequent account workflow.
  -- All mutators take the gate first. Start/cancel then lock Auth -> user.
  -- Completion writes event/counter before locking Auth -> user for a valid code.
  PERFORM pg_advisory_xact_lock(18443, 43);
  v_user := public.fn_whatsapp_link_account(p_auth_user_id);
  v_now := clock_timestamp();
  IF p_challenge_id IS NULL OR p_idempotency_key IS NULL OR p_sender IS NULL
     OR p_sender !~ '^[1-9][0-9]{7,14}$' OR p_code_digest IS NULL OR p_code_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid WhatsApp linking input' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_existing FROM public.tb_whatsapp_link_challenges
    WHERE user_id = v_user AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.id <> p_challenge_id OR v_existing.expected_sender <> p_sender OR v_existing.code_digest <> p_code_digest THEN
      RETURN jsonb_build_object('status', 'IDEMPOTENCY_CONFLICT');
    END IF;
    IF v_existing.status = 'PENDING' AND v_existing.expires_at <= v_now THEN
      UPDATE public.tb_whatsapp_link_challenges SET status = 'EXPIRED', resolved_at = v_now WHERE id = v_existing.id;
      v_existing.status := 'EXPIRED';
    END IF;
    RETURN jsonb_build_object('status', v_existing.status, 'challengeId', v_existing.id, 'expiresAt', v_existing.expires_at);
  END IF;
  IF EXISTS (SELECT 1 FROM public.tb_whatsapp_links WHERE user_id = v_user AND status = 'ACTIVE') THEN
    RETURN jsonb_build_object('status', 'ALREADY_LINKED');
  END IF;
  -- Even an own legacy identifier is not silently promoted to verified.
  IF EXISTS (SELECT 1 FROM public.tb_users WHERE external_identifier = p_sender)
     OR EXISTS (SELECT 1 FROM public.tb_whatsapp_links WHERE sender = p_sender AND status = 'ACTIVE') THEN
    RETURN jsonb_build_object('status', 'UNAVAILABLE');
  END IF;
  IF EXISTS (SELECT 1 FROM public.tb_whatsapp_link_challenges WHERE user_id = v_user AND created_at > v_now - interval '1 minute')
     OR (SELECT count(*) FROM public.tb_whatsapp_link_challenges WHERE user_id = v_user AND created_at > v_now - interval '15 minutes') >= 3 THEN
    RETURN jsonb_build_object('status', 'RATE_LIMITED');
  END IF;
  IF EXISTS (SELECT 1 FROM public.tb_whatsapp_link_challenges WHERE id = p_challenge_id OR code_digest = p_code_digest) THEN
    RETURN jsonb_build_object('status', 'UNAVAILABLE');
  END IF;
  UPDATE public.tb_whatsapp_link_challenges SET status = CASE WHEN expires_at <= v_now THEN 'EXPIRED' ELSE 'CANCELLED' END,
    resolved_at = v_now WHERE user_id = v_user AND status = 'PENDING';
  INSERT INTO public.tb_whatsapp_link_challenges(id, user_id, expected_sender, code_digest, idempotency_key, status, created_at, expires_at)
    VALUES (p_challenge_id, v_user, p_sender, p_code_digest, p_idempotency_key, 'PENDING', v_now, v_now + interval '10 minutes');
  RETURN jsonb_build_object('status', 'PENDING', 'challengeId', p_challenge_id, 'expiresAt', v_now + interval '10 minutes');
END;
$$;

CREATE FUNCTION public.fn_cancel_whatsapp_link_challenge(p_auth_user_id UUID, p_challenge_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_user UUID; v_challenge public.tb_whatsapp_link_challenges;
BEGIN
  PERFORM pg_advisory_xact_lock(18443, 43);
  v_user := public.fn_whatsapp_link_account(p_auth_user_id);
  SELECT * INTO v_challenge FROM public.tb_whatsapp_link_challenges WHERE id = p_challenge_id AND user_id = v_user;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'NOT_FOUND'); END IF;
  IF v_challenge.status = 'PENDING' THEN
    UPDATE public.tb_whatsapp_link_challenges SET status = CASE WHEN expires_at <= clock_timestamp() THEN 'EXPIRED' ELSE 'CANCELLED' END,
      resolved_at = clock_timestamp() WHERE id = p_challenge_id RETURNING * INTO v_challenge;
  END IF;
  RETURN jsonb_build_object('status', v_challenge.status, 'challengeId', p_challenge_id);
END;
$$;

CREATE FUNCTION public.fn_get_whatsapp_link_state(p_auth_user_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_user UUID; v_result JSONB;
BEGIN
  v_user := public.fn_whatsapp_link_account(p_auth_user_id);
  -- One statement snapshot; neither secret digests nor full senders are returned.
  SELECT jsonb_build_object(
    'link', (SELECT jsonb_build_object('id', id, 'authorizationVersion', authorization_version, 'verifiedAt', verified_at)
             FROM public.tb_whatsapp_links WHERE user_id = v_user AND status = 'ACTIVE'),
    'challenge', (SELECT jsonb_build_object('id', id, 'status', CASE WHEN status = 'PENDING' AND expires_at <= clock_timestamp() THEN 'EXPIRED' ELSE status END,
                  'expiresAt', expires_at, 'attemptsRemaining', 5 - attempts)
                  FROM public.tb_whatsapp_link_challenges WHERE user_id = v_user ORDER BY created_at DESC, id DESC LIMIT 1)
  ) INTO v_result;
  RETURN v_result;
END;
$$;

CREATE FUNCTION public.fn_complete_whatsapp_link_challenge(
  p_challenge_id UUID, p_sender TEXT, p_code_digest TEXT, p_external_event_id TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_challenge public.tb_whatsapp_link_challenges; v_auth UUID; v_now TIMESTAMPTZ;
  v_sender_digest TEXT; v_request_digest TEXT; v_event public.tb_whatsapp_link_events;
  v_bucket public.tb_whatsapp_link_attempt_buckets; v_result JSONB; v_link UUID;
BEGIN
  PERFORM pg_advisory_xact_lock(18443, 43);
  v_now := clock_timestamp();
  IF p_challenge_id IS NULL OR p_sender IS NULL OR p_sender !~ '^[1-9][0-9]{7,14}$'
     OR p_code_digest IS NULL OR p_code_digest !~ '^[0-9a-f]{64}$'
     OR p_external_event_id IS NULL OR length(p_external_event_id) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'Invalid WhatsApp linking input' USING ERRCODE = '22023';
  END IF;
  v_sender_digest := encode(sha256(convert_to(p_sender, 'UTF8')), 'hex');
  v_request_digest := encode(sha256(convert_to(p_challenge_id::text || ':' || p_sender || ':' || p_code_digest, 'UTF8')), 'hex');
  SELECT * INTO v_event FROM public.tb_whatsapp_link_events WHERE external_event_id = p_external_event_id;
  IF FOUND THEN
    IF v_event.request_digest <> v_request_digest THEN RETURN jsonb_build_object('status', 'EVENT_CONFLICT'); END IF;
    RETURN v_event.result;
  END IF;
  INSERT INTO public.tb_processed_whatsapp_events(external_event_id) VALUES (p_external_event_id) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'EVENT_CONFLICT'); END IF;
  SELECT * INTO v_bucket FROM public.tb_whatsapp_link_attempt_buckets WHERE sender_digest = v_sender_digest;
  IF FOUND AND v_bucket.window_started_at > v_now - interval '15 minutes' AND v_bucket.attempts >= 20 THEN
    v_result := jsonb_build_object('status', 'RATE_LIMITED');
  ELSE
    INSERT INTO public.tb_whatsapp_link_attempt_buckets(sender_digest, window_started_at, attempts)
      VALUES(v_sender_digest, v_now, 1)
      ON CONFLICT(sender_digest) DO UPDATE SET
        attempts = CASE WHEN tb_whatsapp_link_attempt_buckets.window_started_at <= v_now - interval '15 minutes' THEN 1 ELSE tb_whatsapp_link_attempt_buckets.attempts + 1 END,
        window_started_at = CASE WHEN tb_whatsapp_link_attempt_buckets.window_started_at <= v_now - interval '15 minutes' THEN v_now ELSE tb_whatsapp_link_attempt_buckets.window_started_at END;
    SELECT * INTO v_challenge FROM public.tb_whatsapp_link_challenges WHERE id = p_challenge_id;
    v_result := jsonb_build_object('status', 'INVALID');
    IF FOUND AND v_challenge.status = 'PENDING' THEN
      IF v_challenge.expires_at <= v_now THEN
        UPDATE public.tb_whatsapp_link_challenges SET status = 'EXPIRED', resolved_at = v_now WHERE id = p_challenge_id;
      ELSIF v_challenge.expected_sender = p_sender THEN
        IF v_challenge.code_digest <> p_code_digest THEN
          UPDATE public.tb_whatsapp_link_challenges SET attempts = attempts + 1,
            status = CASE WHEN attempts + 1 >= 5 THEN 'EXHAUSTED' ELSE 'PENDING' END,
            resolved_at = CASE WHEN attempts + 1 >= 5 THEN v_now ELSE NULL END WHERE id = p_challenge_id;
        ELSE
          SELECT auth_user_id INTO v_auth FROM public.tb_users WHERE id = v_challenge.user_id;
          IF public.fn_whatsapp_link_account(v_auth) IS DISTINCT FROM v_challenge.user_id THEN
            RAISE EXCEPTION 'WhatsApp linking is unavailable' USING ERRCODE = '42501';
          END IF;
          -- Auth locking can wait. Recheck wall-clock expiry after that wait.
          v_now := clock_timestamp();
          IF v_challenge.expires_at <= v_now THEN
            UPDATE public.tb_whatsapp_link_challenges SET status = 'EXPIRED', resolved_at = v_now WHERE id = p_challenge_id;
          ELSIF EXISTS (SELECT 1 FROM public.tb_users WHERE external_identifier = p_sender)
             OR EXISTS (SELECT 1 FROM public.tb_whatsapp_links WHERE status = 'ACTIVE' AND (sender = p_sender OR user_id = v_challenge.user_id)) THEN
            v_result := jsonb_build_object('status', 'UNAVAILABLE');
          ELSE
            INSERT INTO public.tb_whatsapp_links(user_id, sender, status, authorization_version, verified_at)
              SELECT v_challenge.user_id, p_sender, 'ACTIVE', COALESCE(max(authorization_version), 0) + 1, v_now
                FROM public.tb_whatsapp_links WHERE user_id = v_challenge.user_id RETURNING id INTO v_link;
            UPDATE public.tb_whatsapp_link_challenges SET status = 'CONSUMED', resolved_at = v_now WHERE id = p_challenge_id;
            v_result := jsonb_build_object('status', 'LINKED', 'linkId', v_link);
          END IF;
        END IF;
      END IF;
    END IF;
  END IF;
  INSERT INTO public.tb_whatsapp_link_events(external_event_id, request_digest, result)
    VALUES (p_external_event_id, v_request_digest, v_result);
  RETURN v_result;
END;
$$;

DO $permissions$
DECLARE v_table TEXT; v_role TEXT; f RECORD;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['tb_whatsapp_links', 'tb_whatsapp_link_challenges', 'tb_whatsapp_link_attempt_buckets', 'tb_whatsapp_link_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO postgres', v_table);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, service_role', v_table);
    FOR v_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', v_table, v_role);
    END LOOP;
  END LOOP;
  FOR f IN SELECT p.oid, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('fn_whatsapp_link_account', 'fn_start_whatsapp_link_challenge', 'fn_cancel_whatsapp_link_challenge', 'fn_get_whatsapp_link_state', 'fn_complete_whatsapp_link_challenge') LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', f.oid::regprocedure);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, service_role', f.oid::regprocedure);
    FOR v_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f.oid::regprocedure, v_role);
    END LOOP;
    IF f.proname <> 'fn_whatsapp_link_account' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.oid::regprocedure);
    END IF;
  END LOOP;
END;
$permissions$;

COMMIT;
