export type ReceiptProcessingStatus = "PENDING" | "PROCESSED" | "FAILED";

export interface ReceiptItem {
  name: string;
  quantity: number | null;
  unitPrice: number | null;
  totalPrice: number;
}

export interface ReceiptAnalysis {
  merchant: string | null;
  date: string | null;
  totalAmount: number | null;
  items: ReceiptItem[];
  missingFields: string[];
}

export interface Receipt {
  id: string;
  householdId: string;
  conversationKey: string;
  storagePath: string;
  originalFilename: string;
  mimeType: string;
  uploadedAt: string;
  processingStatus: ReceiptProcessingStatus;
  analysis: ReceiptAnalysis;
}

export interface ReceiptServiceContext {
  householdId: string;
  conversationKey: string;
}

export interface ReceiptImageInput {
  bytes: Uint8Array;
  originalFilename: string;
  mimeType: string;
}

export interface ReceiptClarifications {
  merchant?: string | null;
  date?: string | null;
  totalAmount?: number | null;
  items?: ReceiptItem[];
}

export type ReceiptAnalysisRequest =
  | { kind: "NEW"; image: ReceiptImageInput }
  | { kind: "RETRY"; receiptId: string }
  | {
      kind: "CLARIFY";
      receiptId: string;
      clarifications: ReceiptClarifications;
    };

export type ReceiptDomainErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "HOUSEHOLD_MISMATCH"
  | "ACTIVE_RECEIPT_EXISTS"
  | "ANALYSIS_ERROR"
  | "PERSISTENCE_ERROR";

export class ReceiptDomainError extends Error {
  readonly code: ReceiptDomainErrorCode;
  readonly receiptId?: string;

  constructor(
    code: ReceiptDomainErrorCode,
    message: string,
    receiptId?: string,
  ) {
    super(message);
    this.name = "ReceiptDomainError";
    this.code = code;
    this.receiptId = receiptId;
  }
}
