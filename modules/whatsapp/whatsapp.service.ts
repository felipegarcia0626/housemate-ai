import {
  extractWhatsAppTextMessage,
  sendWhatsAppText,
  type WhatsAppTextMessage,
} from "@/infrastructure/whatsapp/whatsapp.adapter";
import { processAgentMessage } from "@/modules/agent/conversation.service";
import { findActiveProposalId } from "@/modules/agent/agent.service";
import { getCategoriesTool } from "@/modules/agent/tools/get-categories.tool";
import { listHouseholdMembers } from "@/modules/household-members/household-member.service";
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

function formatWhatsAppMoney(value: number): string {
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatWhatsAppDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function renderWhatsAppExpenses(data: ExpenseListItem[]): string {
  if (data.length === 0) return "No encontré gastos con esos criterios.";

  const total = data.reduce((sum, expense) => sum + expense.totalAmount, 0);
  const lines = data.map(
    (expense, index) =>
      `${index + 1}. ${expense.merchant ?? "Gasto"} — ${formatWhatsAppMoney(expense.totalAmount)} — ${formatWhatsAppDate(expense.expenseDate)} — ${expense.category?.name ?? "Sin categoría"}`,
  );

  return [
    `Encontré ${data.length} ${data.length === 1 ? "gasto" : "gastos"}:`,
    ...lines,
    `Total: ${formatWhatsAppMoney(total)}`,
  ].join("\n");
}

type AgentResult = Awaited<ReturnType<typeof processAgentMessage>>;
type ProposalUpdatedResult = Extract<AgentResult, { type: "PROPOSAL_UPDATED" }>;
type ProposalPresentationLabels = {
  categories: Map<string, string>;
  members: Map<string, string>;
};

function emptyProposalPresentationLabels(): ProposalPresentationLabels {
  return { categories: new Map(), members: new Map() };
}

function renderUpdatedProposal(
  result: ProposalUpdatedResult,
  labels: ProposalPresentationLabels,
): string {
  const lines = [
    "Propuesta actualizada. Revisa la información antes de confirmar:",
  ];
  const payload = result.payload;
  if (!payload || typeof payload !== "object")
    return 'Propuesta actualizada. Responde "sí" para confirmar o "no" para rechazar.';

  if (
    result.operationType === "CREATE_EXPENSE" &&
    "expense" in payload &&
    payload.expense
  ) {
    const expense = payload.expense;
    if (expense.merchant?.trim())
      lines.push(`Comercio: ${expense.merchant.trim()}`);
    if (typeof expense.totalAmount === "number")
      lines.push(`Monto: ${formatWhatsAppMoney(expense.totalAmount)}`);
    if (expense.expenseDate?.trim())
      lines.push(`Fecha: ${formatWhatsAppDate(expense.expenseDate)}`);
    if (expense.description?.trim())
      lines.push(`Descripción: ${expense.description.trim()}`);
    const categoryName = expense.categoryId
      ? labels.categories.get(expense.categoryId)
      : undefined;
    if (categoryName) lines.push(`Categoría: ${categoryName}`);
    const payerName = expense.paidByMemberId
      ? labels.members.get(expense.paidByMemberId)
      : undefined;
    if (payerName) lines.push(`Pagador: ${payerName}`);
  } else if (
    result.operationType === "CREATE_INCOME" &&
    "income" in payload &&
    payload.income
  ) {
    const income = payload.income;
    if (typeof income.amount === "number")
      lines.push(`Monto: ${formatWhatsAppMoney(income.amount)}`);
    if (income.incomeDate?.trim())
      lines.push(`Fecha: ${formatWhatsAppDate(income.incomeDate)}`);
    if (income.description?.trim())
      lines.push(`Descripción: ${income.description.trim()}`);
    const categoryName = income.categoryId
      ? labels.categories.get(income.categoryId)
      : undefined;
    if (categoryName) lines.push(`Categoría: ${categoryName}`);
    const memberName = income.memberId
      ? labels.members.get(income.memberId)
      : undefined;
    if (memberName) lines.push(`Integrante: ${memberName}`);
  } else {
    return 'Propuesta actualizada. Responde "sí" para confirmar o "no" para rechazar.';
  }

  lines.push('Responde "sí" para confirmar o "no" para rechazar.');
  return lines.join("\n");
}

async function loadProposalPresentationLabels(
  context: WhatsAppContext,
  result: AgentResult,
): Promise<ProposalPresentationLabels> {
  const labels = emptyProposalPresentationLabels();
  if (result.type !== "PROPOSAL_UPDATED" || !result.payload) return labels;

  const payload = result.payload;
  if (typeof payload !== "object") return labels;
  const categoryId =
    "expense" in payload && payload.expense
      ? payload.expense.categoryId
      : "income" in payload && payload.income
        ? payload.income.categoryId
        : null;
  const memberId =
    "expense" in payload && payload.expense
      ? payload.expense.paidByMemberId
      : "income" in payload && payload.income
        ? payload.income.memberId
        : null;
  const [categories, members] = await Promise.all([
    categoryId
      ? getCategoriesTool(context).catch(() => [])
      : Promise.resolve([]),
    memberId
      ? listHouseholdMembers({ householdId: context.householdId }).catch(
          () => [],
        )
      : Promise.resolve([]),
  ]);
  categories.forEach((category) =>
    labels.categories.set(category.id, category.name),
  );
  members.forEach((member) =>
    labels.members.set(member.id, member.displayName),
  );
  return labels;
}

function renderAgentResult(
  result: AgentResult,
  labels = emptyProposalPresentationLabels(),
): string {
  switch (result.type) {
    case "PROPOSAL_CREATED":
      return 'Propuesta creada. Responde "sí" para confirmar o "no" para rechazar.';
    case "PROPOSAL_UPDATED":
      return renderUpdatedProposal(result, labels);
    case "CONFIRMED":
      return "Operación confirmada.";
    case "REJECTED":
      return "Operación rechazada.";
    case "CLARIFICATION_REQUIRED":
      return result.message || "Necesito más información para continuar.";
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
        return renderWhatsAppExpenses(data);
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
  if (!householdId || !UUID_PATTERN.test(householdId)) {
    throw contextUnavailable();
  }

  let memberId: string | null;
  try {
    memberId = await findWhatsAppMember(householdId, message.sender);
  } catch {
    throw contextUnavailable();
  }
  if (!memberId) {
    throw contextUnavailable();
  }

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

  let labels = emptyProposalPresentationLabels();
  if (result.type === "PROPOSAL_UPDATED") {
    try {
      labels = await loadProposalPresentationLabels(context, result);
    } catch {
      labels = emptyProposalPresentationLabels();
    }
  }

  try {
    await sendWhatsAppText(message.sender, renderAgentResult(result, labels));
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
