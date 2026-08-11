import { getConfiguredHttpHouseholdContext } from "@/app/api/_lib/http-context";
import { listSharingRules } from "@/modules/sharing-rules/sharing-rule.service";
import { SharingRuleDomainError } from "@/modules/sharing-rules/sharing-rule.types";

function errorResponse(
  status: 500,
  code: "INTERNAL_ERROR",
  message: string,
): Response {
  return Response.json({ error: { code, message } }, { status });
}

export async function GET(): Promise<Response> {
  try {
    const { householdId } = await getConfiguredHttpHouseholdContext();
    const rules = await listSharingRules({ householdId });
    return Response.json({ data: rules });
  } catch (error) {
    if (error instanceof SharingRuleDomainError) {
      return errorResponse(
        500,
        "INTERNAL_ERROR",
        "No fue posible completar la operación.",
      );
    }

    return errorResponse(
      500,
      "INTERNAL_ERROR",
      "No fue posible completar la operación.",
    );
  }
}
