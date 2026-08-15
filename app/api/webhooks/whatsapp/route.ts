import {
  verifyWhatsAppWebhook,
  verifyWhatsAppSignature,
  WhatsAppAdapterError,
} from "@/infrastructure/whatsapp/whatsapp.adapter";
import {
  parseWhatsAppPayload,
  processWhatsAppTextMessage,
} from "@/modules/whatsapp/whatsapp.service";
import { WhatsAppDomainError } from "@/modules/whatsapp/whatsapp.types";

function errorResponse(
  status: number,
  code: "VALIDATION_ERROR" | "INTERNAL_ERROR",
  message: string,
): Response {
  return Response.json({ error: { code, message } }, { status });
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  try {
    const challenge = verifyWhatsAppWebhook(
      url.searchParams.get("hub.mode"),
      url.searchParams.get("hub.verify_token"),
      url.searchParams.get("hub.challenge"),
    );
    return new Response(challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch (error) {
    if (error instanceof WhatsAppAdapterError) {
      return errorResponse(403, "VALIDATION_ERROR", "Solicitud inválida.");
    }
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "No fue posible completar la operación.",
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return errorResponse(400, "VALIDATION_ERROR", "Solicitud inválida.");
  }

  try {
    verifyWhatsAppSignature(
      rawBody,
      request.headers.get("x-hub-signature-256"),
    );
  } catch (error) {
    if (error instanceof WhatsAppAdapterError) {
      return errorResponse(403, "VALIDATION_ERROR", "Solicitud inválida.");
    }
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "No fue posible completar la operación.",
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return errorResponse(400, "VALIDATION_ERROR", "Solicitud inválida.");
  }

  const message = parseWhatsAppPayload(payload);
  if (!message) return Response.json({ ok: true, ignored: true });

  try {
    const result = await processWhatsAppTextMessage(message);
    return Response.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof WhatsAppDomainError) {
      return errorResponse(
        500,
        "INTERNAL_ERROR",
        "No fue posible procesar el mensaje.",
      );
    }
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "No fue posible procesar el mensaje.",
    );
  }
}
