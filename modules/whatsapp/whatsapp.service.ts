import {
  extractWhatsAppTextMessage,
  sendWhatsAppText,
  type WhatsAppTextMessage,
} from "@/infrastructure/whatsapp/whatsapp.adapter";
import { processAgentMessage } from "@/modules/agent/conversation.service";
import { findActiveProposalId } from "@/modules/agent/agent.service";
import type { AgentReadResult } from "@/modules/agent/agent.types";
import type { Category } from "@/modules/categories/category.types";
import type { IncomeListResult } from "@/modules/incomes/income.types";
import type { SharingRule } from "@/modules/sharing-rules/sharing-rule.types";
import type { ExpenseListItem } from "@/modules/expenses/expense.types";
import {
  findWhatsAppMember,
  reserveWhatsAppEvent,
  WhatsAppRepositoryError,
} from "./whatsapp.repository";
import {
  WhatsAppDomainError,
  type WhatsAppContext,
  type WhatsAppProcessResult,
} from "./whatsapp.types";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXPECTED_MVP_HOUSEHOLD_ID =
  "00000000-0000-4000-8000-000000000001";

function configuredSupabaseHost(): string {
  const configuredUrl = process.env.SUPABASE_URL;
  if (!configuredUrl) return "absent";

  try {
    return new URL(configuredUrl).hostname || "invalid";
  } catch {
    return "invalid";
  }
}

function logContextConfiguration(householdId: string | undefined): void {
  const householdIdPresent = Boolean(householdId);
  const householdIdValid = Boolean(
    householdId && UUID_PATTERN.test(householdId),
  );
  console.info(
    `[whatsapp-context] stage=config householdIdPresent=${String(householdIdPresent)} householdIdValid=${String(householdIdValid)} householdIdMatchesExpected=${String(householdId === EXPECTED_MVP_HOUSEHOLD_ID)} supabaseUrlPresent=${String(Boolean(process.env.SUPABASE_URL))} supabaseHost=${configuredSupabaseHost()} serviceRoleKeyPresent=${String(Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY))}`,
  );
}

function contextUnavailable(): WhatsAppDomainError {
  return new WhatsAppDomainError(
    "CONTEXT_UNAVAILABLE",
    "WhatsApp context is unavailable.",
  );
}

function persistenceError(): WhatsAppDomainError {
  return new WhatsAppDomainError(
    "PERSISTENCE_ERROR",
    "WhatsApp event could not be processed.",
  );
}

function isConfirmationOrRejection(text: string): boolean {
  return /^(?:s[ií]|ok|confirmo|confirmar|acepto|yes|no|rechazo|rechazar|cancelar|cancelo)(?:\s|$)/i.test(
    text,
  );
}

function extractProposalId(text: string): string | undefined {
  const candidate = text.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  )?.[0];
  return candidate && UUID_PATTERN.test(candidate) ? candidate : undefined;
}

function renderAgentResult(
  result: Awaited<ReturnType<typeof processAgentMessage>>,
): string {
  switch (result.type) {
    case "PROPOSAL_CREATED":
      return 'Propuesta creada. Responde "sí" para confirmar o "no" para rechazar.';
    case "CONFIRMED":
      return "Operación confirmada.";
    case "REJECTED":
      return "Operación rechazada.";
    case "CLARIFICATION_REQUIRED":
      return "Necesito más información para continuar.";
    case "READ_RESULT":
      if (result.operation === "GET_CATEGORIES") {
        const data = (result as AgentReadResult).data as Category[];
        return `Categorías: ${data.map((category) => category.name).join(", ") || "ninguna"}.`;
      }
      if (result.operation === "GET_SHARING_RULES") {
        const data = (result as AgentReadResult).data as SharingRule[];
        return `Reglas de reparto: ${data.map((rule) => rule.name).join(", ") || "ninguna"}.`;
      }
      if (result.operation === "GET_INCOMES") {
        const data = (result as AgentReadResult).data as IncomeListResult;
        return `Ingresos encontrados: ${data.incomes.length}. Total: ${data.summary.totalIncome}.`;
      }
      if (result.operation === "GET_EXPENSES") {
        const data = (result as AgentReadResult).data as ExpenseListItem[];
        return `Gastos encontrados: ${data.length}.`;
      }
      return "Balance consultado correctamente.";
    case "UNSUPPORTED":
      return "No pude interpretar la solicitud.";
    case "ERROR":
      return "No pude procesar la solicitud en este momento.";
  }
}

async function resolveWhatsAppContext(
  message: WhatsAppTextMessage,
): Promise<WhatsAppContext> {
  const householdId = process.env.HOUSEMATE_MVP_HOUSEHOLD_ID;
  logContextConfiguration(householdId);
  if (!householdId || !UUID_PATTERN.test(householdId)) {
    console.info(
      `[whatsapp-context] contextResolution=not_found reason=${householdId ? "household_invalid" : "household_missing"}`,
    );
    throw contextUnavailable();
  }

  let memberId: string | null;
  try {
    memberId = await findWhatsAppMember(householdId, message.sender);
  } catch (error) {
    console.info(
      `[whatsapp-context] contextResolution=error error_stage=${error instanceof WhatsAppRepositoryError ? "repository" : "unknown"}`,
    );
    throw contextUnavailable();
  }
  if (!memberId) {
    console.info(
      "[whatsapp-context] contextResolution=not_found reason=member_not_found",
    );
    throw contextUnavailable();
  }

  console.info("[whatsapp-context] contextResolution=result_found");

  return {
    householdId,
    actorMemberId: memberId,
    conversationKey: `whatsapp:${message.phoneNumberId}:${message.sender}`,
    source: "WHATSAPP",
  };
}

export async function processWhatsAppTextMessage(
  message: WhatsAppTextMessage,
): Promise<WhatsAppProcessResult> {
  const context = await resolveWhatsAppContext(message);

  let reserved: boolean;
  try {
    reserved = await reserveWhatsAppEvent(message.eventId);
  } catch (error) {
    if (error instanceof WhatsAppRepositoryError) throw persistenceError();
    throw persistenceError();
  }
  if (!reserved) return { status: "DUPLICATE" };

  let proposalId = extractProposalId(message.text);
  if (!proposalId && isConfirmationOrRejection(message.text)) {
    try {
      proposalId = (await findActiveProposalId(context)) ?? undefined;
    } catch {
      throw persistenceError();
    }
  }

  let result: Awaited<ReturnType<typeof processAgentMessage>>;
  try {
    result = await processAgentMessage(context, {
      message: message.text,
      proposalId,
    });
  } catch {
    throw new WhatsAppDomainError(
      "AGENT_ERROR",
      "The Agent could not process the message.",
    );
  }

  try {
    await sendWhatsAppText(message.sender, renderAgentResult(result));
  } catch {
    throw new WhatsAppDomainError(
      "PROVIDER_ERROR",
      "WhatsApp response could not be sent.",
    );
  }

  return { status: "PROCESSED" };
}

export function parseWhatsAppPayload(
  payload: unknown,
): WhatsAppTextMessage | null {
  return extractWhatsAppTextMessage(payload);
}
