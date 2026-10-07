BEGIN;

DO $$
DECLARE
  owner_id UUID := '00000000-0000-4000-8000-000000000021';
  member_id UUID := '00000000-0000-4000-8000-000000000022';
  household_id UUID := '00000000-0000-4000-8000-000000000001';
BEGIN
  IF (SELECT role FROM public.tb_household_members WHERE id=owner_id) <> 'OWNER' OR
     (SELECT status FROM public.tb_household_members WHERE id=owner_id) <> 'ACTIVE' THEN
    RAISE EXCEPTION 'owner backfill failed';
  END IF;
  IF (SELECT role FROM public.tb_household_members WHERE id=member_id) <> 'MEMBER' THEN
    RAISE EXCEPTION 'member backfill failed';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fn_transfer_household_owner') THEN
    RAISE EXCEPTION 'transfer RPC missing';
  END IF;
END $$;

ROLLBACK;
