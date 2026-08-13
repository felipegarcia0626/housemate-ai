import { getSupabaseAdminClient } from "@/infrastructure/database/client";

export class ReceiptStorageAdapterError extends Error {
  constructor(cause?: unknown) {
    super("Receipt storage is unavailable.", { cause });
    this.name = "ReceiptStorageAdapterError";
  }
}

function bucketName(): string {
  const value = process.env.SUPABASE_RECEIPTS_BUCKET;
  if (!value || value.trim().length === 0) {
    throw new ReceiptStorageAdapterError();
  }
  return value;
}

export async function uploadReceiptImage(input: {
  path: string;
  bytes: Uint8Array;
  mimeType: string;
}): Promise<void> {
  try {
    const copy = new Uint8Array(input.bytes.byteLength);
    copy.set(input.bytes);
    const { error } = await getSupabaseAdminClient()
      .storage.from(bucketName())
      .upload(
        input.path,
        new Blob([copy.buffer as ArrayBuffer], { type: input.mimeType }),
        {
          contentType: input.mimeType,
          upsert: false,
        },
      );
    if (error) throw error;
  } catch (error) {
    if (error instanceof ReceiptStorageAdapterError) throw error;
    throw new ReceiptStorageAdapterError(error);
  }
}

export async function downloadReceiptImage(path: string): Promise<Uint8Array> {
  try {
    const { data, error } = await getSupabaseAdminClient()
      .storage.from(bucketName())
      .download(path);
    if (error || data === null)
      throw error ?? new Error("Receipt file missing.");
    return new Uint8Array(await data.arrayBuffer());
  } catch (error) {
    if (error instanceof ReceiptStorageAdapterError) throw error;
    throw new ReceiptStorageAdapterError(error);
  }
}

export async function deleteReceiptImage(path: string): Promise<void> {
  try {
    const { error } = await getSupabaseAdminClient()
      .storage.from(bucketName())
      .remove([path]);
    if (error) throw error;
  } catch (error) {
    if (error instanceof ReceiptStorageAdapterError) throw error;
    throw new ReceiptStorageAdapterError(error);
  }
}
