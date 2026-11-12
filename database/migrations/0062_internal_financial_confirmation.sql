BEGIN;

CREATE OR REPLACE FUNCTION public.fn_confirm_pending_expense_eligible(p_auth_user_id UUID, p_proposal_id UUID, p_household_id UUID, p_conversation_key TEXT,
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
    PERFORM pg_advisory_xact_lock(18443,43);
  END IF;
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
  -- A supplied persistence source must match the authorized proposal context.
  IF p_source IS NOT NULL AND p_source IS DISTINCT FROM p_context_source THEN
    RAISE EXCEPTION 'Expense source does not match confirmation context' USING ERRCODE = '22023';
  END IF;
  RETURN public.fn_confirm_pending_expense_consistent(p_proposal_id, p_household_id, p_conversation_key, p_actor_member_id, p_context_source, p_expected_updated_at, p_created_by, p_paid_by, p_category_id, p_receipt_id, p_merchant, p_total_amount, p_expense_date, p_description, p_source, p_items, p_distributions, p_whatsapp_user_id, p_whatsapp_lease_id, p_whatsapp_lease_epoch);
END;
$$;

DO $confirmation_acl$
DECLARE
  target regprocedure;
  app_role text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'public.fn_confirm_pending_expense_eligible(uuid,uuid,uuid,text,uuid,public.expense_source,timestamptz,uuid,uuid,uuid,uuid,text,numeric,date,text,public.expense_source,jsonb,jsonb,uuid,uuid,bigint)'::regprocedure,
    'public.fn_confirm_pending_income_eligible(uuid,uuid,uuid,text,uuid,public.expense_source,timestamptz,uuid,uuid,numeric,date,text,uuid,uuid,uuid,bigint)'::regprocedure
  ] LOOP
    EXECUTE pg_catalog.format(
      'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', target
    );
    FOREACH app_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF pg_catalog.has_function_privilege(app_role, target, 'EXECUTE') THEN
        RAISE EXCEPTION '% retains direct confirmation EXECUTE on %', app_role, target;
      END IF;
    END LOOP;
    IF NOT pg_catalog.has_function_privilege('postgres', target, 'EXECUTE') THEN
      RAISE EXCEPTION 'postgres cannot execute confirmation delegate %', target;
    END IF;
  END LOOP;
END;
$confirmation_acl$;

COMMIT;
