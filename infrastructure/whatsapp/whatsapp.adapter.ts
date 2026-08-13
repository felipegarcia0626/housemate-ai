export class WhatsAppAdapterError extends Error {
  constructor() {
    super("WhatsApp provider operation failed.");
    this.name = "WhatsAppAdapterError";
  }
}

interface RecordValue {
  [key: string]: unknown;
}

export interface WhatsAppTextMessage {
  eventId: string;
  sender: string;
  phoneNumberId: string;
  text: string;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null;
}

export function extractWhatsAppTextMessage(
  payload: unknown,
): WhatsAppTextMessage | null {
  if (!isRecord(payload) || payload.object !== "whatsapp_business_account") {
    return null;
  }

  if (!Array.isArray(payload.entry)) return null;

  for (const entry of payload.entry) {
    if (!isRecord(entry) || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      if (!isRecord(change) || change.field !== "messages") continue;
      const value = change.value;
      if (!isRecord(value) || !Array.isArray(value.messages)) continue;
      const metadata = value.metadata;
      const phoneNumberId =
        isRecord(metadata) && typeof metadata.phone_number_id === "string"
          ? metadata.phone_number_id.trim()
          : "";
      if (!phoneNumberId) continue;

      for (const message of value.messages) {
        if (!isRecord(message) || message.type !== "text") continue;
        const text = message.text;
        if (
          typeof message.id !== "string" ||
          typeof message.from !== "string" ||
          !isRecord(text) ||
          typeof text.body !== "string"
        ) {
          continue;
        }
        const eventId = message.id.trim();
        const sender = message.from.trim();
        const body = text.body.trim();
        if (!eventId || !sender || !body) continue;
        return { eventId, sender, phoneNumberId, text: body };
      }
    }
  }

  return null;
}

export function verifyWhatsAppWebhook(
  mode: string | null,
  verifyToken: string | null,
  challenge: string | null,
): string {
  const configuredToken = process.env.WHATSAPP_VERIFY_TOKEN;
  if (
    !configuredToken ||
    mode !== "subscribe" ||
    verifyToken !== configuredToken ||
    !challenge
  ) {
    throw new WhatsAppAdapterError();
  }
  return challenge;
}

export async function sendWhatsAppText(
  recipient: string,
  body: string,
): Promise<void> {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!accessToken || !phoneNumberId) throw new WhatsAppAdapterError();

  let response: Response;
  try {
    response = await fetch(
      `https://graph.facebook.com/v20.0/${encodeURIComponent(phoneNumberId)}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: recipient,
          type: "text",
          text: { body },
        }),
      },
    );
  } catch {
    throw new WhatsAppAdapterError();
  }

  if (!response.ok) throw new WhatsAppAdapterError();
}
