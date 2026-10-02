import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

let browserClient: SupabaseClient | undefined;

function requiredPublicEnvironmentVariable(
  name: "NEXT_PUBLIC_SUPABASE_URL" | "NEXT_PUBLIC_SUPABASE_ANON_KEY",
): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export function createSupabaseBrowserClient(): SupabaseClient {
  if (!browserClient) {
    browserClient = createBrowserClient(
      requiredPublicEnvironmentVariable("NEXT_PUBLIC_SUPABASE_URL"),
      requiredPublicEnvironmentVariable("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    );
  }
  return browserClient;
}
