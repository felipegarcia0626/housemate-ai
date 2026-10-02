BEGIN;

CREATE OR REPLACE FUNCTION public.fn_provision_authenticated_user(
  p_auth_user_id UUID,
  p_display_name TEXT,
  p_household_name TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id UUID;
  v_household_id UUID;
  v_member_id UUID;
  v_display_name TEXT := btrim(p_display_name);
  v_household_name TEXT := btrim(p_household_name);
BEGIN
  IF p_auth_user_id IS NULL
     OR v_display_name = ''
     OR v_household_name = ''
     OR length(v_display_name) > 120
     OR length(v_household_name) > 120 THEN
    RAISE EXCEPTION 'Invalid provisioning input' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.tb_users (display_name, external_identifier, auth_user_id)
  VALUES (v_display_name, 'supabase:' || p_auth_user_id::TEXT, p_auth_user_id)
  ON CONFLICT (auth_user_id) DO NOTHING;

  SELECT id INTO v_user_id
    FROM public.tb_users
   WHERE auth_user_id = p_auth_user_id
   FOR UPDATE;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Unable to provision application user';
  END IF;

  SELECT id INTO v_member_id
    FROM public.tb_household_members
   WHERE user_id = v_user_id
   ORDER BY created_at, id
   LIMIT 1;

  IF v_member_id IS NOT NULL THEN
    SELECT household_id INTO v_household_id
      FROM public.tb_household_members
     WHERE id = v_member_id;
    RETURN jsonb_build_object(
      'status', 'ALREADY_PROVISIONED',
      'userId', v_user_id,
      'householdId', v_household_id,
      'memberId', v_member_id
    );
  END IF;

  INSERT INTO public.tb_households (name)
  VALUES (v_household_name)
  RETURNING id INTO v_household_id;

  INSERT INTO public.tb_household_members (household_id, user_id, display_name)
  VALUES (v_household_id, v_user_id, v_display_name)
  RETURNING id INTO v_member_id;

  RETURN jsonb_build_object(
    'status', 'PROVISIONING_COMPLETED',
    'userId', v_user_id,
    'householdId', v_household_id,
    'memberId', v_member_id
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_provision_authenticated_user(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_provision_authenticated_user(UUID, TEXT, TEXT) TO service_role;

COMMIT;
