import {
  resolveAuthenticatedContext,
} from "@/modules/context/authenticated-context.service";
import { AuthenticatedContextError } from "@/modules/context/authenticated-context.types";
import { processAgentMessage } from "@/modules/agent/conversation.service";
import { AgentDomainError } from "@/modules/agent/agent.types";

function diagnosticRequestId(request: Request): string {
  const value = request.headers.get("x-e2e-request-id") ?? "";
  return /^e2e-[a-z0-9-]{8,80}$/i.test(value) ? value : "local";
}

function diagnosticError(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== "object") return { name: "UnknownError" };
  const value = error as { name?: unknown; code?: unknown; status?: unknown };
  return {
    name: typeof value.name === "string" ? value.name : "Error",
    code: typeof value.code === "string" ? value.code : null,
    status: typeof value.status === "number" ? value.status : null,
  };
}

function invalidRequest(): Response {
  return Response.json(
    {
      error: {
        code: "VALIDATION_ERROR",
        message: "Solicitud inválida.",
      },
    },
    { status: 400 },
  );
}

function internalError(): Response {
  return Response.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "No fue posible completar la operación.",
      },
    },
    { status: 500 },
  );
}

function contextErrorResponse(error: AuthenticatedContextError): Response {
  switch (error.code) {
    case "UNAUTHENTICATED":
      return Response.json(
        { error: { code: "UNAUTHENTICATED", message: "Se requiere una sesión autenticada." } },
        { status: 401 },
      );
    case "APPLICATION_USER_NOT_FOUND":
      return Response.json(
        { error: { code: "APPLICATION_USER_NOT_FOUND", message: "La identidad autenticada no tiene acceso a la aplicación." } },
        { status: 403 },
      );
    case "NO_ACTIVE_MEMBERSHIP":
      return Response.json(
        { error: { code: "NO_ACTIVE_MEMBERSHIP", message: "La identidad autenticada no tiene un hogar activo." } },
        { status: 403 },
      );
    case "HOUSEHOLD_SELECTION_REQUIRED":
      return Response.json(
        { error: { code: "HOUSEHOLD_SELECTION_REQUIRED", message: "Debes seleccionar un hogar antes de continuar." } },
        { status: 409 },
      );
    default:
      return internalError();
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = diagnosticRequestId(request);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidRequest();
  }

  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    typeof (body as { message?: unknown }).message !== "string" ||
    (body as { message: string }).message.trim().length === 0
  ) {
    return invalidRequest();
  }

  try {
    console.info("[agent]", JSON.stringify({ requestId, stage: "context_start" }));
    const authenticated = await resolveAuthenticatedContext();
    const context = {
      householdId: authenticated.householdId,
      actorMemberId: authenticated.memberId,
      conversationKey: `web:${authenticated.householdId}:${authenticated.memberId}`,
      source: "WEB" as const,
    };
    const result = await processAgentMessage(context, {
      message: (body as { message: string }).message,
    });
    console.info("[agent]", JSON.stringify({ requestId, stage: "completed", resultType: result.type }));
    return Response.json({ data: result });
  } catch (error) {
    console.error("[agent]", JSON.stringify({
      requestId,
      stage: "failed",
      error: diagnosticError(error),
    }));
    if (error instanceof AuthenticatedContextError) {
      return contextErrorResponse(error);
    }
    if (error instanceof AgentDomainError) return internalError();
    return internalError();
  }
}
