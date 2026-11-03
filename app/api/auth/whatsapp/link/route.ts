import { SupabaseAuthError } from "@/infrastructure/auth/supabase-server.client";
import {
  cancelPendingWhatsAppLink,
  getWhatsAppLinkState,
  initiateWhatsAppLink,
  WhatsAppLinkingError,
} from "@/modules/whatsapp/whatsapp-linking.service";

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function failure(error: unknown): Response {
  if (error instanceof SupabaseAuthError && error.code === "UNAUTHENTICATED")
    return json(
      {
        error: {
          code: "UNAUTHENTICATED",
          message: "Se requiere una sesión autenticada.",
        },
      },
      401,
    );
  if (error instanceof WhatsAppLinkingError) {
    if (error.code === "VALIDATION_ERROR")
      return json(
        { error: { code: error.code, message: "Solicitud inválida." } },
        400,
      );
    if (error.code === "ACCOUNT_NOT_ELIGIBLE")
      return json(
        {
          error: {
            code: error.code,
            message: "La cuenta no está habilitada para vincular WhatsApp.",
          },
        },
        403,
      );
    if (error.code === "CHALLENGE_OUTCOME_UNKNOWN")
      return json(
        {
          error: {
            code: error.code,
            message:
              "No se pudo confirmar el resultado. Consulta el estado; el código no puede recuperarse. Cancela el desafío pendiente y reinicia con otra clave cuando el límite lo permita.",
          },
        },
        503,
      );
  }
  return json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "No fue posible completar la operación.",
      },
    },
    500,
  );
}

async function body(
  request: Request,
  keys: string[],
): Promise<Record<string, unknown>> {
  if (
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
    "application/json"
  )
    throw new WhatsAppLinkingError("VALIDATION_ERROR");
  try {
    const text = await request.text();
    if (text.length > 4096) throw new WhatsAppLinkingError("VALIDATION_ERROR");
    const value: unknown = JSON.parse(text);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !keys.includes(key)) ||
      keys.some((key) => !(key in value))
    )
      throw new WhatsAppLinkingError("VALIDATION_ERROR");
    return value as Record<string, unknown>;
  } catch {
    throw new WhatsAppLinkingError("VALIDATION_ERROR");
  }
}

export async function GET(): Promise<Response> {
  try {
    return json({ data: await getWhatsAppLinkState() });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const input = await body(request, ["phoneNumber", "idempotencyKey"]);
    const result = await initiateWhatsAppLink({
      phoneNumber: input.phoneNumber,
      idempotencyKey: input.idempotencyKey,
    });
    return json(
      { data: result },
      result.status === "PENDING"
        ? 201
        : result.status === "RATE_LIMITED"
          ? 429
          : 409,
    );
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    const input = await body(request, ["challengeId"]);
    const result = await cancelPendingWhatsAppLink(input.challengeId);
    return json({ data: result }, result.status === "NOT_FOUND" ? 404 : 200);
  } catch (error) {
    return failure(error);
  }
}
