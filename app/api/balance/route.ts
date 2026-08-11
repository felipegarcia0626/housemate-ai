import { getConfiguredHttpHouseholdContext } from "@/app/api/_lib/http-context";
import { getBalance } from "@/modules/expenses/balance.service";

export async function GET(): Promise<Response> {
  try {
    const { householdId } = await getConfiguredHttpHouseholdContext();
    const result = await getBalance({ householdId });
    return Response.json({ data: result });
  } catch {
    return Response.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "No fue posible completar la operación.",
        },
      },
      { status: 500 },
    );
  }
}
