BEGIN;

-- Additive deployment: legacy grants remain until the documented permission cut.
-- No financial data or existing identity is changed.
CREATE FUNCTION public.fn_require_financial_eligibility(
  p_auth_user_id UUID, p_household_id UUID, p_actor_member_id UUID
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_email TEXT; v_confirmed TIMESTAMPTZ; v_user_id UUID;
BEGIN
  IF p_auth_user_id IS NULL OR p_household_id IS NULL OR p_actor_member_id IS NULL THEN
    RAISE EXCEPTION 'Financial access is unavailable' USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
  END IF;
  SELECT email, email_confirmed_at INTO v_email, v_confirmed
    FROM auth.users WHERE id = p_auth_user_id FOR SHARE;
  IF NOT FOUND OR nullif(btrim(v_email), '') IS NULL OR v_confirmed IS NULL THEN
    RAISE EXCEPTION 'Financial access is unavailable' USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
  END IF;
  -- Household precedes application user/membership, matching lifecycle RPCs.
  -- SHARE also satisfies later FK KEY SHARE without a lock-order inversion.
  PERFORM 1 FROM public.tb_households WHERE id = p_household_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial access is unavailable' USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
  END IF;
  SELECT id INTO v_user_id FROM public.tb_users
    WHERE auth_user_id = p_auth_user_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial access is unavailable' USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
  END IF;
  IF NOT public.fn_lock_whatsapp_active_membership(v_user_id, p_household_id, p_actor_member_id) THEN
    RAISE EXCEPTION 'Financial access is unavailable' USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
  END IF;
  RETURN v_user_id;
END;
$$;

CREATE FUNCTION public.fn_create_expense_eligible(p_auth_user_id UUID, p_actor_member_id UUID, p_household_id UUID,
  p_created_by UUID,
  p_paid_by UUID,
  p_category_id UUID,
  p_receipt_id UUID,
  p_merchant TEXT,
  p_total_amount NUMERIC(14,2),
  p_expense_date DATE,
  p_description TEXT,
  p_source public.expense_source,
  p_items JSONB,
  p_distributions JSONB)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$

BEGIN
  PERFORM public.fn_require_financial_eligibility(p_auth_user_id, p_household_id, p_actor_member_id);
  IF p_created_by IS DISTINCT FROM p_actor_member_id THEN RAISE EXCEPTION 'Financial access is unavailable' USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1'; END IF;
  RETURN public.fn_create_expense(p_household_id, p_created_by, p_paid_by, p_category_id, p_receipt_id, p_merchant, p_total_amount, p_expense_date, p_description, p_source, p_items, p_distributions);
END;
$$;

CREATE FUNCTION public.fn_update_expense_eligible(p_auth_user_id UUID, p_actor_member_id UUID, p_household_id UUID,
  p_expense_id UUID,
  p_set_merchant BOOLEAN,
  p_merchant TEXT,
  p_set_description BOOLEAN,
  p_description TEXT,
  p_total_amount NUMERIC(14,2),
  p_expense_date DATE,
  p_paid_by UUID,
  p_set_category_id BOOLEAN,
  p_category_id UUID,
  p_items JSONB,
  p_distributions JSONB)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$

BEGIN
  PERFORM public.fn_require_financial_eligibility(p_auth_user_id, p_household_id, p_actor_member_id);
  RETURN public.fn_update_expense(p_household_id, p_expense_id, p_set_merchant, p_merchant, p_set_description, p_description, p_total_amount, p_expense_date, p_paid_by, p_set_category_id, p_category_id, p_items, p_distributions);
END;
$$;

CREATE FUNCTION public.fn_delete_expense_eligible(p_auth_user_id UUID, p_actor_member_id UUID, p_household_id UUID,
  p_expense_id UUID)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$

BEGIN
  PERFORM public.fn_require_financial_eligibility(p_auth_user_id, p_household_id, p_actor_member_id);
  RETURN public.fn_delete_expense(p_household_id, p_expense_id);
END;
$$;

CREATE FUNCTION public.fn_confirm_pending_expense_eligible(p_auth_user_id UUID, p_proposal_id UUID, p_household_id UUID, p_conversation_key TEXT,
  p_actor_member_id UUID DEFAULT NULL,
  p_context_source public.expense_source DEFAULT NULL,
  p_expected_updated_at TIMESTAMPTZ DEFAULT NULL,
  p_created_by UUID DEFAULT NULL, p_paid_by UUID DEFAULT NULL,
  p_category_id UUID DEFAULT NULL, p_receipt_id UUID DEFAULT NULL,
  p_merchant TEXT DEFAULT NULL, p_total_amount NUMERIC(14,2) DEFAULT NULL,
  p_expense_date DATE DEFAULT NULL, p_description TEXT DEFAULT NULL,
  p_source public.expense_source DEFAULT NULL, p_items JSONB DEFAULT NULL,
  p_distributions JSONB DEFAULT NULL,
  p_whatsapp_user_id UUID DEFAULT NULL,
  p_whatsapp_lease_id UUID DEFAULT NULL,
  p_whatsapp_lease_epoch BIGINT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE effective_auth_id UUID := p_auth_user_id; effective_user_id UUID;
BEGIN
  IF p_context_source = 'WHATSAPP' THEN
    -- Transitional channel identity is derived only from the controlled lease user.
    SELECT auth_user_id INTO effective_auth_id FROM public.tb_users WHERE id = p_whatsapp_user_id;
    IF p_auth_user_id IS NOT NULL AND p_auth_user_id IS DISTINCT FROM effective_auth_id THEN
      RAISE EXCEPTION 'Financial access is unavailable' USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
    END IF;
  END IF;
  effective_user_id := public.fn_require_financial_eligibility(effective_auth_id, p_household_id, p_actor_member_id);
  IF p_created_by IS NOT NULL AND p_created_by IS DISTINCT FROM p_actor_member_id THEN
    RAISE EXCEPTION 'Financial access is unavailable' USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
  END IF;
  IF p_context_source = 'WHATSAPP' AND effective_user_id IS DISTINCT FROM p_whatsapp_user_id THEN
    RAISE EXCEPTION 'Financial access is unavailable' USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
  END IF;
  RETURN public.fn_confirm_pending_expense_consistent(p_proposal_id, p_household_id, p_conversation_key, p_actor_member_id, p_context_source, p_expected_updated_at, p_created_by, p_paid_by, p_category_id, p_receipt_id, p_merchant, p_total_amount, p_expense_date, p_description, p_source, p_items, p_distributions, p_whatsapp_user_id, p_whatsapp_lease_id, p_whatsapp_lease_epoch);
END;
$$;

CREATE FUNCTION public.fn_confirm_pending_income_eligible(p_auth_user_id UUID, p_proposal_id UUID, p_household_id UUID, p_conversation_key TEXT,
  p_actor_member_id UUID DEFAULT NULL,
  p_context_source public.expense_source DEFAULT NULL,
  p_expected_updated_at TIMESTAMPTZ DEFAULT NULL,
  p_created_by UUID DEFAULT NULL, p_member_id UUID DEFAULT NULL,
  p_amount NUMERIC(14,2) DEFAULT NULL, p_income_date DATE DEFAULT NULL,
  p_description TEXT DEFAULT NULL, p_category_id UUID DEFAULT NULL,
  p_whatsapp_user_id UUID DEFAULT NULL,
  p_whatsapp_lease_id UUID DEFAULT NULL,
  p_whatsapp_lease_epoch BIGINT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE effective_auth_id UUID := p_auth_user_id; effective_user_id UUID;
BEGIN
  IF p_context_source = 'WHATSAPP' THEN
    -- Transitional channel identity is derived only from the controlled lease user.
    SELECT auth_user_id INTO effective_auth_id FROM public.tb_users WHERE id = p_whatsapp_user_id;
    IF p_auth_user_id IS NOT NULL AND p_auth_user_id IS DISTINCT FROM effective_auth_id THEN
      RAISE EXCEPTION 'Financial access is unavailable' USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
    END IF;
  END IF;
  effective_user_id := public.fn_require_financial_eligibility(effective_auth_id, p_household_id, p_actor_member_id);
  IF p_created_by IS NOT NULL AND p_created_by IS DISTINCT FROM p_actor_member_id THEN
    RAISE EXCEPTION 'Financial access is unavailable' USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
  END IF;
  IF p_context_source = 'WHATSAPP' AND effective_user_id IS DISTINCT FROM p_whatsapp_user_id THEN
    RAISE EXCEPTION 'Financial access is unavailable' USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
  END IF;
  RETURN public.fn_confirm_pending_income_consistent(p_proposal_id, p_household_id, p_conversation_key, p_actor_member_id, p_context_source, p_expected_updated_at, p_created_by, p_member_id, p_amount, p_income_date, p_description, p_category_id, p_whatsapp_user_id, p_whatsapp_lease_id, p_whatsapp_lease_epoch);
END;
$$;

CREATE FUNCTION public.fn_create_income_eligible(p_auth_user_id UUID, p_actor_member_id UUID, p_household_id UUID, p_member_id UUID, p_amount NUMERIC, p_income_date DATE, p_description TEXT, p_category_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE result public.tb_incomes;
BEGIN
  PERFORM public.fn_require_financial_eligibility(p_auth_user_id,p_household_id,p_actor_member_id);
  INSERT INTO public.tb_incomes(household_id,created_by,member_id,amount,income_date,description,category_id)
    VALUES(p_household_id,p_actor_member_id,p_member_id,p_amount,p_income_date,p_description,p_category_id) RETURNING * INTO result;
  RETURN to_jsonb(result);
END;
$$;
CREATE FUNCTION public.fn_update_income_eligible(p_auth_user_id UUID, p_actor_member_id UUID, p_household_id UUID, p_income_id UUID, p_changes JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE result public.tb_incomes;
BEGIN
  PERFORM public.fn_require_financial_eligibility(p_auth_user_id,p_household_id,p_actor_member_id);
  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object' OR p_changes = '{}'::jsonb
     OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_changes) k WHERE k NOT IN ('member_id','amount','income_date','description','category_id')) THEN
    RAISE EXCEPTION 'Invalid income changes' USING ERRCODE = '22023';
  END IF;
  UPDATE public.tb_incomes SET
    member_id=CASE WHEN p_changes ? 'member_id' THEN (p_changes->>'member_id')::uuid ELSE member_id END,
    amount=CASE WHEN p_changes ? 'amount' THEN (p_changes->>'amount')::numeric ELSE amount END,
    income_date=CASE WHEN p_changes ? 'income_date' THEN (p_changes->>'income_date')::date ELSE income_date END,
    description=CASE WHEN p_changes ? 'description' THEN p_changes->>'description' ELSE description END,
    category_id=CASE WHEN p_changes ? 'category_id' THEN (p_changes->>'category_id')::uuid ELSE category_id END
    WHERE id=p_income_id AND household_id=p_household_id RETURNING * INTO result;
  RETURN to_jsonb(result);
END;
$$;
CREATE FUNCTION public.fn_delete_income_eligible(p_auth_user_id UUID, p_actor_member_id UUID, p_household_id UUID, p_income_id UUID)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE result UUID;
BEGIN
  PERFORM public.fn_require_financial_eligibility(p_auth_user_id,p_household_id,p_actor_member_id);
  DELETE FROM public.tb_incomes WHERE id=p_income_id AND household_id=p_household_id RETURNING id INTO result;
  RETURN result;
END;
$$;

-- Set ownership and revoke default/explicit application access on every new entry.
DO $permissions$
DECLARE f record; role_name text;
BEGIN
  FOR f IN SELECT p.oid, p.proname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('fn_require_financial_eligibility','fn_create_expense_eligible','fn_update_expense_eligible','fn_delete_expense_eligible','fn_create_income_eligible','fn_update_income_eligible','fn_delete_income_eligible','fn_confirm_pending_expense_eligible','fn_confirm_pending_income_eligible') LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', f.oid::regprocedure);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, service_role', f.oid::regprocedure);
    FOR role_name IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname IN ('anon','authenticated') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f.oid::regprocedure, role_name);
    END LOOP;
    IF f.proname <> 'fn_require_financial_eligibility' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.oid::regprocedure);
    END IF;
  END LOOP;
END;
$permissions$;
COMMIT;
