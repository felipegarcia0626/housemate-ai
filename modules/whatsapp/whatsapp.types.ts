import type { AgentContext } from "@/modules/agent/agent.types";

export interface WhatsAppContext extends AgentContext {
  source: "WHATSAPP";
  whatsappExecution: NonNullable<AgentContext["whatsappExecution"]>;
}

export interface WhatsAppProcessResult {
  status: "PROCESSED" | "DUPLICATE";
}

export type WhatsAppDomainErrorCode =
  | "VALIDATION_ERROR"
  | "CONTEXT_UNAVAILABLE"
  | "PERSISTENCE_ERROR"
  | "PROCESSING_BUSY"
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
