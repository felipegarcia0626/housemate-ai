BEGIN;

CREATE FUNCTION public.fn_update_expense(
  p_household_id UUID,
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
  p_distributions JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  current_total_amount NUMERIC(14,2);
  current_status public.expense_status;
  effective_total_amount NUMERIC(14,2);
  item JSONB;
  distribution JSONB;
  item_total_amount NUMERIC(14,2);
  distribution_amount NUMERIC(14,2);
  distribution_percentage NUMERIC(5,2);
  items_amount_total NUMERIC := 0;
  distributions_amount_total NUMERIC := 0;
  distributions_percentage_total NUMERIC := 0;
BEGIN
  IF p_set_merchant IS NULL
     OR p_set_description IS NULL
     OR p_set_category_id IS NULL THEN
    RAISE EXCEPTION 'Update presence flags cannot be null'
      USING ERRCODE = '22023';
  END IF;

  IF NOT p_set_merchant
     AND NOT p_set_description
     AND p_total_amount IS NULL
     AND p_expense_date IS NULL
     AND p_paid_by IS NULL
     AND NOT p_set_category_id
     AND p_items IS NULL
     AND p_distributions IS NULL THEN
    RAISE EXCEPTION 'At least one Expense field must be provided for update'
      USING ERRCODE = '22023';
  END IF;

  SELECT expense.total_amount, expense.status
    INTO current_total_amount, current_status
    FROM public.tb_expenses AS expense
   WHERE expense.id = p_expense_id
     AND expense.household_id = p_household_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense was not found in the current household'
      USING ERRCODE = 'P0002';
  END IF;

  IF current_status <> 'CONFIRMED' THEN
    RAISE EXCEPTION 'Only confirmed Expenses can be updated'
      USING ERRCODE = '23514';
  END IF;

  effective_total_amount := COALESCE(p_total_amount, current_total_amount);

  IF effective_total_amount <= 0 THEN
    RAISE EXCEPTION 'Expense total must be greater than zero'
      USING ERRCODE = '23514';
  END IF;

  IF p_total_amount IS NOT NULL
     AND p_total_amount <> current_total_amount
     AND p_distributions IS NULL THEN
    RAISE EXCEPTION 'Distributions are required when Expense total changes'
      USING ERRCODE = '23514';
  END IF;

  IF p_items IS NOT NULL THEN
    IF jsonb_typeof(p_items) <> 'array' THEN
      RAISE EXCEPTION 'p_items must be a JSON array or null'
        USING ERRCODE = '22023';
    END IF;

    FOR item IN
      SELECT value FROM jsonb_array_elements(p_items)
    LOOP
      IF jsonb_typeof(item) <> 'object'
         OR NOT item ? 'name'
         OR jsonb_typeof(item -> 'name') <> 'string'
         OR NOT item ? 'totalAmount'
         OR jsonb_typeof(item -> 'totalAmount') <> 'number'
         OR (
           item ? 'quantity'
           AND jsonb_typeof(item -> 'quantity') NOT IN ('number', 'null')
         )
         OR (
           item ? 'unitPrice'
           AND jsonb_typeof(item -> 'unitPrice') NOT IN ('number', 'null')
         )
         OR (
           item ? 'categoryId'
           AND jsonb_typeof(item -> 'categoryId') NOT IN ('string', 'null')
         ) THEN
        RAISE EXCEPTION 'Invalid p_items element structure'
          USING ERRCODE = '22023';
      END IF;

      item_total_amount := (item ->> 'totalAmount')::NUMERIC(14,2);
      items_amount_total := items_amount_total + item_total_amount;

      IF item ? 'quantity' AND jsonb_typeof(item -> 'quantity') = 'number' THEN
        PERFORM (item ->> 'quantity')::NUMERIC(12,3);
      END IF;

      IF item ? 'unitPrice' AND jsonb_typeof(item -> 'unitPrice') = 'number' THEN
        PERFORM (item ->> 'unitPrice')::NUMERIC(14,2);
      END IF;

      IF item ? 'categoryId' AND jsonb_typeof(item -> 'categoryId') = 'string' THEN
        PERFORM (item ->> 'categoryId')::UUID;
      END IF;
    END LOOP;
  ELSE
    SELECT COALESCE(SUM(existing_item.total_amount), 0)
      INTO items_amount_total
      FROM public.tb_expense_items AS existing_item
     WHERE existing_item.expense_id = p_expense_id;
  END IF;

  IF items_amount_total > effective_total_amount THEN
    RAISE EXCEPTION 'ExpenseItem total exceeds effective Expense total'
      USING ERRCODE = '23514';
  END IF;

  IF p_distributions IS NOT NULL THEN
    IF jsonb_typeof(p_distributions) <> 'array'
       OR jsonb_array_length(p_distributions) = 0 THEN
      RAISE EXCEPTION 'p_distributions must be a non-empty JSON array or null'
        USING ERRCODE = '22023';
    END IF;

    FOR distribution IN
      SELECT value FROM jsonb_array_elements(p_distributions)
    LOOP
      IF jsonb_typeof(distribution) <> 'object'
         OR NOT distribution ? 'householdMemberId'
         OR jsonb_typeof(distribution -> 'householdMemberId') <> 'string'
         OR NOT distribution ? 'amount'
         OR jsonb_typeof(distribution -> 'amount') <> 'number'
         OR NOT distribution ? 'percentage'
         OR jsonb_typeof(distribution -> 'percentage') <> 'number' THEN
        RAISE EXCEPTION 'Invalid p_distributions element structure'
          USING ERRCODE = '22023';
      END IF;

      PERFORM (distribution ->> 'householdMemberId')::UUID;
      distribution_amount :=
        (distribution ->> 'amount')::NUMERIC(14,2);
      distribution_percentage :=
        (distribution ->> 'percentage')::NUMERIC(5,2);
      distributions_amount_total :=
        distributions_amount_total + distribution_amount;
      distributions_percentage_total :=
        distributions_percentage_total + distribution_percentage;
    END LOOP;

    IF distributions_percentage_total <> 100.00 THEN
      RAISE EXCEPTION
        'ExpenseDistribution percentages (%) do not sum to 100.00',
        distributions_percentage_total
        USING ERRCODE = '23514';
    END IF;

    IF distributions_amount_total <> effective_total_amount THEN
      RAISE EXCEPTION
        'ExpenseDistribution amount total (%) differs from effective Expense total (%)',
        distributions_amount_total,
        effective_total_amount
        USING ERRCODE = '23514';
    END IF;
  END IF;

  UPDATE public.tb_expenses
     SET merchant = CASE
           WHEN p_set_merchant THEN p_merchant
           ELSE merchant
         END,
         description = CASE
           WHEN p_set_description THEN p_description
           ELSE description
         END,
         total_amount = COALESCE(p_total_amount, total_amount),
         expense_date = COALESCE(p_expense_date, expense_date),
         paid_by = COALESCE(p_paid_by, paid_by),
         category_id = CASE
           WHEN p_set_category_id THEN p_category_id
           ELSE category_id
         END
   WHERE id = p_expense_id
     AND household_id = p_household_id;

  IF p_items IS NOT NULL THEN
    DELETE FROM public.tb_expense_items
     WHERE expense_id = p_expense_id;

    FOR item IN
      SELECT value FROM jsonb_array_elements(p_items)
    LOOP
      INSERT INTO public.tb_expense_items (
        expense_id,
        name,
        quantity,
        unit_price,
        total_amount,
        category_id
      )
      VALUES (
        p_expense_id,
        item ->> 'name',
        CASE
          WHEN jsonb_typeof(item -> 'quantity') = 'number'
            THEN (item ->> 'quantity')::NUMERIC(12,3)
          ELSE NULL
        END,
        CASE
          WHEN jsonb_typeof(item -> 'unitPrice') = 'number'
            THEN (item ->> 'unitPrice')::NUMERIC(14,2)
          ELSE NULL
        END,
        (item ->> 'totalAmount')::NUMERIC(14,2),
        CASE
          WHEN jsonb_typeof(item -> 'categoryId') = 'string'
            THEN (item ->> 'categoryId')::UUID
          ELSE NULL
        END
      );
    END LOOP;
  END IF;

  IF p_distributions IS NOT NULL THEN
    DELETE FROM public.tb_expense_distributions
     WHERE expense_id = p_expense_id;

    FOR distribution IN
      SELECT value FROM jsonb_array_elements(p_distributions)
    LOOP
      INSERT INTO public.tb_expense_distributions (
        expense_id,
        household_member_id,
        amount,
        percentage
      )
      VALUES (
        p_expense_id,
        (distribution ->> 'householdMemberId')::UUID,
        (distribution ->> 'amount')::NUMERIC(14,2),
        (distribution ->> 'percentage')::NUMERIC(5,2)
      );
    END LOOP;
  END IF;

  RETURN p_expense_id;
END;
$$;

GRANT UPDATE (
  merchant,
  description,
  total_amount,
  expense_date,
  paid_by,
  category_id
)
ON TABLE public.tb_expenses
TO service_role;

GRANT DELETE ON TABLE
  public.tb_expense_items,
  public.tb_expense_distributions
TO service_role;

REVOKE EXECUTE ON FUNCTION public.fn_update_expense(
  UUID,
  UUID,
  BOOLEAN,
  TEXT,
  BOOLEAN,
  TEXT,
  NUMERIC,
  DATE,
  UUID,
  BOOLEAN,
  UUID,
  JSONB,
  JSONB
)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.fn_update_expense(
  UUID,
  UUID,
  BOOLEAN,
  TEXT,
  BOOLEAN,
  TEXT,
  NUMERIC,
  DATE,
  UUID,
  BOOLEAN,
  UUID,
  JSONB,
  JSONB
)
TO service_role;

COMMIT;
