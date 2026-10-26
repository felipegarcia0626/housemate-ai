BEGIN;

DO $$
DECLARE
  v_user_id CONSTANT UUID := '60000000-0000-4000-8000-000000000001';
  v_other_user_id CONSTANT UUID := '60000000-0000-4000-8000-000000000002';
  v_household_one CONSTANT UUID := '60000000-0000-4000-8000-000000000011';
  v_household_two CONSTANT UUID := '60000000-0000-4000-8000-000000000012';
  v_member_one CONSTANT UUID := '60000000-0000-4000-8000-000000000021';
  v_member_two CONSTANT UUID := '60000000-0000-4000-8000-000000000022';
  v_foreign_member CONSTANT UUID := '60000000-0000-4000-8000-000000000023';
  v_expense_proposal CONSTANT UUID := '60000000-0000-4000-8000-000000000031';
  v_income_proposal CONSTANT UUID := '60000000-0000-4000-8000-000000000032';
  v_lease_id CONSTANT UUID := '60000000-0000-4000-8000-000000000041';
  v_second_lease_id CONSTANT UUID := '60000000-0000-4000-8000-000000000042';
  v_other_lease_id CONSTANT UUID := '60000000-0000-4000-8000-000000000043';
  v_epoch BIGINT;
  v_other_epoch BIGINT;
  v_result JSONB;
  v_draft public.tb_agent_category_drafts%ROWTYPE;
  v_menu_expires_at TIMESTAMPTZ;
  v_expense_count BIGINT;
  v_income_count BIGINT;
  v_rls_enabled BOOLEAN;
  v_cancelled BOOLEAN := FALSE;
  v_guard_rejected BOOLEAN := FALSE;
  v_role TEXT;
BEGIN
  SELECT c.relrowsecurity
    INTO v_rls_enabled
    FROM pg_class AS c
   WHERE c.oid = 'public.tb_whatsapp_user_contexts'::regclass;
  IF v_rls_enabled IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'FAIL WhatsApp user context must have RLS enabled';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'tb_whatsapp_user_contexts'
  ) THEN
    RAISE EXCEPTION 'FAIL WhatsApp user context must not expose client policies';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.tb_whatsapp_user_contexts', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.tb_whatsapp_user_contexts', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.tb_whatsapp_user_contexts', 'UPDATE')
     OR has_table_privilege('service_role', 'public.tb_whatsapp_user_contexts', 'DELETE') THEN
    RAISE EXCEPTION 'FAIL WhatsApp context table grants are not minimal';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role)
       AND (has_table_privilege(v_role, 'public.tb_whatsapp_user_contexts', 'SELECT')
         OR has_table_privilege(v_role, 'public.tb_whatsapp_user_contexts', 'INSERT')
         OR has_table_privilege(v_role, 'public.tb_whatsapp_user_contexts', 'UPDATE')
         OR has_table_privilege(v_role, 'public.tb_whatsapp_user_contexts', 'DELETE')) THEN
      RAISE EXCEPTION 'FAIL WhatsApp context table is directly available to an application client role';
    END IF;
  END LOOP;

  INSERT INTO public.tb_users (id, display_name, external_identifier)
  VALUES
    (v_user_id, 'WhatsApp Context Test User', 'wa-context-test-user'),
    (v_other_user_id, 'WhatsApp Context Other User', 'wa-context-other-user');
  INSERT INTO public.tb_households (id, name)
  VALUES
    (v_household_one, 'WhatsApp Context Household One'),
    (v_household_two, 'WhatsApp Context Household Two');
  INSERT INTO public.tb_household_members (
    id, household_id, user_id, display_name, role, status
  ) VALUES
    (v_member_one, v_household_one, v_user_id, 'Test User', 'MEMBER', 'ACTIVE'),
    (v_member_two, v_household_two, v_user_id, 'Test User', 'MEMBER', 'ACTIVE'),
    (v_foreign_member, v_household_one, v_other_user_id, 'Other User', 'MEMBER', 'ACTIVE');

  v_result := public.fn_acquire_whatsapp_context_lease(v_user_id, v_lease_id, 120);
  IF v_result ->> 'acquired' IS DISTINCT FROM 'true'
     OR (v_result ->> 'epoch')::BIGINT IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'FAIL first WhatsApp context lease was not acquired';
  END IF;
  v_epoch := (v_result ->> 'epoch')::BIGINT;
  v_result := public.fn_acquire_whatsapp_context_lease(v_user_id, v_second_lease_id, 120);
  IF v_result ->> 'acquired' IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'FAIL concurrent WhatsApp context lease was not rejected';
  END IF;

  v_result := public.fn_transition_whatsapp_household_context(
    p_user_id => v_user_id,
    p_phone_number_id => 'test-phone-one',
    p_lease_id => v_lease_id,
    p_lease_epoch => v_epoch,
    p_action => 'OPEN_MENU',
    p_household_ids => ARRAY[v_household_one, v_household_two]
  );
  IF v_result ->> 'status' IS DISTINCT FROM 'MENU_OPENED' THEN
    RAISE EXCEPTION 'FAIL current active households were not offered';
  END IF;

  v_result := public.fn_transition_whatsapp_household_context(
    p_user_id => v_user_id,
    p_phone_number_id => 'test-phone-two',
    p_lease_id => v_lease_id,
    p_lease_epoch => v_epoch,
    p_action => 'CHOOSE_OPTION',
    p_option_number => 2
  );
  IF v_result ->> 'status' IS DISTINCT FROM 'NO_CURRENT_MENU' THEN
    RAISE EXCEPTION 'FAIL a menu was accepted from another WhatsApp phone context';
  END IF;

  v_result := public.fn_transition_whatsapp_household_context(
    p_user_id => v_user_id,
    p_phone_number_id => 'test-phone-one',
    p_lease_id => v_lease_id,
    p_lease_epoch => v_epoch,
    p_action => 'SET_SELECTION',
    p_household_id => v_household_one,
    p_member_id => v_foreign_member
  );
  IF v_result ->> 'status' IS DISTINCT FROM 'MEMBERSHIP_UNAVAILABLE' THEN
    RAISE EXCEPTION 'FAIL a foreign user''s membership was selectable';
  END IF;

  v_result := public.fn_transition_whatsapp_household_context(
    p_user_id => v_user_id,
    p_phone_number_id => 'test-phone-one',
    p_lease_id => v_lease_id,
    p_lease_epoch => v_epoch,
    p_action => 'CHOOSE_OPTION',
    p_option_number => 2
  );
  IF v_result ->> 'status' IS DISTINCT FROM 'SELECTED'
     OR (v_result ->> 'household_id')::UUID <> v_household_two
     OR (v_result ->> 'member_id')::UUID <> v_member_two THEN
    RAISE EXCEPTION 'FAIL valid menu option was not persisted for the active member';
  END IF;

  v_result := public.fn_acquire_whatsapp_context_lease(v_other_user_id, v_other_lease_id, 120);
  IF v_result ->> 'acquired' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'FAIL a different user could not acquire an independent context lease';
  END IF;
  v_other_epoch := (v_result ->> 'epoch')::BIGINT;
  v_result := public.fn_transition_whatsapp_household_context(
    p_user_id => v_other_user_id,
    p_phone_number_id => 'test-phone-one',
    p_lease_id => v_other_lease_id,
    p_lease_epoch => v_other_epoch,
    p_action => 'SET_SELECTION',
    p_household_id => v_household_one,
    p_member_id => v_foreign_member
  );
  IF v_result ->> 'status' IS DISTINCT FROM 'SELECTED'
     OR NOT EXISTS (
       SELECT 1 FROM public.tb_whatsapp_user_contexts
        WHERE user_id = v_user_id AND selected_household_id = v_household_two
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.tb_whatsapp_user_contexts
        WHERE user_id = v_other_user_id AND selected_household_id = v_household_one
     ) THEN
    RAISE EXCEPTION 'FAIL WhatsApp household selections were not isolated by user';
  END IF;

  v_result := public.fn_transition_whatsapp_household_context(
    p_user_id => v_user_id,
    p_phone_number_id => 'test-phone-one',
    p_lease_id => v_lease_id,
    p_lease_epoch => v_epoch,
    p_action => 'OPEN_MENU',
    p_household_ids => ARRAY[v_household_one, v_household_two]
  );
  v_result := public.fn_transition_whatsapp_household_context(
    p_user_id => v_user_id,
    p_phone_number_id => 'test-phone-one',
    p_lease_id => v_lease_id,
    p_lease_epoch => v_epoch,
    p_action => 'CANCEL_MENU'
  );
  IF v_result ->> 'status' IS DISTINCT FROM 'MENU_CANCELLED'
     OR NOT EXISTS (
       SELECT 1 FROM public.tb_whatsapp_user_contexts
        WHERE user_id = v_user_id
          AND selected_household_id = v_household_two
          AND selected_member_id = v_member_two
          AND menu_household_ids IS NULL
     ) THEN
    RAISE EXCEPTION 'FAIL cancelling the menu changed the selected household';
  END IF;

  v_result := public.fn_transition_whatsapp_household_context(
    p_user_id => v_user_id,
    p_phone_number_id => 'test-phone-one',
    p_lease_id => v_lease_id,
    p_lease_epoch => v_epoch,
    p_action => 'OPEN_MENU',
    p_household_ids => ARRAY[v_household_one, v_household_two]
  );
  IF v_result ->> 'status' IS DISTINCT FROM 'MENU_OPENED' THEN
    RAISE EXCEPTION 'FAIL valid lease could not open a household menu for lease regression';
  END IF;
  SELECT menu_expires_at INTO v_menu_expires_at
    FROM public.tb_whatsapp_user_contexts WHERE user_id = v_user_id;

  IF NOT public.fn_release_whatsapp_context_lease(v_user_id, v_lease_id, v_epoch) THEN
    RAISE EXCEPTION 'FAIL valid WhatsApp context lease could not be released';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.tb_whatsapp_user_contexts
     WHERE user_id = v_user_id
       AND processing_lease_id IS NULL
       AND processing_expires_at IS NULL
  ) THEN
    RAISE EXCEPTION 'FAIL normal lease release did not persist the valid empty lease state';
  END IF;

  v_guard_rejected := FALSE;
  BEGIN
    PERFORM public.fn_transition_whatsapp_household_context(
      p_user_id => v_user_id,
      p_phone_number_id => 'test-phone-one',
      p_lease_id => NULL::UUID,
      p_lease_epoch => v_epoch,
      p_action => 'SET_SELECTION',
      p_household_id => v_household_one,
      p_member_id => v_member_one
    );
  EXCEPTION WHEN SQLSTATE '40001' THEN
    v_guard_rejected := TRUE;
  END;
  IF NOT v_guard_rejected THEN
    RAISE EXCEPTION 'FAIL transition accepted a NULL lease id after normal release';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.tb_whatsapp_user_contexts
     WHERE user_id = v_user_id
       AND selected_household_id = v_household_two
       AND selected_member_id = v_member_two
       AND menu_household_ids = ARRAY[v_household_one, v_household_two]
       AND menu_phone_number_id = 'test-phone-one'
       AND menu_expires_at = v_menu_expires_at
       AND processing_lease_id IS NULL
       AND processing_expires_at IS NULL
  ) THEN
    RAISE EXCEPTION 'FAIL rejected NULL-lease transition changed selection or menu state';
  END IF;

  v_guard_rejected := FALSE;
  BEGIN
    PERFORM public.fn_create_whatsapp_agent_draft(
      '60000000-0000-4000-8000-000000000044',
      v_household_two,
      v_member_two,
      'whatsapp:test:null-lease',
      'CREATE_EXPENSE',
      '{}'::JSONB,
      'AWAITING_DETAILS',
      v_user_id,
      NULL::UUID,
      v_epoch
    );
  EXCEPTION WHEN SQLSTATE '40001' THEN
    v_guard_rejected := TRUE;
  END;
  IF NOT v_guard_rejected
     OR EXISTS (
       SELECT 1 FROM public.tb_agent_category_drafts
        WHERE id = '60000000-0000-4000-8000-000000000044'
     ) THEN
    RAISE EXCEPTION 'FAIL NULL lease created or modified an Agent draft after release';
  END IF;

  v_guard_rejected := FALSE;
  BEGIN
    PERFORM public.fn_create_whatsapp_agent_draft(
      '60000000-0000-4000-8000-000000000048',
      v_household_two,
      v_member_two,
      'whatsapp:test:released-lease-id',
      'CREATE_EXPENSE',
      '{}'::JSONB,
      'AWAITING_DETAILS',
      v_user_id,
      v_lease_id,
      v_epoch
    );
  EXCEPTION WHEN SQLSTATE '40001' THEN
    v_guard_rejected := TRUE;
  END;
  IF NOT v_guard_rejected
     OR EXISTS (
       SELECT 1 FROM public.tb_agent_category_drafts
        WHERE id = '60000000-0000-4000-8000-000000000048'
     ) THEN
    RAISE EXCEPTION 'FAIL released persisted lease created or modified an Agent draft';
  END IF;

  v_result := public.fn_acquire_whatsapp_context_lease(v_user_id, v_lease_id, 120);
  IF v_result ->> 'acquired' IS DISTINCT FROM 'true'
     OR (v_result ->> 'epoch')::BIGINT IS DISTINCT FROM v_epoch + 1 THEN
    RAISE EXCEPTION 'FAIL released WhatsApp context lease could not be reacquired';
  END IF;
  v_epoch := (v_result ->> 'epoch')::BIGINT;

  v_guard_rejected := FALSE;
  BEGIN
    PERFORM public.fn_transition_whatsapp_household_context(
      p_user_id => v_user_id,
      p_phone_number_id => 'test-phone-one',
      p_lease_id => v_lease_id,
      p_lease_epoch => NULL::BIGINT,
      p_action => 'SET_SELECTION',
      p_household_id => v_household_one,
      p_member_id => v_member_one
    );
  EXCEPTION WHEN SQLSTATE '40001' THEN
    v_guard_rejected := TRUE;
  END;
  IF NOT v_guard_rejected
     OR NOT EXISTS (
       SELECT 1 FROM public.tb_whatsapp_user_contexts
        WHERE user_id = v_user_id
          AND selected_household_id = v_household_two
          AND selected_member_id = v_member_two
          AND menu_household_ids = ARRAY[v_household_one, v_household_two]
          AND menu_phone_number_id = 'test-phone-one'
          AND menu_expires_at = v_menu_expires_at
     ) THEN
    RAISE EXCEPTION 'FAIL NULL-epoch transition was accepted or changed context state';
  END IF;

  v_guard_rejected := FALSE;
  BEGIN
    PERFORM public.fn_create_whatsapp_agent_draft(
      '60000000-0000-4000-8000-000000000045',
      v_household_two,
      v_member_two,
      'whatsapp:test:null-epoch',
      'CREATE_EXPENSE',
      '{}'::JSONB,
      'AWAITING_DETAILS',
      v_user_id,
      v_lease_id,
      NULL::BIGINT
    );
  EXCEPTION WHEN SQLSTATE '40001' THEN
    v_guard_rejected := TRUE;
  END;
  IF NOT v_guard_rejected
     OR EXISTS (
       SELECT 1 FROM public.tb_agent_category_drafts
        WHERE id = '60000000-0000-4000-8000-000000000045'
     ) THEN
    RAISE EXCEPTION 'FAIL NULL epoch created or modified an Agent draft';
  END IF;

  v_guard_rejected := FALSE;
  BEGIN
    PERFORM public.fn_transition_whatsapp_household_context(
      p_user_id => v_user_id,
      p_phone_number_id => 'test-phone-one',
      p_lease_id => v_lease_id,
      p_lease_epoch => v_epoch - 1,
      p_action => 'SET_SELECTION',
      p_household_id => v_household_one,
      p_member_id => v_member_one
    );
  EXCEPTION WHEN SQLSTATE '40001' THEN
    v_guard_rejected := TRUE;
  END;
  IF NOT v_guard_rejected
     OR NOT EXISTS (
       SELECT 1 FROM public.tb_whatsapp_user_contexts
        WHERE user_id = v_user_id
          AND selected_household_id = v_household_two
          AND selected_member_id = v_member_two
          AND menu_household_ids = ARRAY[v_household_one, v_household_two]
          AND menu_phone_number_id = 'test-phone-one'
          AND menu_expires_at = v_menu_expires_at
     ) THEN
    RAISE EXCEPTION 'FAIL stale-epoch transition was accepted or changed context state';
  END IF;

  v_draft := public.fn_create_whatsapp_agent_draft(
    '60000000-0000-4000-8000-000000000046',
    v_household_two,
    v_member_two,
    'whatsapp:test:valid-lease',
    'CREATE_EXPENSE',
    '{}'::JSONB,
    'AWAITING_DETAILS',
    v_user_id,
    v_lease_id,
    v_epoch
  );
  IF v_draft.id IS DISTINCT FROM '60000000-0000-4000-8000-000000000046'::UUID THEN
    RAISE EXCEPTION 'FAIL valid lease did not permit an authorized Agent draft write';
  END IF;

  v_guard_rejected := FALSE;
  BEGIN
    UPDATE public.tb_whatsapp_user_contexts
       SET processing_expires_at = NULL
     WHERE user_id = v_user_id;
  EXCEPTION WHEN check_violation THEN
    v_guard_rejected := TRUE;
  END;
  IF NOT v_guard_rejected
     OR NOT EXISTS (
       SELECT 1 FROM public.tb_whatsapp_user_contexts
        WHERE user_id = v_user_id
          AND processing_lease_id = v_lease_id
          AND processing_epoch = v_epoch
          AND processing_expires_at > clock_timestamp()
     ) THEN
    RAISE EXCEPTION 'FAIL context constraint allowed a persisted lease without expiry';
  END IF;

  UPDATE public.tb_whatsapp_user_contexts
     SET processing_expires_at = clock_timestamp() - interval '1 second'
   WHERE user_id = v_user_id;
  v_guard_rejected := FALSE;
  BEGIN
    PERFORM public.fn_transition_whatsapp_household_context(
      p_user_id => v_user_id,
      p_phone_number_id => 'test-phone-one',
      p_lease_id => v_lease_id,
      p_lease_epoch => v_epoch,
      p_action => 'SET_SELECTION',
      p_household_id => v_household_one,
      p_member_id => v_member_one
    );
  EXCEPTION WHEN SQLSTATE '40001' THEN
    v_guard_rejected := TRUE;
  END;
  IF NOT v_guard_rejected
     OR NOT EXISTS (
       SELECT 1 FROM public.tb_whatsapp_user_contexts
        WHERE user_id = v_user_id
          AND selected_household_id = v_household_two
          AND selected_member_id = v_member_two
          AND menu_household_ids = ARRAY[v_household_one, v_household_two]
          AND menu_phone_number_id = 'test-phone-one'
          AND menu_expires_at = v_menu_expires_at
     ) THEN
    RAISE EXCEPTION 'FAIL expired-lease transition was accepted or changed context state';
  END IF;

  v_guard_rejected := FALSE;
  BEGIN
    PERFORM public.fn_create_whatsapp_agent_draft(
      '60000000-0000-4000-8000-000000000047',
      v_household_two,
      v_member_two,
      'whatsapp:test:expired-lease',
      'CREATE_EXPENSE',
      '{}'::JSONB,
      'AWAITING_DETAILS',
      v_user_id,
      v_lease_id,
      v_epoch
    );
  EXCEPTION WHEN SQLSTATE '40001' THEN
    v_guard_rejected := TRUE;
  END;
  UPDATE public.tb_whatsapp_user_contexts
     SET processing_expires_at = clock_timestamp() + interval '120 seconds'
   WHERE user_id = v_user_id;
  IF NOT v_guard_rejected
     OR EXISTS (
       SELECT 1 FROM public.tb_agent_category_drafts
        WHERE id = '60000000-0000-4000-8000-000000000047'
     ) THEN
    RAISE EXCEPTION 'FAIL expired lease created or modified an Agent draft';
  END IF;

  PERFORM public.fn_transition_whatsapp_household_context(
    p_user_id => v_user_id,
    p_phone_number_id => 'test-phone-one',
    p_lease_id => v_lease_id,
    p_lease_epoch => v_epoch,
    p_action => 'OPEN_MENU',
    p_household_ids => ARRAY[v_household_one, v_household_two]
  );
  UPDATE public.tb_whatsapp_user_contexts
     SET menu_expires_at = clock_timestamp() - interval '1 second'
   WHERE user_id = v_user_id;
  v_result := public.fn_transition_whatsapp_household_context(
    p_user_id => v_user_id,
    p_phone_number_id => 'test-phone-one',
    p_lease_id => v_lease_id,
    p_lease_epoch => v_epoch,
    p_action => 'CHOOSE_OPTION',
    p_option_number => 1
  );
  IF v_result ->> 'status' IS DISTINCT FROM 'MENU_EXPIRED'
     OR NOT EXISTS (
       SELECT 1 FROM public.tb_whatsapp_user_contexts
        WHERE user_id = v_user_id
          AND selected_household_id = v_household_two
          AND menu_household_ids IS NULL
     ) THEN
    RAISE EXCEPTION 'FAIL expired menu changed the selected household';
  END IF;

  PERFORM public.fn_transition_whatsapp_household_context(
    p_user_id => v_user_id,
    p_phone_number_id => 'test-phone-one',
    p_lease_id => v_lease_id,
    p_lease_epoch => v_epoch,
    p_action => 'OPEN_MENU',
    p_household_ids => ARRAY[v_household_one, v_household_two]
  );
  UPDATE public.tb_household_members SET status = 'REMOVED' WHERE id = v_member_one;
  v_result := public.fn_transition_whatsapp_household_context(
    p_user_id => v_user_id,
    p_phone_number_id => 'test-phone-one',
    p_lease_id => v_lease_id,
    p_lease_epoch => v_epoch,
    p_action => 'CHOOSE_OPTION',
    p_option_number => 1
  );
  IF v_result ->> 'status' IS DISTINCT FROM 'MEMBERSHIP_UNAVAILABLE'
     OR NOT EXISTS (
       SELECT 1 FROM public.tb_whatsapp_user_contexts
        WHERE user_id = v_user_id
          AND selected_household_id = v_household_two
          AND menu_household_ids IS NULL
     ) THEN
    RAISE EXCEPTION 'FAIL revoked membership was selected or changed the existing selection';
  END IF;

  INSERT INTO public.tb_pending_proposals (
    id, household_id, conversation_key, operation_type, payload,
    actor_member_id, source
  ) VALUES
    (v_expense_proposal, v_household_one, 'whatsapp:test:context', 'CREATE_EXPENSE',
     jsonb_build_object('actorMemberId', v_member_one, 'source', 'WHATSAPP', 'expense', '{}'::JSONB),
     v_member_one, 'WHATSAPP'),
    (v_income_proposal, v_household_two, 'whatsapp:test:context', 'CREATE_INCOME',
     jsonb_build_object('actorMemberId', v_member_two, 'source', 'WHATSAPP', 'income', '{}'::JSONB),
     v_member_two, 'WHATSAPP');
  UPDATE public.tb_household_members SET status = 'LEFT' WHERE id = v_member_two;

  SELECT count(*) INTO v_expense_count FROM public.tb_expenses;
  SELECT count(*) INTO v_income_count FROM public.tb_incomes;
  v_result := public.fn_confirm_pending_expense_consistent(
    p_proposal_id => v_expense_proposal,
    p_household_id => v_household_one,
    p_conversation_key => 'whatsapp:test:context',
    p_actor_member_id => v_member_one,
    p_context_source => 'WHATSAPP'::public.expense_source,
    p_whatsapp_user_id => v_user_id,
    p_whatsapp_lease_id => v_lease_id,
    p_whatsapp_lease_epoch => v_epoch
  );
  IF v_result ->> 'status' IS DISTINCT FROM 'NOT_FOUND' THEN
    RAISE EXCEPTION 'FAIL revoked expense membership was confirmed';
  END IF;
  v_result := public.fn_confirm_pending_income_consistent(
    p_proposal_id => v_income_proposal,
    p_household_id => v_household_two,
    p_conversation_key => 'whatsapp:test:context',
    p_actor_member_id => v_member_two,
    p_context_source => 'WHATSAPP'::public.expense_source,
    p_whatsapp_user_id => v_user_id,
    p_whatsapp_lease_id => v_lease_id,
    p_whatsapp_lease_epoch => v_epoch
  );
  IF v_result ->> 'status' IS DISTINCT FROM 'NOT_FOUND' THEN
    RAISE EXCEPTION 'FAIL revoked income membership was confirmed';
  END IF;
  IF (SELECT count(*) FROM public.tb_expenses) <> v_expense_count
     OR (SELECT count(*) FROM public.tb_incomes) <> v_income_count THEN
    RAISE EXCEPTION 'FAIL confirmation after membership revocation wrote a financial movement';
  END IF;

  BEGIN
    PERFORM public.fn_assert_whatsapp_active_context(
      v_user_id, v_lease_id, v_epoch, v_household_two, v_member_two
    );
  EXCEPTION WHEN insufficient_privilege THEN
    v_cancelled := TRUE;
  END;
  IF NOT v_cancelled THEN
    RAISE EXCEPTION 'FAIL inactive membership passed the active-context guard';
  END IF;
END;
$$;

SELECT 'PASS persistent WhatsApp selection, NULL/expired lease guards, membership and RLS checks' AS result;

ROLLBACK;
