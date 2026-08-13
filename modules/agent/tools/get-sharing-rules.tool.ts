import { listSharingRules } from "@/modules/sharing-rules/sharing-rule.service";
import type {
  SharingRule,
  SharingRuleServiceContext,
} from "@/modules/sharing-rules/sharing-rule.types";
import type { AgentContext } from "../agent.types";

export async function getSharingRulesTool(
  context: AgentContext,
): Promise<SharingRule[]> {
  const serviceContext: SharingRuleServiceContext = {
    householdId: context.householdId,
  };
  return listSharingRules(serviceContext);
}
