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
    console.info("[whatsapp-debug] stage=body_read_failed");
    return errorResponse(400, "VALIDATION_ERROR", "Solicitud inválida.");
  }

  try {
    verifyWhatsAppSignature(
      rawBody,
      request.headers.get("x-hub-signature-256"),
    );
  } catch (error) {
    if (error instanceof WhatsAppAdapterError) {
      console.info("[whatsapp-debug] stage=hmac_rejected");
      return errorResponse(403, "VALIDATION_ERROR", "Solicitud inválida.");
    }
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "No fue posible completar la operación.",
    );
  }
  console.info("[whatsapp-debug] stage=hmac_validated");

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    console.info("[whatsapp-debug] stage=json_parse_failed");
    return errorResponse(400, "VALIDATION_ERROR", "Solicitud inválida.");
  }
  console.info("[whatsapp-debug] stage=json_parsed");

  const message = parseWhatsAppPayload(payload);
  console.info(
    `[whatsapp-debug] stage=payload_parsed recognized=${String(Boolean(message))}`,
  );
  if (!message) {
    console.info("[whatsapp-debug] stage=payload_ignored");
    const response = Response.json({ ok: true, ignored: true });
    console.info(
      `[whatsapp-debug] stage=response_sent status=${response.status}`,
    );
    return response;
  }
  console.info(
    `[whatsapp-debug] stage=text_extracted event_id_present=${String(Boolean(message.eventId))} event_id_length=${message.eventId.length} text_length=${message.text.length} sender_present=${String(Boolean(message.sender))} phone_number_id_present=${String(Boolean(message.phoneNumberId))}`,
  );

  try {
    console.info("[whatsapp-debug] stage=processing_started");
    const result = await processWhatsAppTextMessage(message);
    console.info(
      `[whatsapp-debug] stage=processing_completed result_status=${result.status}`,
    );
    const response = Response.json({ ok: true, ...result });
    console.info(
      `[whatsapp-debug] stage=response_sent status=${response.status}`,
    );
    return response;
  } catch (error) {
    if (error instanceof WhatsAppDomainError) {
      console.info(
        `[whatsapp-debug] stage=processing_failed code=${error.code}`,
      );
      return errorResponse(
        500,
        "INTERNAL_ERROR",
        "No fue posible procesar el mensaje.",
      );
    }
    console.info("[whatsapp-debug] stage=processing_failed code=UNKNOWN");
    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "No fue posible procesar el mensaje.",
    );
  }
}
