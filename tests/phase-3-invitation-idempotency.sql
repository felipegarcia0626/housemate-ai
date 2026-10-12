BEGIN;
\ir fixtures/0038_invitation_idempotency_fixture.sql

DO $$
DECLARE
  actor UUID := 'd1000000-0000-4000-8000-000000000001';
  household UUID := 'd3000000-0000-4000-8000-000000000001';
  key UUID := 'd5000000-0000-4000-8000-000000000001';
  first_result JSONB; repeated JSONB; invitation UUID;
BEGIN
  first_result := public.fn_create_household_invitation(actor,household,' Recipient-Idempotency@Example.Test ',
    'first-private-token-hash',now()+interval '7 days',key);
  invitation := (first_result->>'invitationId')::UUID;
  IF first_result->>'outcome' <> 'CREATED' OR
     (SELECT count(*) FROM public.tb_notifications WHERE source_entity_id=invitation AND type='HOUSEHOLD_INVITATION_RECEIVED') <> 1 THEN
    RAISE EXCEPTION 'first creation must persist invitation and notification';
  END IF;
  repeated := public.fn_create_household_invitation(actor,household,'recipient-idempotency@example.test',NULL,NULL,key);
  IF repeated->>'outcome' <> 'RECOVERED' OR repeated->>'invitationId' <> first_result->>'invitationId' OR
     repeated ? 'token' OR repeated ? 'tokenHash' OR repeated ? 'inviteUrl' THEN
    RAISE EXCEPTION 'recovery must return the existing ID without a token';
  END IF;
  PERFORM public.fn_create_household_invitation(actor,household,'recipient-idempotency@example.test',
    'replacement-must-not-persist',now()+interval '7 days',key);
  IF (SELECT token_hash FROM public.tb_household_invitations WHERE id=invitation) <> 'first-private-token-hash' OR
     (SELECT count(*) FROM public.tb_household_invitations WHERE creator_user_id='d2000000-0000-4000-8000-000000000001' AND idempotency_key=key) <> 1 OR
     (SELECT count(*) FROM public.tb_notifications WHERE source_entity_id=invitation) <> 1 THEN
    RAISE EXCEPTION 'retry duplicated resources or replaced token';
  END IF;
  BEGIN
    PERFORM public.fn_create_household_invitation(actor,household,'different@example.test',NULL,NULL,key);
    RAISE EXCEPTION 'email mismatch was accepted';
  EXCEPTION WHEN SQLSTATE 'P0004' THEN NULL; END;
  BEGIN
    PERFORM public.fn_create_household_invitation(actor,'d3000000-0000-4000-8000-000000000002',
      'recipient-idempotency@example.test',NULL,NULL,key);
    RAISE EXCEPTION 'household mismatch was accepted';
  EXCEPTION WHEN SQLSTATE 'P0004' THEN NULL; END;
  repeated := public.fn_create_household_invitation('d1000000-0000-4000-8000-000000000003',household,
    'recipient-idempotency@example.test',NULL,NULL,key);
  IF repeated->>'outcome' <> 'NEEDS_CREATION' OR repeated ? 'invitationId' THEN
    RAISE EXCEPTION 'another actor recovered private resources';
  END IF;
  BEGIN
    PERFORM public.fn_create_household_invitation('d1000000-0000-4000-8000-000000000003',household,
      'recipient-idempotency@example.test','other-private-hash',now()+interval '7 days',key);
    RAISE EXCEPTION 'another actor adopted an existing invitation';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  UPDATE public.tb_household_members SET status='LEFT' WHERE id='d4000000-0000-4000-8000-000000000001';
  BEGIN
    PERFORM public.fn_create_household_invitation(actor,household,'recipient-idempotency@example.test',NULL,NULL,key);
    RAISE EXCEPTION 'inactive actor recovered resources';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  UPDATE public.tb_household_members SET status='ACTIVE' WHERE id='d4000000-0000-4000-8000-000000000001';
  UPDATE public.tb_household_invitations SET expires_at=now()-interval '1 day' WHERE id=invitation;
  repeated := public.fn_create_household_invitation(actor,household,'recipient-idempotency@example.test',NULL,NULL,key);
  IF repeated->>'invitationId' <> invitation::TEXT THEN RAISE EXCEPTION 'expired correlation was lost'; END IF;
  BEGIN
    PERFORM public.fn_create_household_invitation(household,'d4000000-0000-4000-8000-000000000001',
      'recipient-idempotency@example.test','legacy-private-hash',now()+interval '7 days');
    RAISE EXCEPTION 'legacy call removed correlated invitation';
  EXCEPTION WHEN unique_violation THEN NULL; END;
END; $$;

CREATE FUNCTION pg_temp.reject_fixture_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.household_id='d3000000-0000-4000-8000-000000000002'::UUID THEN
    RAISE EXCEPTION 'Controlled notification failure' USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER reject_fixture_notification BEFORE INSERT ON public.tb_notifications
FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_fixture_notification();
DO $$
BEGIN
  BEGIN
    PERFORM public.fn_create_household_invitation('d1000000-0000-4000-8000-000000000001',
      'd3000000-0000-4000-8000-000000000002','recipient-idempotency@example.test','rollback-private-hash',
      now()+interval '7 days','d5000000-0000-4000-8000-000000000002');
    RAISE EXCEPTION 'notification failure did not occur';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  IF EXISTS (SELECT 1 FROM public.tb_household_invitations WHERE idempotency_key='d5000000-0000-4000-8000-000000000002') OR
     EXISTS (SELECT 1 FROM public.tb_notifications WHERE household_id='d3000000-0000-4000-8000-000000000002') THEN
    RAISE EXCEPTION 'failed notification left persistent resources';
  END IF;
END; $$;
ROLLBACK;
