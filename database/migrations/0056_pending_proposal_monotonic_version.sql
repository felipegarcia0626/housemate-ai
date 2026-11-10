BEGIN;

-- A row version, not a transaction timestamp, is the optimistic concurrency
-- token for Web proposal correction, confirmation, and compensation.
ALTER TABLE public.tb_pending_proposals
  ADD COLUMN version bigint NOT NULL DEFAULT 1;

ALTER TABLE public.tb_pending_proposals
  ADD CONSTRAINT ck_tb_pending_proposals_version_positive CHECK (version > 0);

COMMENT ON COLUMN public.tb_pending_proposals.version IS
  'Monotonic compare-and-swap token; initialized by trigger and incremented on every row update.';

CREATE FUNCTION public.fn_set_pending_proposal_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.version := 1;
  ELSE
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.fn_set_pending_proposal_version() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_set_pending_proposal_version()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_tb_pending_proposals_set_monotonic_version
BEFORE INSERT OR UPDATE ON public.tb_pending_proposals
FOR EACH ROW EXECUTE FUNCTION public.fn_set_pending_proposal_version();

-- Preserve the reviewed 0054 confirmation implementation as an owner-only
-- delegate. The new public RPCs below verify the monotonic version while
-- holding the proposal row lock, then pass the locked row's timestamp only as
-- an internal compatibility precondition to this existing implementation.
ALTER FUNCTION public.fn_confirm_web_pending_expense(uuid,uuid,timestamptz)
  RENAME TO fn_internal_confirm_web_pending_expense_v0054;
ALTER FUNCTION public.fn_confirm_web_pending_income(uuid,uuid,timestamptz)
  RENAME TO fn_internal_confirm_web_pending_income_v0054;

REVOKE ALL ON FUNCTION public.fn_internal_confirm_web_pending_expense_v0054(uuid,uuid,timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_internal_confirm_web_pending_income_v0054(uuid,uuid,timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

-- The five row-returning 0055 RPCs are replaced by JSONB wrappers so bigint is
-- returned as decimal text. JavaScript must never round a version above 2^53.
ALTER FUNCTION public.fn_create_web_pending_proposal(uuid,text,public.pending_operation_type,jsonb)
  RENAME TO fn_internal_create_web_pending_proposal_v0055;
ALTER FUNCTION public.fn_get_web_pending_proposal(uuid,uuid,text,public.pending_operation_type)
  RENAME TO fn_internal_get_web_pending_proposal_v0055;
ALTER FUNCTION public.fn_get_web_active_pending_proposal(uuid,text)
  RENAME TO fn_internal_get_web_active_pending_proposal_v0055;
ALTER FUNCTION public.fn_get_web_latest_terminal_pending_proposal(uuid,text)
  RENAME TO fn_internal_get_web_latest_terminal_pending_proposal_v0055;

REVOKE ALL ON FUNCTION public.fn_internal_create_web_pending_proposal_v0055(uuid,text,public.pending_operation_type,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_internal_get_web_pending_proposal_v0055(uuid,uuid,text,public.pending_operation_type)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_internal_get_web_active_pending_proposal_v0055(uuid,text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_internal_get_web_latest_terminal_pending_proposal_v0055(uuid,text)
  FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION public.fn_update_web_pending_proposal(
  uuid,uuid,text,public.pending_operation_type,timestamptz,jsonb
);
DROP FUNCTION public.fn_compensate_web_pending_proposal(
  uuid,uuid,text,public.pending_operation_type,timestamptz,timestamptz
);

CREATE FUNCTION public.fn_web_pending_proposal_json(
  p_proposal public.tb_pending_proposals
) RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
  SELECT pg_catalog.to_jsonb(p_proposal)
         || pg_catalog.jsonb_build_object('version', (p_proposal).version::text)
$$;

ALTER FUNCTION public.fn_web_pending_proposal_json(public.tb_pending_proposals)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_web_pending_proposal_json(public.tb_pending_proposals)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.fn_create_web_pending_proposal(
  p_household_id uuid,
  p_conversation_key text,
  p_operation_type public.pending_operation_type,
  p_payload jsonb
) RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT public.fn_web_pending_proposal_json(
    public.fn_internal_create_web_pending_proposal_v0055(
      p_household_id, p_conversation_key, p_operation_type, p_payload
    )
  )
$$;

CREATE FUNCTION public.fn_get_web_pending_proposal(
  p_proposal_id uuid,
  p_household_id uuid,
  p_conversation_key text,
  p_operation_type public.pending_operation_type
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_proposal public.tb_pending_proposals%ROWTYPE;
BEGIN
  v_proposal := public.fn_internal_get_web_pending_proposal_v0055(
    p_proposal_id, p_household_id, p_conversation_key, p_operation_type
  );
  IF v_proposal IS NULL THEN RETURN NULL; END IF;
  RETURN public.fn_web_pending_proposal_json(v_proposal);
END;
$$;

CREATE FUNCTION public.fn_get_web_active_pending_proposal(
  p_household_id uuid,
  p_conversation_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_proposal public.tb_pending_proposals%ROWTYPE;
BEGIN
  v_proposal := public.fn_internal_get_web_active_pending_proposal_v0055(
    p_household_id, p_conversation_key
  );
  IF v_proposal IS NULL THEN RETURN NULL; END IF;
  RETURN public.fn_web_pending_proposal_json(v_proposal);
END;
$$;

CREATE FUNCTION public.fn_get_web_latest_terminal_pending_proposal(
  p_household_id uuid,
  p_conversation_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_proposal public.tb_pending_proposals%ROWTYPE;
BEGIN
  v_proposal := public.fn_internal_get_web_latest_terminal_pending_proposal_v0055(
    p_household_id, p_conversation_key
  );
  IF v_proposal IS NULL THEN RETURN NULL; END IF;
  RETURN public.fn_web_pending_proposal_json(v_proposal);
END;
$$;

CREATE FUNCTION public.fn_update_web_pending_proposal(
  p_proposal_id uuid,
  p_household_id uuid,
  p_conversation_key text,
  p_operation_type public.pending_operation_type,
  p_expected_version bigint,
  p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor_member_id uuid;
  v_conversation_key text;
  v_payload jsonb;
  v_proposal public.tb_pending_proposals%ROWTYPE;
BEGIN
  v_actor_member_id := public.fn_require_web_financial_actor(p_household_id);
  v_conversation_key := 'web:' || p_household_id::text || ':' || v_actor_member_id::text;
  IF p_conversation_key IS DISTINCT FROM v_conversation_key THEN
    RAISE EXCEPTION 'Web conversation is unavailable'
      USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
  END IF;

  SELECT proposal.* INTO v_proposal
    FROM public.tb_pending_proposals AS proposal
   WHERE proposal.id = p_proposal_id
     AND proposal.household_id = p_household_id
     AND proposal.conversation_key = v_conversation_key
     AND proposal.actor_member_id = v_actor_member_id
     AND proposal.source = 'WEB'
     AND proposal.payload ->> 'actorMemberId' = v_actor_member_id::text
     AND proposal.payload ->> 'source' = 'WEB'
     AND proposal.operation_type = p_operation_type
     AND proposal.status = 'AWAITING_CONFIRMATION'
   FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF p_expected_version IS NULL
     OR v_proposal.version IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'Web pending proposal changed before correction'
      USING ERRCODE = '40001';
  END IF;

  v_payload := p_payload || pg_catalog.jsonb_build_object(
    'actorMemberId', v_actor_member_id::text, 'source', 'WEB'
  );
  PERFORM public.fn_assert_web_pending_proposal_snapshot(
    p_household_id, v_actor_member_id, p_operation_type, v_payload
  );

  UPDATE public.tb_pending_proposals AS proposal
     SET payload = v_payload
   WHERE proposal.id = p_proposal_id
     AND proposal.household_id = p_household_id
     AND proposal.conversation_key = v_conversation_key
     AND proposal.actor_member_id = v_actor_member_id
     AND proposal.source = 'WEB'
     AND proposal.operation_type = p_operation_type
     AND proposal.status = 'AWAITING_CONFIRMATION'
     AND proposal.version = p_expected_version
  RETURNING proposal.* INTO v_proposal;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Web pending proposal changed before correction'
      USING ERRCODE = '40001';
  END IF;
  RETURN public.fn_web_pending_proposal_json(v_proposal);
END;
$$;

CREATE FUNCTION public.fn_compensate_web_pending_proposal(
  p_proposal_id uuid,
  p_household_id uuid,
  p_conversation_key text,
  p_operation_type public.pending_operation_type,
  p_expected_created_at timestamptz,
  p_expected_version bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_actor_member_id uuid;
  v_conversation_key text;
  v_proposal public.tb_pending_proposals%ROWTYPE;
BEGIN
  v_actor_member_id := public.fn_require_web_financial_actor(p_household_id);
  v_conversation_key := 'web:' || p_household_id::text || ':' || v_actor_member_id::text;
  IF p_conversation_key IS DISTINCT FROM v_conversation_key THEN
    RAISE EXCEPTION 'Web conversation is unavailable'
      USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
  END IF;

  SELECT proposal.* INTO v_proposal
    FROM public.tb_pending_proposals AS proposal
   WHERE proposal.id = p_proposal_id
     AND proposal.household_id = p_household_id
     AND proposal.conversation_key = v_conversation_key
     AND proposal.actor_member_id = v_actor_member_id
     AND proposal.source = 'WEB'
     AND proposal.payload ->> 'actorMemberId' = v_actor_member_id::text
     AND proposal.payload ->> 'source' = 'WEB'
     AND proposal.operation_type = p_operation_type
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'NOT_FOUND');
  END IF;
  IF v_proposal.status IS DISTINCT FROM 'AWAITING_CONFIRMATION'
     OR p_expected_created_at IS NULL
     OR p_expected_version IS NULL
     OR v_proposal.created_at IS DISTINCT FROM p_expected_created_at
     OR v_proposal.version IS DISTINCT FROM p_expected_version THEN
    RETURN pg_catalog.jsonb_build_object('status', 'VERSION_CONFLICT');
  END IF;

  DELETE FROM public.tb_pending_proposals AS proposal
   WHERE proposal.id = p_proposal_id
     AND proposal.household_id = p_household_id
     AND proposal.conversation_key = v_conversation_key
     AND proposal.actor_member_id = v_actor_member_id
     AND proposal.source = 'WEB'
     AND proposal.operation_type = p_operation_type
     AND proposal.status = 'AWAITING_CONFIRMATION'
     AND proposal.created_at = p_expected_created_at
     AND proposal.version = p_expected_version;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'VERSION_CONFLICT');
  END IF;
  RETURN pg_catalog.jsonb_build_object('status', 'REMOVED');
END;
$$;

CREATE FUNCTION public.fn_lock_web_pending_proposal_for_confirmation(
  p_proposal_id uuid,
  p_household_id uuid
) RETURNS public.tb_pending_proposals
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_auth_user_id uuid := auth.uid();
  v_actor_member_id uuid;
  v_conversation_key text;
  v_proposal public.tb_pending_proposals%ROWTYPE;
BEGIN
  IF v_auth_user_id IS NULL OR auth.role() IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION 'Financial access is unavailable'
      USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
  END IF;
  v_actor_member_id := public.fn_require_web_financial_actor(p_household_id);
  v_conversation_key := 'web:' || p_household_id::text || ':' || v_actor_member_id::text;

  SELECT proposal.* INTO v_proposal
    FROM public.tb_pending_proposals AS proposal
   WHERE proposal.id = p_proposal_id
     AND proposal.household_id = p_household_id
     AND proposal.conversation_key = v_conversation_key
   FOR UPDATE;
  IF NOT FOUND
     OR v_proposal.payload ->> 'actorMemberId' IS DISTINCT FROM v_actor_member_id::text
     OR v_proposal.payload ->> 'source' IS DISTINCT FROM 'WEB'
     OR v_proposal.actor_member_id IS DISTINCT FROM v_actor_member_id
     OR v_proposal.source IS DISTINCT FROM 'WEB' THEN
    RETURN NULL;
  END IF;
  RETURN v_proposal;
END;
$$;

CREATE FUNCTION public.fn_confirm_web_pending_expense(
  p_proposal_id uuid,
  p_household_id uuid,
  p_expected_version bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_proposal public.tb_pending_proposals%ROWTYPE;
BEGIN
  v_proposal := public.fn_lock_web_pending_proposal_for_confirmation(
    p_proposal_id, p_household_id
  );
  IF v_proposal IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'NOT_FOUND', 'expense_id', NULL);
  END IF;
  IF v_proposal.operation_type IS DISTINCT FROM 'CREATE_EXPENSE' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'INVALID_OPERATION', 'expense_id', NULL);
  END IF;
  IF v_proposal.status = 'AWAITING_CONFIRMATION'
     AND (p_expected_version IS NULL
          OR v_proposal.version IS DISTINCT FROM p_expected_version) THEN
    RAISE EXCEPTION 'Pending proposal changed before confirmation'
      USING ERRCODE = '40001';
  END IF;
  RETURN public.fn_internal_confirm_web_pending_expense_v0054(
    p_proposal_id, p_household_id, v_proposal.updated_at
  );
END;
$$;

CREATE FUNCTION public.fn_confirm_web_pending_income(
  p_proposal_id uuid,
  p_household_id uuid,
  p_expected_version bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_proposal public.tb_pending_proposals%ROWTYPE;
BEGIN
  v_proposal := public.fn_lock_web_pending_proposal_for_confirmation(
    p_proposal_id, p_household_id
  );
  IF v_proposal IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'NOT_FOUND', 'income_id', NULL);
  END IF;
  IF v_proposal.operation_type IS DISTINCT FROM 'CREATE_INCOME' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'INVALID_OPERATION', 'income_id', NULL);
  END IF;
  IF v_proposal.status = 'AWAITING_CONFIRMATION'
     AND (p_expected_version IS NULL
          OR v_proposal.version IS DISTINCT FROM p_expected_version) THEN
    RAISE EXCEPTION 'Pending proposal changed before confirmation'
      USING ERRCODE = '40001';
  END IF;
  RETURN public.fn_internal_confirm_web_pending_income_v0054(
    p_proposal_id, p_household_id, v_proposal.updated_at
  );
END;
$$;

ALTER FUNCTION public.fn_create_web_pending_proposal(uuid,text,public.pending_operation_type,jsonb) OWNER TO postgres;
ALTER FUNCTION public.fn_get_web_pending_proposal(uuid,uuid,text,public.pending_operation_type) OWNER TO postgres;
ALTER FUNCTION public.fn_get_web_active_pending_proposal(uuid,text) OWNER TO postgres;
ALTER FUNCTION public.fn_get_web_latest_terminal_pending_proposal(uuid,text) OWNER TO postgres;
ALTER FUNCTION public.fn_update_web_pending_proposal(uuid,uuid,text,public.pending_operation_type,bigint,jsonb) OWNER TO postgres;
ALTER FUNCTION public.fn_compensate_web_pending_proposal(uuid,uuid,text,public.pending_operation_type,timestamptz,bigint) OWNER TO postgres;
ALTER FUNCTION public.fn_lock_web_pending_proposal_for_confirmation(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.fn_confirm_web_pending_expense(uuid,uuid,bigint) OWNER TO postgres;
ALTER FUNCTION public.fn_confirm_web_pending_income(uuid,uuid,bigint) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_create_web_pending_proposal(uuid,text,public.pending_operation_type,jsonb)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.fn_get_web_pending_proposal(uuid,uuid,text,public.pending_operation_type)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.fn_get_web_active_pending_proposal(uuid,text)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.fn_get_web_latest_terminal_pending_proposal(uuid,text)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.fn_update_web_pending_proposal(uuid,uuid,text,public.pending_operation_type,bigint,jsonb)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.fn_compensate_web_pending_proposal(uuid,uuid,text,public.pending_operation_type,timestamptz,bigint)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.fn_lock_web_pending_proposal_for_confirmation(uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_confirm_web_pending_expense(uuid,uuid,bigint)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.fn_confirm_web_pending_income(uuid,uuid,bigint)
  FROM PUBLIC, anon, service_role;

GRANT EXECUTE ON FUNCTION public.fn_create_web_pending_proposal(uuid,text,public.pending_operation_type,jsonb)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_get_web_pending_proposal(uuid,uuid,text,public.pending_operation_type)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_get_web_active_pending_proposal(uuid,text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_get_web_latest_terminal_pending_proposal(uuid,text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_update_web_pending_proposal(uuid,uuid,text,public.pending_operation_type,bigint,jsonb)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_compensate_web_pending_proposal(uuid,uuid,text,public.pending_operation_type,timestamptz,bigint)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_confirm_web_pending_expense(uuid,uuid,bigint)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_confirm_web_pending_income(uuid,uuid,bigint)
  TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
