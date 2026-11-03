/** SQL and authenticated HTTP contracts; no webhook integration yet. */
export type WhatsAppLinkChallengeStatus =
  "PENDING" | "CONSUMED" | "CANCELLED" | "EXPIRED" | "EXHAUSTED";

export interface StartWhatsAppLinkChallengeArgs {
  p_auth_user_id: string;
  p_challenge_id: string;
  p_sender: string;
  p_code_digest: string;
  p_idempotency_key: string;
}

export type StartWhatsAppLinkChallengeResult =
  | {
      status: WhatsAppLinkChallengeStatus;
      challengeId: string;
      expiresAt: string;
    }
  | {
      status:
        | "IDEMPOTENCY_CONFLICT"
        | "ALREADY_LINKED"
        | "UNAVAILABLE"
        | "RATE_LIMITED";
    };

export interface CancelWhatsAppLinkChallengeArgs {
  p_auth_user_id: string;
  p_challenge_id: string;
}

export type CancelWhatsAppLinkChallengeResult =
  | { status: "NOT_FOUND" }
  | {
      status: Exclude<WhatsAppLinkChallengeStatus, "PENDING">;
      challengeId: string;
    };

export interface CompleteWhatsAppLinkChallengeArgs {
  p_challenge_id: string;
  p_sender: string;
  p_code_digest: string;
  p_external_event_id: string;
}

export type CompleteWhatsAppLinkChallengeResult =
  | { status: "LINKED"; linkId: string }
  | { status: "INVALID" | "UNAVAILABLE" | "RATE_LIMITED" | "EVENT_CONFLICT" };

export interface WhatsAppLinkState {
  link: {
    id: string;
    authorizationVersion: number;
    verifiedAt: string;
  } | null;
  challenge: {
    id: string;
    status: WhatsAppLinkChallengeStatus;
    expiresAt: string;
    attemptsRemaining: number;
  } | null;
}

/** Only the first successful creation response carries the verification message. */
export type StartWhatsAppLinkHttpResult =
  | {
      status: "PENDING";
      challengeId: string;
      expiresAt: string;
      verificationMessage: string;
    }
  | { status: "RESTART_REQUIRED"; challengeId: string }
  | { status: "ALREADY_LINKED" | "UNAVAILABLE" | "RATE_LIMITED" };
