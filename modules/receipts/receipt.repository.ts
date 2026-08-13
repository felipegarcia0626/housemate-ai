import { getSupabaseAdminClient } from "@/infrastructure/database/client";

import type {
  Receipt,
  ReceiptAnalysis,
  ReceiptProcessingStatus,
} from "./receipt.types";

type ReceiptRow = {
  id: string;
  household_id: string;
  conversation_key: string;
  storage_path: string;
  original_filename: string;
  mime_type: string;
  uploaded_at: string;
  processing_status: ReceiptProcessingStatus;
  analysis_payload: ReceiptAnalysis | null;
};

export type ReceiptRepositoryErrorKind =
  "CONFLICT" | "NOT_FOUND" | "INTEGRITY" | "TECHNICAL";

export class ReceiptRepositoryError extends Error {
  readonly kind: ReceiptRepositoryErrorKind;

  constructor(kind: ReceiptRepositoryErrorKind, cause: unknown) {
    super("Unable to access receipts.", { cause });
    this.name = "ReceiptRepositoryError";
    this.kind = kind;
  }
}

const receiptColumns =
  "id,household_id,conversation_key,storage_path,original_filename,mime_type,uploaded_at,processing_status,analysis_payload";

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? typeof error.code === "string"
      ? error.code
      : undefined
    : undefined;
}

function mapError(error: unknown): ReceiptRepositoryErrorKind {
  const code = errorCode(error);
  if (code === "23505") return "CONFLICT";
  if (["22023", "22P02", "23503", "23514"].includes(code ?? "")) {
    return "INTEGRITY";
  }
  return "TECHNICAL";
}

function mapReceipt(row: ReceiptRow): Receipt {
  const analysis = row.analysis_payload ?? {
    merchant: null,
    date: null,
    totalAmount: null,
    items: [],
    missingFields: ["merchant", "date", "totalAmount"],
  };

  return {
    id: row.id,
    householdId: row.household_id,
    conversationKey: row.conversation_key,
    storagePath: row.storage_path,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    uploadedAt: row.uploaded_at,
    processingStatus: row.processing_status,
    analysis,
  };
}

export async function findActiveReceipt(
  householdId: string,
  conversationKey: string,
): Promise<Receipt | null> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_receipts")
    .select(receiptColumns)
    .eq("household_id", householdId)
    .eq("conversation_key", conversationKey)
    .is("expense_id", null)
    .in("processing_status", ["PENDING", "FAILED"])
    .maybeSingle();

  if (error) throw new ReceiptRepositoryError(mapError(error), error);
  return data === null ? null : mapReceipt(data as ReceiptRow);
}

export async function findReceipt(
  receiptId: string,
  householdId: string,
  conversationKey: string,
): Promise<Receipt | null> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_receipts")
    .select(receiptColumns)
    .eq("id", receiptId)
    .eq("household_id", householdId)
    .eq("conversation_key", conversationKey)
    .maybeSingle();

  if (error) throw new ReceiptRepositoryError(mapError(error), error);
  return data === null ? null : mapReceipt(data as ReceiptRow);
}

export async function createReceipt(input: {
  id: string;
  householdId: string;
  conversationKey: string;
  storagePath: string;
  originalFilename: string;
  mimeType: string;
  analysis: ReceiptAnalysis;
}): Promise<Receipt> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_receipts")
    .insert({
      id: input.id,
      household_id: input.householdId,
      conversation_key: input.conversationKey,
      storage_path: input.storagePath,
      original_filename: input.originalFilename,
      mime_type: input.mimeType,
      processing_status: "PENDING",
      analysis_payload: input.analysis,
    })
    .select(receiptColumns)
    .single();

  if (error) throw new ReceiptRepositoryError(mapError(error), error);
  if (data === null) {
    throw new ReceiptRepositoryError(
      "TECHNICAL",
      new Error("Receipt insert returned no representation."),
    );
  }
  return mapReceipt(data as ReceiptRow);
}

export async function updateReceiptAnalysis(input: {
  receiptId: string;
  householdId: string;
  conversationKey: string;
  processingStatus: ReceiptProcessingStatus;
  analysis: ReceiptAnalysis;
}): Promise<Receipt> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_receipts")
    .update({
      processing_status: input.processingStatus,
      analysis_payload: input.analysis,
    })
    .eq("id", input.receiptId)
    .eq("household_id", input.householdId)
    .eq("conversation_key", input.conversationKey)
    .select(receiptColumns)
    .maybeSingle();

  if (error) throw new ReceiptRepositoryError(mapError(error), error);
  if (data === null) {
    throw new ReceiptRepositoryError(
      "NOT_FOUND",
      new Error("Receipt was not found in the current context."),
    );
  }
  return mapReceipt(data as ReceiptRow);
}

export async function deleteReceipt(input: {
  receiptId: string;
  householdId: string;
  conversationKey: string;
}): Promise<void> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_receipts")
    .delete()
    .eq("id", input.receiptId)
    .eq("household_id", input.householdId)
    .eq("conversation_key", input.conversationKey)
    .select("id")
    .maybeSingle();

  if (error) throw new ReceiptRepositoryError(mapError(error), error);
  if (data === null) {
    throw new ReceiptRepositoryError(
      "NOT_FOUND",
      new Error("Receipt was not found in the current context."),
    );
  }
}
