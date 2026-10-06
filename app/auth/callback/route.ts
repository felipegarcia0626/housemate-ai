import { NextResponse } from "next/server";
import { createSupabaseAuthServerClient } from "@/infrastructure/auth/supabase-server.client";

const CALLBACK_ERROR = "oauth_callback";

function safeInvitationReturnTo(value: string | null): string {
  if (!value) return "/";
  const candidate = value.startsWith("/") && !value.startsWith("//") ? value : "";
  return /^\/household\/invitations\/[A-Za-z0-9_-]{40,}$/.test(candidate) ? candidate : "/";
}

function redirectToError(request: Request) {
  const url = new URL("/", request.url);
  url.searchParams.set("authError", CALLBACK_ERROR);
  return NextResponse.redirect(url);
}

export async function GET(request: Request) {
  const callbackUrl = new URL(request.url);
  const code = callbackUrl.searchParams.get("code");
  const returnTo = safeInvitationReturnTo(callbackUrl.searchParams.get("next"));
  if (!code) return redirectToError(request);

  try {
    const supabase = await createSupabaseAuthServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return redirectToError(request);
  } catch {
    return redirectToError(request);
  }

  return NextResponse.redirect(new URL(returnTo, request.url));
}
