import type {
  ReceiptAnalysis,
  ReceiptClarifications,
  ReceiptImageInput,
  ReceiptItem,
} from "./receipt.types";
import { ReceiptDomainError } from "./receipt.types";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const SUPPORTED_RECEIPT_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function validationError(message: string): ReceiptDomainError {
  return new ReceiptDomainError("VALIDATION_ERROR", message);
}

export function validateReceiptContext(
  householdId: string,
  conversationKey: string,
): void {
  if (!UUID_PATTERN.test(householdId)) {
    throw validationError("The household context is invalid.");
  }
  if (conversationKey.trim().length === 0) {
    throw validationError("The conversation context is required.");
  }
}

export function validateReceiptId(receiptId: string): void {
  if (!UUID_PATTERN.test(receiptId)) {
    throw validationError("The receipt identifier is invalid.");
  }
}

export function validateReceiptImage(image: ReceiptImageInput): void {
  if (
    image.bytes.byteLength === 0 ||
    image.originalFilename.trim().length === 0 ||
    !SUPPORTED_RECEIPT_MIME_TYPES.has(image.mimeType)
  ) {
    throw validationError("The receipt image is invalid.");
  }
}

function validateDate(value: string | null): void {
  if (value !== null && !DATE_PATTERN.test(value)) {
    throw validationError("The extracted receipt date is invalid.");
  }
}

function validateAmount(value: number | null): void {
  if (
    value !== null &&
    (!Number.isFinite(value) ||
      value <= 0 ||
      Math.round(value * 100) !== value * 100)
  ) {
    throw validationError("The extracted receipt amount is invalid.");
  }
}

function validateItem(item: ReceiptItem): void {
  if (
    typeof item.name !== "string" ||
    item.name.trim().length === 0 ||
    (item.quantity !== null &&
      (!Number.isFinite(item.quantity) || item.quantity <= 0)) ||
    (item.unitPrice !== null &&
      (!Number.isFinite(item.unitPrice) || item.unitPrice < 0)) ||
    !Number.isFinite(item.totalPrice) ||
    item.totalPrice < 0 ||
    Math.round(item.totalPrice * 100) !== item.totalPrice * 100
  ) {
    throw validationError("The extracted receipt items are invalid.");
  }
}

export function validateReceiptAnalysis(analysis: ReceiptAnalysis): void {
  if (
    (analysis.merchant !== null && typeof analysis.merchant !== "string") ||
    (analysis.date !== null && typeof analysis.date !== "string") ||
    (analysis.totalAmount !== null &&
      typeof analysis.totalAmount !== "number") ||
    !Array.isArray(analysis.items) ||
    !Array.isArray(analysis.missingFields)
  ) {
    throw validationError("The extracted receipt data is invalid.");
  }

  validateDate(analysis.date);
  validateAmount(analysis.totalAmount);
  for (const item of analysis.items) validateItem(item);
  if (analysis.missingFields.some((field) => typeof field !== "string")) {
    throw validationError("The extracted receipt data is invalid.");
  }
}

export function validateReceiptClarifications(
  clarifications: ReceiptClarifications,
): void {
  const allowed = new Set(["merchant", "date", "totalAmount", "items"]);
  if (
    typeof clarifications !== "object" ||
    clarifications === null ||
    Object.keys(clarifications).some((key) => !allowed.has(key))
  ) {
    throw validationError("The receipt clarifications are invalid.");
  }

  if (
    clarifications.merchant !== undefined &&
    clarifications.merchant !== null &&
    (typeof clarifications.merchant !== "string" ||
      clarifications.merchant.trim().length === 0)
  ) {
    throw validationError("The receipt clarifications are invalid.");
  }
  if (
    clarifications.date !== undefined &&
    clarifications.date !== null &&
    !DATE_PATTERN.test(clarifications.date)
  ) {
    throw validationError("The receipt clarifications are invalid.");
  }
  if (clarifications.totalAmount !== undefined) {
    validateAmount(clarifications.totalAmount);
  }
  if (clarifications.items !== undefined) {
    if (!Array.isArray(clarifications.items)) {
      throw validationError("The receipt clarifications are invalid.");
    }
    for (const item of clarifications.items) validateItem(item);
  }
}

export function deriveMissingFields(analysis: ReceiptAnalysis): string[] {
  const missing: string[] = [];
  if (!analysis.merchant) missing.push("merchant");
  if (!analysis.date) missing.push("date");
  if (analysis.totalAmount === null) missing.push("totalAmount");
  return missing;
}

export function isCompleteAnalysis(analysis: ReceiptAnalysis): boolean {
  return deriveMissingFields(analysis).length === 0;
}
