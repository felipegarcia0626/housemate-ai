import { createHouseholdForAuthenticatedUser as createInRepository, HouseholdRepositoryError, HouseholdApplicationUserNotFoundError, type CreatedHouseholdRecord } from "./household.repository";
export { HouseholdApplicationUserNotFoundError };
export { HouseholdRepositoryError };

export class HouseholdValidationError extends Error {
  constructor() { super("Invalid household name or idempotency key."); this.name = "HouseholdValidationError"; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function createHouseholdForAuthenticatedUser(input: { authUserId: string; name: unknown; idempotencyKey: unknown }): Promise<CreatedHouseholdRecord> {
  if (!UUID.test(input.authUserId) || typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 120 || typeof input.idempotencyKey !== "string" || !UUID.test(input.idempotencyKey)) throw new HouseholdValidationError();
  try { return await createInRepository(input.authUserId, input.name.trim(), input.idempotencyKey); }
  catch (error) { if (error instanceof HouseholdRepositoryError || error instanceof HouseholdApplicationUserNotFoundError) throw error; throw new HouseholdRepositoryError(error); }
}
