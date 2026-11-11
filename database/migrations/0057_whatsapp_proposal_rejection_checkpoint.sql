-- Keep proposal rejection and its recoverable WhatsApp response in the same
-- transaction. The fixed response matches renderAgentResult(REJECTED).
CREATE OR REPLACE FUNCTION public.fn_reject_whatsapp_proposal_event(
  p_event_id TEXT,
  p_token UUID,
  p_epoch BIGINT,
  p_proposal_id UUID,
  p_conversation_key TEXT,
  p_operation_type public.pending_operation_type
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  r public.tb_whatsapp_event_receipts;
  outcome JSONB;
  digest TEXT;
BEGIN
  r := public.fn_require_whatsapp_event_conversation(
    p_event_id,
    p_token,
    p_epoch,
    p_conversation_key
  );

  digest := encode(
    sha256(
      convert_to(
        jsonb_build_array(
          'REJECT_PROPOSAL',
          p_proposal_id,
          p_conversation_key,
          p_operation_type
        )::TEXT,
        'UTF8'
      )
    ),
    'hex'
  );

  IF r.business_result IS NOT NULL THEN
    IF r.operation_digest IS DISTINCT FROM digest THEN
      RAISE EXCEPTION 'Event operation changed' USING ERRCODE = '40001';
    END IF;
    RETURN r.business_result;
  END IF;

  outcome := public.fn_reject_whatsapp_pending_proposal(
    p_proposal_id,
    r.household_id,
    p_conversation_key,
    r.actor_member_id,
    p_operation_type,
    r.user_id,
    r.context_lease_id,
    r.context_epoch
  );

  IF outcome->>'status' = 'REJECTED' THEN
    UPDATE public.tb_whatsapp_event_receipts
    SET business_result = outcome,
        operation_digest = digest,
        delivery_state = 'READY',
        reply_template = 'TEXT_V1',
        reply_text = 'Operación rechazada.',
        reply_guard = '{"financial":true}'::JSONB,
        reply_expires_at = pg_catalog.clock_timestamp() + INTERVAL '72 hours',
        updated_at = pg_catalog.clock_timestamp()
    WHERE external_event_id = p_event_id
      AND event_token = p_token
      AND event_epoch = p_epoch
      AND processing_state = 'RUNNING'
      AND delivery_state = 'NONE'
      AND business_result IS NULL;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'WhatsApp rejection checkpoint is no longer current'
        USING ERRCODE = '40001';
    END IF;
  END IF;

  RETURN outcome;
END;
$$;

ALTER FUNCTION public.fn_reject_whatsapp_proposal_event(
  TEXT,
  UUID,
  BIGINT,
  UUID,
  TEXT,
  public.pending_operation_type
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_reject_whatsapp_proposal_event(
  TEXT,
  UUID,
  BIGINT,
  UUID,
  TEXT,
  public.pending_operation_type
) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.fn_reject_whatsapp_proposal_event(
  TEXT,
  UUID,
  BIGINT,
  UUID,
  TEXT,
  public.pending_operation_type
) TO service_role;
