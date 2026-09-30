BEGIN;

ALTER TABLE public.tb_users
  ADD COLUMN auth_user_id UUID;

ALTER TABLE public.tb_users
  ADD CONSTRAINT uq_tb_users_auth_user_id UNIQUE (auth_user_id);

DO $$
BEGIN
  -- The embedded SQL test database does not provide Supabase's managed auth
  -- schema. Production Supabase instances do, so add the FK there without
  -- manufacturing an auth.users table in non-Supabase environments.
  IF to_regclass('auth.users') IS NOT NULL THEN
    ALTER TABLE public.tb_users
      ADD CONSTRAINT fk_tb_users_auth_user
      FOREIGN KEY (auth_user_id)
      REFERENCES auth.users(id)
      ON DELETE RESTRICT;
  END IF;
END;
$$;

COMMIT;
