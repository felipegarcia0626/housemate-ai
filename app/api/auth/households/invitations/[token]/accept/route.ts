import { NextResponse } from "next/server";
import { SupabaseAuthError } from "@/infrastructure/auth/supabase-server.client";
import { HouseholdInvitationConflictError, HouseholdInvitationForbiddenError, HouseholdInvitationRepositoryError, HouseholdInvitationValidationError, acceptInvitation } from "@/modules/household-invitations/invitation.service";

export async function POST(_request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  try {
    const { token } = await params;
    return NextResponse.json({ data: await acceptInvitation(token) });
  } catch (error) {
    if (error instanceof SupabaseAuthError && error.code === "UNAUTHENTICATED") return NextResponse.json({ error: { code: "UNAUTHENTICATED", message: "Se requiere una sesión autenticada." } }, { status: 401 });
    if (error instanceof HouseholdInvitationValidationError) return NextResponse.json({ error: { code: "VALIDATION_ERROR", message: "Invitación inválida." } }, { status: 400 });
    if (error instanceof HouseholdInvitationForbiddenError) return NextResponse.json({ error: { code: "FORBIDDEN", message: "No es posible aceptar esta invitación." } }, { status: 403 });
    if (error instanceof HouseholdInvitationConflictError) return NextResponse.json({ error: { code: "CONFLICT", message: "La invitación ya no está disponible." } }, { status: 409 });
    if (error instanceof HouseholdInvitationRepositoryError) return NextResponse.json({ error: { code: "INTERNAL_ERROR", message: "No fue posible aceptar la invitación." } }, { status: 500 });
    return NextResponse.json({ error: { code: "INTERNAL_ERROR", message: "No fue posible aceptar la invitación." } }, { status: 500 });
  }
}
