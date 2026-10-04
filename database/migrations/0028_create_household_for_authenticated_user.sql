BEGIN;

CREATE TABLE public.tb_household_creation_idempotency (
  auth_user_id UUID NOT NULL,
  idempotency_key UUID NOT NULL,
  household_id UUID,
  member_id UUID,
  household_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_tb_household_creation_idempotency PRIMARY KEY (auth_user_id, idempotency_key),
  CONSTRAINT fk_tb_household_creation_idempotency_user
    FOREIGN KEY (auth_user_id) REFERENCES public.tb_users (auth_user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_tb_household_creation_idempotency_household
    FOREIGN KEY (household_id) REFERENCES public.tb_households (id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT fk_tb_household_creation_idempotency_member
    FOREIGN KEY (household_id, member_id)
    REFERENCES public.tb_household_members (household_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);

ALTER TABLE public.tb_household_creation_idempotency ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.fn_create_household_for_authenticated_user(
  p_auth_user_id UUID,
  p_household_name TEXT,
  p_idempotency_key UUID
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
  v_name TEXT := btrim(p_household_name);
  v_existing RECORD;
BEGIN
  IF p_auth_user_id IS NULL OR p_idempotency_key IS NULL
     OR v_name = '' OR length(v_name) > 120 THEN
    RAISE EXCEPTION 'Invalid household input' USING ERRCODE = '22023';
  END IF;

  SELECT id INTO v_user_id
    FROM public.tb_users
   WHERE auth_user_id = p_auth_user_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Application user not found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.tb_household_creation_idempotency
    (auth_user_id, idempotency_key, household_id, member_id, household_name)
  VALUES (p_auth_user_id, p_idempotency_key, gen_random_uuid(), gen_random_uuid(), v_name)
  ON CONFLICT (auth_user_id, idempotency_key) DO NOTHING;

  SELECT * INTO v_existing
    FROM public.tb_household_creation_idempotency
   WHERE auth_user_id = p_auth_user_id AND idempotency_key = p_idempotency_key
   FOR UPDATE;

  IF v_existing.household_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.tb_households WHERE id = v_existing.household_id
  ) THEN
    RETURN jsonb_build_object(
      'householdId', v_existing.household_id,
      'householdName', v_existing.household_name,
      'memberId', v_existing.member_id,
      'idempotent', true
    );
  END IF;

  INSERT INTO public.tb_households (name) VALUES (v_name) RETURNING id INTO v_household_id;
  INSERT INTO public.tb_household_members (household_id, user_id, display_name)
  SELECT v_household_id, id, display_name FROM public.tb_users WHERE id = v_user_id
  RETURNING id INTO v_member_id;

  UPDATE public.tb_household_creation_idempotency
     SET household_id = v_household_id, member_id = v_member_id, household_name = v_name
   WHERE auth_user_id = p_auth_user_id AND idempotency_key = p_idempotency_key;

  RETURN jsonb_build_object(
    'householdId', v_household_id, 'householdName', v_name,
    'memberId', v_member_id, 'idempotent', false
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_create_household_for_authenticated_user(UUID, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_create_household_for_authenticated_user(UUID, TEXT, UUID) TO service_role;

COMMIT;
