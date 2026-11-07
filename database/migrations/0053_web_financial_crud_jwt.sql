BEGIN;

-- Derive the current application's active household actor from the verified
-- PostgREST JWT. The existing 0048 helper performs the ordered locks and the
-- current Auth/email/membership checks after this non-locking lookup.
CREATE FUNCTION public.fn_require_web_financial_actor(
  p_household_id uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_auth_user_id uuid := auth.uid();
  v_actor_member_id uuid;
BEGIN
  IF v_auth_user_id IS NULL
     OR auth.role() IS DISTINCT FROM 'authenticated'
     OR p_household_id IS NULL THEN
    RAISE EXCEPTION 'Financial access is unavailable'
      USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
  END IF;

  SELECT member.id
    INTO v_actor_member_id
    FROM public.tb_users AS app_user
    JOIN public.tb_household_members AS member
      ON member.user_id = app_user.id
   WHERE app_user.auth_user_id = v_auth_user_id
     AND member.household_id = p_household_id
     AND member.status = 'ACTIVE';

  IF v_actor_member_id IS NULL THEN
    RAISE EXCEPTION 'Financial access is unavailable'
      USING ERRCODE = '42501', DETAIL = 'HOUSEMATE_FINANCIAL_ELIGIBILITY_V1';
  END IF;

  PERFORM public.fn_require_web_financial_context(
    p_household_id, v_actor_member_id
  );
  RETURN v_actor_member_id;
END;
$$;

-- Match the category availability rule used by the Web services, but enforce
-- it again at the SQL boundary because authenticated users can call PostgREST
-- RPCs without going through those services. Lock both rows through the write.
CREATE FUNCTION public.fn_assert_web_financial_categories(
  p_movement_type text,
  p_category_ids uuid[]
) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  v_category_id uuid;
BEGIN
  IF p_movement_type NOT IN ('EXPENSE', 'INCOME') THEN
    RAISE EXCEPTION 'Invalid financial category movement type'
      USING ERRCODE = '22023';
  END IF;

  FOR v_category_id IN
    SELECT DISTINCT requested.category_id
      FROM pg_catalog.unnest(coalesce(p_category_ids, ARRAY[]::uuid[]))
        AS requested(category_id)
     WHERE requested.category_id IS NOT NULL
  LOOP
    PERFORM 1
      FROM public.tb_categories AS category
      JOIN public.tb_categories AS parent_category
        ON parent_category.id = category.parent_id
     WHERE category.id = v_category_id
       AND category.movement_type = p_movement_type
       AND category.level = 'MICRO'
       AND category.is_active
       AND parent_category.movement_type = p_movement_type
       AND parent_category.level = 'MACRO'
       AND parent_category.is_active
     FOR SHARE OF category, parent_category;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Financial category is unavailable'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;
END;
$$;

-- Keep the Web Expense text invariants at the database boundary as well as in
-- TypeScript. A NULL merchant remains optional, and NULL p_items means the
-- caller is not replacing the existing items during an update.
CREATE FUNCTION public.fn_assert_web_expense_texts(
  p_merchant text,
  p_validate_merchant boolean,
  p_items jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  item jsonb;
  v_trim_chars text :=
      pg_catalog.chr(9) || pg_catalog.chr(10) || pg_catalog.chr(11)
    || pg_catalog.chr(12) || pg_catalog.chr(13) || pg_catalog.chr(32)
    || pg_catalog.chr(160);
BEGIN
  -- PostgreSQL cannot represent every ECMAScript whitespace code point in
  -- legacy database encodings. Supabase uses UTF8; retain the supported set
  -- there, while still matching ASCII and NBSP in other encodings.
  IF pg_catalog.getdatabaseencoding() = 'UTF8' THEN
    v_trim_chars := v_trim_chars
      || pg_catalog.chr(5760)
      || pg_catalog.chr(8192) || pg_catalog.chr(8193) || pg_catalog.chr(8194)
      || pg_catalog.chr(8195) || pg_catalog.chr(8196) || pg_catalog.chr(8197)
      || pg_catalog.chr(8198) || pg_catalog.chr(8199) || pg_catalog.chr(8200)
      || pg_catalog.chr(8201) || pg_catalog.chr(8202) || pg_catalog.chr(8232)
      || pg_catalog.chr(8233) || pg_catalog.chr(8239) || pg_catalog.chr(8287)
      || pg_catalog.chr(12288) || pg_catalog.chr(65279);
  END IF;

  IF coalesce(p_validate_merchant, false)
     AND p_merchant IS NOT NULL
     AND pg_catalog.translate(p_merchant, v_trim_chars, '') = '' THEN
    RAISE EXCEPTION 'Expense merchant cannot be blank'
      USING ERRCODE = '22023';
  END IF;

  IF p_items IS NOT NULL AND jsonb_typeof(p_items) = 'array' THEN
    FOR item IN
      SELECT value FROM pg_catalog.jsonb_array_elements(p_items)
    LOOP
      IF jsonb_typeof(item -> 'name') = 'string'
         AND pg_catalog.translate(item ->> 'name', v_trim_chars, '') = '' THEN
        RAISE EXCEPTION 'Expense item name cannot be blank'
          USING ERRCODE = '22023';
      END IF;
    END LOOP;
  END IF;
END;
$$;

-- Function arguments declared numeric(p,s) do not retain that typmod in
-- PostgreSQL. Validate unbounded numeric values before any eligible RPC casts
-- JSON fields to numeric(p,s) or assigns them to scaled columns.
CREATE FUNCTION public.fn_assert_web_numeric_scale(
  p_value numeric,
  p_scale integer,
  p_field text
) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  IF p_scale IS NULL OR p_scale NOT IN (2, 3) THEN
    RAISE EXCEPTION 'Unsupported numeric scale'
      USING ERRCODE = '22023';
  END IF;

  IF p_value IS NOT NULL
     AND p_value IN (
       'NaN'::numeric,
       'Infinity'::numeric,
       '-Infinity'::numeric
     ) THEN
    RAISE EXCEPTION '% must be finite', p_field
      USING ERRCODE = '22023';
  END IF;

  IF p_value IS NOT NULL
     AND p_value <> pg_catalog.trunc(p_value, p_scale) THEN
    RAISE EXCEPTION '% supports at most % decimal places', p_field, p_scale
      USING ERRCODE = '22023';
  END IF;
END;
$$;

CREATE FUNCTION public.fn_assert_web_expense_numeric_scales(
  p_total_amount numeric,
  p_items jsonb,
  p_distributions jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  entry record;
BEGIN
  PERFORM public.fn_assert_web_numeric_scale(
    p_total_amount, 2, 'Expense total amount'
  );

  IF p_items IS NOT NULL AND pg_catalog.jsonb_typeof(p_items) = 'array' THEN
    FOR entry IN
      SELECT value, ordinality
        FROM pg_catalog.jsonb_array_elements(p_items) WITH ORDINALITY
          AS elements(value, ordinality)
    LOOP
      IF pg_catalog.jsonb_typeof(entry.value -> 'totalAmount') = 'number' THEN
        PERFORM public.fn_assert_web_numeric_scale(
          (entry.value ->> 'totalAmount')::numeric,
          2,
          pg_catalog.format('items[%s].totalAmount', entry.ordinality)
        );
      END IF;
      IF pg_catalog.jsonb_typeof(entry.value -> 'unitPrice') = 'number' THEN
        PERFORM public.fn_assert_web_numeric_scale(
          (entry.value ->> 'unitPrice')::numeric,
          2,
          pg_catalog.format('items[%s].unitPrice', entry.ordinality)
        );
      END IF;
      IF pg_catalog.jsonb_typeof(entry.value -> 'quantity') = 'number' THEN
        PERFORM public.fn_assert_web_numeric_scale(
          (entry.value ->> 'quantity')::numeric,
          3,
          pg_catalog.format('items[%s].quantity', entry.ordinality)
        );
      END IF;
    END LOOP;
  END IF;

  IF p_distributions IS NOT NULL
     AND pg_catalog.jsonb_typeof(p_distributions) = 'array' THEN
    FOR entry IN
      SELECT value, ordinality
        FROM pg_catalog.jsonb_array_elements(p_distributions) WITH ORDINALITY
          AS elements(value, ordinality)
    LOOP
      IF pg_catalog.jsonb_typeof(entry.value -> 'amount') = 'number' THEN
        PERFORM public.fn_assert_web_numeric_scale(
          (entry.value ->> 'amount')::numeric,
          2,
          pg_catalog.format('distributions[%s].amount', entry.ordinality)
        );
      END IF;
      IF pg_catalog.jsonb_typeof(entry.value -> 'percentage') = 'number' THEN
        PERFORM public.fn_assert_web_numeric_scale(
          (entry.value ->> 'percentage')::numeric,
          2,
          pg_catalog.format('distributions[%s].percentage', entry.ordinality)
        );
      END IF;
    END LOOP;
  END IF;
END;
$$;

-- These six Web entry points accept business context only. Identity and
-- source are derived/fixed in PostgreSQL; category availability is checked
-- here, while the established 0042 routines retain atomic persistence and
-- the remaining financial constraints.
CREATE FUNCTION public.fn_create_web_expense(
  p_household_id uuid,
  p_paid_by uuid,
  p_category_id uuid,
  p_receipt_id uuid,
  p_merchant text,
  p_total_amount numeric(14,2),
  p_expense_date date,
  p_description text,
  p_items jsonb,
  p_distributions jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_actor_member_id uuid := public.fn_require_web_financial_actor(p_household_id);
BEGIN
  PERFORM public.fn_assert_web_expense_numeric_scales(
    p_total_amount, p_items, p_distributions
  );
  PERFORM public.fn_assert_web_expense_texts(
    p_merchant, p_merchant IS NOT NULL, p_items
  );
  PERFORM public.fn_assert_web_financial_categories(
    'EXPENSE',
    ARRAY[p_category_id] || CASE
      WHEN jsonb_typeof(p_items) = 'array' THEN ARRAY(
        SELECT (item ->> 'categoryId')::uuid
          FROM pg_catalog.jsonb_array_elements(p_items) AS item
         WHERE jsonb_typeof(item -> 'categoryId') = 'string'
      )
      ELSE ARRAY[]::uuid[]
    END
  );
  RETURN public.fn_create_expense_eligible(
    auth.uid(), v_actor_member_id, p_household_id, v_actor_member_id,
    p_paid_by, p_category_id, p_receipt_id, p_merchant, p_total_amount,
    p_expense_date, p_description, 'WEB'::public.expense_source,
    p_items, p_distributions
  );
END;
$$;

CREATE FUNCTION public.fn_update_web_expense(
  p_household_id uuid,
  p_expense_id uuid,
  p_set_merchant boolean,
  p_merchant text,
  p_set_description boolean,
  p_description text,
  p_total_amount numeric(14,2),
  p_expense_date date,
  p_paid_by uuid,
  p_set_category_id boolean,
  p_category_id uuid,
  p_items jsonb,
  p_distributions jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_actor_member_id uuid := public.fn_require_web_financial_actor(p_household_id);
BEGIN
  PERFORM public.fn_assert_web_expense_numeric_scales(
    p_total_amount, p_items, p_distributions
  );
  PERFORM public.fn_assert_web_expense_texts(
    p_merchant, p_set_merchant, p_items
  );
  PERFORM public.fn_assert_web_financial_categories(
    'EXPENSE',
    ARRAY[CASE WHEN p_set_category_id THEN p_category_id ELSE NULL::uuid END]
      || CASE
        WHEN jsonb_typeof(p_items) = 'array' THEN ARRAY(
          SELECT (item ->> 'categoryId')::uuid
            FROM pg_catalog.jsonb_array_elements(p_items) AS item
           WHERE jsonb_typeof(item -> 'categoryId') = 'string'
        )
        ELSE ARRAY[]::uuid[]
      END
  );
  RETURN public.fn_update_expense_eligible(
    auth.uid(), v_actor_member_id, p_household_id, p_expense_id,
    p_set_merchant, p_merchant, p_set_description, p_description,
    p_total_amount, p_expense_date, p_paid_by, p_set_category_id,
    p_category_id, p_items, p_distributions
  );
END;
$$;

CREATE FUNCTION public.fn_delete_web_expense(
  p_household_id uuid,
  p_expense_id uuid
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_actor_member_id uuid := public.fn_require_web_financial_actor(p_household_id);
BEGIN
  RETURN public.fn_delete_expense_eligible(
    auth.uid(), v_actor_member_id, p_household_id, p_expense_id
  );
END;
$$;

CREATE FUNCTION public.fn_create_web_income(
  p_household_id uuid,
  p_member_id uuid,
  p_amount numeric(14,2),
  p_income_date date,
  p_description text,
  p_category_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_actor_member_id uuid := public.fn_require_web_financial_actor(p_household_id);
BEGIN
  PERFORM public.fn_assert_web_numeric_scale(
    p_amount, 2, 'Income amount'
  );
  PERFORM public.fn_assert_web_financial_categories('INCOME', ARRAY[p_category_id]);
  RETURN public.fn_create_income_eligible(
    auth.uid(), v_actor_member_id, p_household_id, p_member_id,
    p_amount, p_income_date, p_description, p_category_id
  );
END;
$$;

CREATE FUNCTION public.fn_update_web_income(
  p_household_id uuid,
  p_income_id uuid,
  p_changes jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_actor_member_id uuid := public.fn_require_web_financial_actor(p_household_id);
BEGIN
  IF p_changes ? 'amount'
     AND p_changes -> 'amount' IS DISTINCT FROM 'null'::jsonb THEN
    PERFORM public.fn_assert_web_numeric_scale(
      (p_changes ->> 'amount')::numeric, 2, 'Income amount'
    );
  END IF;
  PERFORM public.fn_assert_web_financial_categories(
    'INCOME',
    CASE
      WHEN p_changes ? 'category_id'
       AND p_changes ->> 'category_id' IS NOT NULL
        THEN ARRAY[(p_changes ->> 'category_id')::uuid]
      ELSE ARRAY[]::uuid[]
    END
  );
  RETURN public.fn_update_income_eligible(
    auth.uid(), v_actor_member_id, p_household_id, p_income_id, p_changes
  );
END;
$$;

CREATE FUNCTION public.fn_delete_web_income(
  p_household_id uuid,
  p_income_id uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_actor_member_id uuid := public.fn_require_web_financial_actor(p_household_id);
BEGIN
  RETURN public.fn_delete_income_eligible(
    auth.uid(), v_actor_member_id, p_household_id, p_income_id
  );
END;
$$;

ALTER FUNCTION public.fn_require_web_financial_actor(uuid) OWNER TO postgres;
ALTER FUNCTION public.fn_assert_web_financial_categories(text,uuid[]) OWNER TO postgres;
ALTER FUNCTION public.fn_assert_web_expense_texts(text,boolean,jsonb) OWNER TO postgres;
ALTER FUNCTION public.fn_assert_web_numeric_scale(numeric,integer,text) OWNER TO postgres;
ALTER FUNCTION public.fn_assert_web_expense_numeric_scales(numeric,jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION public.fn_create_web_expense(uuid,uuid,uuid,uuid,text,numeric,date,text,jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION public.fn_update_web_expense(uuid,uuid,boolean,text,boolean,text,numeric,date,uuid,boolean,uuid,jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION public.fn_delete_web_expense(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.fn_create_web_income(uuid,uuid,numeric,date,text,uuid) OWNER TO postgres;
ALTER FUNCTION public.fn_update_web_income(uuid,uuid,jsonb) OWNER TO postgres;
ALTER FUNCTION public.fn_delete_web_income(uuid,uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.fn_require_web_financial_actor(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_assert_web_financial_categories(text,uuid[])
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_assert_web_expense_texts(text,boolean,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_assert_web_numeric_scale(numeric,integer,text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_assert_web_expense_numeric_scales(numeric,jsonb,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_create_web_expense(uuid,uuid,uuid,uuid,text,numeric,date,text,jsonb,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_update_web_expense(uuid,uuid,boolean,text,boolean,text,numeric,date,uuid,boolean,uuid,jsonb,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_delete_web_expense(uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_create_web_income(uuid,uuid,numeric,date,text,uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_update_web_income(uuid,uuid,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_delete_web_income(uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.fn_create_web_expense(uuid,uuid,uuid,uuid,text,numeric,date,text,jsonb,jsonb)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_update_web_expense(uuid,uuid,boolean,text,boolean,text,numeric,date,uuid,boolean,uuid,jsonb,jsonb)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_delete_web_expense(uuid,uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_create_web_income(uuid,uuid,numeric,date,text,uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_update_web_income(uuid,uuid,jsonb)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_delete_web_income(uuid,uuid)
  TO authenticated;

-- service_role no longer needs direct entry into ordinary Web CRUD. PostgreSQL
-- ownership still lets the wrappers call these protected functions internally.
REVOKE ALL ON FUNCTION public.fn_create_expense_eligible(
  uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,numeric,date,text,
  public.expense_source,jsonb,jsonb
) FROM service_role;
REVOKE ALL ON FUNCTION public.fn_update_expense_eligible(
  uuid,uuid,uuid,uuid,boolean,text,boolean,text,numeric,date,uuid,
  boolean,uuid,jsonb,jsonb
) FROM service_role;
REVOKE ALL ON FUNCTION public.fn_delete_expense_eligible(uuid,uuid,uuid,uuid)
  FROM service_role;
REVOKE ALL ON FUNCTION public.fn_create_income_eligible(
  uuid,uuid,uuid,uuid,numeric,date,text,uuid
) FROM service_role;
REVOKE ALL ON FUNCTION public.fn_update_income_eligible(uuid,uuid,uuid,uuid,jsonb)
  FROM service_role;
REVOKE ALL ON FUNCTION public.fn_delete_income_eligible(uuid,uuid,uuid,uuid)
  FROM service_role;

DO $assert_web_financial_crud_acl$
DECLARE
  entry regprocedure;
  entry_signature text;
  helper regprocedure := 'public.fn_require_web_financial_actor(uuid)'::regprocedure;
  category_helper regprocedure := 'public.fn_assert_web_financial_categories(text,uuid[])'::regprocedure;
  expense_text_helper regprocedure := 'public.fn_assert_web_expense_texts(text,boolean,jsonb)'::regprocedure;
  numeric_helper regprocedure := 'public.fn_assert_web_numeric_scale(numeric,integer,text)'::regprocedure;
  expense_numeric_helper regprocedure := 'public.fn_assert_web_expense_numeric_scales(numeric,jsonb,jsonb)'::regprocedure;
  old_entry regprocedure;
  old_signatures text[] := ARRAY[
    'public.fn_create_expense_eligible(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,numeric,date,text,public.expense_source,jsonb,jsonb)',
    'public.fn_update_expense_eligible(uuid,uuid,uuid,uuid,boolean,text,boolean,text,numeric,date,uuid,boolean,uuid,jsonb,jsonb)',
    'public.fn_delete_expense_eligible(uuid,uuid,uuid,uuid)',
    'public.fn_create_income_eligible(uuid,uuid,uuid,uuid,numeric,date,text,uuid)',
    'public.fn_update_income_eligible(uuid,uuid,uuid,uuid,jsonb)',
    'public.fn_delete_income_eligible(uuid,uuid,uuid,uuid)'
  ];
  entry_signatures text[] := ARRAY[
    'public.fn_create_web_expense(uuid,uuid,uuid,uuid,text,numeric,date,text,jsonb,jsonb)',
    'public.fn_update_web_expense(uuid,uuid,boolean,text,boolean,text,numeric,date,uuid,boolean,uuid,jsonb,jsonb)',
    'public.fn_delete_web_expense(uuid,uuid)',
    'public.fn_create_web_income(uuid,uuid,numeric,date,text,uuid)',
    'public.fn_update_web_income(uuid,uuid,jsonb)',
    'public.fn_delete_web_income(uuid,uuid)'
  ];
  fn record;
BEGIN
  IF has_function_privilege('service_role', helper, 'EXECUTE')
     OR has_function_privilege('authenticated', helper, 'EXECUTE')
     OR has_function_privilege('anon', helper, 'EXECUTE')
     OR EXISTS (
       SELECT 1 FROM pg_catalog.aclexplode(
         coalesce((SELECT proacl FROM pg_catalog.pg_proc WHERE oid = helper),
                  pg_catalog.acldefault('f', (SELECT proowner FROM pg_catalog.pg_proc WHERE oid = helper)))
       ) acl WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Web financial actor helper is directly executable';
  END IF;
  SELECT p.proowner, p.prosecdef, p.proconfig INTO fn
    FROM pg_catalog.pg_proc p WHERE p.oid = helper;
  IF fn.proowner <> 'postgres'::regrole
     OR NOT fn.prosecdef
     OR fn.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog'] THEN
    RAISE EXCEPTION 'Unsafe Web financial actor helper configuration';
  END IF;

  IF has_function_privilege('service_role', category_helper, 'EXECUTE')
     OR has_function_privilege('authenticated', category_helper, 'EXECUTE')
     OR has_function_privilege('anon', category_helper, 'EXECUTE')
     OR EXISTS (
       SELECT 1 FROM pg_catalog.aclexplode(
         coalesce((SELECT proacl FROM pg_catalog.pg_proc WHERE oid = category_helper),
                  pg_catalog.acldefault('f', (SELECT proowner FROM pg_catalog.pg_proc WHERE oid = category_helper)))
       ) acl WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Web financial category helper is directly executable';
  END IF;
  SELECT p.proowner, p.prosecdef, p.proconfig INTO fn
    FROM pg_catalog.pg_proc p WHERE p.oid = category_helper;
  IF fn.proowner <> 'postgres'::regrole
     OR fn.prosecdef
     OR fn.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog'] THEN
    RAISE EXCEPTION 'Unsafe Web financial category helper configuration';
  END IF;

  IF has_function_privilege('service_role', expense_text_helper, 'EXECUTE')
     OR has_function_privilege('authenticated', expense_text_helper, 'EXECUTE')
     OR has_function_privilege('anon', expense_text_helper, 'EXECUTE')
     OR EXISTS (
       SELECT 1 FROM pg_catalog.aclexplode(
         coalesce((SELECT proacl FROM pg_catalog.pg_proc WHERE oid = expense_text_helper),
                  pg_catalog.acldefault('f', (SELECT proowner FROM pg_catalog.pg_proc WHERE oid = expense_text_helper)))
       ) acl WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Web Expense text helper is directly executable';
  END IF;
  SELECT p.proowner, p.prosecdef, p.proconfig INTO fn
    FROM pg_catalog.pg_proc p WHERE p.oid = expense_text_helper;
  IF fn.proowner <> 'postgres'::regrole
     OR fn.prosecdef
     OR fn.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog'] THEN
    RAISE EXCEPTION 'Unsafe Web Expense text helper configuration';
  END IF;

  FOREACH helper IN ARRAY ARRAY[numeric_helper, expense_numeric_helper] LOOP
    IF has_function_privilege('service_role', helper, 'EXECUTE')
       OR has_function_privilege('authenticated', helper, 'EXECUTE')
       OR has_function_privilege('anon', helper, 'EXECUTE')
       OR EXISTS (
         SELECT 1 FROM pg_catalog.aclexplode(
           coalesce((SELECT p.proacl FROM pg_catalog.pg_proc p WHERE p.oid = helper),
                    pg_catalog.acldefault('f', (SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = helper)))
         ) acl WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
       ) THEN
      RAISE EXCEPTION 'Web financial numeric helper is directly executable: %', helper;
    END IF;
    SELECT p.proowner, p.prosecdef, p.proconfig INTO fn
      FROM pg_catalog.pg_proc p WHERE p.oid = helper;
    IF fn.proowner <> 'postgres'::regrole
       OR fn.prosecdef
       OR fn.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog'] THEN
      RAISE EXCEPTION 'Unsafe Web financial numeric helper configuration: %', helper;
    END IF;
  END LOOP;

  FOREACH entry_signature IN ARRAY entry_signatures LOOP
    entry := entry_signature::regprocedure;
    SELECT p.proowner, p.prosecdef, p.proconfig
      INTO fn FROM pg_catalog.pg_proc p WHERE p.oid = entry;
    IF fn.proowner <> 'postgres'::regrole
       OR NOT fn.prosecdef
       OR fn.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog'] THEN
      RAISE EXCEPTION 'Unsafe Web financial entry configuration: %', entry;
    END IF;
    IF NOT has_function_privilege('authenticated', entry, 'EXECUTE')
       OR has_function_privilege('anon', entry, 'EXECUTE')
       OR has_function_privilege('service_role', entry, 'EXECUTE')
       OR EXISTS (
         SELECT 1 FROM pg_catalog.aclexplode(
           coalesce((SELECT proacl FROM pg_catalog.pg_proc WHERE oid = entry),
                    pg_catalog.acldefault('f', fn.proowner))
         ) acl WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
       ) THEN
      RAISE EXCEPTION 'Unexpected Web financial entry ACL: %', entry;
    END IF;
  END LOOP;

  FOREACH entry_signature IN ARRAY old_signatures LOOP
    old_entry := entry_signature::regprocedure;
    IF has_function_privilege('service_role', old_entry, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role retains direct CRUD EXECUTE on %', old_entry;
    END IF;
  END LOOP;

  -- Proposal confirmation and WhatsApp event wrappers remain outside this cut.
  IF NOT has_function_privilege(
       'service_role',
       'public.fn_confirm_pending_expense_eligible(uuid,uuid,uuid,text,uuid,public.expense_source,timestamp with time zone,uuid,uuid,uuid,uuid,text,numeric,date,text,public.expense_source,jsonb,jsonb,uuid,uuid,bigint)'::regprocedure,
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_confirm_pending_income_eligible(uuid,uuid,uuid,text,uuid,public.expense_source,timestamp with time zone,uuid,uuid,numeric,date,text,uuid,uuid,uuid,bigint)'::regprocedure,
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'Proposal confirmation permissions changed outside this increment';
  END IF;
END;
$assert_web_financial_crud_acl$;

COMMIT;
