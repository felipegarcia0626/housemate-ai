export type CreatedHousehold = {
  householdId: string;
  householdName: string;
  memberId: string;
  idempotent: boolean;
};

export async function createHouseholdRequest(name: string): Promise<CreatedHousehold> {
  const response = await fetch("/api/auth/households", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, idempotencyKey: crypto.randomUUID() }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error?.message ?? "No fue posible crear el hogar.");
  }
  return body.data as CreatedHousehold;
}
