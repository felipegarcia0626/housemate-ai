export interface WhatsAppContext {
  householdId: string;
  actorMemberId: string;
  conversationKey: string;
  source: "WHATSAPP";
}

export interface WhatsAppProcessResult {
  status: "PROCESSED" | "DUPLICATE";
}

export type WhatsAppDomainErrorCode =
  | "VALIDATION_ERROR"
  | "CONTEXT_UNAVAILABLE"
  | "PERSISTENCE_ERROR"
  | "AGENT_ERROR"
  | "PROVIDER_ERROR";

export class WhatsAppDomainError extends Error {
  readonly code: WhatsAppDomainErrorCode;

  constructor(code: WhatsAppDomainErrorCode, message: string) {
    super(message);
    this.name = "WhatsAppDomainError";
    this.code = code;
  }
}
