BEGIN;

GRANT SELECT ON TABLE
  public.tb_households,
  public.tb_household_members,
  public.tb_categories,
  public.tb_expenses,
  public.tb_expense_items,
  public.tb_expense_distributions
TO service_role;

COMMIT;
