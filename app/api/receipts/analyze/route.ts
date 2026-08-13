import {
  getConfiguredHttpConversationKey,
  getConfiguredHttpHouseholdContext,
} from "@/app/api/_lib/http-context";
import { analyzeReceipt } from "@/modules/receipts/receipt.service";
import {
  ReceiptDomainError,
  type ReceiptAnalysisRequest,
  type Receipt,
  type ReceiptClarifications,
  type ReceiptImageInput,
} from "@/modules/receipts/receipt.types";

function errorResponse(
  status: number,
  code:
    | "VALIDATION_ERROR"
    | "NOT_FOUND"
    | "ACTIVE_RECEIPT_EXISTS"
    | "INTERNAL_ERROR",
  message: string,
  receiptId?: string,
): Response {
  const body: { error: { code: string; message: string }; receiptId?: string } =
    {
      error: { code, message },
    };
  if (receiptId) body.receiptId = receiptId;
  return Response.json(body, { status });
}

function publicReceipt(receipt: Receipt) {
  return {
    receiptId: receipt.id,
    storagePath: receipt.storagePath,
    processingStatus: receipt.processingStatus,
    merchant: receipt.analysis.merchant,
    date: receipt.analysis.date,
    totalAmount: receipt.analysis.totalAmount,
    items: receipt.analysis.items,
    missingFields: receipt.analysis.missingFields,
  };
}

function invalidRequest(): Response {
  return errorResponse(422, "VALIDATION_ERROR", "Solicitud inválida.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function parseRequest(request: Request): Promise<ReceiptAnalysisRequest> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().startsWith("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    if (
      !file ||
      typeof file === "string" ||
      typeof file.arrayBuffer !== "function"
    ) {
      throw new ReceiptDomainError(
        "VALIDATION_ERROR",
        "A receipt image is required.",
      );
    }
    const image: ReceiptImageInput = {
      bytes: new Uint8Array(await file.arrayBuffer()),
      originalFilename:
        typeof file.name === "string" && file.name.length > 0
          ? file.name
          : "receipt-image",
      mimeType: typeof file.type === "string" ? file.type : "",
    };
    return { kind: "NEW", image };
  }

  if (!contentType.toLowerCase().includes("application/json")) {
    throw new ReceiptDomainError(
      "VALIDATION_ERROR",
      "Unsupported receipt request format.",
    );
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ReceiptDomainError("VALIDATION_ERROR", "Solicitud inválida.");
  }
  if (!isRecord(body)) {
    throw new ReceiptDomainError("VALIDATION_ERROR", "Solicitud inválida.");
  }
  const keys = Object.keys(body);
  if (
    keys.some((key) => !new Set(["receiptId", "clarifications"]).has(key)) ||
    typeof body.receiptId !== "string"
  ) {
    throw new ReceiptDomainError("VALIDATION_ERROR", "Solicitud inválida.");
  }
  if (body.clarifications !== undefined) {
    if (!isRecord(body.clarifications)) {
      throw new ReceiptDomainError("VALIDATION_ERROR", "Solicitud inválida.");
    }
    return {
      kind: "CLARIFY",
      receiptId: body.receiptId,
      clarifications: body.clarifications as ReceiptClarifications,
    };
  }
  return { kind: "RETRY", receiptId: body.receiptId };
}

export async function POST(request: Request): Promise<Response> {
  if (new URL(request.url).searchParams.toString()) return invalidRequest();

  let parsed: ReceiptAnalysisRequest;
  try {
    parsed = await parseRequest(request);
  } catch (error) {
    if (error instanceof ReceiptDomainError) return invalidRequest();
    return errorResponse(422, "VALIDATION_ERROR", "Solicitud inválida.");
  }

  try {
    const { householdId } = await getConfiguredHttpHouseholdContext();
    const conversationKey = getConfiguredHttpConversationKey();
    const receipt = await analyzeReceipt(
      { householdId, conversationKey },
      parsed,
    );
    return Response.json({ data: publicReceipt(receipt) });
  } catch (error) {
    if (error instanceof ReceiptDomainError) {
      if (error.code === "VALIDATION_ERROR") return invalidRequest();
      if (error.code === "NOT_FOUND" || error.code === "HOUSEHOLD_MISMATCH") {
        return errorResponse(404, "NOT_FOUND", "Recurso no encontrado.");
      }
      if (error.code === "ACTIVE_RECEIPT_EXISTS") {
        return errorResponse(
          409,
          "ACTIVE_RECEIPT_EXISTS",
          "Ya existe una factura activa para esta conversación.",
        );
      }
      return errorResponse(
        500,
        "INTERNAL_ERROR",
        "No fue posible analizar la factura.",
        error.receiptId,
      );
    }

    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "No fue posible completar la operación.",
    );
  }
}
