import { createExpenseTool } from "./tools/create-expense.tool";
import {
  confirmAgentProposal,
  findActiveProposalId,
  findLatestTerminalProposal,
  getTerminalProposalResult,
  rejectAgentProposal,
} from "./agent.service";
import { createIncomeTool } from "./tools/create-income.tool";
import { getExpensesTool } from "./tools/get-expenses.tool";
import { getIncomesTool } from "./tools/get-incomes.tool";
import { getBalanceTool } from "./tools/get-balance.tool";
import { getCategoriesTool } from "./tools/get-categories.tool";
import { getSharingRulesTool } from "./tools/get-sharing-rules.tool";
import { listHouseholdMembers } from "@/modules/household-members/household-member.service";
import {
  createOperationDraft,
  createCategoryDraft,
  deleteAgentDraft,
  deleteCategoryDraft,
  createDetailsDraft,
  getActiveAgentDraft,
  isCategoryDraftRepositoryError,
  updateAgentDraft,
  updateCategoryDraft,
} from "./category-draft.service";
import type {
  AgentDraft,
  AgentCategoryDraft,
  CategoryDraftExpensePayload,
  CategoryDraftIncomePayload,
  AgentOperationDraftPayload,
} from "./category-draft.types";
import type {
  Category,
  CategoryMovementType,
  HierarchicalCategory,
} from "@/modules/categories/category.types";
import type {
  AgentContext,
  AgentMessageInput,
  AgentMessageResult,
  ExpenseProposalInput,
} from "./agent.types";
import { AgentDomainError } from "./agent.types";
import {
  consumePendingIncomeProposal,
  consumePendingProposal,
  findPendingProposalForConversation,
  PendingProposalRepositoryError,
  updatePendingProposalConditionally,
} from "./pending-proposal.repository";
import type { PendingProposal } from "./agent.types";
import {
  interpretExpenseMessage,
  type CorrectionInterpretation,
  type ExpenseInterpretation,
} from "@/infrastructure/openai/openai.adapter";

type Interpreter = (
  message: string,
) => Promise<ExpenseInterpretation | CorrectionInterpretation>;

function isConfirmation(message: string): boolean {
  return /^(?:si|sí|ok|confirmo|confirmar|acepto|yes)(?:\s|$)/i.test(
    message.trim(),
  );
}

function isRejection(message: string): boolean {
  const normalized = normalizeOperationMessage(message);
  if (/^no\s+(?:fueron|eran|fue|era)\b/.test(normalized)) return false;
  return /^(?:no|rechazo|rechazar|cancelar|cancelo)(?:\s|$)/.test(normalized);
}

function looksLikeCorrection(message: string): boolean {
  const normalized = normalizeOperationMessage(message);
  const payerCorrection =
    /^pago\s+(?!(?:\d|de|en|por|para|con|el|la|los|las|un|una|mi|mis)\b)[a-z]+(?:\s+[a-z]+)?(?:\s+\d+(?:[.,]\d+)?)?$/.test(
      normalized,
    );
  return (
    /^(?:no\s*,|no\s+(?:fueron|eran|fue|era)\b|en realidad\b|corrige\b|corregir\b|cambia\b|cambiar\b|actualiza\b|actualizar\b|quiero\s+(?:corregir|cambiar|actualizar)\b|la categoria (?:correcta|debe)\b|la fecha (?:correcta|debe)\b|el monto (?:correcto|debe)\b|la descripcion (?:correcta|debe)\b)/.test(
      normalized,
    ) || /^(?:fueron|eran|fue|era)\b/.test(normalized) || payerCorrection
  );
}

function clarification(
  missingFields: string[],
  message = "Necesito más información para preparar el gasto.",
  options?: Category[],
): AgentMessageResult {
  return {
    type: "CLARIFICATION_REQUIRED",
    missingFields,
    message,
    ...(options ? { options: options.map((category) => ({ name: category.name })) } : {}),
  };
}

function normalizeCategoryName(value: string): string {
  return value
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es");
}

function normalizeOperationMessage(value: string): string {
  return value
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es")
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ");
}

function toIsoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    !Number.isFinite(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

function normalizeDraftDate(value: string | null): string | null {
  if (!value) return null;
  const normalized = normalizeOperationMessage(value);
  const today = new Date();
  if (normalized === "hoy") return today.toISOString().slice(0, 10);
  if (normalized === "ayer") {
    const yesterday = new Date(today);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    return yesterday.toISOString().slice(0, 10);
  }
  const numericMatch = normalized.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (numericMatch) {
    return toIsoDate(
      Number(numericMatch[3]),
      Number(numericMatch[2]),
      Number(numericMatch[1]),
    );
  }
  const isoMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    return toIsoDate(
      Number(isoMatch[1]),
      Number(isoMatch[2]),
      Number(isoMatch[3]),
    );
  }
  const months: Record<string, number> = {
    enero: 0,
    febrero: 1,
    marzo: 2,
    abril: 3,
    mayo: 4,
    junio: 5,
    julio: 6,
    agosto: 7,
    septiembre: 8,
    octubre: 9,
    noviembre: 10,
    diciembre: 11,
  };
  const match = normalized.match(
    /^(\d{1,2}) de ([a-z]+)(?: de (\d{4}))?$/,
  );
  if (!match || !(match[2] in months)) return null;
  const year = match[3] ? Number(match[3]) : today.getUTCFullYear();
  const day = Number(match[1]);
  const month = months[match[2]];
  return toIsoDate(year, month + 1, day);
}

function resolveOperationChoice(
  message: string,
): "CREATE_EXPENSE" | "CREATE_INCOME" | null {
  const normalized = normalizeOperationMessage(message);
  if (/^(?:un )?gasto$/.test(normalized) || normalized === "registrar gasto") {
    return "CREATE_EXPENSE";
  }
  if (
    /^(?:un )?ingreso$/.test(normalized) ||
    normalized === "registrar ingreso"
  ) {
    return "CREATE_INCOME";
  }
  return null;
}

function looksLikeMovementRequest(message: string): boolean {
  const normalized = normalizeOperationMessage(message);
  if (
    /^(?:fecha|date|descripci[oó]n|description|monto|valor|categor[ií]a|category|pagado por|payer)\b/.test(
      normalized,
    )
  ) {
    return false;
  }
  const hasAmount = /\b\d+(?:[.,]\d+)?\b/.test(normalized);
  const hasExpenseSignal =
    /\b(gaste|pague|gasto|gastos|compra|compras|compre|factura|registra|registrar|anota|anotar|apunta|apuntar|agrega|agregar)\b/.test(
      normalized,
    );
  const hasIncomeSignal =
    /\b(recibi|recibir|ingreso|ingresos|salario|sueldo|honorario|honorarios|nomina|bono|entraron|entro)\b/.test(
      normalized,
    );
  return hasAmount && (hasExpenseSignal || hasIncomeSignal);
}

function operationClarification(): AgentMessageResult {
  return clarification(
    ["operation"],
    "¿Quieres registrar un gasto o un ingreso?",
  );
}

function operationDetailsClarification(
  operation: "CREATE_EXPENSE" | "CREATE_INCOME",
  missingFields: string[],
): AgentMessageResult {
  const labels = missingFields.map((field) => {
    if (field === "incomeDate") return "la fecha del ingreso";
    if (field === "expenseDate") return "la fecha del gasto";
    if (field === "description") return "la descripción del ingreso";
    if (field === "amount") return "el monto";
    if (field === "totalAmount") return "el monto";
    if (field === "paidByMemberName") return "qué integrante pagó";
    return field;
  });
  const subject = operation === "CREATE_INCOME" ? "ingreso" : "gasto";
  return clarification(
    missingFields,
    `Necesito ${labels.join(" y ")} para continuar con el ${subject}.`,
  );
}

function operationPayloadFromInterpretation(
  interpretation: Extract<
    ExpenseInterpretation,
    { kind: "AMBIGUOUS_MOVEMENT" }
  >,
): AgentOperationDraftPayload {
  return {
    amount: interpretation.amount ?? null,
    date: normalizeDraftDate(interpretation.date),
    merchant: interpretation.merchant ?? null,
    description: interpretation.description ?? null,
    paidBySelf: interpretation.paidBySelf ?? null,
    paidByMemberName: interpretation.paidByMemberName ?? null,
    categoryName: interpretation.categoryName ?? null,
  };
}

function operationPayloadFromIncomeInterpretation(
  interpretation: Extract<ExpenseInterpretation, { kind: "CREATE_INCOME" }>,
): AgentOperationDraftPayload {
  return {
    amount: interpretation.amount ?? null,
    date: normalizeDraftDate(interpretation.incomeDate),
    merchant: null,
    description: interpretation.description ?? null,
    paidBySelf: null,
    paidByMemberName: null,
    categoryName: interpretation.categoryName ?? null,
  };
}

function operationPayloadFromExpenseInterpretation(
  interpretation: Extract<ExpenseInterpretation, { kind: "CREATE_EXPENSE" }>,
): AgentOperationDraftPayload {
  return {
    amount: interpretation.totalAmount ?? null,
    date: normalizeDraftDate(interpretation.expenseDate),
    merchant: interpretation.merchant ?? null,
    description: interpretation.description ?? null,
    paidBySelf: interpretation.paidBySelf ?? null,
    paidByMemberName: interpretation.paidByMemberName ?? null,
    categoryName: interpretation.categoryName ?? null,
  };
}

function isDraftDateValue(value: string): boolean {
  return /^(?:hoy|ayer|\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2} de [a-záéíóúñ]+(?: de \d{4})?)$/i.test(
    normalizeOperationMessage(value),
  );
}

function isDraftAmountValue(value: string): boolean {
  return /^\$?\s*\d[\d.,]*$/.test(value.trim());
}

function canResolveDraftDetails(
  message: string,
  pendingFields: string[],
): boolean {
  if (!looksLikeMovementRequest(message)) return true;
  const parts = message
    .split(/\s*[,;]\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return false;
  return parts.every((part) => {
    if (
      pendingFields.some(
        (field) => field === "incomeDate" || field === "expenseDate",
      ) && isDraftDateValue(part)
    ) {
      return true;
    }
    if (
      pendingFields.some(
        (field) => field === "amount" || field === "totalAmount",
      ) && isDraftAmountValue(part)
    ) {
      return true;
    }
    return pendingFields.includes("description") && part.length > 0;
  });
}

function toCategoryExpensePayload(
  input: ExpenseProposalInput,
): CategoryDraftExpensePayload["expense"] {
  const payload = {
    ...input,
    categoryId: input.categoryId ?? null,
  } as CategoryDraftExpensePayload["expense"];
  delete payload.splits;
  return payload;
}

function toCategoryIncomePayload(
  input: CategoryDraftIncomePayload["income"] & { memberId: string },
): CategoryDraftIncomePayload["income"] {
  const { memberId, ...payload } = input;
  void memberId;
  return payload;
}

function parseDraftDetails(
  message: string,
  payload: AgentOperationDraftPayload,
  pendingFields: string[],
): AgentOperationDraftPayload {
  const amountMatch = message.match(
    /(?:monto|valor|por)\s*[:=]?\s*\$?\s*([\d.,]+)/i,
  );
  const dateMatch = message.match(
    /(?:fecha|date)\s*[:=]?\s*([^\s,;]+)/i,
  );
  const descriptionMatch = message.match(
    /(?:descripci[oó]n|description)\s*[:=]\s*(.*?)(?=\s+(?:categor[ií]a|category)\s*[:=]|$)/i,
  );
  const categoryMatch = message.match(
    /(?:categor[ií]a|category)\s*[:=]\s*(.+)$/i,
  );
  const payerMatch = message.match(
    /(?:pag[oó]|pagado por|payer)\s*[:=]?\s*(.+)$/i,
  );
  const updatedPayload = {
    ...payload,
    amount: amountMatch?.[1] ?? payload.amount,
    date: dateMatch ? normalizeDraftDate(dateMatch[1]) ?? payload.date : payload.date,
    description: descriptionMatch?.[1]?.trim() ?? payload.description,
    paidByMemberName:
      payerMatch?.[1]?.trim() ?? payload.paidByMemberName,
    categoryName: categoryMatch?.[1]?.trim() ?? payload.categoryName,
  };

  const dateFields = pendingFields.filter(
    (field) => field === "incomeDate" || field === "expenseDate",
  );
  const amountFields = pendingFields.filter(
    (field) => field === "amount" || field === "totalAmount",
  );
  const parts = message
    .split(/\s*[,;]\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  const canCaptureDescription =
    (!looksLikeCorrection(message) && pendingFields.includes("description")) ||
    (!looksLikeCorrection(message) &&
      !payload.description &&
      pendingFields.some(
        (field) => field === "incomeDate" || field === "expenseDate",
      ));

  for (const part of parts) {
    if (dateFields.length > 0 && isDraftDateValue(part)) {
      const date = normalizeDraftDate(part);
      if (date) updatedPayload.date = date;
      continue;
    }
    if (amountFields.length > 0 && isDraftAmountValue(part)) {
      updatedPayload.amount = part.replace(/^\$\s*/, "").trim();
      continue;
    }
    if (
      canCaptureDescription &&
      !descriptionMatch &&
      part
    ) {
      updatedPayload.description = part;
    }
  }

  if (
    pendingFields.length === 1 &&
    !amountMatch &&
    !dateMatch &&
    !descriptionMatch &&
    !payerMatch &&
    !categoryMatch &&
    !looksLikeCorrection(message)
  ) {
    const value = message.trim();
    if (pendingFields[0] === "amount" || pendingFields[0] === "totalAmount") {
      updatedPayload.amount = value;
    } else if (pendingFields[0] === "incomeDate" || pendingFields[0] === "expenseDate") {
      const date = normalizeDraftDate(value);
      if (date) updatedPayload.date = date;
    } else if (pendingFields[0] === "description") {
      updatedPayload.description = value;
    } else if (pendingFields[0] === "paidByMemberName") {
      updatedPayload.paidByMemberName = value;
    }
  }
  return updatedPayload;
}

function resolveCategorySelection(
  message: string,
  categories: HierarchicalCategory[],
): Category | null {
  const normalized = normalizeCategoryName(message);
  const matches = categories.filter(
    (category) =>
      category.level === "MICRO" &&
      normalizeCategoryName(category.name) === normalized,
  );
  return matches.length === 1 ? matches[0] : null;
}

function categoryMovementType(
  operationType: "CREATE_EXPENSE" | "CREATE_INCOME",
): CategoryMovementType {
  return operationType === "CREATE_EXPENSE" ? "EXPENSE" : "INCOME";
}

function resolveMacroSelection(
  message: string,
  categories: HierarchicalCategory[],
): string | null {
  const macros = new Map<string, { name: string; ids: Set<string> }>();
  for (const category of categories) {
    const macro = macros.get(category.macroName);
    if (macro) {
      macro.ids.add(category.macroId);
    } else {
      macros.set(category.macroName, {
        name: category.macroName,
        ids: new Set([category.macroId]),
      });
    }
  }
  const options = [...macros.values()].flatMap(({ name, ids }) =>
    [...ids].map((id) => ({ id, name, isUnique: ids.size === 1 })),
  );
  const numeric = Number.parseInt(message.trim(), 10);
  if (Number.isInteger(numeric) && String(numeric) === message.trim()) {
    return options[numeric - 1]?.id ?? null;
  }
  const normalized = normalizeCategoryName(message);
  const matches = options.filter(
    ({ name, isUnique }) =>
      isUnique && normalizeCategoryName(name) === normalized,
  );
  return matches.length === 1 ? matches[0].id : null;
}

function resolveMicroSelection(
  message: string,
  categories: HierarchicalCategory[],
  macroId: string,
): HierarchicalCategory | null {
  const options = categories.filter((category) => category.macroId === macroId);
  const numeric = Number.parseInt(message.trim(), 10);
  if (Number.isInteger(numeric) && String(numeric) === message.trim()) {
    return options[numeric - 1] ?? null;
  }
  const normalized = normalizeCategoryName(message);
  const matches = options.filter(
    (category) =>
      normalizeCategoryName(category.name) === normalized ||
      normalizeCategoryName(category.path) === normalized,
  );
  return matches.length === 1 ? matches[0] : null;
}

async function categoryClarification(
  context: AgentContext,
  message = "¿En qué categoría lo quieres registrar?",
  movementType: CategoryMovementType,
  selectedMacroId: string | null = null,
  availableCategories?: HierarchicalCategory[],
): Promise<AgentMessageResult> {
  const categories =
    availableCategories ?? (await getCategoriesTool(context, movementType));
  const optionCategories = selectedMacroId
    ? categories
        .filter((category) => category.macroId === selectedMacroId)
        .map((category) => ({
          id: category.id,
          name: category.path,
        }))
    : [
        ...new Map(
          categories.map((category) => [
            category.macroId,
            { id: category.macroId, name: category.macroName },
          ]),
        ).values(),
      ];
  const options = optionCategories
    .map((category) => category.name)
    .map((name, index) => `${index + 1}. ${name}`)
    .join("\n");
  const prompt = selectedMacroId
    ? "Selecciona una categoría específica:"
    : "Selecciona una categoría principal:";
  return clarification(
    ["categoryId"],
    `${message}\n\n${prompt}\n\n${options}`,
    optionCategories,
  );
}

async function persistCategoryDraft(
  context: AgentContext,
  draft: Parameters<typeof createCategoryDraft>[2],
  operationType: "CREATE_EXPENSE" | "CREATE_INCOME",
): Promise<void> {
  try {
    await createCategoryDraft(context, operationType, draft);
  } catch (error) {
    if (isCategoryDraftRepositoryError(error)) {
      throw new AgentDomainError(
        "PERSISTENCE_ERROR",
        "The category clarification could not be persisted.",
      );
    }
    throw error;
  }
}

async function persistOperationDraft(
  context: AgentContext,
  payload: AgentOperationDraftPayload,
): Promise<void> {
  try {
    await createOperationDraft(context, payload);
  } catch (error) {
    if (isCategoryDraftRepositoryError(error)) {
      throw new AgentDomainError(
        "PERSISTENCE_ERROR",
        "The operation clarification could not be persisted.",
      );
    }
    throw error;
  }
}

async function persistDetailsDraft(
  context: AgentContext,
  operationType: "CREATE_EXPENSE" | "CREATE_INCOME",
  payload: AgentOperationDraftPayload,
): Promise<void> {
  try {
    await createDetailsDraft(context, operationType, payload);
  } catch (error) {
    if (isCategoryDraftRepositoryError(error)) {
      throw new AgentDomainError(
        "PERSISTENCE_ERROR",
        "The conversation details could not be persisted.",
      );
    }
    throw error;
  }
}

async function completeCategoryDraft(
  context: AgentContext,
  draft: AgentCategoryDraft,
  category: HierarchicalCategory,
): Promise<AgentMessageResult> {
  if (
    category.level !== "MICRO" ||
    category.movementType !== categoryMovementType(draft.operationType)
  ) {
    return correctionClarification(
      "Selecciona una categoría específica de la operación.",
    );
  }
  try {
    if (draft.operationType === "CREATE_EXPENSE") {
      const payload = draft.payload as CategoryDraftExpensePayload;
      const nextPayload: CategoryDraftExpensePayload = {
        ...payload,
        selectedMacroId: null,
        expense: { ...payload.expense, categoryId: category.id },
      };
      let updatedCategoryDraft: AgentCategoryDraft | null = null;
      if (
        payload.expense.categoryId !== category.id ||
        (payload.selectedMacroId !== null &&
          payload.selectedMacroId !== undefined)
      ) {
        updatedCategoryDraft = await updateCategoryDraft(
          context,
          draft.id,
          nextPayload,
          draft.updatedAt,
        );
      }
      const result = await createExpenseTool(context, {
        ...nextPayload.expense,
        splits: nextPayload.expense.splits ?? [
          { householdMemberId: context.actorMemberId, percentage: 100 },
        ],
      });
      try {
        await deleteCategoryDraft(context, draft.id);
      } catch (error) {
        await compensatePendingProposalAfterDraftFailure(
          context,
          draft.operationType,
          result.proposalId,
        );
        if (updatedCategoryDraft) {
          await updateCategoryDraft(
            context,
            draft.id,
            draft.payload,
            updatedCategoryDraft.updatedAt,
          );
        }
        throw error;
      }
      return { type: "PROPOSAL_CREATED", ...result };
    }
    const payload = draft.payload as CategoryDraftIncomePayload;
    const nextPayload: CategoryDraftIncomePayload = {
      ...payload,
      selectedMacroId: null,
      income: { ...payload.income, categoryId: category.id },
    };
    let updatedCategoryDraft: AgentCategoryDraft | null = null;
    if (
      payload.income.categoryId !== category.id ||
      (payload.selectedMacroId !== null &&
        payload.selectedMacroId !== undefined)
    ) {
      updatedCategoryDraft = await updateCategoryDraft(
        context,
        draft.id,
        nextPayload,
        draft.updatedAt,
      );
    }
    const result = await createIncomeTool(context, {
      ...nextPayload.income,
      memberId: context.actorMemberId,
    });
    try {
      await deleteCategoryDraft(context, draft.id);
    } catch (error) {
      await compensatePendingProposalAfterDraftFailure(
        context,
        draft.operationType,
        result.proposalId,
      );
      if (updatedCategoryDraft) {
        await updateCategoryDraft(
          context,
          draft.id,
          draft.payload,
          updatedCategoryDraft.updatedAt,
        );
      }
      throw error;
    }
    return { type: "PROPOSAL_CREATED", ...result };
  } catch (error) {
    if (error instanceof AgentDomainError) throw error;
    throw new AgentDomainError(
      "PERSISTENCE_ERROR",
      "The category clarification could not be completed.",
    );
  }
}

function toAmount(value: string | null): number | null {
  if (!value || !/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

type IncomeDiagnosticFields = {
  amountPresent?: boolean;
  amountStatus?: "missing" | "normalized" | "invalid";
  datePresent?: boolean;
  dateStatus?: "missing" | "normalized" | "invalid";
  descriptionPresent?: boolean;
  categoryPresent?: boolean;
  missingFields?: string[];
  draftStatus?: AgentDraft["status"];
};

function hasDiagnosticValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  return typeof value === "string" ? value.trim().length > 0 : true;
}

function logIncomeDiagnostic(
  context: AgentContext,
  stage: "normalization" | "missing_fields" | "draft_persisted",
  fields: IncomeDiagnosticFields,
): void {
  try {
    console.info("[agent-income-diagnostic]", {
      stage,
      operation: "CREATE_INCOME",
      source: context.source,
      conversationKeyPresent: Boolean(context.conversationKey.trim()),
      ...fields,
    });
  } catch {
    // Diagnostic logging must never alter conversation behavior.
  }
}

function logIncomeNormalization(
  context: AgentContext,
  amount: string | null,
  normalizedAmount: number | null,
  date: string | null,
  normalizedDate: string | null,
): void {
  logIncomeDiagnostic(context, "normalization", {
    amountStatus:
      !hasDiagnosticValue(amount)
        ? "missing"
        : normalizedAmount === null
          ? "invalid"
          : "normalized",
    dateStatus:
      !hasDiagnosticValue(date)
        ? "missing"
        : normalizedDate === null
          ? "invalid"
          : "normalized",
  });
}

function logIncomeDraft(
  context: AgentContext,
  status: AgentDraft["status"],
  fields: {
    amount?: unknown;
    date?: unknown;
    incomeDate?: unknown;
    description?: unknown;
    categoryName?: unknown;
    categoryId?: unknown;
  },
): void {
  logIncomeDiagnostic(context, "draft_persisted", {
    draftStatus: status,
    amountPresent: hasDiagnosticValue(fields.amount),
    datePresent: hasDiagnosticValue(fields.date ?? fields.incomeDate),
    descriptionPresent: hasDiagnosticValue(fields.description),
    categoryPresent: hasDiagnosticValue(
      fields.categoryName ?? fields.categoryId,
    ),
  });
}

function normalizeCorrectionDate(value: string): string | null {
  const date = normalizeDraftDate(value);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date
    ? null
    : date;
}

function normalizeMemberName(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es");
}

function correctionClarification(message: string): AgentMessageResult {
  return clarification([], message);
}

async function resolveCorrectionCategory(
  context: AgentContext,
  value: string,
  movementType: CategoryMovementType,
): Promise<{
  category: Category | null;
  macroId: string | null;
  categories: HierarchicalCategory[];
}> {
  const categories = await getCategoriesTool(context, movementType);
  const normalized = normalizeCategoryName(value);
  if (!normalized) {
    return { category: null, macroId: null, categories };
  }
  const matches = categories.filter(
    (category) =>
      category.isActive &&
      category.movementType === movementType &&
      category.level === "MICRO" &&
      (normalizeCategoryName(category.name) === normalized ||
        normalizeCategoryName(category.path) === normalized),
  );
  const macroIds = new Set(
    categories
      .filter(
        (category) =>
          category.isActive &&
          category.movementType === movementType &&
          normalizeCategoryName(category.macroName) === normalized,
      )
      .map((category) => category.macroId),
  );
  return {
    category: matches.length === 1 ? matches[0] : null,
    macroId: macroIds.size === 1 ? [...macroIds][0] : null,
    categories,
  };
}

async function resolveCorrectionPayer(
  context: AgentContext,
  value: string,
): Promise<string | null> {
  const normalized = normalizeMemberName(value);
  if (!normalized) return null;
  let members;
  try {
    members = await listHouseholdMembers({ householdId: context.householdId });
  } catch {
    throw new AgentDomainError(
      "PERSISTENCE_ERROR",
      "Household members could not be resolved.",
    );
  }
  const matches = members.filter(
    (member) => normalizeMemberName(member.displayName) === normalized,
  );
  return matches.length === 1 ? matches[0].id : null;
}

async function applyPendingProposalCorrection(
  context: AgentContext,
  proposal: PendingProposal,
  correction: CorrectionInterpretation,
): Promise<AgentMessageResult> {
  const value = correction.value.trim();
  if (!value) {
    return correctionClarification("Indica un valor para corregir.");
  }

  let payload: PendingProposal["payload"];
  if (proposal.operationType === "CREATE_EXPENSE") {
    const original = proposal.payload;
    const expense = { ...original.expense };
    if (correction.field === "amount") {
      const amount = toAmount(value);
      if (amount === null) {
        return correctionClarification("El monto indicado no es válido.");
      }
      expense.totalAmount = amount;
    } else if (correction.field === "date") {
      const date = normalizeCorrectionDate(value);
      if (!date) {
        return correctionClarification("La fecha indicada no es válida.");
      }
      expense.expenseDate = date;
    } else if (correction.field === "description") {
      expense.description = value;
    } else if (correction.field === "category") {
      const selection = await resolveCorrectionCategory(
        context,
        value,
        "EXPENSE",
      );
      if (!selection.category) {
        if (selection.macroId) {
          return categoryClarification(
            context,
            "Selecciona una categoría específica dentro de esa macro.",
            "EXPENSE",
            selection.macroId,
            selection.categories,
          );
        }
        return correctionClarification(
          "No encontré una categoría única para esa corrección.",
        );
      }
      expense.categoryId = selection.category.id;
    } else if (correction.field === "payer") {
      const payerId = await resolveCorrectionPayer(context, value);
      if (!payerId) {
        return correctionClarification(
          "No encontré un integrante único para esa corrección.",
        );
      }
      expense.paidByMemberId = payerId;
    } else {
      return correctionClarification("No puedo corregir ese campo.");
    }
    payload = { ...original, expense };
  } else {
    const original = proposal.payload;
    const income = { ...original.income };
    if (correction.field === "amount") {
      const amount = toAmount(value);
      if (amount === null) {
        return correctionClarification("El monto indicado no es válido.");
      }
      income.amount = amount;
    } else if (correction.field === "date") {
      const date = normalizeCorrectionDate(value);
      if (!date) {
        return correctionClarification("La fecha indicada no es válida.");
      }
      income.incomeDate = date;
    } else if (correction.field === "description") {
      income.description = value;
    } else if (correction.field === "category") {
      const selection = await resolveCorrectionCategory(
        context,
        value,
        "INCOME",
      );
      if (!selection.category) {
        if (selection.macroId) {
          return categoryClarification(
            context,
            "Selecciona una categoría específica dentro de esa macro.",
            "INCOME",
            selection.macroId,
            selection.categories,
          );
        }
        return correctionClarification(
          "No encontré una categoría única para esa corrección.",
        );
      }
      income.categoryId = selection.category.id;
    } else {
      return correctionClarification(
        "Ese campo no aplica a la corrección de un ingreso.",
      );
    }
    payload = { ...original, income };
  }

  let updated: PendingProposal | null;
  try {
    updated = await updatePendingProposalConditionally({
      id: proposal.id,
      householdId: context.householdId,
      conversationKey: context.conversationKey,
      operationType: proposal.operationType,
      payload,
      expectedUpdatedAt: proposal.updatedAt,
    });
  } catch (error) {
    if (error instanceof PendingProposalRepositoryError) {
      throw new AgentDomainError(
        "PERSISTENCE_ERROR",
        "The pending proposal could not be updated.",
      );
    }
    throw error;
  }
  if (!updated) {
    return correctionClarification(
      "La propuesta ya no está disponible para corregir.",
    );
  }
  if (updated.status !== "AWAITING_CONFIRMATION") {
    return correctionClarification(
      "La propuesta ya no está disponible para corregir.",
    );
  }
  return {
    type: "PROPOSAL_UPDATED",
    proposalId: updated.id,
    operationType: updated.operationType,
    status: updated.status,
    payload: updated.payload,
  };
}

interface ProposalInputResult {
  input: ExpenseProposalInput;
  missingFields: string[];
  clarificationMessage?: string;
}

async function toProposalInput(
  context: AgentContext,
  interpretation: Extract<ExpenseInterpretation, { kind: "CREATE_EXPENSE" }>,
  options: { defaultExpenseDate?: boolean } = {},
): Promise<ProposalInputResult> {
  const totalAmount = toAmount(interpretation.totalAmount);
  const rawExpenseDate = interpretation.expenseDate?.trim() ?? "";
  const normalizedExpenseDate = normalizeDraftDate(rawExpenseDate);
  const expenseDate =
    rawExpenseDate.length > 0
      ? normalizedExpenseDate
      : options.defaultExpenseDate === true
        ? new Date().toISOString().slice(0, 10)
        : null;
  const missingFields: string[] = [];
  if (totalAmount === null) missingFields.push("totalAmount");
  if (!expenseDate) missingFields.push("expenseDate");
  if (missingFields.length > 0) {
    return { input: {} as ExpenseProposalInput, missingFields };
  }

  let paidByMemberId = context.actorMemberId;
  let clarificationMessage: string | undefined;
  const paidByMemberName = interpretation.paidByMemberName?.trim() ?? "";
  if (paidByMemberName) {
    let members;
    try {
      members = await listHouseholdMembers({
        householdId: context.householdId,
      });
    } catch {
      throw new AgentDomainError(
        "PERSISTENCE_ERROR",
        "Household members could not be resolved.",
      );
    }
    const normalizedName = normalizeMemberName(paidByMemberName);
    const matches = members.filter(
      (member) => normalizeMemberName(member.displayName) === normalizedName,
    );
    if (matches.length === 1) {
      paidByMemberId = matches[0].id;
    } else if (matches.length > 1) {
      missingFields.push("paidByMemberName");
      clarificationMessage =
        "Encontré varios integrantes con ese nombre. ¿Cuál de ellos pagó?";
    } else {
      missingFields.push("paidByMemberName");
      clarificationMessage =
        "No encontré ese integrante en el household. ¿Quién pagó?";
    }
  } else if (interpretation.paidBySelf === false) {
    missingFields.push("paidByMemberName");
    clarificationMessage = "¿Qué integrante del household pagó el gasto?";
  }

  if (missingFields.length > 0) {
    return {
      input: {} as ExpenseProposalInput,
      missingFields,
      clarificationMessage,
    };
  }

  return {
    input: {
      paidByMemberId,
      totalAmount: totalAmount as number,
      expenseDate: expenseDate as string,
      merchant: interpretation.merchant,
      description: interpretation.description,
      items: [],
      splits: [{ householdMemberId: context.actorMemberId, percentage: 100 }],
    },
    missingFields,
  };
}

function toIncomeInput(
  context: AgentContext,
  payload: AgentOperationDraftPayload,
): {
  input: {
    memberId: string;
    amount: number;
    incomeDate: string;
    description: string;
    categoryId: null;
  };
  missingFields: string[];
} {
  const amount = toAmount(payload.amount);
  const incomeDate = normalizeDraftDate(payload.date);
  const description = payload.description?.trim() ?? "";
  const missingFields: string[] = [];
  if (amount === null) missingFields.push("amount");
  if (!incomeDate) missingFields.push("incomeDate");
  if (!description) missingFields.push("description");
  return {
    input: {
      memberId: context.actorMemberId,
      amount: amount as number,
      incomeDate: incomeDate as string,
      description,
      categoryId: null,
    },
    missingFields,
  };
}

async function getDraftMissingFields(
  context: AgentContext,
  draft: Extract<AgentDraft, { status: "AWAITING_DETAILS" }>,
): Promise<string[]> {
  const payload = draft.payload as AgentOperationDraftPayload;
  if (draft.operationType === "CREATE_INCOME") {
    return toIncomeInput(context, payload).missingFields;
  }
  return (
    await toProposalInput(context, {
      kind: "CREATE_EXPENSE",
      merchant: payload.merchant,
      description: payload.description,
      totalAmount: payload.amount,
      expenseDate: payload.date,
      paidBySelf: payload.paidBySelf,
      paidByMemberName: payload.paidByMemberName,
      categoryName: payload.categoryName,
    }, { defaultExpenseDate: false })
  ).missingFields;
}

async function updateDraftOrThrow(
  context: AgentContext,
  draft: AgentDraft,
  operationType: AgentDraft["operationType"],
  status: AgentDraft["status"],
  payload: AgentDraft["payload"],
): Promise<AgentDraft> {
  try {
    return await updateAgentDraft(
      context,
      draft,
      operationType,
      status,
      payload,
    );
  } catch (error) {
    if (isCategoryDraftRepositoryError(error)) {
      throw new AgentDomainError(
        "PERSISTENCE_ERROR",
        "The conversation draft could not be updated.",
      );
    }
    throw error;
  }
}

async function deleteDraftOrThrow(
  context: AgentContext,
  draft: AgentDraft,
): Promise<void> {
  try {
    await deleteAgentDraft(context, draft.id);
  } catch (error) {
    if (isCategoryDraftRepositoryError(error)) {
      throw new AgentDomainError(
        "PERSISTENCE_ERROR",
        "The conversation draft could not be completed.",
      );
    }
    throw error;
  }
}

async function compensatePendingProposalAfterDraftFailure(
  context: AgentContext,
  operationType: "CREATE_EXPENSE" | "CREATE_INCOME",
  proposalId: string,
): Promise<void> {
  try {
    if (operationType === "CREATE_EXPENSE") {
      await consumePendingProposal(
        proposalId,
        context.householdId,
        context.conversationKey,
      );
      return;
    }
    await consumePendingIncomeProposal(
      proposalId,
      context.householdId,
      context.conversationKey,
    );
  } catch (error) {
    if (error instanceof PendingProposalRepositoryError) {
      throw new AgentDomainError(
        "PERSISTENCE_ERROR",
        "The pending proposal could not be rolled back after draft cleanup failed.",
      );
    }
    throw error;
  }
}

async function completeOperationDraft(
  context: AgentContext,
  draft: AgentDraft,
  operation: "CREATE_EXPENSE" | "CREATE_INCOME",
  options: { defaultExpenseDate?: boolean } = {},
): Promise<AgentMessageResult> {
  const operationPayload = draft.payload as AgentOperationDraftPayload;
  if (operation === "CREATE_EXPENSE") {
    const proposal = await toProposalInput(context, {
      kind: "CREATE_EXPENSE",
      merchant: operationPayload.merchant,
      description: operationPayload.description,
      totalAmount: operationPayload.amount,
      expenseDate: operationPayload.date,
      paidBySelf: operationPayload.paidBySelf,
      paidByMemberName: operationPayload.paidByMemberName,
      categoryName: operationPayload.categoryName,
    }, {
      defaultExpenseDate: options.defaultExpenseDate === true,
    });
    if (proposal.missingFields.length > 0) {
      await updateDraftOrThrow(
        context,
        draft,
        operation,
        "AWAITING_DETAILS",
        operationPayload,
      );
      return operationDetailsClarification(
        operation,
        proposal.missingFields,
      );
    }
    const categories = await getCategoriesTool(context, "EXPENSE");
    const category = operationPayload.categoryName
      ? resolveCategorySelection(operationPayload.categoryName, categories)
      : null;
    if (!category) {
      const selectedMacroId = operationPayload.categoryName
        ? resolveMacroSelection(operationPayload.categoryName, categories)
        : null;
      await updateDraftOrThrow(
        context,
        draft,
        operation,
        "AWAITING_CATEGORY",
        {
          selectedMacroId,
          expense: toCategoryExpensePayload(proposal.input),
        },
      );
      return categoryClarification(
        context,
        operationPayload.categoryName
          ? "No tengo esa categoría disponible. Elige una de estas opciones:"
          : "Claro. ¿En qué categoría lo quieres registrar?",
        "EXPENSE",
        selectedMacroId,
      );
    }
    const result = await createExpenseTool(context, {
      ...proposal.input,
      categoryId: category.id,
    });
    await deleteDraftOrThrow(context, draft);
    return { type: "PROPOSAL_CREATED", ...result };
  }

  const income = toIncomeInput(context, operationPayload);
  logIncomeNormalization(
    context,
    operationPayload.amount,
    income.input.amount,
    operationPayload.date,
    income.input.incomeDate,
  );
  if (income.missingFields.length > 0) {
    await updateDraftOrThrow(
      context,
      draft,
      operation,
      "AWAITING_DETAILS",
      operationPayload,
    );
    logIncomeDiagnostic(context, "missing_fields", {
      missingFields: income.missingFields,
      draftStatus: "AWAITING_DETAILS",
    });
    logIncomeDraft(context, "AWAITING_DETAILS", operationPayload);
    return operationDetailsClarification(operation, income.missingFields);
  }
  const categories = await getCategoriesTool(context, "INCOME");
  const category = operationPayload.categoryName
    ? resolveCategorySelection(operationPayload.categoryName, categories)
    : null;
  if (!category) {
    const selectedMacroId = operationPayload.categoryName
      ? resolveMacroSelection(operationPayload.categoryName, categories)
      : null;
    await updateDraftOrThrow(
      context,
      draft,
      operation,
      "AWAITING_CATEGORY",
      {
        selectedMacroId,
        income: toCategoryIncomePayload(income.input),
      },
    );
    logIncomeDiagnostic(context, "missing_fields", {
      missingFields: ["categoryId"],
      draftStatus: "AWAITING_CATEGORY",
    });
    logIncomeDraft(context, "AWAITING_CATEGORY", {
      incomeDate: income.input.incomeDate,
      amount: income.input.amount,
      description: income.input.description,
      categoryId: income.input.categoryId,
    });
    return categoryClarification(
      context,
      operationPayload.categoryName
        ? "No tengo esa categoría disponible. Elige una de estas opciones:"
        : "¿En qué categoría quieres registrar el ingreso?",
      "INCOME",
      selectedMacroId,
    );
  }
  const result = await createIncomeTool(context, {
    ...income.input,
    categoryId: category.id,
  });
  await deleteDraftOrThrow(context, draft);
  return { type: "PROPOSAL_CREATED", ...result };
}

export async function processAgentMessage(
  context: AgentContext,
  input: AgentMessageInput,
  interpreter: Interpreter = interpretExpenseMessage,
): Promise<AgentMessageResult> {
  const message = input.message.trim();
  let activeDraft: AgentDraft | null;
  try {
    activeDraft = await getActiveAgentDraft(context);
  } catch (error) {
    if (isCategoryDraftRepositoryError(error)) {
      throw new AgentDomainError(
        "PERSISTENCE_ERROR",
        "The conversation draft could not be loaded.",
      );
    }
    throw error;
  }

  let pendingProposal: PendingProposal | null = null;
  let pendingProposalLoaded = false;
  const getPendingProposalForMessage = async (): Promise<PendingProposal | null> => {
    if (pendingProposalLoaded) return pendingProposal;
    try {
      pendingProposal = await findPendingProposalForConversation(
        context.householdId,
        context.conversationKey,
      );
      pendingProposalLoaded = true;
      return pendingProposal;
    } catch (error) {
      if (error instanceof PendingProposalRepositoryError) {
        throw new AgentDomainError(
          "PERSISTENCE_ERROR",
          "The pending proposal could not be loaded.",
        );
      }
      throw error;
    }
  };

  if (isConfirmation(message)) {
    const proposalId =
      input.proposalId ?? (await findActiveProposalId(context));
    if (proposalId) {
      const result = await confirmAgentProposal(context, proposalId);
      if (activeDraft) await deleteDraftOrThrow(context, activeDraft);
      if (result.status === "REJECTED") {
        return {
          type: "REJECTED",
          ...result,
          message: "La propuesta ya había sido rechazada.",
        };
      }
      return { type: "CONFIRMED", ...result };
    }
    if (activeDraft?.status === "AWAITING_CATEGORY") {
      return categoryClarification(
        context,
        undefined,
        activeDraft.operationType === "CREATE_EXPENSE" ? "EXPENSE" : "INCOME",
      );
    }
    if (activeDraft?.status === "AWAITING_OPERATION") {
      return operationClarification();
    }
    if (activeDraft?.status === "AWAITING_DETAILS") {
      const missingFields = await getDraftMissingFields(context, activeDraft);
      return operationDetailsClarification(
        activeDraft.operationType,
        missingFields,
      );
    }
    const terminalProposal = await findLatestTerminalProposal(context);
    if (terminalProposal) {
      const result = await getTerminalProposalResult(context, terminalProposal);
      if (result.status === "REJECTED") {
        return {
          type: "REJECTED",
          ...result,
          message: "La propuesta ya había sido rechazada.",
        };
      }
      return { type: "CONFIRMED", ...result };
    }
    return clarification(["proposalId"]);
  }
  if (isRejection(message)) {
    const proposalId =
      input.proposalId ?? (await findActiveProposalId(context));
    if (proposalId) {
      const result = await rejectAgentProposal(context, proposalId);
      if (activeDraft) await deleteDraftOrThrow(context, activeDraft);
      return { type: "REJECTED", ...result };
    }
    if (activeDraft) {
      await deleteDraftOrThrow(context, activeDraft);
      return {
        type: "REJECTED",
        proposalId: activeDraft.id,
        status: "REJECTED",
        message: "Operación cancelada.",
      };
    }
    return clarification(["proposalId"]);
  }

  let interpretation: ExpenseInterpretation | CorrectionInterpretation | null =
    null;
  if (looksLikeCorrection(message)) {
    const activePendingProposal = await getPendingProposalForMessage();
    if (activePendingProposal) {
      try {
        interpretation = await interpreter(message);
      } catch (error) {
        if (error instanceof AgentDomainError) throw error;
        return {
          type: "ERROR",
          code: "INTERPRETATION_ERROR",
          message: "No pude interpretar el mensaje.",
        };
      }
      if (interpretation.kind === "CORRECTION") {
        return applyPendingProposalCorrection(
          context,
          activePendingProposal,
          interpretation,
        );
      }
    }
  }

  if (!message)
    return { type: "UNSUPPORTED", message: "No pude interpretar el mensaje." };

  if (activeDraft?.status === "AWAITING_CATEGORY") {
    const categoryDraft = activeDraft as AgentCategoryDraft;
    const categories = await getCategoriesTool(
      context,
      categoryMovementType(categoryDraft.operationType),
    );
    const selectedMacroId = categoryDraft.payload.selectedMacroId ?? null;
    if (!selectedMacroId) {
      const macroId = resolveMacroSelection(message, categories);
      if (macroId) {
        try {
          await updateCategoryDraft(
            context,
            categoryDraft.id,
            { ...categoryDraft.payload, selectedMacroId: macroId },
            categoryDraft.updatedAt,
          );
        } catch (error) {
          if (isCategoryDraftRepositoryError(error)) {
            throw new AgentDomainError(
              "PERSISTENCE_ERROR",
              "The category clarification could not be updated.",
            );
          }
          throw error;
        }
        return categoryClarification(
          context,
          "Ahora elige una categoría específica.",
          categoryMovementType(categoryDraft.operationType),
          macroId,
        );
      }
      try {
        await updateCategoryDraft(
          context,
          categoryDraft.id,
          categoryDraft.payload,
          categoryDraft.updatedAt,
        );
      } catch (error) {
        if (isCategoryDraftRepositoryError(error)) {
          throw new AgentDomainError(
            "PERSISTENCE_ERROR",
            "The category clarification could not be updated.",
          );
        }
        throw error;
      }
      return categoryClarification(
        context,
        "No tengo esa categoría disponible. Elige una de estas opciones:",
        categoryMovementType(categoryDraft.operationType),
      );
    }
    const category = resolveMicroSelection(
      message,
      categories,
      selectedMacroId,
    );
    if (!category) {
      try {
        await updateCategoryDraft(
          context,
          categoryDraft.id,
          categoryDraft.payload,
          categoryDraft.updatedAt,
        );
      } catch (error) {
        if (isCategoryDraftRepositoryError(error)) {
          throw new AgentDomainError(
            "PERSISTENCE_ERROR",
            "The category clarification could not be updated.",
          );
        }
        throw error;
      }
      return categoryClarification(
        context,
        "No tengo esa categoría disponible. Elige una de estas opciones:",
        categoryMovementType(categoryDraft.operationType),
        selectedMacroId,
      );
    }
    return completeCategoryDraft(context, categoryDraft, category);
  }

  if (activeDraft?.status === "AWAITING_OPERATION") {
    const operation = resolveOperationChoice(message);
    if (operation) {
      return completeOperationDraft(context, activeDraft, operation, {
        defaultExpenseDate: true,
      });
    }
    if (looksLikeMovementRequest(message)) {
      return clarification(
        ["operation"],
        'Primero necesito resolver la operación anterior. Responde "gasto", "ingreso" o "cancelar".',
      );
    }
    await updateDraftOrThrow(
      context,
      activeDraft,
      null,
      "AWAITING_OPERATION",
      activeDraft.payload,
    );
    return operationClarification();
  }

  if (activeDraft?.status === "AWAITING_DETAILS") {
    const pendingFields = await getDraftMissingFields(context, activeDraft);
    if (!canResolveDraftDetails(message, pendingFields)) {
      return clarification(
        [],
        'Primero completa la operación anterior. Responde con los datos solicitados o "cancelar".',
      );
    }
    const operationPayload =
      activeDraft.payload as AgentOperationDraftPayload;
    const updatedPayload = parseDraftDetails(
      message,
      operationPayload,
      pendingFields,
    );
    const updatedDraft = await updateDraftOrThrow(
      context,
      activeDraft,
      activeDraft.operationType,
      "AWAITING_DETAILS",
      updatedPayload,
    );
    return completeOperationDraft(
      context,
      updatedDraft,
      activeDraft.operationType,
    );
  }

  if (!interpretation) {
    try {
      interpretation = await interpreter(message);
    } catch (error) {
      if (error instanceof AgentDomainError) throw error;
      return {
        type: "ERROR",
        code: "INTERPRETATION_ERROR",
        message: "No pude interpretar el mensaje.",
      };
    }
  }

  if (interpretation.kind === "CORRECTION") {
    const activePendingProposal = await getPendingProposalForMessage();
    if (activePendingProposal) {
      return applyPendingProposalCorrection(
        context,
        activePendingProposal,
        interpretation,
      );
    }
    return correctionClarification(
      "No hay una propuesta activa para corregir.",
    );
  }

  if (interpretation.kind === "UNSUPPORTED") {
    return {
      type: "UNSUPPORTED",
      message: "No pude interpretarlo como un gasto.",
    };
  }
  if (interpretation.kind === "AMBIGUOUS_MOVEMENT") {
    await persistOperationDraft(
      context,
      operationPayloadFromInterpretation(interpretation),
    );
    return operationClarification();
  }
  if (interpretation.kind === "GET_EXPENSES") {
    return {
      type: "READ_RESULT",
      operation: "GET_EXPENSES",
      data: await getExpensesTool(context, interpretation.filters),
    };
  }
  if (interpretation.kind === "GET_INCOMES") {
    return {
      type: "READ_RESULT",
      operation: "GET_INCOMES",
      data: await getIncomesTool(context, interpretation.filters),
    };
  }
  if (interpretation.kind === "GET_BALANCE") {
    return {
      type: "READ_RESULT",
      operation: "GET_BALANCE",
      data: await getBalanceTool(context),
    };
  }
  if (interpretation.kind === "GET_CATEGORIES") {
    return {
      type: "READ_RESULT",
      operation: "GET_CATEGORIES",
      data: await getCategoriesTool(context),
    };
  }
  if (interpretation.kind === "GET_SHARING_RULES") {
    return {
      type: "READ_RESULT",
      operation: "GET_SHARING_RULES",
      data: await getSharingRulesTool(context),
    };
  }
  if (interpretation.kind === "CREATE_INCOME") {
    const amount = toAmount(interpretation.amount);
    const incomeDate = normalizeDraftDate(interpretation.incomeDate);
    logIncomeNormalization(
      context,
      interpretation.amount,
      amount,
      interpretation.incomeDate,
      incomeDate,
    );
    const missingFields: string[] = [];
    if (amount === null) missingFields.push("amount");
    if (!incomeDate) missingFields.push("incomeDate");
    if (!interpretation.description?.trim()) missingFields.push("description");
    if (missingFields.length > 0) {
      const draftPayload = operationPayloadFromIncomeInterpretation(
        interpretation,
      );
      await persistDetailsDraft(
        context,
        "CREATE_INCOME",
        draftPayload,
      );
      logIncomeDiagnostic(context, "missing_fields", {
        missingFields,
        draftStatus: "AWAITING_DETAILS",
      });
      logIncomeDraft(context, "AWAITING_DETAILS", draftPayload);
      return operationDetailsClarification("CREATE_INCOME", missingFields);
    }
    const incomeInput = {
      memberId: context.actorMemberId,
      amount: amount as number,
      incomeDate: incomeDate as string,
      description: interpretation.description as string,
      categoryId: null,
    };
    const categories = await getCategoriesTool(context, "INCOME");
    const category = interpretation.categoryName
      ? resolveCategorySelection(interpretation.categoryName, categories)
      : null;
    if (!category) {
      const selectedMacroId = interpretation.categoryName
        ? resolveMacroSelection(interpretation.categoryName, categories)
        : null;
      await persistCategoryDraft(
        context,
        {
          selectedMacroId,
          income: toCategoryIncomePayload(incomeInput),
        },
        "CREATE_INCOME",
      );
      logIncomeDiagnostic(context, "missing_fields", {
        missingFields: ["categoryId"],
        draftStatus: "AWAITING_CATEGORY",
      });
      logIncomeDraft(context, "AWAITING_CATEGORY", {
        incomeDate: incomeInput.incomeDate,
        amount: incomeInput.amount,
        description: incomeInput.description,
        categoryId: incomeInput.categoryId,
      });
      return categoryClarification(
        context,
        interpretation.categoryName
          ? "No tengo esa categoría disponible. Elige una de estas opciones:"
          : "¿En qué categoría quieres registrar el ingreso?",
        "INCOME",
        selectedMacroId,
      );
    }
    const result = await createIncomeTool(context, {
      ...incomeInput,
      categoryId: category.id,
    });
    return { type: "PROPOSAL_CREATED", ...result };
  }
  const proposal = await toProposalInput(context, interpretation, {
    defaultExpenseDate: Boolean(interpretation.categoryName),
  });
  if (proposal.missingFields.length > 0) {
    const draftPayload = operationPayloadFromExpenseInterpretation(
      interpretation,
    );
    await persistDetailsDraft(context, "CREATE_EXPENSE", draftPayload);
    return operationDetailsClarification(
      "CREATE_EXPENSE",
      proposal.missingFields,
    );
  }
  const categories = await getCategoriesTool(context, "EXPENSE");
  const category = interpretation.categoryName
    ? resolveCategorySelection(interpretation.categoryName, categories)
    : null;
  if (!category) {
    const selectedMacroId = interpretation.categoryName
      ? resolveMacroSelection(interpretation.categoryName, categories)
      : null;
    await persistCategoryDraft(
      context,
      {
        selectedMacroId,
        expense: toCategoryExpensePayload(proposal.input),
      },
      "CREATE_EXPENSE",
    );
    return categoryClarification(
      context,
      interpretation.categoryName
        ? "No tengo esa categoría disponible. Elige una de estas opciones:"
        : "Claro. ¿En qué categoría lo quieres registrar?",
      "EXPENSE",
      selectedMacroId,
    );
  }
  const result = await createExpenseTool(context, {
    ...proposal.input,
    categoryId: category.id,
  });
  return {
    type: "PROPOSAL_CREATED",
    ...result,
  };
}
