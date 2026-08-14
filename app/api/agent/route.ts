import {
  getConfiguredHttpActorContext,
  getConfiguredHttpConversationKey,
} from "@/app/api/_lib/http-context";
import { processAgentMessage } from "@/modules/agent/conversation.service";
import { AgentDomainError } from "@/modules/agent/agent.types";

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

export async function POST(request: Request): Promise<Response> {
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
    const actor = await getConfiguredHttpActorContext();
    const context = {
      householdId: actor.householdId,
      actorMemberId: actor.memberId,
      conversationKey: getConfiguredHttpConversationKey(),
      source: "WEB" as const,
    };
    const result = await processAgentMessage(context, {
      message: (body as { message: string }).message,
    });
    return Response.json({ data: result });
  } catch (error) {
    if (error instanceof AgentDomainError) return internalError();
    return internalError();
  }
}
