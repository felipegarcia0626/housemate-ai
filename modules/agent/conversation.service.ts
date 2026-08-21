import { createExpenseTool } from "./tools/create-expense.tool";
import {
  confirmAgentProposal,
  findActiveProposalId,
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
import type { Category } from "@/modules/categories/category.types";
import type {
  AgentContext,
  AgentMessageInput,
  AgentMessageResult,
  ExpenseProposalInput,
} from "./agent.types";
import { AgentDomainError } from "./agent.types";
import {
  interpretExpenseMessage,
  type ExpenseInterpretation,
} from "@/infrastructure/openai/openai.adapter";

type Interpreter = (message: string) => Promise<ExpenseInterpretation>;

function isConfirmation(message: string): boolean {
  return /^(?:si|sí|ok|confirmo|confirmar|acepto|yes)(?:\s|$)/i.test(
    message.trim(),
  );
}

function isRejection(message: string): boolean {
  return /^(?:no|rechazo|rechazar|cancelar|cancelo)(?:\s|$)/i.test(
    message.trim(),
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

function normalizeDraftDate(value: string | null): string {
  if (!value) return "";
  const normalized = normalizeOperationMessage(value);
  const today = new Date();
  if (normalized === "hoy") return today.toISOString().slice(0, 10);
  if (normalized === "ayer") {
    const yesterday = new Date(today);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    return yesterday.toISOString().slice(0, 10);
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
  if (!match || !(match[2] in months)) return value.trim();
  const year = match[3] ? Number(match[3]) : today.getUTCFullYear();
  const day = Number(match[1]);
  const month = months[match[2]];
  const date = new Date(Date.UTC(year, month, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day
  ) {
    return value.trim();
  }
  return date.toISOString().slice(0, 10);
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
    amount: interpretation.amount,
    date: interpretation.date,
    merchant: interpretation.merchant,
    description: interpretation.description,
    paidBySelf: interpretation.paidBySelf,
    paidByMemberName: interpretation.paidByMemberName,
    categoryName: interpretation.categoryName,
  };
}

function operationPayloadFromIncomeInterpretation(
  interpretation: Extract<ExpenseInterpretation, { kind: "CREATE_INCOME" }>,
): AgentOperationDraftPayload {
  return {
    amount: interpretation.amount,
    date: interpretation.incomeDate,
    merchant: null,
    description: interpretation.description,
    paidBySelf: null,
    paidByMemberName: null,
    categoryName: interpretation.categoryName,
  };
}

function toCategoryExpensePayload(
  input: ExpenseProposalInput,
): CategoryDraftExpensePayload["expense"] {
  const payload = { ...input } as CategoryDraftExpensePayload["expense"];
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
    /(?:fecha|date)\s*[:=]?\s*(\d{4}-\d{2}-\d{2})/i,
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
    date: dateMatch?.[1] ?? payload.date,
    description: descriptionMatch?.[1]?.trim() ?? payload.description,
    paidByMemberName:
      payerMatch?.[1]?.trim() ?? payload.paidByMemberName,
    categoryName: categoryMatch?.[1]?.trim() ?? payload.categoryName,
  };
  if (pendingFields.includes("incomeDate") && pendingFields.includes("description")) {
    const parts = message
      .split(/\s*[,;]\s*/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length === 2) {
      const date = normalizeDraftDate(parts[0]);
      const normalizedDate = normalizeOperationMessage(parts[0]);
      const isDate =
        normalizedDate === "hoy" ||
        normalizedDate === "ayer" ||
        /^\d{4}-\d{2}-\d{2}$/.test(date);
      if (isDate && parts[1]) {
        updatedPayload.date = date;
        updatedPayload.description = parts[1];
      }
    }
  }
  if (
    pendingFields.length === 1 &&
    !amountMatch &&
    !dateMatch &&
    !descriptionMatch &&
    !payerMatch &&
    !categoryMatch
  ) {
    const value = message.trim();
    if (pendingFields[0] === "amount" || pendingFields[0] === "totalAmount") {
      updatedPayload.amount = value;
    } else if (pendingFields[0] === "incomeDate" || pendingFields[0] === "expenseDate") {
      updatedPayload.date = value;
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
  categories: Category[],
): Category | null {
  const normalized = normalizeCategoryName(message);
  return (
    categories.find(
      (category) => normalizeCategoryName(category.name) === normalized,
    ) ?? null
  );
}

async function categoryClarification(
  context: AgentContext,
  message = "¿En qué categoría lo quieres registrar?",
): Promise<AgentMessageResult> {
  const categories = await getCategoriesTool(context);
  const options = categories
    .map((category) => category.name)
    .map((name, index) => `${index + 1}. ${name}`)
    .join("\n");
  return clarification(
    ["categoryId"],
    `${message}\n\n${options}`,
    categories,
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
  category: Category,
): Promise<AgentMessageResult> {
  try {
    if (draft.operationType === "CREATE_EXPENSE") {
      const payload = draft.payload as CategoryDraftExpensePayload;
      const result = await createExpenseTool(context, {
        ...payload.expense,
        splits: payload.expense.splits ?? [
          { householdMemberId: context.actorMemberId, percentage: 100 },
        ],
        categoryId: category.id,
      });
      await deleteCategoryDraft(context, draft.id);
      return { type: "PROPOSAL_CREATED", ...result };
    }
    const payload = draft.payload as CategoryDraftIncomePayload;
    const result = await createIncomeTool(context, {
      ...payload.income,
      memberId: context.actorMemberId,
      categoryId: category.id,
    });
    await deleteCategoryDraft(context, draft.id);
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

function normalizeMemberName(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es");
}

interface ProposalInputResult {
  input: ExpenseProposalInput;
  missingFields: string[];
  clarificationMessage?: string;
}

async function toProposalInput(
  context: AgentContext,
  interpretation: Extract<ExpenseInterpretation, { kind: "CREATE_EXPENSE" }>,
): Promise<ProposalInputResult> {
  const totalAmount = toAmount(interpretation.totalAmount);
  const expenseDate =
    normalizeDraftDate(interpretation.expenseDate) ||
    new Date().toISOString().slice(0, 10);
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
      expenseDate,
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
      incomeDate,
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
    })
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

async function completeOperationDraft(
  context: AgentContext,
  draft: AgentDraft,
  operation: "CREATE_EXPENSE" | "CREATE_INCOME",
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
    const categories = await getCategoriesTool(context);
    const category = operationPayload.categoryName
      ? resolveCategorySelection(operationPayload.categoryName, categories)
      : null;
    if (!category) {
      await updateDraftOrThrow(
        context,
        draft,
        operation,
        "AWAITING_CATEGORY",
        {
          expense: toCategoryExpensePayload(proposal.input),
        },
      );
      return categoryClarification(
        context,
        operationPayload.categoryName
          ? "No tengo esa categoría disponible. Elige una de estas opciones:"
          : "Claro. ¿En qué categoría lo quieres registrar?",
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
  if (income.missingFields.length > 0) {
    await updateDraftOrThrow(
      context,
      draft,
      operation,
      "AWAITING_DETAILS",
      operationPayload,
    );
    return operationDetailsClarification(operation, income.missingFields);
  }
  const categories = await getCategoriesTool(context);
  const category = operationPayload.categoryName
    ? resolveCategorySelection(operationPayload.categoryName, categories)
    : null;
  if (!category) {
    await updateDraftOrThrow(
      context,
      draft,
      operation,
      "AWAITING_CATEGORY",
      {
        income: toCategoryIncomePayload(income.input),
      },
    );
    return categoryClarification(
      context,
      operationPayload.categoryName
        ? "No tengo esa categoría disponible. Elige una de estas opciones:"
        : "¿En qué categoría quieres registrar el ingreso?",
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
  if (isConfirmation(message)) {
    const proposalId =
      input.proposalId ?? (await findActiveProposalId(context));
    if (proposalId) {
      const result = await confirmAgentProposal(context, proposalId);
      return { type: "CONFIRMED", ...result };
    }
    if (activeDraft?.status === "AWAITING_CATEGORY") {
      return categoryClarification(context);
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
    return clarification(["proposalId"]);
  }
  if (isRejection(message)) {
    const proposalId =
      input.proposalId ?? (await findActiveProposalId(context));
    if (proposalId) {
      const result = await rejectAgentProposal(context, proposalId);
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
  if (!message)
    return { type: "UNSUPPORTED", message: "No pude interpretar el mensaje." };

  if (activeDraft?.status === "AWAITING_CATEGORY") {
    const categoryDraft = activeDraft as AgentCategoryDraft;
    const categories = await getCategoriesTool(context);
    const category = resolveCategorySelection(message, categories);
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
      );
    }
    return completeCategoryDraft(context, categoryDraft, category);
  }

  if (activeDraft?.status === "AWAITING_OPERATION") {
    const operation = resolveOperationChoice(message);
    if (operation) return completeOperationDraft(context, activeDraft, operation);
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
    if (looksLikeMovementRequest(message)) {
      return clarification(
        [],
        'Primero completa la operación anterior. Responde con los datos solicitados o "cancelar".',
      );
    }
    const operationPayload =
      activeDraft.payload as AgentOperationDraftPayload;
    const pendingFields = await getDraftMissingFields(context, activeDraft);
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

  let interpretation: ExpenseInterpretation;
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
    const missingFields: string[] = [];
    if (amount === null) missingFields.push("amount");
    if (!incomeDate) missingFields.push("incomeDate");
    if (!interpretation.description?.trim()) missingFields.push("description");
    if (missingFields.length > 0) {
      await persistDetailsDraft(
        context,
        "CREATE_INCOME",
        operationPayloadFromIncomeInterpretation(interpretation),
      );
      return operationDetailsClarification("CREATE_INCOME", missingFields);
    }
    const incomeInput = {
      memberId: context.actorMemberId,
      amount: amount as number,
      incomeDate,
      description: interpretation.description as string,
      categoryId: null,
    };
    const categories = await getCategoriesTool(context);
    const category = interpretation.categoryName
      ? resolveCategorySelection(interpretation.categoryName, categories)
      : null;
    if (!category) {
      await persistCategoryDraft(
        context,
        {
          income: toCategoryIncomePayload(incomeInput),
        },
        "CREATE_INCOME",
      );
      return categoryClarification(
        context,
        interpretation.categoryName
          ? "No tengo esa categoría disponible. Elige una de estas opciones:"
          : "¿En qué categoría quieres registrar el ingreso?",
      );
    }
    const result = await createIncomeTool(context, {
      ...incomeInput,
      categoryId: category.id,
    });
    return { type: "PROPOSAL_CREATED", ...result };
  }
  const proposal = await toProposalInput(context, interpretation);
  if (proposal.missingFields.length > 0) {
    return clarification(proposal.missingFields, proposal.clarificationMessage);
  }
  const categories = await getCategoriesTool(context);
  const category = interpretation.categoryName
    ? resolveCategorySelection(interpretation.categoryName, categories)
    : null;
  if (!category) {
      await persistCategoryDraft(
        context,
        {
          expense: toCategoryExpensePayload(proposal.input),
        },
      "CREATE_EXPENSE",
    );
    return categoryClarification(
      context,
      interpretation.categoryName
        ? "No tengo esa categoría disponible. Elige una de estas opciones:"
        : "Claro. ¿En qué categoría lo quieres registrar?",
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
