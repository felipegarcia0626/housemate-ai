import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import {
  isAuthApiError,
  isAuthSessionMissingError,
} from "@supabase/supabase-js";

type SupabaseAuthErrorCode = "UNAUTHENTICATED" | "AUTH_PROVIDER_ERROR";

export class SupabaseAuthError extends Error {
  readonly code: SupabaseAuthErrorCode;

  constructor(code: SupabaseAuthErrorCode) {
    super(
      code === "UNAUTHENTICATED"
        ? "An authenticated Supabase user is required."
        : "The Supabase authentication provider is unavailable.",
    );
    this.name = "SupabaseAuthError";
    this.code = code;
  }
}

function requiredEnvironmentVariable(
  name: "SUPABASE_URL" | "SUPABASE_ANON_KEY",
): string {
  const value = process.env[name];

  if (value === undefined || value.length === 0) {
    throw new SupabaseAuthError("AUTH_PROVIDER_ERROR");
  }

  return value;
}

export async function createSupabaseAuthServerClient() {
  const cookieStore = await cookies();

  return createServerClient(
    requiredEnvironmentVariable("SUPABASE_URL"),
    requiredEnvironmentVariable("SUPABASE_ANON_KEY"),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            // Server Components cannot mutate response cookies. Route
            // Handlers can, and the client still verifies the current user.
          }
        },
      },
    },
  );
}

export async function getAuthenticatedAuthUser(): Promise<{ id: string; email?: string | null }> {
  const supabase = await createSupabaseAuthServerClient();
  const { data, error } = await supabase.auth.getUser();

  // Supabase represents both an absent session and a signed-out/expired
  // session as authentication errors, not as a successful null response.
  if (
    error &&
    (isAuthSessionMissingError(error) ||
      (isAuthApiError(error) && error.status === 401))
  ) {
    throw new SupabaseAuthError("UNAUTHENTICATED");
  }

  if (error) {
    throw new SupabaseAuthError("AUTH_PROVIDER_ERROR");
  }

  if (!data.user) {
    throw new SupabaseAuthError("UNAUTHENTICATED");
  }

  return { id: data.user.id, email: data.user.email ?? null };
}
