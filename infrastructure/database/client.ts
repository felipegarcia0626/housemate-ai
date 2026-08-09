import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let supabaseAdminClient: SupabaseClient | undefined;

function getRequiredServerEnvironmentVariable(
  name: "SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY",
) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required server environment variable: ${name}`);
  }

  return value;
}

export function getSupabaseAdminClient(): SupabaseClient {
  if (!supabaseAdminClient) {
    supabaseAdminClient = createClient(
      getRequiredServerEnvironmentVariable("SUPABASE_URL"),
      getRequiredServerEnvironmentVariable("SUPABASE_SERVICE_ROLE_KEY"),
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      },
    );
  }

  return supabaseAdminClient;
}
