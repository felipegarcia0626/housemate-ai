import { createHash, randomBytes } from "node:crypto";
import { getAuthenticatedAuthUser } from "@/infrastructure/auth/supabase-server.client";
import {
  cancelWhatsAppLinkChallenge,
  readWhatsAppLinkState,
  startWhatsAppLinkChallenge,
  WhatsAppLinkingError,
} from "./whatsapp-linking.repository";
import type { StartWhatsAppLinkHttpResult } from "./whatsapp-linking.types";
export { WhatsAppLinkingError };

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value))
    throw new WhatsAppLinkingError("VALIDATION_ERROR");
  return value.toLowerCase();
}

export function normalizeWhatsAppPhoneNumber(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !/^\+[0-9 ()-]+$/.test(value.trim())
  )
    throw new WhatsAppLinkingError("VALIDATION_ERROR");
  const sender = value
    .trim()
    .slice(1)
    .replace(/[ ()-]/g, "");
  if (!/^[1-9][0-9]{7,14}$/.test(sender))
    throw new WhatsAppLinkingError("VALIDATION_ERROR");
  return sender;
}

async function authIdentity(): Promise<string> {
  const auth = await getAuthenticatedAuthUser();
  if (!auth.email?.trim() || !auth.emailConfirmedAt)
    throw new WhatsAppLinkingError("ACCOUNT_NOT_ELIGIBLE");
  return auth.id;
}

export async function getWhatsAppLinkState() {
  return readWhatsAppLinkState(await authIdentity());
}

export async function initiateWhatsAppLink(input: {
  phoneNumber: unknown;
  idempotencyKey: unknown;
}): Promise<StartWhatsAppLinkHttpResult> {
  const authUserId = await authIdentity();
  const sender = normalizeWhatsAppPhoneNumber(input.phoneNumber);
  const challengeId = uuid(input.idempotencyKey);
  const state = await readWhatsAppLinkState(authUserId);
  // The database stores only a digest. A response lost after COMMIT cannot be recovered.
  if (state.challenge?.id === challengeId)
    return { status: "RESTART_REQUIRED", challengeId };
  const secret = randomBytes(32).toString("base64url");
  const result = await startWhatsAppLinkChallenge({
    p_auth_user_id: authUserId,
    p_challenge_id: challengeId,
    p_idempotency_key: challengeId,
    p_sender: sender,
    p_code_digest: createHash("sha256").update(secret, "utf8").digest("hex"),
  });
  switch (result.status) {
    case "PENDING":
      return {
        status: "PENDING",
        challengeId,
        expiresAt: result.expiresAt,
        verificationMessage: `VINCULAR ${challengeId} ${secret}`,
      };
    case "ALREADY_LINKED":
    case "UNAVAILABLE":
    case "RATE_LIMITED":
      return { status: result.status };
    default:
      return { status: "RESTART_REQUIRED", challengeId };
  }
}

export async function cancelPendingWhatsAppLink(challengeId: unknown) {
  const authUserId = await authIdentity();
  return cancelWhatsAppLinkChallenge(authUserId, uuid(challengeId));
}
