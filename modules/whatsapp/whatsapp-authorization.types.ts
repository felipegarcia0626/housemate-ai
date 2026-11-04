/** SQL foundation only; not yet wired into the webhook or HTTP routes. */
export type WhatsAppIdentity =
  | {
      userId: string;
      origin: "LEGACY";
      linkId: null;
      authorizationVersion: null;
    }
  | {
      userId: string;
      origin: "VERIFIED";
      linkId: string;
      authorizationVersion: number;
    };

export type ResolveWhatsAppSenderResult =
  (WhatsAppIdentity & { status: "RESOLVED" }) | { status: "UNAVAILABLE" };

export type AdmitWhatsAppSenderResult =
  | (WhatsAppIdentity & { status: "ADMITTED"; acquired: true; epoch: number })
  | { status: "UNAVAILABLE" | "BUSY"; acquired: false };

export interface AdmitWhatsAppSenderArgs {
  p_sender: string;
  p_lease_id: string;
  p_lease_seconds?: number;
}

export interface RevokeWhatsAppLinkArgs {
  p_auth_user_id: string;
  p_link_id: string;
  p_expected_version: number;
}

export interface RevokeWhatsAppLinkResult {
  status: "REVOKED" | "NOT_FOUND" | "STALE";
}
