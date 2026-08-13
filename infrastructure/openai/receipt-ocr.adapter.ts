import type {
  ReceiptAnalysis,
  ReceiptItem,
} from "@/modules/receipts/receipt.types";

export class ReceiptOcrAdapterError extends Error {
  constructor(cause?: unknown) {
    super("Receipt analysis is unavailable.", { cause });
    this.name = "ReceiptOcrAdapterError";
  }
}

const responseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    merchant: { type: ["string", "null"] },
    date: { type: ["string", "null"] },
    totalAmount: { type: ["number", "null"] },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          quantity: { type: ["number", "null"] },
          unitPrice: { type: ["number", "null"] },
          totalPrice: { type: "number" },
        },
        required: ["name", "quantity", "unitPrice", "totalPrice"],
      },
    },
  },
  required: ["merchant", "date", "totalAmount", "items"],
} as const;

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

function parseItem(value: unknown): ReceiptItem | null {
  if (!isRecord(value)) return null;
  const { name, quantity, unitPrice, totalPrice } = value;
  if (
    typeof name !== "string" ||
    (quantity !== null && typeof quantity !== "number") ||
    (unitPrice !== null && typeof unitPrice !== "number") ||
    typeof totalPrice !== "number"
  ) {
    return null;
  }
  return { name, quantity, unitPrice, totalPrice };
}

function parseAnalysis(value: unknown): ReceiptAnalysis {
  if (!isRecord(value)) throw new ReceiptOcrAdapterError();
  const { merchant, date, totalAmount, items } = value;
  if (
    (merchant !== null && typeof merchant !== "string") ||
    (date !== null && typeof date !== "string") ||
    (totalAmount !== null && typeof totalAmount !== "number") ||
    !Array.isArray(items)
  ) {
    throw new ReceiptOcrAdapterError();
  }
  const parsedItems = items.map(parseItem);
  if (parsedItems.some((item) => item === null)) {
    throw new ReceiptOcrAdapterError();
  }
  return {
    merchant,
    date,
    totalAmount,
    items: parsedItems as ReceiptItem[],
    missingFields: [],
  };
}

export async function analyzeReceiptImage(input: {
  bytes: Uint8Array;
  mimeType: string;
}): Promise<ReceiptAnalysis> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new ReceiptOcrAdapterError();

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
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Extrae los datos de esta factura. No inventes valores; usa null cuando un campo no sea legible.",
              },
              {
                type: "input_image",
                image_url: `data:${input.mimeType};base64,${Buffer.from(input.bytes).toString("base64")}`,
              },
            ],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "receipt_analysis",
            strict: true,
            schema: responseSchema,
          },
        },
      }),
    });
  } catch (error) {
    throw new ReceiptOcrAdapterError(error);
  }

  if (!response.ok) throw new ReceiptOcrAdapterError();
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new ReceiptOcrAdapterError(error);
  }
  const text = extractText(body);
  if (!text) throw new ReceiptOcrAdapterError();
  try {
    return parseAnalysis(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof ReceiptOcrAdapterError) throw error;
    throw new ReceiptOcrAdapterError(error);
  }
}
