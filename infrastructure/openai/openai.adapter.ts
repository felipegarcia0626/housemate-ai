type ExpenseReadFilters = {
  from?: string;
  to?: string;
  categoryId?: string;
  memberId?: string;
  merchant?: string;
  minAmount?: number;
  maxAmount?: number;
};

type IncomeReadFilters = {
  from?: string;
  to?: string;
  memberId?: string;
  categoryId?: string;
};

export type CorrectionField =
  "amount" | "date" | "description" | "category" | "payer";

export type CorrectionInterpretation = {
  kind: "CORRECTION";
  field: CorrectionField;
  value: string;
};

export type ExpenseInterpretation =
  | {
      kind: "AMBIGUOUS_MOVEMENT";
      amount: string | null;
      date: string | null;
      merchant: string | null;
      description: string | null;
      paidBySelf: boolean | null;
      paidByMemberName: string | null;
      categoryName: string | null;
      splitRequested: boolean;
      splitInstructions: ExpenseSplitInstruction[] | null;
    }
  | {
      kind: "CREATE_EXPENSE";
      merchant: string | null;
      description: string | null;
      totalAmount: string | null;
      expenseDate: string | null;
      paidBySelf: boolean | null;
      paidByMemberName: string | null;
      categoryName: string | null;
      splitRequested: boolean;
      splitInstructions: ExpenseSplitInstruction[] | null;
    }
  | {
      kind: "CREATE_INCOME";
      amount: string | null;
      incomeDate: string | null;
      description: string | null;
      categoryName: string | null;
    }
  | {
      kind: "GET_EXPENSES";
      filters: ExpenseReadFilters;
    }
  | {
      kind: "GET_INCOMES";
      filters: IncomeReadFilters;
    }
  | { kind: "GET_BALANCE" }
  | { kind: "GET_CATEGORIES" }
  | { kind: "GET_SHARING_RULES" }
  | { kind: "UNSUPPORTED" };

export type ExpenseSplitInstruction = {
  participant: "SELF" | "NAME";
  name: string | null;
  percentage: string | null;
  equalShare: boolean;
};

type ParsedInterpretation = ExpenseInterpretation | CorrectionInterpretation;

export type PeriodFinancialToolCall = {
  kind: "GET_PERIOD_FINANCIAL_SUMMARY_TOOL_CALL";
  responseId: string;
  callId: string;
  arguments: unknown;
};

const periodFinancialTool = {
  type: "function",
  name: "get_period_financial_summary",
  description:
    "Summarize the authenticated household's retrieved and validated income, confirmed expenses and net amount for an inclusive period of at most 366 days. Set categoryLevel to null and categoryName to null for financial totals only. Set categoryLevel to MACRO or MICRO to include a category ranking or exact category amount in the same expense read. The separately paginated reads are not a transactional snapshot. Use for period financial summaries, never for creating or changing records.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      from: { type: "string", description: "Inclusive start date, YYYY-MM-DD" },
      to: { type: "string", description: "Inclusive end date, YYYY-MM-DD" },
      categoryLevel: {
        type: ["string", "null"],
        enum: ["MACRO", "MICRO", null],
        description: "Null for totals only; otherwise the requested expense category level.",
      },
      categoryName: {
        type: ["string", "null"],
        description: "Null for the full category ranking, or an exact category name.",
      },
    },
    required: ["from", "to", "categoryLevel", "categoryName"],
  },
} as const;

export type PeriodExpenseCategoryToolCall = {
  kind: "GET_PERIOD_EXPENSE_CATEGORY_SUMMARY_TOOL_CALL";
  responseId: string;
  callId: string;
  arguments: unknown;
};

const periodExpenseCategoryTool = {
  type: "function",
  name: "get_period_expense_category_summary",
  description:
    "Summarize confirmed household expenses by an exact expense category name for an inclusive period of at most 366 days. Set categoryName to null for the full ranking. The backend resolves categories and calculates totals; never choose category IDs.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      from: { type: "string", description: "Inclusive start date, YYYY-MM-DD" },
      to: { type: "string", description: "Inclusive end date, YYYY-MM-DD" },
      level: { type: "string", enum: ["MACRO", "MICRO"] },
      categoryName: { type: ["string", "null"] },
    },
    required: ["from", "to", "level", "categoryName"],
  },
} as const;

type IncomeAmountFormat =
  | "missing"
  | "plain_decimal"
  | "grouped_decimal"
  | "currency_prefixed"
  | "non_numeric"
  | "other";

type IncomeDateFormat =
  | "missing"
  | "iso"
  | "dd_mm_yyyy"
  | "relative"
  | "textual"
  | "invalid"
  | "other";

export class OpenAIAdapterError extends Error {
  readonly code = "INTERPRETATION_ERROR" as const;

  constructor() {
    super("The message could not be interpreted.");
    this.name = "OpenAIAdapterError";
  }
}

type InterpretationDiagnosticStage =
  | "configuration_rejected"
  | "request_failed"
  | "http_rejected"
  | "response_invalid"
  | "response_not_completed"
  | "function_call_invalid"
  | "function_arguments_invalid"
  | "output_text_missing"
  | "output_json_invalid"
  | "output_intent_invalid";

type InterpretationDiagnosticDetails = {
  reason?:
    | "missing_api_key"
    | "message_too_long"
    | "invalid_json"
    | "invalid_call_count"
    | "invalid_call_shape"
    | "invalid_arguments"
    | "empty_text"
    | "invalid_json_text"
    | "invalid_intent";
  status?: number | "failed" | "incomplete" | "cancelled" | "other";
};

function logInterpretationDiagnostic(
  stage: InterpretationDiagnosticStage,
  details: InterpretationDiagnosticDetails = {},
): void {
  try {
    console.warn("[agent-interpretation-diagnostic]", { stage, ...details });
  } catch {
    // Diagnostic logging must never alter interpretation behavior.
  }
}

function safeResponseStatus(value: unknown): "failed" | "incomplete" | "cancelled" | "other" {
  if (value === "failed" || value === "incomplete" || value === "cancelled") {
    return value;
  }
  return "other";
}

const responseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: {
      type: "string",
      enum: [
        "CREATE_EXPENSE",
        "CREATE_INCOME",
        "CORRECTION",
        "AMBIGUOUS_MOVEMENT",
        "GET_EXPENSES",
        "GET_INCOMES",
        "GET_BALANCE",
        "GET_CATEGORIES",
        "GET_SHARING_RULES",
        "UNSUPPORTED",
      ],
    },
    merchant: { type: ["string", "null"] },
    description: { type: ["string", "null"] },
    totalAmount: { type: ["string", "null"] },
    expenseDate: { type: ["string", "null"] },
    paidBySelf: { type: ["boolean", "null"] },
    paidByMemberName: { type: ["string", "null"] },
    categoryName: { type: ["string", "null"] },
    splitRequested: { type: "boolean" },
    splitInstructions: {
      type: ["array", "null"],
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          participant: { type: "string", enum: ["SELF", "NAME"] },
          name: { type: ["string", "null"] },
          percentage: { type: ["string", "null"] },
          equalShare: { type: "boolean" },
        },
        required: ["participant", "name", "percentage", "equalShare"],
      },
    },
    amount: { type: ["string", "null"] },
    date: { type: ["string", "null"] },
    incomeDate: { type: ["string", "null"] },
    incomeDescription: { type: ["string", "null"] },
    correctionField: {
      type: ["string", "null"],
      enum: ["amount", "date", "description", "category", "payer", null],
    },
    correctionValue: { type: ["string", "null"] },
    filters: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        from: { type: ["string", "null"] },
        to: { type: ["string", "null"] },
        categoryId: { type: ["string", "null"] },
        memberId: { type: ["string", "null"] },
        merchant: { type: ["string", "null"] },
        minAmount: { type: ["number", "null"] },
        maxAmount: { type: ["number", "null"] },
      },
      required: [
        "from",
        "to",
        "categoryId",
        "memberId",
        "merchant",
        "minAmount",
        "maxAmount",
      ],
    },
  },
  required: [
    "kind",
    "merchant",
    "description",
    "totalAmount",
    "expenseDate",
    "paidBySelf",
    "paidByMemberName",
    "categoryName",
    "splitRequested",
    "splitInstructions",
    "amount",
    "date",
    "incomeDate",
    "incomeDescription",
    "correctionField",
    "correctionValue",
    "filters",
  ],
} as const;

const systemPrompt = `For a request for income, confirmed expenses and net amount over a period, call get_period_financial_summary with inclusive from and to dates and categoryLevel=null, categoryName=null. If that request also asks for category spending or a category ranking, call the same financial tool with categoryLevel MACRO or MICRO and categoryName set to the exact requested name or null for a ranking; the backend combines these in one expense read. For category-only requests, call get_period_expense_category_summary with inclusive dates, level MACRO or MICRO, and an exact categoryName or null for the full ranking. Both tools support at most 366 inclusive days. Do not choose category IDs, household, actor or permissions. Use at most one tool call. Otherwise interpret the user's message using only the supported HouseMate
intents: create expense, create income, correction, get expenses, get incomes, get balance,
get categories, get sharing rules, ambiguous movement, or unsupported. Return only the requested JSON
schema. Use null when a value is absent. Do not invent financial values.
When the user clearly corrects one field of a previously proposed operation, return
CORRECTION with exactly one correctionField and its correctionValue as text. Use only
the fields amount, date, description, category or payer. Do not include an operation,
proposal id, household id, conversation key, source or any internal identifier.
Do not use CORRECTION for a complete rejection such as "No", "No gracias",
"rechazo", "rechazar", "cancelar", "cancela eso" or "cancelo". A message beginning
with "No" is a correction only when the remaining text clearly identifies one field
and its replacement value. Return null for correctionField and correctionValue for
every non-CORRECTION intent. Support only one corrected field per message; when the
field is ambiguous or several fields are corrected at once, return UNSUPPORTED.
For CORRECTION, preserve the value as text for server-side validation; do not convert
amounts to numbers, dates to ISO, categories to ids or payers to member ids.
When the user asks to register a movement with an amount but does not say whether
it is an expense or income, return AMBIGUOUS_MOVEMENT and preserve the available
amount, date, merchant, description, payer and category fields without choosing
an operation. Generic recording verbs such as "registra", "anota" or "agrega"
remain AMBIGUOUS_MOVEMENT when they do not identify spending or receiving money.
When the message clearly describes money being received or credited to the user,
return CREATE_INCOME, even when the amount, date, description or category is
missing; preserve the CREATE_INCOME intent and leave missing fields as null for
the Conversation Service to request later. This includes semantically equivalent
expressions such as "recibí", "me consignaron", "me pagaron", "entró",
"ingresaron", "depositaron", "me llegó", receiving a salary, receiving a
paycheck or receiving fees/honorarios. Explicit spending signals such as
"gasté", "pagué" or "compré" remain CREATE_EXPENSE and take precedence over
incidental mentions of other movement types.
For CREATE_INCOME, extract every value that is explicitly present in the user's
message in the canonical income fields: put the received amount in amount, the
income date in incomeDate, and the income description in incomeDescription or
description. Do not return null for a canonical field when that value is
explicitly present. When an income date is written as DD/MM/YYYY, convert it to
YYYY-MM-DD before returning it in incomeDate. Keep totalAmount reserved for
expense or ambiguous-movement data and keep date/expenseDate out of the
income mapping. Extract all explicit income values from one sentence; do not
require the user to provide them in separate messages.
Expense totalAmount and income amount must be decimal strings with at most two
decimal places. Dates must be ISO dates when explicitly known. Categories are
closed and must never be invented; return the category name only when the user
provides one. Only return
paidBySelf=true when the user clearly says they paid. If the user explicitly
names another household member as the payer, return paidBySelf=false and
preserve that person's display name in paidByMemberName. Return
paidBySelf=null and paidByMemberName=null when no payer is specified. Never
invent a member name. Read filters must use only the fields available in the
corresponding intent. Never return household, actor,
createdBy, source, member ids, or any persistence fields. For an explicitly
requested split, return splitInstructions using SELF or NAME and percentages
as decimal strings; use equalShare=true only when equal sharing is explicit.
Return splitRequested=true when the user explicitly asks to share or split a
expense, even if participants or percentages are still missing. Return false
when no split is requested.`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function classifyIncomeAmountFormat(value: string | null): IncomeAmountFormat {
  if (value === null || !value.trim()) return "missing";
  const normalized = value.trim();
  if (/^\d+(?:[.]\d{1,2})?$/.test(normalized)) return "plain_decimal";
  if (/^\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?$/.test(normalized)) {
    return "grouped_decimal";
  }
  if (/^(?:[$€£]|(?:cop|usd|eur)\s*)\s*[\d.,]+$/i.test(normalized)) {
    return "currency_prefixed";
  }
  if (/[a-z]/i.test(normalized)) return "non_numeric";
  return "other";
}

function classifyIncomeDateFormat(value: string | null): IncomeDateFormat {
  if (value === null || !value.trim()) return "missing";
  const normalized = value.trim().toLocaleLowerCase("es");
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return "iso";
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(normalized)) return "dd_mm_yyyy";
  if (normalized === "hoy" || normalized === "ayer") return "relative";
  if (/^\d{1,2} de [a-z]+(?: de \d{4})?$/.test(normalized)) {
    return "textual";
  }
  if (/^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}$/.test(normalized)) {
    return "invalid";
  }
  return "other";
}

function logIncomeInterpretationDiagnostic(
  interpretation: Extract<ExpenseInterpretation, { kind: "CREATE_INCOME" }>,
): void {
  try {
    console.info("[agent-income-diagnostic]", {
      stage: "interpretation_parsed",
      operation: "CREATE_INCOME",
      kind: interpretation.kind,
      amountPresent: Boolean(interpretation.amount?.trim()),
      amountType: interpretation.amount === null ? "null" : "string",
      amountFormat: classifyIncomeAmountFormat(interpretation.amount),
      incomeDatePresent: Boolean(interpretation.incomeDate?.trim()),
      incomeDateType: interpretation.incomeDate === null ? "null" : "string",
      incomeDateFormat: classifyIncomeDateFormat(interpretation.incomeDate),
      descriptionPresent: Boolean(interpretation.description?.trim()),
      categoryPresent: Boolean(interpretation.categoryName?.trim()),
    });
  } catch {
    // Diagnostic logging must never alter interpretation behavior.
  }
}

function extractText(body: unknown): string | null {
  if (!isRecord(body)) return null;
  if (!Array.isArray(body.output)) return null;
  const messages = body.output.filter(
    (item) => isRecord(item) && item.type === "message",
  );
  if (messages.length !== 1) return null;
  const message = messages[0] as Record<string, unknown>;
  if (
    (message.status !== undefined && message.status !== "completed") ||
    !Array.isArray(message.content) || message.content.length !== 1
  ) return null;
  const content = message.content[0];
  return isRecord(content) && content.type === "output_text" &&
    typeof content.text === "string" ? content.text : null;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === "number";
}

function parseSplitInstructions(value: unknown): ExpenseSplitInstruction[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length === 0) throw new OpenAIAdapterError();
  return value.map((item) => {
    if (!isRecord(item)) throw new OpenAIAdapterError();
    if (item.participant !== "SELF" && item.participant !== "NAME") {
      throw new OpenAIAdapterError();
    }
    if (!isNullableString(item.name) || !isNullableString(item.percentage) || typeof item.equalShare !== "boolean") {
      throw new OpenAIAdapterError();
    }
    if (item.participant === "NAME" && !item.name?.trim()) throw new OpenAIAdapterError();
    if (item.participant === "SELF" && item.name !== null) throw new OpenAIAdapterError();
    if (item.equalShare && item.percentage !== null) throw new OpenAIAdapterError();
    if (!item.equalShare && (item.percentage === null || !/^\d+(?:\.\d{1,2})?$/.test(item.percentage.trim()))) {
      throw new OpenAIAdapterError();
    }
    return item as ExpenseSplitInstruction;
  });
}

function isCorrectionField(value: unknown): value is CorrectionField {
  return (
    value === "amount" ||
    value === "date" ||
    value === "description" ||
    value === "category" ||
    value === "payer"
  );
}

function nullableFilterValue<T extends string | number>(
  filters: Record<string, unknown>,
  key: string,
  guard: (value: unknown) => value is T | null,
): T | undefined {
  const value = filters[key];
  if (!guard(value)) throw new OpenAIAdapterError();
  return value === null ? undefined : value;
}

function parseFilters(value: unknown): ExpenseReadFilters {
  if (!isRecord(value)) throw new OpenAIAdapterError();
  return {
    from: nullableFilterValue(value, "from", isNullableString),
    to: nullableFilterValue(value, "to", isNullableString),
    categoryId: nullableFilterValue(value, "categoryId", isNullableString),
    memberId: nullableFilterValue(value, "memberId", isNullableString),
    merchant: nullableFilterValue(value, "merchant", isNullableString),
    minAmount: nullableFilterValue(value, "minAmount", isNullableNumber),
    maxAmount: nullableFilterValue(value, "maxAmount", isNullableNumber),
  };
}

function parseInterpretation(value: unknown): ParsedInterpretation {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new OpenAIAdapterError();
  }
  if (
    !isNullableString(value.correctionField) ||
    !isNullableString(value.correctionValue)
  ) {
    throw new OpenAIAdapterError();
  }
  if (value.kind === "CORRECTION") {
    if (
      !isCorrectionField(value.correctionField) ||
      typeof value.correctionValue !== "string" ||
      !value.correctionValue.trim()
    ) {
      throw new OpenAIAdapterError();
    }
    return {
      kind: "CORRECTION",
      field: value.correctionField,
      value: value.correctionValue.trim(),
    };
  }
  if (value.correctionField !== null || value.correctionValue !== null) {
    throw new OpenAIAdapterError();
  }
  if (value.kind === "UNSUPPORTED") return { kind: "UNSUPPORTED" };
  if (value.kind === "AMBIGUOUS_MOVEMENT") {
    if (
      !isNullableString(value.amount) ||
      !isNullableString(value.date) ||
      !isNullableString(value.merchant) ||
      !isNullableString(value.description) ||
      !isNullableString(value.totalAmount) ||
      !isNullableString(value.paidByMemberName) ||
      !isNullableString(value.categoryName) ||
      (value.paidBySelf !== null && typeof value.paidBySelf !== "boolean")
    ) {
      throw new OpenAIAdapterError();
    }
    const amount =
      typeof value.amount === "string" && value.amount.trim()
        ? value.amount
        : value.totalAmount;
    if (typeof amount !== "string" || !amount.trim()) {
      throw new OpenAIAdapterError();
    }
    return {
      kind: "AMBIGUOUS_MOVEMENT",
      amount,
      date: value.date,
      merchant: value.merchant,
      description: value.description,
      paidBySelf: value.paidBySelf,
      paidByMemberName: value.paidByMemberName,
      categoryName: value.categoryName,
      splitRequested: value.splitRequested === true,
      splitInstructions: parseSplitInstructions(value.splitInstructions ?? null),
    };
  }
  if (value.kind === "CREATE_INCOME") {
    if (
      !isNullableString(value.amount) ||
      !isNullableString(value.incomeDate) ||
      !isNullableString(value.description) ||
      !isNullableString(value.incomeDescription) ||
      !isNullableString(value.categoryName)
    ) {
      throw new OpenAIAdapterError();
    }
    return {
      kind: "CREATE_INCOME",
      amount: value.amount,
      incomeDate: value.incomeDate,
      description:
        typeof value.incomeDescription === "string" &&
        value.incomeDescription.trim()
          ? value.incomeDescription
          : value.description,
      categoryName: value.categoryName,
    };
  }
  if (value.kind === "GET_EXPENSES" || value.kind === "GET_INCOMES") {
    const filters = parseFilters(value.filters);
    if (value.kind === "GET_INCOMES") {
      return {
        kind: value.kind,
        filters: {
          from: filters.from,
          to: filters.to,
          memberId: filters.memberId,
          categoryId: filters.categoryId,
        },
      };
    }
    return { kind: value.kind, filters };
  }
  if (
    value.kind === "GET_BALANCE" ||
    value.kind === "GET_CATEGORIES" ||
    value.kind === "GET_SHARING_RULES"
  ) {
    return { kind: value.kind };
  }
  if (
    value.kind !== "CREATE_EXPENSE" ||
    !isNullableString(value.merchant) ||
    !isNullableString(value.description) ||
    !isNullableString(value.totalAmount) ||
    !isNullableString(value.expenseDate) ||
    !isNullableString(value.paidByMemberName) ||
    !isNullableString(value.categoryName) ||
    (value.paidBySelf !== null && typeof value.paidBySelf !== "boolean")
  ) {
    throw new OpenAIAdapterError();
  }
  return {
    kind: "CREATE_EXPENSE",
    merchant: value.merchant,
    description: value.description,
    totalAmount: value.totalAmount,
    expenseDate: value.expenseDate,
    paidBySelf: value.paidBySelf,
    paidByMemberName: value.paidByMemberName,
    categoryName: value.categoryName,
    splitRequested: value.splitRequested === true,
    splitInstructions: parseSplitInstructions(value.splitInstructions ?? null),
  };
}

export async function interpretExpenseMessage(
  message: string,
): Promise<ExpenseInterpretation | PeriodFinancialToolCall | PeriodExpenseCategoryToolCall> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || message.length > 2000) {
    logInterpretationDiagnostic("configuration_rejected", {
      reason: !apiKey ? "missing_api_key" : "message_too_long",
    });
    throw new OpenAIAdapterError();
  }
  const currentDate = new Date().toISOString().slice(0, 10);

  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_output_tokens: 700,
        parallel_tool_calls: false,
        tools: [periodFinancialTool, periodExpenseCategoryTool],
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text: `${systemPrompt}\nCurrent date: ${currentDate}.`,
              },
            ],
          },
          {
            role: "user",
            content: [{ type: "input_text", text: message }],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "expense_intent",
            strict: true,
            schema: responseSchema,
          },
        },
      }),
    });
  } catch {
    logInterpretationDiagnostic("request_failed");
    throw new OpenAIAdapterError();
  }

  if (!response.ok) {
    logInterpretationDiagnostic("http_rejected", {
      ...(Number.isSafeInteger(response.status) ? { status: response.status } : {}),
    });
    throw new OpenAIAdapterError();
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    logInterpretationDiagnostic("response_invalid", { reason: "invalid_json" });
    throw new OpenAIAdapterError();
  }
  if (isRecord(body) && body.status === "completed" && Array.isArray(body.output)) {
    const calls = body.output.filter(
      (item) => isRecord(item) && item.type === "function_call",
    );
    if (calls.length > 0) {
      if (calls.length !== 1 || typeof body.id !== "string") {
        logInterpretationDiagnostic("function_call_invalid", { reason: "invalid_call_count" });
        throw new OpenAIAdapterError();
      }
      const call = calls[0] as Record<string, unknown>;
      if (
        (call.name !== periodFinancialTool.name && call.name !== periodExpenseCategoryTool.name) ||
        (call.status !== undefined && call.status !== "completed") ||
        typeof call.call_id !== "string" ||
        typeof call.arguments !== "string"
      ) {
        logInterpretationDiagnostic("function_call_invalid", { reason: "invalid_call_shape" });
        throw new OpenAIAdapterError();
      }
      let args: unknown;
      try {
        args = JSON.parse(call.arguments);
      } catch {
        logInterpretationDiagnostic("function_arguments_invalid", { reason: "invalid_arguments" });
        throw new OpenAIAdapterError();
      }
      return {
        kind: call.name === periodFinancialTool.name
          ? "GET_PERIOD_FINANCIAL_SUMMARY_TOOL_CALL"
          : "GET_PERIOD_EXPENSE_CATEGORY_SUMMARY_TOOL_CALL",
        responseId: body.id,
        callId: call.call_id,
        arguments: args,
      };
    }
  }
  if (!isRecord(body) || body.status !== "completed") {
    logInterpretationDiagnostic("response_not_completed", {
      status: safeResponseStatus(isRecord(body) ? body.status : undefined),
    });
    throw new OpenAIAdapterError();
  }
  const text = extractText(body);
  if (!text) {
    logInterpretationDiagnostic("output_text_missing", { reason: "empty_text" });
    throw new OpenAIAdapterError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    logInterpretationDiagnostic("output_json_invalid", { reason: "invalid_json_text" });
    throw new OpenAIAdapterError();
  }

  try {
    const result = parseInterpretation(parsed);
    if (result.kind === "CREATE_INCOME") {
      logIncomeInterpretationDiagnostic(result);
    }
    return result as ExpenseInterpretation;
  } catch {
    logInterpretationDiagnostic("output_intent_invalid", { reason: "invalid_intent" });
    throw new OpenAIAdapterError();
  }
}

export async function explainPeriodFinancialSummary(
  call: PeriodFinancialToolCall,
  summary: {
    from: string;
    to: string;
    complete: boolean;
    totalIncome?: number;
    totalSpent?: number;
    netAmount?: number;
    movementCount?: number;
  },
): Promise<string | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        previous_response_id: call.responseId,
        max_output_tokens: 180,
        tool_choice: "none",
        input: [
          {
            type: "function_call_output",
            call_id: call.callId,
            output: JSON.stringify(summary),
          },
        ],
        instructions:
          "Choose exactly one qualitative observation supported by the function output. Do not calculate or produce any financial amount. The backend will render the final response.",
        text: {
          format: {
            type: "json_schema",
            name: "period_observation",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                observation: {
                  type: "string",
                  enum: [
                    "EMPTY",
                    "INCOME_EXCEEDS_EXPENSE",
                    "EXPENSE_EXCEEDS_INCOME",
                    "EQUAL",
                    "INCOMPLETE",
                  ],
                },
              },
              required: ["observation"],
            },
          },
        },
      }),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (
      !isRecord(body) ||
      body.status !== "completed" ||
      !Array.isArray(body.output) ||
      body.output.some((item) => isRecord(item) && item.type === "function_call")
    ) return null;
    const raw = extractText(body);
    if (!raw || raw.length > 100) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || Object.keys(parsed).join(",") !== "observation") {
      return null;
    }
    const expected = !summary.complete
      ? "INCOMPLETE"
      : summary.movementCount === 0
        ? "EMPTY"
        : summary.netAmount! > 0
          ? "INCOME_EXCEEDS_EXPENSE"
          : summary.netAmount! < 0
            ? "EXPENSE_EXCEEDS_INCOME"
            : "EQUAL";
    if (parsed.observation !== expected) return null;
    const language: Record<string, string> = {
      EMPTY: "No hay ingresos ni gastos confirmados en este período.",
      INCOME_EXCEEDS_EXPENSE: "Los ingresos superaron a los gastos confirmados del período.",
      EXPENSE_EXCEEDS_INCOME: "Los gastos confirmados superaron a los ingresos del período.",
      EQUAL: "Los ingresos y los gastos confirmados del período fueron iguales.",
      INCOMPLETE: "La consulta no pudo completarse.",
    };
    return language[expected];
  } catch {
    return null;
  }
}
