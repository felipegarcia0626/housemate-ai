BEGIN;

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'authenticated'
  ) THEN
    EXECUTE $create$
      CREATE FUNCTION public.fn_notifications_current_user_id()
      RETURNS UUID
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = ''
      AS $function$
        SELECT u.id
        FROM public.tb_users AS u
        WHERE u.auth_user_id = (SELECT auth.uid());
      $function$;
    $create$;

    REVOKE ALL
      ON FUNCTION public.fn_notifications_current_user_id()
      FROM PUBLIC;

    GRANT EXECUTE
      ON FUNCTION public.fn_notifications_current_user_id()
      TO authenticated;

    ALTER POLICY tb_notifications_select_own
      ON public.tb_notifications
      USING (
        recipient_user_id =
          (SELECT public.fn_notifications_current_user_id())
      );
  END IF;
END;
$migration$;

COMMIT;
