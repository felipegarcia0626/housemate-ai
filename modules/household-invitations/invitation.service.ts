import { createHash, randomBytes } from "node:crypto";
import { getAuthenticatedAuthUser, SupabaseAuthError } from "@/infrastructure/auth/supabase-server.client";
import { findApplicationUserByAuthUserId, findActiveMembershipsByUserId } from "@/modules/context/authenticated-context.repository";
import { createHouseholdInvitation, acceptHouseholdInvitation, acceptHouseholdInvitationById, HouseholdInvitationRepositoryError } from "./invitation.repository";
import type { AcceptedHouseholdInvitation, CreatedHouseholdInvitation } from "./invitation.types";

export class HouseholdInvitationValidationError extends Error { constructor() { super("Invalid invitation input."); this.name = "HouseholdInvitationValidationError"; } }
export class HouseholdInvitationForbiddenError extends Error { constructor() { super("Invitation access is not available."); this.name = "HouseholdInvitationForbiddenError"; } }
export class HouseholdInvitationConflictError extends Error { constructor() { super("Invitation is not available."); this.name = "HouseholdInvitationConflictError"; } }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN = /^[A-Za-z0-9_-]{40,}$/;

export function normalizeInvitationEmail(value: unknown): string {
  if (typeof value !== "string") throw new HouseholdInvitationValidationError();
  const normalized = value.trim().toLowerCase();
  if (!EMAIL.test(normalized) || normalized.length > 320) throw new HouseholdInvitationValidationError();
  return normalized;
}

function tokenHash(token: string): string { return createHash("sha256").update(token, "utf8").digest("hex"); }

async function authenticatedApplicationUser(): Promise<{ authUserId: string; userId: string; email: string }> {
  const authUser = await getAuthenticatedAuthUser();
  if (!authUser.email) throw new HouseholdInvitationForbiddenError();
  const user = await findApplicationUserByAuthUserId(authUser.id);
  if (!user) throw new HouseholdInvitationForbiddenError();
  return { authUserId: authUser.id, userId: user.id, email: normalizeInvitationEmail(authUser.email) };
}

export async function createInvitation(input: { householdId: string; email: unknown }): Promise<CreatedHouseholdInvitation & { token: string }> {
  const email = normalizeInvitationEmail(input.email);
  const current = await authenticatedApplicationUser();
  const memberships = await findActiveMembershipsByUserId(current.userId);
  const membership = memberships.find((item) => item.householdId === input.householdId);
  if (!membership) throw new HouseholdInvitationForbiddenError();
  const token = randomBytes(32).toString("base64url");
  try {
    const result = await createHouseholdInvitation({ householdId: input.householdId, inviterMemberId: membership.memberId, email, tokenHash: tokenHash(token), expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() });
    return { ...result, token };
  } catch (error) {
    if (error instanceof HouseholdInvitationRepositoryError && error.code === "23505") throw new HouseholdInvitationConflictError();
    throw error;
  }
}

export async function acceptInvitation(token: unknown): Promise<AcceptedHouseholdInvitation> {
  if (typeof token !== "string" || !TOKEN.test(token)) throw new HouseholdInvitationValidationError();
  const current = await authenticatedApplicationUser();
  try {
    return await acceptHouseholdInvitation({ authUserId: current.authUserId, email: current.email, tokenHash: tokenHash(token) });
  } catch (error) {
    if (error instanceof HouseholdInvitationRepositoryError && ["P0003", "42501"].includes(error.code ?? "")) throw new HouseholdInvitationConflictError();
    throw error;
  }
}

export async function acceptInvitationById(invitationId: unknown): Promise<AcceptedHouseholdInvitation> {
  if (typeof invitationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(invitationId)) throw new HouseholdInvitationValidationError();
  const current = await authenticatedApplicationUser();
  try {
    return await acceptHouseholdInvitationById({ authUserId: current.authUserId, invitationId });
  } catch (error) {
    if (error instanceof HouseholdInvitationRepositoryError && ["P0003", "42501"].includes(error.code ?? "")) throw new HouseholdInvitationConflictError();
    throw error;
  }
}

export { HouseholdInvitationRepositoryError, SupabaseAuthError };
