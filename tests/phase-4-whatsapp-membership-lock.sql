BEGIN;

CREATE ROLE housemate_whatsapp_membership_test NOLOGIN;

INSERT INTO public.tb_users (id, display_name, external_identifier)
VALUES
  ('61000000-0000-4000-8000-000000000001', 'WhatsApp Lock User', 'wa-lock-user'),
  ('61000000-0000-4000-8000-000000000002', 'WhatsApp Lock Other User', 'wa-lock-other-user');

INSERT INTO public.tb_households (id, name)
VALUES
  ('61000000-0000-4000-8000-000000000011', 'WhatsApp Lock Household One'),
  ('61000000-0000-4000-8000-000000000012', 'WhatsApp Lock Household Two');

INSERT INTO public.tb_household_members (
  id, household_id, user_id, display_name, role, status
)
VALUES
  ('61000000-0000-4000-8000-000000000021', '61000000-0000-4000-8000-000000000011', '61000000-0000-4000-8000-000000000001', 'Lock User One', 'MEMBER', 'ACTIVE'),
  ('61000000-0000-4000-8000-000000000022', '61000000-0000-4000-8000-000000000012', '61000000-0000-4000-8000-000000000001', 'Lock User Two', 'MEMBER', 'ACTIVE'),
  ('61000000-0000-4000-8000-000000000023', '61000000-0000-4000-8000-000000000011', '61000000-0000-4000-8000-000000000002', 'Lock Other User', 'MEMBER', 'ACTIVE');

INSERT INTO public.tb_pending_proposals (
  id, household_id, conversation_key, operation_type, payload, status,
  actor_member_id, source
)
VALUES
  ('61000000-0000-4000-8000-000000000031', '61000000-0000-4000-8000-000000000012', 'whatsapp:lock-expense', 'CREATE_EXPENSE', '{"actorMemberId":"61000000-0000-4000-8000-000000000022","source":"WHATSAPP"}'::JSONB, 'AWAITING_CONFIRMATION', '61000000-0000-4000-8000-000000000022', 'WHATSAPP'),
  ('61000000-0000-4000-8000-000000000032', '61000000-0000-4000-8000-000000000012', 'whatsapp:lock-income', 'CREATE_INCOME', '{"actorMemberId":"61000000-0000-4000-8000-000000000022","source":"WHATSAPP"}'::JSONB, 'AWAITING_CONFIRMATION', '61000000-0000-4000-8000-000000000022', 'WHATSAPP');

DO $$
DECLARE
  v_helper_oid REGPROCEDURE := 'public.fn_lock_whatsapp_active_membership(uuid,uuid,uuid)'::REGPROCEDURE;
  v_acl_has_public_execute BOOLEAN;
BEGIN
  IF has_table_privilege('service_role', 'public.tb_household_members', 'UPDATE') THEN
    RAISE EXCEPTION 'FAIL service_role unexpectedly has UPDATE on household memberships';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.tb_household_members', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL service_role lacks its existing membership SELECT privilege';
  END IF;
  IF NOT has_function_privilege('service_role', v_helper_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL service_role cannot execute the membership lock helper';
  END IF;
  IF has_function_privilege(
    'housemate_whatsapp_membership_test', v_helper_oid, 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'FAIL an unprivileged role inherited helper execution';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS proc
     WHERE proc.oid = v_helper_oid
       AND proc.prosecdef
       AND proc.proowner = 'postgres'::REGROLE
       AND proc.prorettype = 'boolean'::REGTYPE
       AND proc.proconfig @> ARRAY['search_path=pg_catalog']
  ) THEN
    RAISE EXCEPTION 'FAIL membership helper security attributes are not minimal';
  END IF;
  IF NOT has_function_privilege(
    'service_role',
    'public.fn_transition_whatsapp_household_context(uuid,text,uuid,bigint,text,uuid,uuid,uuid[],integer)'::REGPROCEDURE,
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'public.fn_assert_whatsapp_active_context(uuid,uuid,bigint,uuid,uuid)'::REGPROCEDURE,
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'public.fn_confirm_pending_expense_consistent(uuid,uuid,text,uuid,public.expense_source,timestamptz,uuid,uuid,uuid,uuid,text,numeric,date,text,public.expense_source,jsonb,jsonb,uuid,uuid,bigint)'::REGPROCEDURE,
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'public.fn_confirm_pending_income_consistent(uuid,uuid,text,uuid,public.expense_source,timestamptz,uuid,uuid,numeric,date,text,uuid,uuid,uuid,bigint)'::REGPROCEDURE,
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'FAIL existing WhatsApp RPC grants changed';
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS proc
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(proc.proacl, pg_catalog.acldefault('f', proc.proowner))
      ) AS privilege
     WHERE proc.oid = v_helper_oid
       AND privilege.grantee = 0
       AND privilege.privilege_type = 'EXECUTE'
  ) INTO v_acl_has_public_execute;
  IF v_acl_has_public_execute THEN
    RAISE EXCEPTION 'FAIL the membership lock helper is executable by PUBLIC';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
     WHERE rolname = 'service_role' AND rolbypassrls AND NOT rolcanlogin
  ) THEN
    RAISE EXCEPTION 'FAIL SQL harness service_role does not model Supabase BYPASSRLS';
  END IF;
END;
$$;

SET LOCAL ROLE service_role;

DO $$
DECLARE
  v_user_id CONSTANT UUID := '61000000-0000-4000-8000-000000000001';
  v_other_user_id CONSTANT UUID := '61000000-0000-4000-8000-000000000002';
  v_household_one CONSTANT UUID := '61000000-0000-4000-8000-000000000011';
  v_household_two CONSTANT UUID := '61000000-0000-4000-8000-000000000012';
  v_member_one CONSTANT UUID := '61000000-0000-4000-8000-000000000021';
  v_member_two CONSTANT UUID := '61000000-0000-4000-8000-000000000022';
  v_foreign_member CONSTANT UUID := '61000000-0000-4000-8000-000000000023';
  v_lease_id CONSTANT UUID := '61000000-0000-4000-8000-000000000041';
  v_epoch BIGINT;
  v_result JSONB;
  v_member_status TEXT;
  v_member_display_name TEXT;
  v_selection_before UUID;
  v_menu_before UUID[];
  v_expense_count BIGINT;
  v_income_count BIGINT;
  v_rejected BOOLEAN;
  v_draft public.tb_agent_category_drafts%ROWTYPE;
BEGIN
  IF NOT public.fn_lock_whatsapp_active_membership(v_user_id, v_household_one, v_member_one) THEN
    RAISE EXCEPTION 'FAIL an active membership for the requested user was not locked';
  END IF;
  IF public.fn_lock_whatsapp_active_membership(v_user_id, v_household_one, v_foreign_member) THEN
    RAISE EXCEPTION 'FAIL the lock helper accepted another user''s membership';
  END IF;
  IF public.fn_lock_whatsapp_active_membership(NULL, v_household_one, v_member_one) THEN
    RAISE EXCEPTION 'FAIL the lock helper accepted a NULL identity';
  END IF;

  v_result := public.fn_acquire_whatsapp_context_lease(v_user_id, v_lease_id, 120);
  IF v_result ->> 'acquired' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'FAIL service_role could not acquire the WhatsApp lease';
  END IF;
  v_epoch := (v_result ->> 'epoch')::BIGINT;

  v_result := public.fn_transition_whatsapp_household_context(
    p_user_id => v_user_id,
    p_phone_number_id => 'membership-lock-test',
    p_lease_id => v_lease_id,
    p_lease_epoch => v_epoch,
    p_action => 'SET_SELECTION',
    p_household_id => v_household_one,
    p_member_id => v_member_one
  );
  IF v_result ->> 'status' IS DISTINCT FROM 'SELECTED' THEN
    RAISE EXCEPTION 'FAIL service_role could not select an active household without membership UPDATE';
  END IF;

  IF NOT public.fn_assert_whatsapp_active_context(
    v_user_id, v_lease_id, v_epoch, v_household_one, v_member_one
  ) THEN
    RAISE EXCEPTION 'FAIL service_role could not validate the selected active membership';
  END IF;

  v_result := public.fn_transition_whatsapp_household_context(
    p_user_id => v_user_id,
    p_phone_number_id => 'membership-lock-test',
    p_lease_id => v_lease_id,
    p_lease_epoch => v_epoch,
    p_action => 'OPEN_MENU',
    p_household_ids => ARRAY[v_household_one, v_household_two]
  );
  IF v_result ->> 'status' IS DISTINCT FROM 'MENU_OPENED' THEN
    RAISE EXCEPTION 'FAIL active household menu could not be opened under service_role';
  END IF;

  v_result := public.fn_transition_whatsapp_household_context(
    p_user_id => v_user_id,
    p_phone_number_id => 'membership-lock-test',
    p_lease_id => v_lease_id,
    p_lease_epoch => v_epoch,
    p_action => 'CHOOSE_OPTION',
    p_option_number => 2
  );
  IF v_result ->> 'status' IS DISTINCT FROM 'SELECTED'
     OR (v_result ->> 'household_id')::UUID IS DISTINCT FROM v_household_two
     OR (v_result ->> 'member_id')::UUID IS DISTINCT FROM v_member_two THEN
    RAISE EXCEPTION 'FAIL service_role could not select a valid active menu membership';
  END IF;

  v_result := public.fn_transition_whatsapp_household_context(
    p_user_id => v_user_id,
    p_phone_number_id => 'membership-lock-test',
    p_lease_id => v_lease_id,
    p_lease_epoch => v_epoch,
    p_action => 'SET_SELECTION',
    p_household_id => v_household_one,
    p_member_id => v_foreign_member
  );
  IF v_result ->> 'status' IS DISTINCT FROM 'MEMBERSHIP_UNAVAILABLE' THEN
    RAISE EXCEPTION 'FAIL another user''s membership was selectable';
  END IF;
  SELECT selected_household_id, menu_household_ids
    INTO v_selection_before, v_menu_before
    FROM public.tb_whatsapp_user_contexts
   WHERE user_id = v_user_id;
  IF v_selection_before IS DISTINCT FROM v_household_two OR v_menu_before IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL rejected foreign membership changed the saved household selection';
  END IF;

  v_rejected := FALSE;
  BEGIN
    UPDATE public.tb_household_members
       SET display_name = 'Must Not Change'
     WHERE id = v_member_two;
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := TRUE;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL service_role directly updated a household membership';
  END IF;
  SELECT status::TEXT, display_name INTO v_member_status, v_member_display_name
    FROM public.tb_household_members
   WHERE id = v_member_two;
  IF v_member_status IS DISTINCT FROM 'ACTIVE'
     OR v_member_display_name IS DISTINCT FROM 'Lock User Two' THEN
    RAISE EXCEPTION 'FAIL denied direct update changed the membership';
  END IF;

  v_draft := public.fn_create_whatsapp_agent_draft(
    '61000000-0000-4000-8000-000000000051', v_household_two, v_member_two,
    'whatsapp:membership-lock-valid-draft', 'CREATE_EXPENSE', '{}'::JSONB,
    'AWAITING_DETAILS', v_user_id, v_lease_id, v_epoch
  );
  IF v_draft.id IS DISTINCT FROM '61000000-0000-4000-8000-000000000051'::UUID THEN
    RAISE EXCEPTION 'FAIL valid service_role draft write did not pass the active-context helper';
  END IF;

  v_rejected := FALSE;
  BEGIN
    PERFORM public.fn_confirm_pending_expense_consistent(
      p_proposal_id => '61000000-0000-4000-8000-000000000031',
      p_household_id => v_household_two,
      p_conversation_key => 'whatsapp:lock-expense',
      p_actor_member_id => v_member_two,
      p_context_source => 'WHATSAPP'::public.expense_source,
      p_expected_updated_at => '2000-01-01 00:00:00+00'::TIMESTAMPTZ,
      p_whatsapp_user_id => v_user_id,
      p_whatsapp_lease_id => v_lease_id,
      p_whatsapp_lease_epoch => v_epoch
    );
  EXCEPTION WHEN SQLSTATE '40001' THEN
    IF SQLERRM <> 'Pending proposal changed before confirmation' THEN
      RAISE;
    END IF;
    v_rejected := TRUE;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL active expense confirmation did not reach its expected proposal-version guard';
  END IF;

  v_rejected := FALSE;
  BEGIN
    PERFORM public.fn_confirm_pending_income_consistent(
      p_proposal_id => '61000000-0000-4000-8000-000000000032',
      p_household_id => v_household_two,
      p_conversation_key => 'whatsapp:lock-income',
      p_actor_member_id => v_member_two,
      p_context_source => 'WHATSAPP'::public.expense_source,
      p_expected_updated_at => '2000-01-01 00:00:00+00'::TIMESTAMPTZ,
      p_whatsapp_user_id => v_user_id,
      p_whatsapp_lease_id => v_lease_id,
      p_whatsapp_lease_epoch => v_epoch
    );
  EXCEPTION WHEN SQLSTATE '40001' THEN
    IF SQLERRM <> 'Pending proposal changed before confirmation' THEN
      RAISE;
    END IF;
    v_rejected := TRUE;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL active income confirmation did not reach its expected proposal-version guard';
  END IF;

END;
$$;

RESET ROLE;
UPDATE public.tb_household_members
   SET status = 'LEFT'
 WHERE id = '61000000-0000-4000-8000-000000000022';
SET LOCAL ROLE service_role;

DO $$
DECLARE
  v_user_id CONSTANT UUID := '61000000-0000-4000-8000-000000000001';
  v_household_two CONSTANT UUID := '61000000-0000-4000-8000-000000000012';
  v_member_two CONSTANT UUID := '61000000-0000-4000-8000-000000000022';
  v_lease_id CONSTANT UUID := '61000000-0000-4000-8000-000000000041';
  v_epoch BIGINT;
  v_result JSONB;
  v_rejected BOOLEAN;
  v_expense_count BIGINT;
  v_income_count BIGINT;
  v_draft_count BIGINT;
BEGIN
  SELECT processing_epoch INTO v_epoch
    FROM public.tb_whatsapp_user_contexts
   WHERE user_id = v_user_id AND processing_lease_id = v_lease_id;
  IF v_epoch IS NULL THEN
    RAISE EXCEPTION 'FAIL the active WhatsApp lease was not retained for inactive-membership checks';
  END IF;

  v_result := public.fn_transition_whatsapp_household_context(
    p_user_id => v_user_id,
    p_phone_number_id => 'membership-lock-test',
    p_lease_id => v_lease_id,
    p_lease_epoch => v_epoch,
    p_action => 'SET_SELECTION',
    p_household_id => v_household_two,
    p_member_id => v_member_two
  );
  IF v_result ->> 'status' IS DISTINCT FROM 'MEMBERSHIP_UNAVAILABLE' THEN
    RAISE EXCEPTION 'FAIL an inactive membership could be selected';
  END IF;

  v_rejected := FALSE;
  BEGIN
    PERFORM public.fn_assert_whatsapp_active_context(
      v_user_id, v_lease_id, v_epoch, v_household_two, v_member_two
    );
  EXCEPTION WHEN SQLSTATE '42501' THEN
    IF SQLERRM <> 'Active household membership is unavailable' THEN
      RAISE;
    END IF;
    v_rejected := TRUE;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL inactive membership passed active-context validation';
  END IF;

  v_rejected := FALSE;
  BEGIN
    PERFORM public.fn_create_whatsapp_agent_draft(
      '61000000-0000-4000-8000-000000000052', v_household_two, v_member_two,
      'whatsapp:membership-lock-inactive-draft', 'CREATE_EXPENSE', '{}'::JSONB,
      'AWAITING_DETAILS', v_user_id, v_lease_id, v_epoch
    );
  EXCEPTION WHEN SQLSTATE '42501' THEN
    IF SQLERRM <> 'Active household membership is unavailable' THEN
      RAISE;
    END IF;
    v_rejected := TRUE;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL inactive membership passed the draft write guard';
  END IF;

  v_result := public.fn_confirm_pending_expense_consistent(
    p_proposal_id => '61000000-0000-4000-8000-000000000031',
    p_household_id => v_household_two,
    p_conversation_key => 'whatsapp:lock-expense',
    p_actor_member_id => v_member_two,
    p_context_source => 'WHATSAPP'::public.expense_source,
    p_whatsapp_user_id => v_user_id,
    p_whatsapp_lease_id => v_lease_id,
    p_whatsapp_lease_epoch => v_epoch
  );
  IF v_result ->> 'status' IS DISTINCT FROM 'NOT_FOUND' THEN
    RAISE EXCEPTION 'FAIL revoked membership passed expense confirmation';
  END IF;
  v_result := public.fn_confirm_pending_income_consistent(
    p_proposal_id => '61000000-0000-4000-8000-000000000032',
    p_household_id => v_household_two,
    p_conversation_key => 'whatsapp:lock-income',
    p_actor_member_id => v_member_two,
    p_context_source => 'WHATSAPP'::public.expense_source,
    p_whatsapp_user_id => v_user_id,
    p_whatsapp_lease_id => v_lease_id,
    p_whatsapp_lease_epoch => v_epoch
  );
  IF v_result ->> 'status' IS DISTINCT FROM 'NOT_FOUND' THEN
    RAISE EXCEPTION 'FAIL revoked membership passed income confirmation';
  END IF;
  SELECT count(*) INTO v_expense_count FROM public.tb_expenses;
  SELECT count(*) INTO v_income_count FROM public.tb_incomes;
  SELECT count(*) INTO v_draft_count FROM public.tb_agent_category_drafts
   WHERE id = '61000000-0000-4000-8000-000000000052';
  IF v_expense_count <> 0 OR v_income_count <> 0 OR v_draft_count <> 0 THEN
    RAISE EXCEPTION 'FAIL rejected membership operation created financial data or a draft';
  END IF;
END;
$$;

RESET ROLE;
UPDATE public.tb_household_members
   SET status = 'ACTIVE'
 WHERE id = '61000000-0000-4000-8000-000000000022';
SET LOCAL ROLE service_role;

DO $$
DECLARE
  v_user_id CONSTANT UUID := '61000000-0000-4000-8000-000000000001';
  v_household_two CONSTANT UUID := '61000000-0000-4000-8000-000000000012';
  v_member_two CONSTANT UUID := '61000000-0000-4000-8000-000000000022';
  v_lease_id CONSTANT UUID := '61000000-0000-4000-8000-000000000041';
  v_epoch BIGINT;
  v_result JSONB;
  v_rejected BOOLEAN;
BEGIN
  SELECT processing_epoch INTO v_epoch
    FROM public.tb_whatsapp_user_contexts
   WHERE user_id = v_user_id AND processing_lease_id = v_lease_id;
  IF v_epoch IS NULL THEN
    RAISE EXCEPTION 'FAIL active lease was unavailable for fencing checks';
  END IF;

  v_rejected := FALSE;
  BEGIN
    PERFORM public.fn_transition_whatsapp_household_context(
      p_user_id => v_user_id,
      p_phone_number_id => 'membership-lock-test',
      p_lease_id => v_lease_id,
      p_lease_epoch => NULL::BIGINT,
      p_action => 'CLEAR_SELECTION'
    );
  EXCEPTION WHEN SQLSTATE '40001' THEN
    IF SQLERRM <> 'WhatsApp context lease is no longer current' THEN
      RAISE;
    END IF;
    v_rejected := TRUE;
  END;
  IF NOT v_rejected OR NOT EXISTS (
    SELECT 1 FROM public.tb_whatsapp_user_contexts
     WHERE user_id = v_user_id
       AND selected_household_id = v_household_two
       AND selected_member_id = v_member_two
  ) THEN
    RAISE EXCEPTION 'FAIL NULL epoch changed selection or passed under service_role';
  END IF;

  IF NOT public.fn_release_whatsapp_context_lease(v_user_id, v_lease_id, v_epoch) THEN
    RAISE EXCEPTION 'FAIL valid service_role lease could not be released';
  END IF;
  v_rejected := FALSE;
  BEGIN
    PERFORM public.fn_transition_whatsapp_household_context(
      p_user_id => v_user_id,
      p_phone_number_id => 'membership-lock-test',
      p_lease_id => NULL::UUID,
      p_lease_epoch => v_epoch,
      p_action => 'CLEAR_SELECTION'
    );
  EXCEPTION WHEN SQLSTATE '40001' THEN
    IF SQLERRM <> 'WhatsApp context lease is no longer current' THEN
      RAISE;
    END IF;
    v_rejected := TRUE;
  END;
  IF NOT v_rejected OR NOT EXISTS (
    SELECT 1 FROM public.tb_whatsapp_user_contexts
     WHERE user_id = v_user_id
       AND selected_household_id = v_household_two
       AND selected_member_id = v_member_two
       AND processing_lease_id IS NULL
       AND processing_expires_at IS NULL
  ) THEN
    RAISE EXCEPTION 'FAIL NULL lease changed selection or passed after normal release';
  END IF;
END;
$$;

SET LOCAL ROLE housemate_whatsapp_membership_test;

DO $$
DECLARE
  v_rejected BOOLEAN := FALSE;
BEGIN
  BEGIN
    PERFORM public.fn_lock_whatsapp_active_membership(
      '61000000-0000-4000-8000-000000000001',
      '61000000-0000-4000-8000-000000000011',
      '61000000-0000-4000-8000-000000000021'
    );
  EXCEPTION WHEN insufficient_privilege THEN
    v_rejected := TRUE;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'FAIL an unauthorized role executed the membership lock helper';
  END IF;
END;
$$;

RESET ROLE;
DROP ROLE housemate_whatsapp_membership_test;
ROLLBACK;

SELECT 'PASS WhatsApp membership row locking uses minimal SECURITY DEFINER access under service_role' AS result;
