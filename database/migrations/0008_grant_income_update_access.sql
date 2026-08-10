BEGIN;

GRANT UPDATE (
  member_id,
  amount,
  income_date,
  description,
  category_id
)
ON TABLE public.tb_incomes
TO service_role;

COMMIT;
