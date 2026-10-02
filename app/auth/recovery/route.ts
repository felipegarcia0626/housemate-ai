import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { createSupabaseAuthServerClient } from "@/infrastructure/auth/supabase-server.client";

const RECOVERY_ERROR = "recovery";

function redirectToForm(request: Request, error = false) {
  const url = new URL("/auth/recovery-form", request.url);
  if (error) url.searchParams.set("authError", RECOVERY_ERROR);
  return NextResponse.redirect(url);
}

function recoverySessionMarker(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("hex");
}

export async function GET(request: Request) {
  const code = new URL(request.url).searchParams.get("code");
  if (!code) return redirectToForm(request, true);

  try {
    const supabase = await createSupabaseAuthServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return redirectToForm(request, true);
  } catch {
    return redirectToForm(request, true);
  }

  const { data: sessionData } = await (await createSupabaseAuthServerClient()).auth.getSession();
  if (!sessionData.session?.access_token) return redirectToForm(request, true);

  const response = redirectToForm(request);
  response.cookies.set("housemate_recovery_session", recoverySessionMarker(sessionData.session.access_token), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/auth/recovery-form",
    maxAge: 600,
  });
  return response;
}

export async function DELETE() {
  const response = new NextResponse(null, { status: 204 });
  for (const name of ["housemate_recovery", "housemate_recovery_session"]) {
    response.cookies.set(name, "", {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/auth/recovery-form",
      maxAge: 0,
    });
  }
  return response;
}
