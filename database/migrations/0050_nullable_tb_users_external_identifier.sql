BEGIN;

ALTER TABLE public.tb_users
  ALTER COLUMN external_identifier DROP NOT NULL;

COMMIT;
