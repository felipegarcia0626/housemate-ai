import { NextResponse } from "next/server";
import { createSupabaseAuthServerClient } from "@/infrastructure/auth/supabase-server.client";

const CALLBACK_ERROR = "oauth_callback";

function redirectToError(request: Request) {
  const url = new URL("/", request.url);
  url.searchParams.set("authError", CALLBACK_ERROR);
  return NextResponse.redirect(url);
}

export async function GET(request: Request) {
  const code = new URL(request.url).searchParams.get("code");
  if (!code) return redirectToError(request);

  try {
    const supabase = await createSupabaseAuthServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return redirectToError(request);
  } catch {
    return redirectToError(request);
  }

  return NextResponse.redirect(new URL("/", request.url));
}
