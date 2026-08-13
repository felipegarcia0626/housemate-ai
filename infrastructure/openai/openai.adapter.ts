export type ExpenseInterpretation =
  | {
      kind: "CREATE_EXPENSE";
      merchant: string | null;
      description: string | null;
      totalAmount: string | null;
      expenseDate: string | null;
      paidBySelf: boolean | null;
    }
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
    kind: { type: "string", enum: ["CREATE_EXPENSE", "UNSUPPORTED"] },
    merchant: { type: ["string", "null"] },
    description: { type: ["string", "null"] },
    totalAmount: { type: ["string", "null"] },
    expenseDate: { type: ["string", "null"] },
    paidBySelf: { type: ["boolean", "null"] },
  },
  required: [
    "kind",
    "merchant",
    "description",
    "totalAmount",
    "expenseDate",
    "paidBySelf",
  ],
} as const;

const systemPrompt = `Interpret the user's message as a HouseMate expense intent.
Return only the requested JSON schema. Use null when a required value is absent.
Do not invent financial values. totalAmount must be a decimal string with at most
two decimal places. expenseDate must be an ISO date when it is explicitly known.
Only return paidBySelf=true when the user clearly says they paid. Never return
household, actor, createdBy, source, member ids, or any persistence fields.`;

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

function parseInterpretation(value: unknown): ExpenseInterpretation {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new OpenAIAdapterError();
  }
  if (value.kind === "UNSUPPORTED") return { kind: "UNSUPPORTED" };
  if (
    value.kind !== "CREATE_EXPENSE" ||
    !isNullableString(value.merchant) ||
    !isNullableString(value.description) ||
    !isNullableString(value.totalAmount) ||
    !isNullableString(value.expenseDate) ||
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
  };
}

export async function interpretExpenseMessage(
  message: string,
): Promise<ExpenseInterpretation> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new OpenAIAdapterError();
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

  if (!response.ok) throw new OpenAIAdapterError();
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new OpenAIAdapterError();
  }
  const text = extractText(body);
  if (!text) throw new OpenAIAdapterError();
  try {
    return parseInterpretation(JSON.parse(text) as unknown);
  } catch {
    throw new OpenAIAdapterError();
  }
}
