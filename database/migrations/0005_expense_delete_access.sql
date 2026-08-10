BEGIN;

CREATE FUNCTION public.fn_delete_expense(
  p_household_id UUID,
  p_expense_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  current_status public.expense_status;
BEGIN
  SELECT expense.status
    INTO current_status
    FROM public.tb_expenses AS expense
   WHERE expense.id = p_expense_id
     AND expense.household_id = p_household_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense was not found in the current household'
      USING ERRCODE = 'P0002';
  END IF;

  CASE current_status
    WHEN 'PENDING' THEN
      DELETE FROM public.tb_expenses
       WHERE id = p_expense_id
         AND household_id = p_household_id;

      RETURN 'DELETED';
    WHEN 'CONFIRMED' THEN
      UPDATE public.tb_expenses
         SET status = 'CANCELLED'
       WHERE id = p_expense_id
         AND household_id = p_household_id;

      RETURN 'CANCELLED';
    WHEN 'CANCELLED' THEN
      RETURN 'ALREADY_CANCELLED';
  END CASE;
END;
$$;

GRANT DELETE
ON TABLE public.tb_expenses
TO service_role;

GRANT UPDATE (status)
ON TABLE public.tb_expenses
TO service_role;

REVOKE EXECUTE ON FUNCTION public.fn_delete_expense(UUID, UUID)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.fn_delete_expense(UUID, UUID)
TO service_role;

COMMIT;
