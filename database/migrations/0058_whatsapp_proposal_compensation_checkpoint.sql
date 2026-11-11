BEGIN;

-- 0056 introduced a monotonic row version. Record that token when the proposal
-- is created so compensation cannot remove a proposal changed later in the
-- same transaction (where updated_at may remain unchanged because now() is
-- transaction-stable). Keep updatedAt for compatibility/diagnostics only.
CREATE OR REPLACE FUNCTION public.fn_create_whatsapp_proposal_event(
  p_event_id TEXT,
  p_token UUID,
  p_epoch BIGINT,
  p_id UUID,
  p_conversation_key TEXT,
  p_operation_type public.pending_operation_type,
  p_payload JSONB
)
RETURNS public.tb_pending_proposals
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  r public.tb_whatsapp_event_receipts;
  proposal public.tb_pending_proposals;
BEGIN
  r := public.fn_require_whatsapp_event_conversation(
    p_event_id,
    p_token,
    p_epoch,
    p_conversation_key
  );

  proposal := public.fn_create_whatsapp_pending_proposal(
    p_id,
    r.household_id,
    p_conversation_key,
    r.actor_member_id,
    p_operation_type,
    p_payload,
    r.user_id,
    r.context_lease_id,
    r.context_epoch
  );

  UPDATE public.tb_whatsapp_event_receipts
     SET artifacts = artifacts || pg_catalog.jsonb_build_object(
           p_id::TEXT,
           pg_catalog.jsonb_build_object(
             'updatedAt', proposal.updated_at,
             'version', proposal.version::TEXT,
             'operation', p_operation_type
           )
         ),
         updated_at = pg_catalog.clock_timestamp()
   WHERE external_event_id = p_event_id;

  RETURN proposal;
END;
$$;

ALTER FUNCTION public.fn_create_whatsapp_proposal_event(
  TEXT, UUID, BIGINT, UUID, TEXT, public.pending_operation_type, JSONB
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_create_whatsapp_proposal_event(
  TEXT, UUID, BIGINT, UUID, TEXT, public.pending_operation_type, JSONB
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.fn_create_whatsapp_proposal_event(
  TEXT, UUID, BIGINT, UUID, TEXT, public.pending_operation_type, JSONB
) TO service_role;

-- Compensation is fenced by the event receipt and compare-and-swap uses the
-- proposal's monotonic version captured above. Receipts created before 0058 do
-- not have this token and fail closed with VERSION_CONFLICT.
CREATE OR REPLACE FUNCTION public.fn_compensate_whatsapp_proposal_event(
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
  proposal public.tb_pending_proposals;
  artifact JSONB;
  v_expected_version BIGINT;
  v_operation_digest TEXT;
  outcome JSONB;
  v_reply_text TEXT;
BEGIN
  r := public.fn_require_whatsapp_event_conversation(
    p_event_id,
    p_token,
    p_epoch,
    p_conversation_key
  );

  v_operation_digest := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_array(
          'COMPENSATE_PROPOSAL',
          p_event_id,
          p_proposal_id,
          p_conversation_key,
          p_operation_type
        )::TEXT,
        'UTF8'
      )
    ),
    'hex'
  );

  -- Replays return the stored business outcome exactly. A receipt cannot be
  -- reused for another proposal or operation.
  IF r.business_result IS NOT NULL THEN
    IF r.operation_digest IS DISTINCT FROM v_operation_digest THEN
      RAISE EXCEPTION 'Event operation changed' USING ERRCODE = '40001';
    END IF;
    RETURN r.business_result;
  END IF;

  artifact := r.artifacts -> p_proposal_id::TEXT;
  IF artifact IS NULL
     OR pg_catalog.jsonb_typeof(artifact) IS DISTINCT FROM 'object'
     OR artifact ->> 'operation' IS DISTINCT FROM p_operation_type::TEXT THEN
    RAISE EXCEPTION 'Proposal creator is unavailable' USING ERRCODE = '42501';
  END IF;

  -- 0047 artifacts have no version. Do not fall back to their timestamp:
  -- an unknown or malformed token cannot authorize a destructive operation.
  IF artifact -> 'version' IS NULL
     OR pg_catalog.jsonb_typeof(artifact -> 'version') IS DISTINCT FROM 'string'
     OR artifact ->> 'version' !~ '^[1-9][0-9]*$' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'VERSION_CONFLICT');
  END IF;

  BEGIN
    v_expected_version := (artifact ->> 'version')::BIGINT;
  EXCEPTION
    WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RETURN pg_catalog.jsonb_build_object('status', 'VERSION_CONFLICT');
  END;

  SELECT *
    INTO proposal
    FROM public.tb_pending_proposals
   WHERE id = p_proposal_id
     AND household_id = r.household_id
     AND actor_member_id = r.actor_member_id
     AND conversation_key = p_conversation_key
     AND source = 'WHATSAPP'
     AND operation_type = p_operation_type
   FOR UPDATE;

  IF NOT FOUND THEN
    -- A missing or out-of-context proposal is a deterministic no-op. The
    -- scoped lookup deliberately does not reveal whether another actor owns it.
    outcome := pg_catalog.jsonb_build_object(
      'status', 'NOT_FOUND',
      'proposal_id', p_proposal_id,
      'operation', 'COMPENSATE_PROPOSAL'
    );
    v_reply_text := 'No se encontró una propuesta pendiente para cancelar.';
  ELSE
    IF proposal.status IS DISTINCT FROM 'AWAITING_CONFIRMATION'
       OR proposal.version IS DISTINCT FROM v_expected_version THEN
      RETURN pg_catalog.jsonb_build_object('status', 'VERSION_CONFLICT');
    END IF;

    DELETE FROM public.tb_pending_proposals
     WHERE id = p_proposal_id
       AND household_id = r.household_id
       AND actor_member_id = r.actor_member_id
       AND conversation_key = p_conversation_key
       AND source = 'WHATSAPP'
       AND operation_type = p_operation_type
       AND status = 'AWAITING_CONFIRMATION'
       AND version = v_expected_version;

    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object('status', 'VERSION_CONFLICT');
    END IF;

    outcome := pg_catalog.jsonb_build_object(
      'status', 'REMOVED',
      'proposal_id', p_proposal_id,
      'operation', 'COMPENSATE_PROPOSAL'
    );
    v_reply_text := 'No se pudo completar la solicitud. La propuesta fue cancelada.';
  END IF;

  -- The outcome, digest and recoverable response commit atomically with a
  -- possible DELETE. A checkpoint failure rolls the DELETE back as well.
  UPDATE public.tb_whatsapp_event_receipts
     SET business_result = outcome,
         operation_digest = v_operation_digest,
         delivery_state = 'READY',
         reply_template = 'TEXT_V1',
         reply_text = v_reply_text,
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
    RAISE EXCEPTION 'WhatsApp compensation checkpoint is no longer current'
      USING ERRCODE = '40001';
  END IF;

  RETURN outcome;
END;
$$;

ALTER FUNCTION public.fn_compensate_whatsapp_proposal_event(
  TEXT, UUID, BIGINT, UUID, TEXT, public.pending_operation_type
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_compensate_whatsapp_proposal_event(
  TEXT, UUID, BIGINT, UUID, TEXT, public.pending_operation_type
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.fn_compensate_whatsapp_proposal_event(
  TEXT, UUID, BIGINT, UUID, TEXT, public.pending_operation_type
) TO service_role;

COMMIT;
