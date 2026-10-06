import { NextResponse } from "next/server";
import { SupabaseAuthError } from "@/infrastructure/auth/supabase-server.client";
import { HouseholdInvitationConflictError, HouseholdInvitationForbiddenError, HouseholdInvitationRepositoryError, HouseholdInvitationValidationError, createInvitation } from "@/modules/household-invitations/invitation.service";

export async function POST(request: Request, { params }: { params: Promise<{ householdId: string }> }): Promise<Response> {
  try {
    const { householdId } = await params;
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "email" && key !== "idempotencyKey")) {
      return NextResponse.json({ error: { code: "VALIDATION_ERROR", message: "Solicitud inválida." } }, { status: 400 });
    }
    const result = await createInvitation({ householdId, email: (body as { email?: unknown }).email });
    const url = new URL(request.url);
    return NextResponse.json({ data: { status: result.status, inviteUrl: `${url.origin}/household/invitations/${encodeURIComponent(result.token)}` } }, { status: 201 });
  } catch (error) {
    if (error instanceof SupabaseAuthError && error.code === "UNAUTHENTICATED") return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Se requiere una sesión autenticada." } }, { status: 401 });
    if (error instanceof HouseholdInvitationValidationError) return NextResponse.json({ error: { code: "VALIDATION_ERROR", message: "Solicitud inválida." } }, { status: 400 });
    if (error instanceof HouseholdInvitationForbiddenError) return NextResponse.json({ error: { code: "FORBIDDEN", message: "No tienes acceso a ese hogar." } }, { status: 403 });
    if (error instanceof HouseholdInvitationConflictError) return NextResponse.json({ error: { code: "CONFLICT", message: "Ya existe una invitación activa para ese correo." } }, { status: 409 });
    if (error instanceof HouseholdInvitationRepositoryError) return NextResponse.json({ error: { code: "INTERNAL_ERROR", message: "No fue posible crear la invitación." } }, { status: 500 });
    return NextResponse.json({ error: { code: "INTERNAL_ERROR", message: "No fue posible crear la invitación." } }, { status: 500 });
  }
}
