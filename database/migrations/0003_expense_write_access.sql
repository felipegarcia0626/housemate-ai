ALTER TABLE public.tb_expenses
  ALTER COLUMN merchant DROP NOT NULL;

CREATE FUNCTION public.fn_create_expense(
  p_household_id UUID,
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
  p_distributions JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  expense_id_to_create UUID;
  item JSONB;
  distribution JSONB;
  distribution_amount NUMERIC(14,2);
  distribution_percentage NUMERIC(5,2);
  distributions_amount_total NUMERIC := 0;
  distributions_percentage_total NUMERIC := 0;
  associated_receipt_count INTEGER;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'p_items must be a JSON array'
      USING ERRCODE = '22023';
  END IF;

  IF p_distributions IS NULL
     OR jsonb_typeof(p_distributions) <> 'array'
     OR jsonb_array_length(p_distributions) = 0 THEN
    RAISE EXCEPTION 'p_distributions must be a non-empty JSON array'
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

    PERFORM (item ->> 'totalAmount')::NUMERIC(14,2);

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
    distribution_amount := (distribution ->> 'amount')::NUMERIC(14,2);
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

  IF distributions_amount_total <> p_total_amount THEN
    RAISE EXCEPTION
      'ExpenseDistribution amount total (%) differs from Expense total (%)',
      distributions_amount_total,
      p_total_amount
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.tb_expenses (
    household_id,
    created_by,
    paid_by,
    category_id,
    merchant,
    total_amount,
    expense_date,
    description,
    status,
    source
  )
  VALUES (
    p_household_id,
    p_created_by,
    p_paid_by,
    p_category_id,
    p_merchant,
    p_total_amount,
    p_expense_date,
    p_description,
    'CONFIRMED',
    p_source
  )
  RETURNING id INTO expense_id_to_create;

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
      expense_id_to_create,
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
      expense_id_to_create,
      (distribution ->> 'householdMemberId')::UUID,
      (distribution ->> 'amount')::NUMERIC(14,2),
      (distribution ->> 'percentage')::NUMERIC(5,2)
    );
  END LOOP;

  IF p_receipt_id IS NOT NULL THEN
    UPDATE public.tb_receipts
       SET expense_id = expense_id_to_create
     WHERE id = p_receipt_id
       AND household_id = p_household_id
       AND processing_status = 'PROCESSED'
       AND expense_id IS NULL;

    GET DIAGNOSTICS associated_receipt_count = ROW_COUNT;

    IF associated_receipt_count <> 1 THEN
      RAISE EXCEPTION
        'Receipt is not available for association with this Expense'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN expense_id_to_create;
END;
$$;

GRANT INSERT ON TABLE
  public.tb_expenses,
  public.tb_expense_items,
  public.tb_expense_distributions
TO service_role;

GRANT SELECT (id, household_id, processing_status, expense_id)
ON TABLE public.tb_receipts
TO service_role;

GRANT UPDATE (expense_id)
ON TABLE public.tb_receipts
TO service_role;

REVOKE EXECUTE ON FUNCTION public.fn_create_expense(
  UUID,
  UUID,
  UUID,
  UUID,
  UUID,
  TEXT,
  NUMERIC,
  DATE,
  TEXT,
  public.expense_source,
  JSONB,
  JSONB
)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.fn_create_expense(
  UUID,
  UUID,
  UUID,
  UUID,
  UUID,
  TEXT,
  NUMERIC,
  DATE,
  TEXT,
  public.expense_source,
  JSONB,
  JSONB
)
TO service_role;
