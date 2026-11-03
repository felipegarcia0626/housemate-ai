BEGIN;

-- Client roles must use the guarded Web entry point or the privileged
-- WhatsApp event wrappers. Keep existing service_role consumers intact.
REVOKE ALL PRIVILEGES ON TABLE public.tb_agent_category_drafts
  FROM PUBLIC, anon, authenticated;

ALTER TABLE public.tb_agent_category_drafts ENABLE ROW LEVEL SECURITY;

REVOKE EXECUTE ON FUNCTION public.fn_create_whatsapp_agent_draft(
  uuid, uuid, uuid, text, public.pending_operation_type, jsonb,
  public.agent_category_draft_status, uuid, uuid, bigint
) FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.fn_update_whatsapp_agent_draft(
  uuid, uuid, uuid, text, public.pending_operation_type, jsonb,
  public.agent_category_draft_status, timestamptz, uuid, uuid, bigint
) FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.fn_delete_whatsapp_agent_draft(
  uuid, uuid, uuid, text, timestamptz, uuid, uuid, bigint
) FROM PUBLIC, anon, authenticated;

COMMIT;
