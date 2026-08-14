import { getConfiguredHttpHouseholdContext } from "@/app/api/_lib/http-context";
import { listHouseholdMembers } from "@/modules/household-members/household-member.service";

export async function GET(): Promise<Response> {
  try {
    const { householdId } = await getConfiguredHttpHouseholdContext();
    const members = await listHouseholdMembers({ householdId });
    return Response.json({ data: members });
  } catch {
    return Response.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "No fue posible completar la operaciÃ³n.",
        },
      },
      { status: 500 },
    );
  }
}
