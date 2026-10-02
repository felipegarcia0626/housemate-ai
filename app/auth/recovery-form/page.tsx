import { cookies } from "next/headers";
import { createHash } from "node:crypto";
import { createSupabaseAuthServerClient } from "@/infrastructure/auth/supabase-server.client";
import { RecoveryPasswordForm } from "@/components/auth/recovery-password-form";

export default async function RecoveryFormPage({
  searchParams,
}: {
  searchParams: Promise<{ authError?: string }>;
}) {
  const params = await searchParams;
  const cookieStore = await cookies();
  const marker = cookieStore.get("housemate_recovery_session")?.value;
  let recoveryCookie = false;
  if (marker) {
    const supabase = await createSupabaseAuthServerClient();
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    recoveryCookie = Boolean(
      token && createHash("sha256").update(token).digest("hex") === marker,
    );
  }
  return (
    <RecoveryPasswordForm
      recoveryReady={recoveryCookie}
      initialError={params.authError === "recovery" ? "El enlace de recuperación no es válido o ya expiró." : ""}
    />
  );
}
