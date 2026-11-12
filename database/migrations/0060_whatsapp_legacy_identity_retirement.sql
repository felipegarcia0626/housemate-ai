BEGIN;

-- Serialize with identity resolution, linking, revocation, and event claims.
SELECT pg_catalog.pg_advisory_xact_lock(18443, 43);

-- Once an account has ever completed a verified link, none of its generic
-- external_identifier values may authorize the account through LEGACY again.
CREATE TABLE public.tb_whatsapp_legacy_identity_retirements (
  user_id UUID PRIMARY KEY
    REFERENCES public.tb_users(id) ON DELETE RESTRICT,
  first_verified_at TIMESTAMPTZ NOT NULL
);
ALTER TABLE public.tb_whatsapp_legacy_identity_retirements OWNER TO postgres;
ALTER TABLE public.tb_whatsapp_legacy_identity_retirements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tb_whatsapp_legacy_identity_retirements
  FROM PUBLIC, anon, authenticated, service_role;

-- Every row in tb_whatsapp_links represents a completed possession challenge,
-- including rows that have since been revoked. Use the actual verification time.
INSERT INTO public.tb_whatsapp_legacy_identity_retirements(user_id, first_verified_at)
SELECT l.user_id, min(l.verified_at)
FROM public.tb_whatsapp_links AS l
GROUP BY l.user_id
ON CONFLICT (user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_resolve_whatsapp_identity_locked(p_sender TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_legacy UUID; v_link public.tb_whatsapp_links;
BEGIN
  IF p_sender IS NULL OR p_sender = '' THEN RETURN NULL; END IF;
  SELECT u.id INTO v_legacy
    FROM public.tb_users AS u
    WHERE u.external_identifier = p_sender
    FOR SHARE;
  SELECT l.* INTO v_link
    FROM public.tb_whatsapp_links AS l
    WHERE l.sender = p_sender AND l.status = 'ACTIVE'
    FOR SHARE;
  IF FOUND THEN
    IF v_legacy IS NOT NULL AND v_legacy IS DISTINCT FROM v_link.user_id THEN RETURN NULL; END IF;
    RETURN jsonb_build_object('userId', v_link.user_id, 'origin', 'VERIFIED', 'linkId', v_link.id, 'authorizationVersion', v_link.authorization_version);
  END IF;
  IF EXISTS(SELECT 1 FROM public.tb_whatsapp_links AS l WHERE l.sender = p_sender AND l.status = 'REVOKED') THEN RETURN NULL; END IF;
  IF v_legacy IS NULL THEN RETURN NULL; END IF;
  IF EXISTS (
    SELECT 1 FROM public.tb_whatsapp_legacy_identity_retirements AS retirement
    WHERE retirement.user_id = v_legacy
  ) THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('userId', v_legacy, 'origin', 'LEGACY', 'linkId', NULL, 'authorizationVersion', NULL);
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_start_whatsapp_link_challenge(
  p_auth_user_id UUID, p_challenge_id UUID, p_sender TEXT, p_code_digest TEXT, p_idempotency_key UUID
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_user UUID;
  v_existing public.tb_whatsapp_link_challenges;
  v_now TIMESTAMPTZ;
  v_legacy_user UUID;
BEGIN
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
  -- A phone may be promoted only by the Auth-mapped owner of its legacy row.
  SELECT u.id INTO v_legacy_user
    FROM public.tb_users AS u
    WHERE u.external_identifier = p_sender
    FOR SHARE;
  IF v_legacy_user IS NOT NULL AND v_legacy_user IS DISTINCT FROM v_user THEN
    RETURN jsonb_build_object('status', 'UNAVAILABLE');
  END IF;
  IF EXISTS (SELECT 1 FROM public.tb_whatsapp_links WHERE sender = p_sender AND status = 'ACTIVE') THEN
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

CREATE OR REPLACE FUNCTION public.fn_complete_whatsapp_link_challenge(
  p_challenge_id UUID, p_sender TEXT, p_code_digest TEXT, p_external_event_id TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_challenge public.tb_whatsapp_link_challenges;
  v_auth UUID;
  v_now TIMESTAMPTZ;
  v_sender_digest TEXT;
  v_request_digest TEXT;
  v_event public.tb_whatsapp_link_events;
  v_bucket public.tb_whatsapp_link_attempt_buckets;
  v_result JSONB;
  v_link UUID;
  v_legacy_user UUID;
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
          ELSE
            SELECT u.id INTO v_legacy_user
              FROM public.tb_users AS u
              WHERE u.external_identifier = p_sender
              FOR SHARE;
            IF (v_legacy_user IS NOT NULL AND v_legacy_user IS DISTINCT FROM v_challenge.user_id)
               OR EXISTS (SELECT 1 FROM public.tb_whatsapp_links WHERE status = 'ACTIVE' AND (sender = p_sender OR user_id = v_challenge.user_id)) THEN
              v_result := jsonb_build_object('status', 'UNAVAILABLE');
            ELSE
              INSERT INTO public.tb_whatsapp_links(user_id, sender, status, authorization_version, verified_at)
                SELECT v_challenge.user_id, p_sender, 'ACTIVE', COALESCE(max(authorization_version), 0) + 1, v_now
                  FROM public.tb_whatsapp_links WHERE user_id = v_challenge.user_id RETURNING id INTO v_link;
              -- This marker and the link/challenge/event writes share this transaction.
              -- Conflict preserves the first verified timestamp permanently.
              INSERT INTO public.tb_whatsapp_legacy_identity_retirements(user_id, first_verified_at)
                VALUES (v_challenge.user_id, v_now)
                ON CONFLICT (user_id) DO NOTHING;
              UPDATE public.tb_whatsapp_link_challenges SET status = 'CONSUMED', resolved_at = v_now WHERE id = p_challenge_id;
              v_result := jsonb_build_object('status', 'LINKED', 'linkId', v_link);
            END IF;
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

ALTER FUNCTION public.fn_resolve_whatsapp_identity_locked(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_resolve_whatsapp_identity_locked(TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION public.fn_start_whatsapp_link_challenge(UUID, UUID, TEXT, TEXT, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_start_whatsapp_link_challenge(UUID, UUID, TEXT, TEXT, UUID)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_start_whatsapp_link_challenge(UUID, UUID, TEXT, TEXT, UUID)
  TO service_role;
ALTER FUNCTION public.fn_complete_whatsapp_link_challenge(UUID, TEXT, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_complete_whatsapp_link_challenge(UUID, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_complete_whatsapp_link_challenge(UUID, TEXT, TEXT, TEXT)
  TO service_role;

COMMIT;
