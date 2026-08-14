import { createExpenseTool } from "./tools/create-expense.tool";
import { confirmAgentProposal, rejectAgentProposal } from "./agent.service";
import { createIncomeTool } from "./tools/create-income.tool";
import { getExpensesTool } from "./tools/get-expenses.tool";
import { getIncomesTool } from "./tools/get-incomes.tool";
import { getBalanceTool } from "./tools/get-balance.tool";
import { getCategoriesTool } from "./tools/get-categories.tool";
import { getSharingRulesTool } from "./tools/get-sharing-rules.tool";
import {
  createCategoryDraft,
  deleteCategoryDraft,
  getActiveCategoryDraft,
  isCategoryDraftRepositoryError,
  updateCategoryDraft,
} from "./category-draft.service";
import type {
  AgentCategoryDraft,
  CategoryDraftExpensePayload,
  CategoryDraftIncomePayload,
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
        categoryId: category.id,
      });
      await deleteCategoryDraft(context, draft.id);
      return { type: "PROPOSAL_CREATED", ...result };
    }
    const payload = draft.payload as CategoryDraftIncomePayload;
    const result = await createIncomeTool(context, {
      ...payload.income,
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

function toProposalInput(
  context: AgentContext,
  interpretation: Extract<ExpenseInterpretation, { kind: "CREATE_EXPENSE" }>,
): { input: ExpenseProposalInput; missingFields: string[] } {
  const totalAmount = toAmount(interpretation.totalAmount);
  const missingFields: string[] = [];
  if (totalAmount === null) missingFields.push("totalAmount");
  if (!interpretation.expenseDate) missingFields.push("expenseDate");
  if (interpretation.paidBySelf !== true) missingFields.push("paidBySelf");
  if (missingFields.length > 0) {
    return { input: {} as ExpenseProposalInput, missingFields };
  }
  return {
    input: {
      paidByMemberId: context.actorMemberId,
      totalAmount: totalAmount as number,
      expenseDate: interpretation.expenseDate as string,
      merchant: interpretation.merchant,
      description: interpretation.description,
      items: [],
      splits: [{ householdMemberId: context.actorMemberId, percentage: 100 }],
    },
    missingFields,
  };
}

export async function processAgentMessage(
  context: AgentContext,
  input: AgentMessageInput,
  interpreter: Interpreter = interpretExpenseMessage,
): Promise<AgentMessageResult> {
  const message = input.message.trim();
  let categoryDraft: AgentCategoryDraft | null;
  try {
    categoryDraft = await getActiveCategoryDraft(context);
  } catch (error) {
    if (isCategoryDraftRepositoryError(error)) {
      throw new AgentDomainError(
        "PERSISTENCE_ERROR",
        "The category clarification could not be loaded.",
      );
    }
    throw error;
  }
  if (isConfirmation(message)) {
    if (!input.proposalId) return clarification(["proposalId"]);
    const result = await confirmAgentProposal(context, input.proposalId);
    return { type: "CONFIRMED", ...result };
  }
  if (isRejection(message)) {
    if (!input.proposalId) return clarification(["proposalId"]);
    const result = await rejectAgentProposal(context, input.proposalId);
    return { type: "REJECTED", ...result };
  }
  if (!message)
    return { type: "UNSUPPORTED", message: "No pude interpretar el mensaje." };

  if (categoryDraft) {
    const categories = await getCategoriesTool(context);
    const category = resolveCategorySelection(message, categories);
    if (!category) {
      try {
        await updateCategoryDraft(context, categoryDraft.id, categoryDraft.payload);
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
    const missingFields: string[] = [];
    if (amount === null) missingFields.push("amount");
    if (!interpretation.incomeDate) missingFields.push("incomeDate");
    if (!interpretation.description?.trim()) missingFields.push("description");
    if (missingFields.length > 0) return clarification(missingFields);
    const incomeInput = {
      memberId: context.actorMemberId,
      amount: amount as number,
      incomeDate: interpretation.incomeDate as string,
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
          actorMemberId: context.actorMemberId,
          source: context.source,
          income: incomeInput,
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
  const proposal = toProposalInput(context, interpretation);
  if (proposal.missingFields.length > 0) {
    return clarification(proposal.missingFields);
  }
  const categories = await getCategoriesTool(context);
  const category = interpretation.categoryName
    ? resolveCategorySelection(interpretation.categoryName, categories)
    : null;
  if (!category) {
    await persistCategoryDraft(
      context,
      {
        actorMemberId: context.actorMemberId,
        source: context.source,
        expense: proposal.input,
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
