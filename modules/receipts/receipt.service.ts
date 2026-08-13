import { randomUUID } from "node:crypto";
import { analyzeReceiptImage } from "@/infrastructure/openai/receipt-ocr.adapter";
import {
  deleteReceiptImage,
  downloadReceiptImage,
  ReceiptStorageAdapterError,
  uploadReceiptImage,
} from "@/infrastructure/storage/receipt-storage.adapter";
import {
  createReceipt as createReceiptInRepository,
  deleteReceipt as deleteReceiptInRepository,
  findActiveReceipt,
  findReceipt,
  ReceiptRepositoryError,
  updateReceiptAnalysis,
} from "./receipt.repository";
import {
  deriveMissingFields,
  isCompleteAnalysis,
  validateReceiptAnalysis,
  validateReceiptClarifications,
  validateReceiptContext,
  validateReceiptId,
  validateReceiptImage,
} from "./receipt.validation";
import {
  ReceiptDomainError,
  type Receipt,
  type ReceiptAnalysis,
  type ReceiptAnalysisRequest,
  type ReceiptClarifications,
  type ReceiptServiceContext,
} from "./receipt.types";

export interface ReceiptServiceDependencies {
  analyzeImage: typeof analyzeReceiptImage;
  uploadImage: typeof uploadReceiptImage;
  downloadImage: typeof downloadReceiptImage;
  deleteImage: typeof deleteReceiptImage;
}

const defaultDependencies: ReceiptServiceDependencies = {
  analyzeImage: analyzeReceiptImage,
  uploadImage: uploadReceiptImage,
  downloadImage: downloadReceiptImage,
  deleteImage: deleteReceiptImage,
};

function persistenceError(): ReceiptDomainError {
  return new ReceiptDomainError(
    "PERSISTENCE_ERROR",
    "Receipt could not be persisted.",
  );
}

function notFoundError(): ReceiptDomainError {
  return new ReceiptDomainError(
    "NOT_FOUND",
    "Receipt was not found in the current context.",
  );
}

function mapRepositoryError(error: unknown): ReceiptDomainError {
  if (error instanceof ReceiptRepositoryError) {
    if (error.kind === "CONFLICT") {
      return new ReceiptDomainError(
        "ACTIVE_RECEIPT_EXISTS",
        "An active receipt already exists for this conversation.",
      );
    }
    if (error.kind === "NOT_FOUND") return notFoundError();
    if (error.kind === "INTEGRITY") {
      return new ReceiptDomainError(
        "VALIDATION_ERROR",
        "Receipt data is no longer valid.",
      );
    }
  }
  return persistenceError();
}

function emptyAnalysis(): ReceiptAnalysis {
  return {
    merchant: null,
    date: null,
    totalAmount: null,
    items: [],
    missingFields: ["merchant", "date", "totalAmount"],
  };
}

function normalizedAnalysis(analysis: ReceiptAnalysis): ReceiptAnalysis {
  const normalized: ReceiptAnalysis = {
    merchant: analysis.merchant?.trim() || null,
    date: analysis.date,
    totalAmount: analysis.totalAmount,
    items: analysis.items,
    missingFields: [],
  };
  normalized.missingFields = deriveMissingFields(normalized);
  validateReceiptAnalysis(normalized);
  return normalized;
}

function mergeAnalysis(
  analysis: ReceiptAnalysis,
  clarifications: ReceiptClarifications,
): ReceiptAnalysis {
  return normalizedAnalysis({
    merchant:
      clarifications.merchant === undefined
        ? analysis.merchant
        : clarifications.merchant,
    date:
      clarifications.date === undefined ? analysis.date : clarifications.date,
    totalAmount:
      clarifications.totalAmount === undefined
        ? analysis.totalAmount
        : clarifications.totalAmount,
    items:
      clarifications.items === undefined
        ? analysis.items
        : clarifications.items,
    missingFields: [],
  });
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "jpg";
}

function mapReceiptResult(receipt: Receipt): Receipt {
  return {
    ...receipt,
    analysis: normalizedAnalysis(receipt.analysis),
  };
}

async function markFailed(
  context: ReceiptServiceContext,
  receipt: Receipt,
): Promise<void> {
  try {
    await updateReceiptAnalysis({
      receiptId: receipt.id,
      householdId: context.householdId,
      conversationKey: context.conversationKey,
      processingStatus: "FAILED",
      analysis: receipt.analysis,
    });
  } catch {
    // The original analysis error remains the public result. Persistence details
    // are intentionally not exposed by this boundary.
  }
}

async function runImageAnalysis(
  context: ReceiptServiceContext,
  receipt: Receipt,
  bytes: Uint8Array,
  mimeType: string,
  dependencies: ReceiptServiceDependencies,
): Promise<Receipt> {
  let analysis: ReceiptAnalysis;
  try {
    analysis = normalizedAnalysis(
      await dependencies.analyzeImage({ bytes, mimeType }),
    );
  } catch (error) {
    await markFailed(context, receipt);
    if (error instanceof ReceiptDomainError) throw error;
    const receiptId = receipt.id;
    throw new ReceiptDomainError(
      "ANALYSIS_ERROR",
      "Receipt analysis could not be completed.",
      receiptId,
    );
  }

  try {
    return mapReceiptResult(
      await updateReceiptAnalysis({
        receiptId: receipt.id,
        householdId: context.householdId,
        conversationKey: context.conversationKey,
        processingStatus: isCompleteAnalysis(analysis)
          ? "PROCESSED"
          : "PENDING",
        analysis,
      }),
    );
  } catch (error) {
    throw mapRepositoryError(error);
  }
}

export async function analyzeReceipt(
  context: ReceiptServiceContext,
  request: ReceiptAnalysisRequest,
  dependencies: ReceiptServiceDependencies = defaultDependencies,
): Promise<Receipt> {
  try {
    validateReceiptContext(context.householdId, context.conversationKey);

    if (request.kind === "NEW") {
      validateReceiptImage(request.image);
      if (
        await findActiveReceipt(context.householdId, context.conversationKey)
      ) {
        throw new ReceiptDomainError(
          "ACTIVE_RECEIPT_EXISTS",
          "An active receipt already exists for this conversation.",
        );
      }

      const id = randomUUID();
      const storagePath = `receipts/${id}.${extensionForMimeType(request.image.mimeType)}`;
      const initialAnalysis = emptyAnalysis();
      try {
        await dependencies.uploadImage({
          path: storagePath,
          bytes: request.image.bytes,
          mimeType: request.image.mimeType,
        });
      } catch (error) {
        if (error instanceof ReceiptStorageAdapterError) {
          throw persistenceError();
        }
        throw persistenceError();
      }

      let receipt: Receipt;
      try {
        receipt = await createReceiptInRepository({
          id,
          householdId: context.householdId,
          conversationKey: context.conversationKey,
          storagePath,
          originalFilename: request.image.originalFilename,
          mimeType: request.image.mimeType,
          analysis: initialAnalysis,
        });
      } catch (error) {
        try {
          await dependencies.deleteImage(storagePath);
        } catch {
          // Preserve the original sanitized persistence result.
        }
        throw mapRepositoryError(error);
      }

      return await runImageAnalysis(
        context,
        receipt,
        request.image.bytes,
        request.image.mimeType,
        dependencies,
      );
    }

    validateReceiptId(request.receiptId);
    const receipt = await findReceipt(
      request.receiptId,
      context.householdId,
      context.conversationKey,
    );
    if (!receipt) throw notFoundError();

    if (request.kind === "CLARIFY") {
      if (receipt.processingStatus !== "PENDING") {
        throw new ReceiptDomainError(
          "VALIDATION_ERROR",
          "Only a pending receipt can receive clarifications.",
        );
      }
      validateReceiptClarifications(request.clarifications);
      const analysis = mergeAnalysis(receipt.analysis, request.clarifications);
      try {
        return mapReceiptResult(
          await updateReceiptAnalysis({
            receiptId: receipt.id,
            householdId: context.householdId,
            conversationKey: context.conversationKey,
            processingStatus: isCompleteAnalysis(analysis)
              ? "PROCESSED"
              : "PENDING",
            analysis,
          }),
        );
      } catch (error) {
        throw mapRepositoryError(error);
      }
    }

    if (receipt.processingStatus !== "FAILED") {
      throw new ReceiptDomainError(
        "VALIDATION_ERROR",
        "Only a failed receipt can be retried.",
      );
    }

    let bytes: Uint8Array;
    try {
      bytes = await dependencies.downloadImage(receipt.storagePath);
      await updateReceiptAnalysis({
        receiptId: receipt.id,
        householdId: context.householdId,
        conversationKey: context.conversationKey,
        processingStatus: "PENDING",
        analysis: receipt.analysis,
      });
    } catch (error) {
      if (error instanceof ReceiptRepositoryError) {
        throw mapRepositoryError(error);
      }
      await markFailed(context, receipt);
      throw new ReceiptDomainError(
        "ANALYSIS_ERROR",
        "Receipt analysis could not be completed.",
        receipt.id,
      );
    }
    return await runImageAnalysis(
      context,
      receipt,
      bytes,
      receipt.mimeType,
      dependencies,
    );
  } catch (error) {
    if (error instanceof ReceiptDomainError) throw error;
    if (error instanceof ReceiptRepositoryError)
      throw mapRepositoryError(error);
    throw persistenceError();
  }
}

export async function cancelReceipt(
  context: ReceiptServiceContext,
  receiptId: string,
  dependencies: ReceiptServiceDependencies = defaultDependencies,
): Promise<void> {
  try {
    validateReceiptContext(context.householdId, context.conversationKey);
    validateReceiptId(receiptId);
    const receipt = await findReceipt(
      receiptId,
      context.householdId,
      context.conversationKey,
    );
    if (!receipt) throw notFoundError();
    await dependencies.deleteImage(receipt.storagePath);
    await deleteReceiptInRepository({
      receiptId,
      householdId: context.householdId,
      conversationKey: context.conversationKey,
    });
  } catch (error) {
    if (error instanceof ReceiptDomainError) throw error;
    if (error instanceof ReceiptRepositoryError)
      throw mapRepositoryError(error);
    throw persistenceError();
  }
}
