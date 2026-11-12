BEGIN;

DO $backfill$
DECLARE
  v_revoked_only_user UUID := '00600000-0060-4000-8000-000000000001';
  v_active_user UUID := '00600000-0060-4000-8000-000000000003';
  v_mixed_history_user UUID := '00600000-0060-4000-8000-000000000005';
  v_generic_only_user UUID := '00600000-0060-4000-8000-000000000008';
BEGIN
  IF (SELECT count(*)
      FROM public.tb_whatsapp_legacy_identity_retirements AS retirement
      WHERE retirement.user_id IN (v_revoked_only_user, v_active_user, v_mixed_history_user)) <> 3 THEN
    RAISE EXCEPTION 'Backfill did not create exactly one retirement marker for each user with verified history';
  END IF;

  IF EXISTS (
    SELECT expected.user_id
    FROM (VALUES
      (v_revoked_only_user, '2024-01-01 12:00:00+00'::timestamptz),
      (v_active_user, '2023-02-01 12:00:00+00'::timestamptz),
      (v_mixed_history_user, '2022-03-01 12:00:00+00'::timestamptz)
    ) AS expected(user_id, first_verified_at)
    LEFT JOIN public.tb_whatsapp_legacy_identity_retirements AS retirement
      ON retirement.user_id = expected.user_id
    WHERE retirement.user_id IS NULL
       OR retirement.first_verified_at IS DISTINCT FROM expected.first_verified_at
  ) THEN
    RAISE EXCEPTION 'Backfill did not preserve the minimum original verified_at for every history shape';
  END IF;

  IF (SELECT count(*) FROM public.tb_whatsapp_links AS link WHERE link.user_id = v_active_user AND link.status = 'ACTIVE') <> 1
     OR (SELECT count(*) FROM public.tb_whatsapp_links AS link WHERE link.user_id = v_mixed_history_user AND link.status = 'ACTIVE') <> 1
     OR (SELECT count(*) FROM public.tb_whatsapp_links AS link WHERE link.user_id = v_mixed_history_user AND link.status = 'REVOKED') <> 1 THEN
    RAISE EXCEPTION 'Backfill fixture did not exercise ACTIVE-only and mixed ACTIVE/REVOKED histories';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tb_whatsapp_legacy_identity_retirements AS retirement
    WHERE retirement.user_id = v_generic_only_user
  ) OR EXISTS (
    SELECT 1 FROM public.tb_whatsapp_links AS link
    WHERE link.user_id = v_generic_only_user
  ) THEN
    RAISE EXCEPTION 'A non-telephone external identifier without verified history caused a retirement marker';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.tb_users AS u
    WHERE u.id = v_revoked_only_user AND u.external_identifier = '19996600001'
      AND u.auth_user_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Backfill changed generic identity data or invented an Auth mapping';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.tb_users AS u
    WHERE u.id = v_generic_only_user
      AND u.external_identifier = 'external-system:opaque-account-008'
      AND u.auth_user_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Backfill changed an unrelated non-telephone external identifier';
  END IF;
END;
$backfill$;

SET LOCAL ROLE service_role;
DO $resolution$
DECLARE v_identity JSONB;
BEGIN
  v_identity := public.fn_resolve_whatsapp_sender('19996600001');
  IF v_identity->>'status' IS DISTINCT FROM 'UNAVAILABLE' THEN
    RAISE EXCEPTION 'Revoked historical link allowed legacy fallback to reappear';
  END IF;
END;
$resolution$;
RESET ROLE;

SELECT 'PASS 0060 historical verified-link retirement backfill' AS result;
ROLLBACK;
