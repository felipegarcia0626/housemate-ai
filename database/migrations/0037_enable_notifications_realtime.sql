DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'tb_notifications'
  ) THEN
    ALTER PUBLICATION supabase_realtime
      ADD TABLE public.tb_notifications;
  END IF;
END;
$$;
