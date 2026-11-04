BEGIN;

-- Identity resolution can wait on a row lock after the first expiry check.
-- Never authorize or renew a lease that expired during that wait.
CREATE OR REPLACE FUNCTION public.fn_whatsapp_lease_authorized(p_user_id UUID,p_lease_id UUID,p_lease_epoch BIGINT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_context public.tb_whatsapp_user_contexts; v_identity JSONB;
BEGIN
  PERFORM pg_advisory_xact_lock(18443,43);
  SELECT * INTO v_context FROM public.tb_whatsapp_user_contexts WHERE user_id=p_user_id FOR SHARE;
  IF NOT FOUND OR p_lease_id IS NULL OR p_lease_epoch IS NULL
     OR v_context.processing_lease_id IS DISTINCT FROM p_lease_id
     OR v_context.processing_epoch IS DISTINCT FROM p_lease_epoch
     OR v_context.processing_expires_at IS NULL OR v_context.processing_expires_at<=clock_timestamp()
     OR v_context.authorization_origin IS NULL THEN RETURN false; END IF;
  v_identity := public.fn_resolve_whatsapp_identity_locked(v_context.authorization_sender);
  RETURN COALESCE(v_context.processing_expires_at > clock_timestamp()
    AND v_identity IS NOT NULL
    AND (v_identity->>'userId')::uuid = p_user_id
    AND v_identity->>'origin' = v_context.authorization_origin
    AND (v_identity->>'linkId')::uuid IS NOT DISTINCT FROM v_context.authorization_link_id
    AND (v_identity->>'authorizationVersion')::bigint IS NOT DISTINCT FROM v_context.authorization_version,false);
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_renew_whatsapp_context_lease(p_user_id UUID,p_lease_id UUID,p_lease_epoch BIGINT,p_lease_seconds INTEGER DEFAULT 120)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(18443,43);
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 300
     OR NOT public.fn_whatsapp_lease_authorized(p_user_id,p_lease_id,p_lease_epoch) THEN RETURN false; END IF;
  UPDATE public.tb_whatsapp_user_contexts SET processing_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),updated_at=clock_timestamp()
    WHERE user_id=p_user_id AND processing_lease_id=p_lease_id AND processing_epoch=p_lease_epoch
      AND processing_expires_at>clock_timestamp();
  RETURN FOUND;
END;
$$;

ALTER FUNCTION public.fn_whatsapp_lease_authorized(UUID,UUID,BIGINT) OWNER TO postgres;
ALTER FUNCTION public.fn_renew_whatsapp_context_lease(UUID,UUID,BIGINT,INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_whatsapp_lease_authorized(UUID,UUID,BIGINT) FROM PUBLIC,service_role;
REVOKE ALL ON FUNCTION public.fn_renew_whatsapp_context_lease(UUID,UUID,BIGINT,INTEGER) FROM PUBLIC,service_role;
DO $$
DECLARE r TEXT;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.fn_whatsapp_lease_authorized(UUID,UUID,BIGINT) FROM %I',r);
    EXECUTE format('REVOKE ALL ON FUNCTION public.fn_renew_whatsapp_context_lease(UUID,UUID,BIGINT,INTEGER) FROM %I',r);
  END LOOP;
END;
$$;
GRANT EXECUTE ON FUNCTION public.fn_renew_whatsapp_context_lease(UUID,UUID,BIGINT,INTEGER) TO service_role;

COMMIT;
