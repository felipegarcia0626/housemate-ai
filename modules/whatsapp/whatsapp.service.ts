import { createHash, randomUUID } from "node:crypto";
import {
  extractWhatsAppTextMessage,
  sendWhatsAppText,
  type WhatsAppTextMessage,
} from "@/infrastructure/whatsapp/whatsapp.adapter";
import { processAgentMessage } from "@/modules/agent/conversation.service";
import {
  copMoneyToCents,
  formatCopCents,
  formatCopMoney,
  proposalCategoryLine,
} from "@/modules/agent/agent-presentation";
import { findActiveProposalId } from "@/modules/agent/agent.service";
import { getActiveAgentDraft } from "@/modules/agent/category-draft.service";
import { findPendingProposalForConversation } from "@/modules/agent/pending-proposal.repository";
import { findSelectableHouseholdsByUserId } from "@/modules/context/authenticated-context.repository";
import type { PersistenceDiagnosticContext } from "@/infrastructure/database/persistence-diagnostic";
import { getCategoriesTool } from "@/modules/agent/tools/get-categories.tool";
import { listHouseholdMembers } from "@/modules/household-members/household-member.service";
import type { AgentReadResult } from "@/modules/agent/agent.types";
import type { BalanceResult } from "@/modules/expenses/balance.types";
import type { Category } from "@/modules/categories/category.types";
import type { IncomeListResult } from "@/modules/incomes/income.types";
import type { SharingRule } from "@/modules/sharing-rules/sharing-rule.types";
import type { ExpenseListItem } from "@/modules/expenses/expense.types";
import {
  findWhatsAppUserId,
  reserveWhatsAppEvent,
  WhatsAppRepositoryError,
} from "./whatsapp.repository";
import {
  acquireWhatsAppLease,
  assertWhatsAppActiveContext,
  assertWhatsAppLeaseCurrent,
  readWhatsAppHouseholdContext,
  releaseWhatsAppLease,
  renewWhatsAppLease,
  transitionWhatsAppHouseholdContext,
  WhatsAppHouseholdRepositoryError,
  type WhatsAppHouseholdContextRecord,
  type WhatsAppLease,
} from "./whatsapp-household.repository";
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

  const totalCents = data.reduce(
    (sum, expense) => sum + copMoneyToCents(expense.totalAmount),
    BigInt(0),
  );
  const lines = data.map(
    (expense, index) =>
      `${index + 1}. ${expense.merchant ?? "Gasto"} — ${formatCopMoney(expense.totalAmount)} — ${formatWhatsAppDate(expense.expenseDate)} — ${expense.category?.name ?? "Sin categoría"}`,
  );

  return [
    `Encontré ${data.length} ${data.length === 1 ? "gasto" : "gastos"}:`,
    ...lines,
    `Total: ${formatCopCents(totalCents)}`,
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
      lines.push(`Monto: ${formatCopMoney(expense.totalAmount)}`);
    if (expense.expenseDate?.trim())
      lines.push(`Fecha: ${formatWhatsAppDate(expense.expenseDate)}`);
    if (expense.description?.trim())
      lines.push(`Descripción: ${expense.description.trim()}`);
    const categoryName = expense.categoryId
      ? labels.categories.get(expense.categoryId)
      : undefined;
    const categoryLine = proposalCategoryLine(
      expense.categoryId,
      categoryName,
    );
    if (categoryLine) lines.push(categoryLine);
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
      lines.push(`Monto: ${formatCopMoney(income.amount)}`);
    if (income.incomeDate?.trim())
      lines.push(`Fecha: ${formatWhatsAppDate(income.incomeDate)}`);
    if (income.description?.trim())
      lines.push(`Descripción: ${income.description.trim()}`);
    const categoryName = income.categoryId
      ? labels.categories.get(income.categoryId)
      : undefined;
    const categoryLine = proposalCategoryLine(
      income.categoryId,
      categoryName,
    );
    if (categoryLine) lines.push(categoryLine);
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
    lines.push(`💰 Monto: ${formatCopMoney(expense.totalAmount)}`);
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
    const categoryLine = proposalCategoryLine(
      expense.categoryId,
      expense.categoryPath,
    );
    if (categoryLine) lines.push(`📂 ${categoryLine}`);
  } else if (!isExpense && "income" in payload && payload.income) {
    const income = payload.income;
    lines.push(`💰 Monto: ${formatCopMoney(income.amount)}`);
    lines.push(`📅 Fecha: ${formatWhatsAppDate(income.incomeDate)}`);
    if (income.description?.trim())
      lines.push(`📝 Descripción: ${income.description.trim()}`);
    const categoryLine = proposalCategoryLine(
      income.categoryId,
      income.categoryPath,
    );
    if (categoryLine) lines.push(`📂 ${categoryLine}`);
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
      if (result.operation === "GET_PERIOD_FINANCIAL_SUMMARY") {
        return result.message ?? "No pude completar la consulta del período.";
      }
      if (result.operation === "GET_PERIOD_EXPENSE_CATEGORY_SUMMARY") {
        return result.message ?? "No pude completar la consulta por categoría.";
      }
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
        return `Ingresos encontrados: ${data.incomes.length}. Total: ${formatCopMoney(data.summary.totalIncome)}.`;
      }
      if (result.operation === "GET_EXPENSES") {
        const data = (result as AgentReadResult).data as ExpenseListItem[];
        return renderWhatsAppExpenses(data);
      }
      if (result.operation === "GET_BALANCE") {
        const data = (result as AgentReadResult).data as BalanceResult;
        if (!Array.isArray(data?.members)) {
          return "No pude mostrar los balances disponibles.";
        }
        if (data.members.length === 0) return "No hay balances para mostrar.";
        return [
          "Balance del hogar:",
          ...data.members.map((member, index) => {
            const memberLabel =
              labels.members.get(member.memberId) ?? `Integrante ${index + 1}`;
            return `• ${memberLabel}: ${formatCopMoney(member.balance)}`;
          }),
        ].join("\n");
      }
      return "Balance consultado correctamente.";
    case "UNSUPPORTED":
      return "No pude interpretar la solicitud.";
    case "ERROR":
      return "No pude procesar la solicitud en este momento.";
  }
}

type SelectableWhatsAppHousehold = Awaited<
  ReturnType<typeof findSelectableHouseholdsByUserId>
>[number];

function normalizedWhatsAppCommand(text: string): string {
  return text
    .trim()
    .toLocaleLowerCase("es-CO")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.!¡?¿]+$/g, "")
    .trim();
}

function isShowHouseholdsCommand(text: string): boolean {
  return new Set(["ver hogares", "ver mis hogares", "mis hogares"]).has(
    normalizedWhatsAppCommand(text),
  );
}

function isChangeHouseholdCommand(text: string): boolean {
  return new Set(["cambiar hogar", "cambiar de hogar", "cambiar el hogar"]).has(
    normalizedWhatsAppCommand(text),
  );
}

function isCancelCommand(text: string): boolean {
  return new Set(["cancelar", "cancela", "cancelar seleccion"]).has(
    normalizedWhatsAppCommand(text),
  );
}

function numericOption(text: string): number | null {
  const normalized = normalizedWhatsAppCommand(text);
  return /^\d{1,2}$/.test(normalized) ? Number(normalized) : null;
}

function renderHouseholdOptions(
  households: SelectableWhatsAppHousehold[],
  selectedHouseholdId: string | null,
): string {
  return [
    "Selecciona un hogar activo:",
    ...households.map(
      (household, index) =>
        `${index + 1}. ${household.householdName}${household.householdId === selectedHouseholdId ? " (actual)" : ""}`,
    ),
    "La selección vence en 30 minutos. Responde con el número o escribe “Cancelar”.",
  ].join("\n");
}

function renderHouseholdList(
  households: SelectableWhatsAppHousehold[],
  selectedHouseholdId: string | null,
): string {
  if (households.length === 0) return "No tienes hogares activos disponibles.";
  return [
    "Tus hogares activos:",
    ...households.map(
      (household, index) =>
        `${index + 1}. ${household.householdName}${household.householdId === selectedHouseholdId ? " (actual)" : ""}`,
    ),
    "Para cambiar, escribe “Cambiar hogar”.",
  ].join("\n");
}

function findActiveHousehold(
  households: SelectableWhatsAppHousehold[],
  householdId: string | null,
  memberId: string | null,
): SelectableWhatsAppHousehold | null {
  if (!householdId || !memberId) return null;
  return (
    households.find(
      (household) =>
        household.householdId === householdId && household.memberId === memberId,
    ) ?? null
  );
}

function isCurrentMenu(
  state: WhatsAppHouseholdContextRecord,
  phoneNumberId: string,
): boolean {
  return Boolean(
    state.menuHouseholdIds &&
      state.menuPhoneNumberId === phoneNumberId &&
      state.menuExpiresAt &&
      Date.parse(state.menuExpiresAt) > Date.now(),
  );
}

function createAgentContext(
  message: WhatsAppTextMessage,
  household: SelectableWhatsAppHousehold,
  lease: WhatsAppLease,
): WhatsAppContext {
  return {
    householdId: household.householdId,
    actorMemberId: household.memberId,
    conversationKey: `whatsapp:${message.phoneNumberId}:${message.sender}`,
    source: "WHATSAPP",
    whatsappExecution: {
      userId: lease.userId,
      leaseId: lease.leaseId,
      epoch: lease.epoch,
      assertCurrent: () =>
        assertWhatsAppActiveContext(lease, household.householdId, household.memberId),
    },
  };
}

async function sendWhatsAppReply(message: WhatsAppTextMessage, text: string) {
  try {
    await sendWhatsAppText(message.sender, text);
  } catch {
    throw new WhatsAppDomainError(
      "PROVIDER_ERROR",
      "WhatsApp response could not be sent.",
    );
  }
}

async function createHouseholdMenu(
  lease: WhatsAppLease,
  message: WhatsAppTextMessage,
  households: SelectableWhatsAppHousehold[],
  selectedHouseholdId: string | null,
): Promise<void> {
  const status = await transitionWhatsAppHouseholdContext(
    lease,
    message.phoneNumberId,
    {
      action: "OPEN_MENU",
      phoneNumberId: message.phoneNumberId,
      householdIds: households.map((household) => household.householdId),
    },
  );
  if (status.status !== "MENU_OPENED") throw persistenceError();
  await sendWhatsAppReply(
    message,
    renderHouseholdOptions(households, selectedHouseholdId),
  );
}

async function hasBlockingAgentWork(context: WhatsAppContext): Promise<boolean> {
  try {
    const [draft, proposal] = await Promise.all([
      getActiveAgentDraft(context),
      findPendingProposalForConversation(
        context.householdId,
        context.conversationKey,
        context.actorMemberId,
        "WHATSAPP",
      ),
    ]);
    return Boolean(draft || proposal);
  } catch {
    throw persistenceError();
  }
}

async function answerSelectionMessage(
  message: WhatsAppTextMessage,
  lease: WhatsAppLease,
  households: SelectableWhatsAppHousehold[],
  state: WhatsAppHouseholdContextRecord,
): Promise<boolean> {
  const text = message.text;
  const activeSelected = findActiveHousehold(
    households,
    state.selectedHouseholdId,
    state.selectedMemberId,
  );

  if (isShowHouseholdsCommand(text)) {
    await sendWhatsAppReply(
      message,
      renderHouseholdList(households, activeSelected?.householdId ?? null),
    );
    return true;
  }

  const option = numericOption(text);
  if (option !== null) {
    const transition = await transitionWhatsAppHouseholdContext(
      lease,
      message.phoneNumberId,
      { action: "CHOOSE_OPTION", phoneNumberId: message.phoneNumberId, optionNumber: option },
    );
    if (transition.status === "SELECTED") {
      const chosen = findActiveHousehold(
        households,
        transition.householdId ?? null,
        transition.memberId ?? null,
      );
      if (!chosen) throw persistenceError();
      await sendWhatsAppReply(
        message,
        `Hogar activo: ${chosen.householdName}. Envíame tu consulta o solicitud.`,
      );
      return true;
    }
    if (transition.status === "MENU_EXPIRED") {
      if (households.length > 1) {
        await createHouseholdMenu(
          lease,
          message,
          households,
          activeSelected?.householdId ?? null,
        );
      } else if (households.length === 1) {
        const only = households[0];
        const saved = await transitionWhatsAppHouseholdContext(
          lease,
          message.phoneNumberId,
          { action: "SET_SELECTION", householdId: only.householdId, memberId: only.memberId },
        );
        if (saved.status !== "SELECTED") throw persistenceError();
        await sendWhatsAppReply(
          message,
          `La selección anterior venció. Tu único hogar activo, ${only.householdName}, quedó seleccionado.`,
        );
      } else {
        await sendWhatsAppReply(message, "No tienes hogares activos disponibles.");
      }
      return true;
    }
    if (transition.status === "MEMBERSHIP_UNAVAILABLE") {
      await transitionWhatsAppHouseholdContext(lease, message.phoneNumberId, {
        action: "CLEAR_SELECTION",
      });
      if (households.length > 1) {
        await createHouseholdMenu(lease, message, households, null);
      } else if (households.length === 1) {
        const only = households[0];
        const saved = await transitionWhatsAppHouseholdContext(
          lease,
          message.phoneNumberId,
          { action: "SET_SELECTION", householdId: only.householdId, memberId: only.memberId },
        );
        if (saved.status !== "SELECTED") throw persistenceError();
        await sendWhatsAppReply(message, `Hogar activo: ${only.householdName}.`);
      } else {
        await sendWhatsAppReply(message, "No tienes hogares activos disponibles.");
      }
      return true;
    }
    await sendWhatsAppReply(
      message,
      transition.status === "NO_CURRENT_MENU"
        ? 'No hay una selección pendiente. Escribe “Cambiar hogar” para abrir el menú.'
        : 'Esa opción no está disponible. Escribe “Cambiar hogar” para ver las opciones actuales.',
    );
    return true;
  }

  if (isCancelCommand(text) && state.menuHouseholdIds) {
    if (state.menuPhoneNumberId !== message.phoneNumberId) {
      await sendWhatsAppReply(message, "No hay una selección pendiente en este chat.");
      return true;
    }
    await transitionWhatsAppHouseholdContext(lease, message.phoneNumberId, {
      action: "CANCEL_MENU",
    });
    await sendWhatsAppReply(message, "Selección cancelada. El hogar activo no cambió.");
    return true;
  }

  if (isChangeHouseholdCommand(text)) {
    if (households.length === 0) {
      await sendWhatsAppReply(message, "No tienes hogares activos disponibles.");
      return true;
    }
    if (households.length === 1) {
      const only = households[0];
      if (!activeSelected) {
        const saved = await transitionWhatsAppHouseholdContext(
          lease,
          message.phoneNumberId,
          { action: "SET_SELECTION", householdId: only.householdId, memberId: only.memberId },
        );
        if (saved.status !== "SELECTED") throw persistenceError();
      }
      await sendWhatsAppReply(message, `Solo tienes un hogar activo: ${only.householdName}.`);
      return true;
    }
    if (activeSelected) {
      const context = createAgentContext(message, activeSelected, lease);
      if (await hasBlockingAgentWork(context)) {
        await sendWhatsAppReply(
          message,
          "Hay un borrador o propuesta pendiente en el hogar actual. Continúala, confírmala, recházala o cancélala antes de cambiar de hogar.",
        );
        return true;
      }
    }
    await createHouseholdMenu(
      lease,
      message,
      households,
      activeSelected?.householdId ?? null,
    );
    return true;
  }

  if (isCancelCommand(text) && state.menuPhoneNumberId === message.phoneNumberId) {
    await transitionWhatsAppHouseholdContext(lease, message.phoneNumberId, {
      action: "CANCEL_MENU",
    });
    await sendWhatsAppReply(message, "Selección cancelada. El hogar activo no cambió.");
    return true;
  }

  if (isCurrentMenu(state, message.phoneNumberId)) {
    await sendWhatsAppReply(
      message,
      'Hay una selección de hogar en curso. Responde con una opción numérica o escribe “Cancelar”.',
    );
    return true;
  }
  if (state.menuHouseholdIds && state.menuExpiresAt && Date.parse(state.menuExpiresAt) <= Date.now()) {
    await transitionWhatsAppHouseholdContext(lease, message.phoneNumberId, {
      action: "CANCEL_MENU",
    });
  }

  if (households.length === 0) {
    await transitionWhatsAppHouseholdContext(lease, message.phoneNumberId, {
      action: "CLEAR_SELECTION",
    });
    await sendWhatsAppReply(message, "No tienes hogares activos disponibles. Solicita acceso a un hogar para continuar.");
    return true;
  }

  if (activeSelected) return false;
  if (households.length === 1) {
    const only = households[0];
    const saved = await transitionWhatsAppHouseholdContext(
      lease,
      message.phoneNumberId,
      { action: "SET_SELECTION", householdId: only.householdId, memberId: only.memberId },
    );
    if (saved.status !== "SELECTED") throw persistenceError();
    state.selectedHouseholdId = only.householdId;
    state.selectedMemberId = only.memberId;
    return false;
  }

  await transitionWhatsAppHouseholdContext(lease, message.phoneNumberId, {
    action: "CLEAR_SELECTION",
  });
  await createHouseholdMenu(lease, message, households, null);
  return true;
}

async function processWithSelectedHousehold(
  message: WhatsAppTextMessage,
  household: SelectableWhatsAppHousehold,
  lease: WhatsAppLease,
): Promise<void> {
  const context = createAgentContext(message, household, lease);
  await context.whatsappExecution.assertCurrent();
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

  await context.whatsappExecution.assertCurrent();
  let labels = emptyProposalPresentationLabels();
  if (result.type === "PROPOSAL_UPDATED" || result.type === "PROPOSAL_CREATED") {
    try {
      labels = await loadProposalPresentationLabels(context, result);
    } catch {
      labels = emptyProposalPresentationLabels();
    }
  }
  await context.whatsappExecution.assertCurrent();
  await sendWhatsAppReply(message, renderAgentResult(result, labels));
}

export async function processWhatsAppTextMessage(
  message: WhatsAppTextMessage,
): Promise<WhatsAppProcessResult> {
  let userId: string | null;
  try {
    userId = await findWhatsAppUserId(message.sender);
  } catch {
    throw contextUnavailable();
  }
  if (!userId) throw contextUnavailable();

  const leaseId = randomUUID();
  let lease: WhatsAppLease | null;
  try {
    lease = await acquireWhatsAppLease(userId, leaseId);
  } catch {
    throw persistenceError();
  }
  if (!lease) {
    throw new WhatsAppDomainError(
      "PROCESSING_BUSY",
      "Another WhatsApp message is still being processed.",
    );
  }

  let leaseLost = false;
  const heartbeat = setInterval(() => {
    void renewWhatsAppLease(lease as WhatsAppLease).then((renewed) => {
      if (!renewed) leaseLost = true;
    }).catch(() => {
      leaseLost = true;
    });
  }, 30_000);
  heartbeat.unref?.();
  const assertCurrent = async () => {
    if (leaseLost) throw new WhatsAppHouseholdRepositoryError(new Error("Lease renewal failed"));
    await assertWhatsAppLeaseCurrent(lease as WhatsAppLease);
  };

  try {
    await assertCurrent();
    let reserved: boolean;
    try {
      reserved = await reserveWhatsAppEvent(message.eventId);
    } catch (error) {
      if (error instanceof WhatsAppRepositoryError) throw persistenceError();
      throw persistenceError();
    }
    if (!reserved) return { status: "DUPLICATE" };

    let households: SelectableWhatsAppHousehold[];
    let state: WhatsAppHouseholdContextRecord;
    try {
      [households, state] = await Promise.all([
        findSelectableHouseholdsByUserId(userId),
        readWhatsAppHouseholdContext(userId),
      ]);
    } catch {
      throw persistenceError();
    }

    const intercepted = await answerSelectionMessage(
      message,
      lease,
      households,
      state,
    );
    if (intercepted) return { status: "PROCESSED" };

    const activeSelected = findActiveHousehold(
      households,
      state.selectedHouseholdId,
      state.selectedMemberId,
    );
    if (!activeSelected) {
      throw new WhatsAppDomainError(
        "CONTEXT_UNAVAILABLE",
        "The active WhatsApp household is unavailable.",
      );
    }

    await processWithSelectedHousehold(message, activeSelected, {
      ...lease,
    });
    return { status: "PROCESSED" };
  } finally {
    clearInterval(heartbeat);
    try {
      await releaseWhatsAppLease(lease);
    } catch {
      // The lease expires automatically if a best-effort release fails.
    }
  }
}

export function parseWhatsAppPayload(
  payload: unknown,
): WhatsAppTextMessage | null {
  return extractWhatsAppTextMessage(payload);
}
