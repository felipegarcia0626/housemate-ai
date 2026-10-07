BEGIN;

CREATE TABLE public.tb_notifications (
  id UUID CONSTRAINT pk_tb_notifications PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id UUID NOT NULL,
  household_id UUID NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_entity_type TEXT,
  source_entity_id UUID,
  deduplication_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ,
  CONSTRAINT fk_tb_notifications_recipient_user
    FOREIGN KEY (recipient_user_id)
    REFERENCES public.tb_users (id)
    ON DELETE RESTRICT
    ON UPDATE NO ACTION,
  CONSTRAINT fk_tb_notifications_household
    FOREIGN KEY (household_id)
    REFERENCES public.tb_households (id)
    ON DELETE RESTRICT
    ON UPDATE NO ACTION
);

CREATE INDEX idx_tb_notifications_recipient_created_at
  ON public.tb_notifications (recipient_user_id, created_at DESC);

CREATE INDEX idx_tb_notifications_recipient_unread
  ON public.tb_notifications (recipient_user_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE INDEX idx_tb_notifications_household_created_at
  ON public.tb_notifications (household_id, created_at DESC);

CREATE UNIQUE INDEX uq_tb_notifications_recipient_deduplication_key
  ON public.tb_notifications (recipient_user_id, deduplication_key)
  WHERE deduplication_key IS NOT NULL;

ALTER TABLE public.tb_notifications ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.tb_notifications FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE public.tb_notifications TO service_role;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT, UPDATE (read_at) ON TABLE public.tb_notifications TO authenticated;

    EXECUTE $policy$
      CREATE POLICY tb_notifications_select_own
        ON public.tb_notifications
        FOR SELECT
        TO authenticated
        USING (
          EXISTS (
            SELECT 1
              FROM public.tb_users
             WHERE public.tb_users.id = recipient_user_id
               AND public.tb_users.auth_user_id =
                 NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID
          )
        )
    $policy$;

    EXECUTE $policy$
      CREATE POLICY tb_notifications_update_read_at_own
        ON public.tb_notifications
        FOR UPDATE
        TO authenticated
        USING (
          EXISTS (
            SELECT 1
              FROM public.tb_users
             WHERE public.tb_users.id = recipient_user_id
               AND public.tb_users.auth_user_id =
                 NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID
          )
        )
        WITH CHECK (
          EXISTS (
            SELECT 1
              FROM public.tb_users
             WHERE public.tb_users.id = recipient_user_id
               AND public.tb_users.auth_user_id =
                 NULLIF(current_setting('request.jwt.claim.sub', true), '')::UUID
          )
        )
    $policy$;
  END IF;
END;
$$;

COMMIT;
