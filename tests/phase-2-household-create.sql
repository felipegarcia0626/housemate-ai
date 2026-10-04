BEGIN;

DO $$
DECLARE
  v_auth UUID := '72000000-0000-4000-8000-000000000001';
  v_key UUID := '72000000-0000-4000-8000-000000000011';
  v_first JSONB;
  v_second JSONB;
  v_household UUID;
BEGIN
  INSERT INTO public.tb_users (id, display_name, external_identifier, auth_user_id)
  VALUES ('72000000-0000-4000-8000-000000000002', 'Household creator', 'test:household-create', v_auth);

  v_first := public.fn_create_household_for_authenticated_user(v_auth, 'Casa nueva', v_key);
  v_second := public.fn_create_household_for_authenticated_user(v_auth, 'Otro nombre ignorado', v_key);
  IF v_first->>'householdId' <> v_second->>'householdId'
     OR v_first->>'memberId' <> v_second->>'memberId'
     OR (v_second->>'idempotent')::BOOLEAN IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL idempotent household creation did not preserve the result';
  END IF;
  v_household := (v_first->>'householdId')::UUID;
  IF (SELECT count(*) FROM public.tb_households WHERE id = v_household) <> 1
     OR (SELECT count(*) FROM public.tb_household_members WHERE household_id = v_household) <> 1 THEN
    RAISE EXCEPTION 'FAIL household creation did not create exactly one membership';
  END IF;

  PERFORM public.fn_create_household_for_authenticated_user(v_auth, 'Otra casa', '72000000-0000-4000-8000-000000000012');
  IF (SELECT count(*) FROM public.tb_households WHERE id IN (
    (v_first->>'householdId')::UUID,
    (public.fn_create_household_for_authenticated_user(v_auth, 'Otra casa repetida', '72000000-0000-4000-8000-000000000012')->>'householdId')::UUID
  )) <> 2 THEN
    RAISE EXCEPTION 'FAIL distinct idempotency keys were not independent';
  END IF;
  RAISE NOTICE 'PASS household creation, membership, idempotency, and independent keys';
END $$;

DO $$
BEGIN
  BEGIN
    PERFORM public.fn_create_household_for_authenticated_user(
      '72000000-0000-4000-8000-000000000099', 'No user', '72000000-0000-4000-8000-000000000099');
    RAISE EXCEPTION 'FAIL missing application user was accepted';
  EXCEPTION WHEN SQLSTATE 'P0002' THEN
    RAISE NOTICE 'PASS missing application user is rejected';
  END;
END $$;

ROLLBACK;
