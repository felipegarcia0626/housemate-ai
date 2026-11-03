import { getSupabaseAdminClient } from "@/infrastructure/database/client";
import type {
  CancelWhatsAppLinkChallengeResult,
  StartWhatsAppLinkChallengeArgs,
  StartWhatsAppLinkChallengeResult,
  WhatsAppLinkState,
  WhatsAppLinkChallengeStatus,
} from "./whatsapp-linking.types";

export class WhatsAppLinkingError extends Error {
  constructor(
    readonly code:
      | "VALIDATION_ERROR"
      | "ACCOUNT_NOT_ELIGIBLE"
      | "INTERNAL_ERROR"
      | "CHALLENGE_OUTCOME_UNKNOWN",
  ) {
    super("WhatsApp linking request could not be completed.");
    this.name = "WhatsAppLinkingError";
  }
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const date = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const statuses = ["PENDING", "CONSUMED", "CANCELLED", "EXPIRED", "EXHAUSTED"];

async function rpc(
  name: string,
  args: Record<string, unknown>,
  creation = false,
) {
  try {
    const { data, error } = await getSupabaseAdminClient().rpc(name, args);
    if (error?.code === "42501")
      throw new WhatsAppLinkingError(
        error.message === "WhatsApp linking is unavailable"
          ? "ACCOUNT_NOT_ELIGIBLE"
          : "INTERNAL_ERROR",
      );
    if (error)
      throw new WhatsAppLinkingError(
        creation ? "CHALLENGE_OUTCOME_UNKNOWN" : "INTERNAL_ERROR",
      );
    return data as unknown;
  } catch (error) {
    if (error instanceof WhatsAppLinkingError) throw error;
    // Do not retain raw provider errors, request arguments or secret material.
    throw new WhatsAppLinkingError(
      creation ? "CHALLENGE_OUTCOME_UNKNOWN" : "INTERNAL_ERROR",
    );
  }
}

export async function readWhatsAppLinkState(
  authUserId: string,
): Promise<WhatsAppLinkState> {
  const result = await rpc("fn_get_whatsapp_link_state", {
    p_auth_user_id: authUserId,
  });
  if (!object(result)) throw new WhatsAppLinkingError("INTERNAL_ERROR");
  const link = result.link;
  const challenge = result.challenge;
  if (
    link !== null &&
    (!object(link) ||
      typeof link.id !== "string" ||
      !UUID.test(link.id) ||
      !Number.isSafeInteger(link.authorizationVersion) ||
      (link.authorizationVersion as number) < 1 ||
      !date(link.verifiedAt))
  )
    throw new WhatsAppLinkingError("INTERNAL_ERROR");
  if (
    challenge !== null &&
    (!object(challenge) ||
      typeof challenge.id !== "string" ||
      !UUID.test(challenge.id) ||
      !statuses.includes(challenge.status as string) ||
      !date(challenge.expiresAt) ||
      !Number.isInteger(challenge.attemptsRemaining) ||
      (challenge.attemptsRemaining as number) < 0 ||
      (challenge.attemptsRemaining as number) > 5)
  )
    throw new WhatsAppLinkingError("INTERNAL_ERROR");
  // Explicit projection: never forward arbitrary RPC fields to HTTP.
  return {
    link:
      link === null
        ? null
        : {
            id: link.id as string,
            authorizationVersion: link.authorizationVersion as number,
            verifiedAt: link.verifiedAt as string,
          },
    challenge:
      challenge === null
        ? null
        : {
            id: challenge.id as string,
            status: challenge.status as WhatsAppLinkChallengeStatus,
            expiresAt: challenge.expiresAt as string,
            attemptsRemaining: challenge.attemptsRemaining as number,
          },
  };
}

export async function startWhatsAppLinkChallenge(
  args: StartWhatsAppLinkChallengeArgs,
): Promise<StartWhatsAppLinkChallengeResult> {
  const result = await rpc(
    "fn_start_whatsapp_link_challenge",
    { ...args },
    true,
  );
  if (!object(result) || typeof result.status !== "string")
    throw new WhatsAppLinkingError("CHALLENGE_OUTCOME_UNKNOWN");
  if (statuses.includes(result.status)) {
    if (result.challengeId !== args.p_challenge_id || !date(result.expiresAt))
      throw new WhatsAppLinkingError("CHALLENGE_OUTCOME_UNKNOWN");
    return {
      status: result.status as
        "PENDING" | "CONSUMED" | "CANCELLED" | "EXPIRED" | "EXHAUSTED",
      challengeId: args.p_challenge_id,
      expiresAt: result.expiresAt,
    };
  }
  if (
    ![
      "IDEMPOTENCY_CONFLICT",
      "ALREADY_LINKED",
      "UNAVAILABLE",
      "RATE_LIMITED",
    ].includes(result.status)
  )
    throw new WhatsAppLinkingError("CHALLENGE_OUTCOME_UNKNOWN");
  return {
    status: result.status as
      | "IDEMPOTENCY_CONFLICT"
      | "ALREADY_LINKED"
      | "UNAVAILABLE"
      | "RATE_LIMITED",
  };
}

export async function cancelWhatsAppLinkChallenge(
  authUserId: string,
  challengeId: string,
): Promise<CancelWhatsAppLinkChallengeResult> {
  const result = await rpc("fn_cancel_whatsapp_link_challenge", {
    p_auth_user_id: authUserId,
    p_challenge_id: challengeId,
  });
  if (!object(result)) throw new WhatsAppLinkingError("INTERNAL_ERROR");
  if (result.status === "NOT_FOUND") return { status: "NOT_FOUND" };
  if (
    !statuses
      .filter((s) => s !== "PENDING")
      .includes(result.status as string) ||
    result.challengeId !== challengeId
  )
    throw new WhatsAppLinkingError("INTERNAL_ERROR");
  return {
    status: result.status as Exclude<WhatsAppLinkChallengeStatus, "PENDING">,
    challengeId,
  };
}
