-- Disposable pre-0060 history used to prove that the backfill considers every
-- verified link state and does not infer retirement from generic identifiers.
INSERT INTO public.tb_users(id, display_name, external_identifier)
VALUES
(
  '00600000-0060-4000-8000-000000000001',
  'Legacy retirement backfill fixture',
  '19996600001'
),
(
  '00600000-0060-4000-8000-000000000003',
  'Active verified backfill fixture',
  'legacy:active-account'
),
(
  '00600000-0060-4000-8000-000000000005',
  'Mixed verified history backfill fixture',
  'legacy:mixed-history-account'
),
(
  '00600000-0060-4000-8000-000000000008',
  'No verified history backfill fixture',
  'external-system:opaque-account-008'
);

INSERT INTO public.tb_whatsapp_links(
  id, user_id, sender, status, authorization_version, created_at, verified_at, revoked_at
)
VALUES
(
  '00600000-0060-4000-8000-000000000002',
  '00600000-0060-4000-8000-000000000001',
  '19996600002',
  'REVOKED',
  2,
  '2024-01-01 12:00:00+00',
  '2024-01-01 12:00:00+00',
  '2024-01-02 12:00:00+00'
),
(
  '00600000-0060-4000-8000-000000000004',
  '00600000-0060-4000-8000-000000000003',
  '19996600003',
  'ACTIVE',
  1,
  '2023-02-01 12:00:00+00',
  '2023-02-01 12:00:00+00',
  NULL
),
(
  '00600000-0060-4000-8000-000000000006',
  '00600000-0060-4000-8000-000000000005',
  '19996600004',
  'REVOKED',
  1,
  '2022-03-01 12:00:00+00',
  '2022-03-01 12:00:00+00',
  '2022-03-02 12:00:00+00'
),
(
  '00600000-0060-4000-8000-000000000007',
  '00600000-0060-4000-8000-000000000005',
  '19996600005',
  'ACTIVE',
  2,
  '2023-04-01 12:00:00+00',
  '2023-04-01 12:00:00+00',
  NULL
);
