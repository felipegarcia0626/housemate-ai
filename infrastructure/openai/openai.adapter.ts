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

export class OpenAIAdapterError extends Error {
  readonly code = "INTERPRETATION_ERROR" as const;

  constructor() {
    super("The message could not be interpreted.");
    this.name = "OpenAIAdapterError";
  }
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
    amount: { type: ["string", "null"] },
    date: { type: ["string", "null"] },
    incomeDate: { type: ["string", "null"] },
    incomeDescription: { type: ["string", "null"] },
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
    "amount",
    "date",
    "incomeDate",
    "incomeDescription",
    "filters",
  ],
} as const;

const systemPrompt = `Interpret the user's message using only the supported HouseMate
intents: create expense, create income, get expenses, get incomes, get balance,
get categories, get sharing rules, ambiguous movement, or unsupported. Return only the requested JSON
schema. Use null when a value is absent. Do not invent financial values.
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
createdBy, source, member ids, or any persistence fields.`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractText(body: unknown): string | null {
  if (!isRecord(body)) return null;
  if (typeof body.output_text === "string") return body.output_text;
  if (!Array.isArray(body.output)) return null;
  for (const output of body.output) {
    if (!isRecord(output) || !Array.isArray(output.content)) continue;
    for (const content of output.content) {
      if (isRecord(content) && typeof content.text === "string") {
        return content.text;
      }
    }
  }
  return null;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === "number";
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

function parseInterpretation(value: unknown): ExpenseInterpretation {
  if (!isRecord(value) || typeof value.kind !== "string") {
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
  };
}

export async function interpretExpenseMessage(
  message: string,
): Promise<ExpenseInterpretation> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new OpenAIAdapterError();
  }
  const currentDate = new Date().toISOString().slice(0, 10);

  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
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
    throw new OpenAIAdapterError();
  }

  if (!response.ok) {
    throw new OpenAIAdapterError();
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new OpenAIAdapterError();
  }
  const text = extractText(body);
  if (!text) {
    throw new OpenAIAdapterError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new OpenAIAdapterError();
  }

  try {
    const result = parseInterpretation(parsed);
    return result;
  } catch {
    throw new OpenAIAdapterError();
  }
}
