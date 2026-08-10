BEGIN;

GRANT SELECT
ON TABLE
  public.tb_sharing_rules,
  public.tb_sharing_rule_members
TO service_role;

COMMIT;
