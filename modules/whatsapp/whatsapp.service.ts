import { createHash } from "node:crypto";
import {
  extractWhatsAppTextMessage,
  sendWhatsAppText,
  type WhatsAppTextMessage,
} from "@/infrastructure/whatsapp/whatsapp.adapter";
import { processAgentMessage } from "@/modules/agent/conversation.service";
import { findActiveProposalId } from "@/modules/agent/agent.service";
import type { PersistenceDiagnosticContext } from "@/infrastructure/database/persistence-diagnostic";
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

function safeDiagnosticCode(error: unknown): string | null {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    typeof (error as { code?: unknown }).code !== "string"
  ) {
    return null;
  }

  const code = (error as { code: string }).code;
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : null;
}

function safeDiagnosticErrorType(error: unknown): string {
  const type =
    error instanceof Error && error.constructor.name
      ? error.constructor.name
      : typeof error;
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(type) ? type : "UnknownError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPersistenceDiagnosticContext(
  value: unknown,
): value is PersistenceDiagnosticContext {
  if (!isRecord(value)) return false;
  return (
    typeof value.repository === "string" &&
    /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value.repository) &&
    typeof value.operation === "string" &&
    /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value.operation) &&
    value.database === "supabase" &&
    typeof value.tableOrRpc === "string" &&
    /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(value.tableOrRpc)
  );
}

function findPersistenceDiagnostic(
  error: unknown,
): PersistenceDiagnosticContext | null {
  const visited = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 5 && isRecord(current); depth += 1) {
    if (visited.has(current)) return null;
    visited.add(current);
    if (isPersistenceDiagnosticContext(current.persistenceDiagnostic)) {
      return current.persistenceDiagnostic;
    }
    current = current.cause;
  }
  return null;
}

function findPersistenceCause(error: unknown): Record<string, unknown> | null {
  const visited = new Set<unknown>();
  let current: unknown = error;
  let fallback: Record<string, unknown> | null = null;
  for (let depth = 0; depth < 5 && isRecord(current); depth += 1) {
    if (visited.has(current)) return fallback;
    visited.add(current);
    if (
      fallback === null &&
      (typeof current.details === "string" || typeof current.hint === "string")
    ) {
      fallback = current;
    }
    const code = current.code;
    if (
      typeof code === "string" &&
      (/^\d{5}$/.test(code) ||
        (/^[A-Z][A-Z0-9_]{0,63}$/.test(code) &&
          !["PERSISTENCE", "PERSISTENCE_ERROR", "CONFLICT"].includes(code)))
    ) {
      return current;
    }
    current = current.cause;
  }
  return fallback;
}

function classifyDiagnosticText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "not_present";
  const normalized = value.toLowerCase();
  if (/duplicate|unique|already exists/.test(normalized)) return "duplicate_key";
  if (/foreign key|referential|violates.*constraint.*foreign/.test(normalized)) {
    return "foreign_key";
  }
  if (/not-null|not null|missing required/.test(normalized)) return "not_null";
  if (/check constraint|check violation|violates.*check/.test(normalized)) {
    return "check_violation";
  }
  if (/permission|not authorized|row-level security|rls/.test(normalized)) {
    return "permission_denied";
  }
  if (/undefined table|relation .* does not exist/.test(normalized)) {
    return "undefined_table";
  }
  if (/undefined column|column .* does not exist/.test(normalized)) {
    return "undefined_column";
  }
  if (/serialization|could not serialize/.test(normalized)) {
    return "serialization_failure";
  }
  if (/deadlock/.test(normalized)) return "deadlock";
  if (/stale|version conflict|updated_at/.test(normalized)) return "stale_cas";
  return "unknown_persistence_error";
}

function safePersistenceErrorCode(error: Record<string, unknown> | null): string {
  if (!error || typeof error.code !== "string") {
    return "unknown_persistence_error";
  }
  return /^\d{5}$/.test(error.code) || /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    ? error.code
    : "unknown_persistence_error";
}

function logAgentProcessingDiagnostic(
  error: unknown,
  eventId: string,
): void {
  const diagnostic: Record<string, string> = {
    stage: "agent_processing",
    errorType: safeDiagnosticErrorType(error),
    eventCorrelationId: createHash("sha256")
      .update(eventId, "utf8")
      .digest("hex")
      .slice(0, 16),
  };
  const code = safeDiagnosticCode(error);
  const persistence = findPersistenceDiagnostic(error);
  if (persistence) {
    const persistenceCause = findPersistenceCause(error);
    diagnostic.errorCode = safePersistenceErrorCode(persistenceCause);
    diagnostic.errorDetailsCode = classifyDiagnosticText(
      persistenceCause?.details,
    );
    diagnostic.errorHintCode = classifyDiagnosticText(persistenceCause?.hint);
    diagnostic.repository = persistence.repository;
    diagnostic.operation = persistence.operation;
    diagnostic.database = persistence.database;
    diagnostic.tableOrRpc = persistence.tableOrRpc;
  } else if (code) {
    diagnostic.errorCode = code;
  }
  console.info("[whatsapp-agent-diagnostic]", diagnostic);
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

function renderExpenseSplits(
  splits: Array<{ householdMemberId: string; percentage: number }> | undefined,
  labels: ProposalPresentationLabels,
): string[] {
  if (!splits || splits.length === 0) return [];
  const lines = ["Reparto:"];
  for (const split of splits) {
    const memberName = labels.members.get(split.householdMemberId);
    if (memberName) lines.push(`- ${memberName}: ${split.percentage.toFixed(2)}%`);
  }
  return lines.length > 1 ? lines : [];
}

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
    lines.push(...renderExpenseSplits(expense.splits, labels));
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
  if (
    (result.type !== "PROPOSAL_UPDATED" && result.type !== "PROPOSAL_CREATED") ||
    !result.payload
  )
    return labels;

  const payload = result.payload;
  if (typeof payload !== "object") return labels;
  const categoryId =
    "expense" in payload && payload.expense
      ? payload.expense.categoryId
      : "income" in payload && payload.income
        ? payload.income.categoryId
        : null;
  const memberIds =
    "expense" in payload && payload.expense
      ? [
          payload.expense.paidByMemberId,
          ...(payload.expense.splits ?? []).map((split) => split.householdMemberId),
        ]
      : "income" in payload && payload.income
        ? [payload.income.memberId]
        : [];
  const uniqueMemberIds = [...new Set(memberIds.filter(Boolean))];
  const [categories, members] = await Promise.all([
    result.type === "PROPOSAL_UPDATED" && categoryId
      ? getCategoriesTool(context).catch(() => [])
      : Promise.resolve([]),
    uniqueMemberIds.length > 0
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

function renderCreatedProposal(
  result: Extract<AgentResult, { type: "PROPOSAL_CREATED" }>,
  labels: ProposalPresentationLabels,
): string {
  const isExpense = result.operationType === "CREATE_EXPENSE";
  const payload = result.payload;
  const lines = [
    `Voy a guardar este ${isExpense ? "gasto" : "ingreso"}:`,
  ];

  if (isExpense && "expense" in payload && payload.expense) {
    const expense = payload.expense;
    lines.push(`💰 Monto: ${formatWhatsAppMoney(expense.totalAmount)}`);
    lines.push(`📅 Fecha: ${formatWhatsAppDate(expense.expenseDate)}`);
    if (expense.description?.trim())
      lines.push(`📝 Descripción: ${expense.description.trim()}`);
    if (expense.merchant?.trim())
      lines.push(`🏪 Comercio: ${expense.merchant.trim()}`);
    const payerName = expense.paidByMemberId
      ? labels.members.get(expense.paidByMemberId)
      : undefined;
    if (payerName) lines.push(`👤 Pagado por: ${payerName}`);
    lines.push(...renderExpenseSplits(expense.splits, labels));
    if (expense.categoryPath)
      lines.push(`📂 Categoría: ${expense.categoryPath}`);
  } else if (!isExpense && "income" in payload && payload.income) {
    const income = payload.income;
    lines.push(`💰 Monto: ${formatWhatsAppMoney(income.amount)}`);
    lines.push(`📅 Fecha: ${formatWhatsAppDate(income.incomeDate)}`);
    if (income.description?.trim())
      lines.push(`📝 Descripción: ${income.description.trim()}`);
    if (income.categoryPath)
      lines.push(`📂 Categoría: ${income.categoryPath}`);
    const memberName = income.memberId
      ? labels.members.get(income.memberId)
      : undefined;
    if (memberName) lines.push(`👤 Integrante: ${memberName}`);
  } else {
    return 'Propuesta creada. Responde "sí" para confirmar o "no" para rechazar.';
  }

  lines.push('Responde "sí" para confirmar o "no" para rechazar.');
  return lines.join("\n");
}

function renderAgentResult(
  result: AgentResult,
  labels = emptyProposalPresentationLabels(),
): string {
  switch (result.type) {
    case "PROPOSAL_CREATED":
      return renderCreatedProposal(result, labels);
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
  } catch (error) {
    try {
      logAgentProcessingDiagnostic(error, message.eventId);
    } catch {
      // Diagnostic logging must never replace the original Agent failure.
    }
    throw new WhatsAppDomainError(
      "AGENT_ERROR",
      "The Agent could not process the message.",
    );
  }

  let labels = emptyProposalPresentationLabels();
  if (result.type === "PROPOSAL_UPDATED" || result.type === "PROPOSAL_CREATED") {
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
