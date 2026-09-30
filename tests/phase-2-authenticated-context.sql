BEGIN;

DO $$
DECLARE
  auth_user_column RECORD;
  auth_constraint_count INTEGER;
BEGIN
  SELECT is_nullable
    INTO auth_user_column
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'tb_users'
     AND column_name = 'auth_user_id';

  IF NOT FOUND OR auth_user_column.is_nullable <> 'YES' THEN
    RAISE EXCEPTION 'FAIL tb_users.auth_user_id must exist and remain nullable';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'uq_tb_users_auth_user_id'
       AND conrelid = 'public.tb_users'::regclass
       AND contype = 'u'
  ) THEN
    RAISE EXCEPTION 'FAIL tb_users.auth_user_id must be unique';
  END IF;

  IF to_regclass('auth.users') IS NOT NULL THEN
    SELECT count(*)
      INTO auth_constraint_count
      FROM pg_constraint
     WHERE conname = 'fk_tb_users_auth_user'
       AND conrelid = 'public.tb_users'::regclass
       AND contype = 'f';

    IF auth_constraint_count <> 1 THEN
      RAISE EXCEPTION 'FAIL auth_user_id must reference auth.users in Supabase';
    END IF;
  END IF;
END;
$$;

ROLLBACK;

SELECT 'PASS authenticated identity schema is additive and nullable' AS result;
