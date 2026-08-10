import { getSupabaseAdminClient } from "@/infrastructure/database/client";
import type { SharingRule } from "./sharing-rule.types";
interface RuleRow {
  id: string;
  name: string;
}
interface MemberRow {
  sharing_rule_id: string;
  household_member_id: string;
  percentage: number | string;
}
export class SharingRuleRepositoryError extends Error {
  constructor(cause: unknown) {
    super("Unable to access Sharing Rules.", { cause });
    this.name = "SharingRuleRepositoryError";
  }
}
export async function listSharingRules(
  householdId: string,
): Promise<SharingRule[]> {
  const client = getSupabaseAdminClient();
  const rulesResult = await client
    .from("tb_sharing_rules")
    .select("id,name")
    .eq("household_id", householdId);
  if (rulesResult.error)
    throw new SharingRuleRepositoryError(rulesResult.error);
  const rules = (rulesResult.data ?? []) as RuleRow[];
  if (rules.length === 0) return [];
  const membersResult = await client
    .from("tb_sharing_rule_members")
    .select("sharing_rule_id,household_member_id,percentage")
    .in(
      "sharing_rule_id",
      rules.map((rule) => rule.id),
    );
  if (membersResult.error)
    throw new SharingRuleRepositoryError(membersResult.error);
  const members = (membersResult.data ?? []) as MemberRow[];
  return rules.map((rule) => ({
    id: rule.id,
    name: rule.name,
    type: "PERCENTAGE",
    splits: members
      .filter((member) => member.sharing_rule_id === rule.id)
      .map((member) => ({
        memberId: member.household_member_id,
        percentage: Number(member.percentage),
      })),
  }));
}
export async function getSharingRuleHouseholdMemberIds(
  householdId: string,
  memberIds: string[],
): Promise<Set<string>> {
  const { data, error } = await getSupabaseAdminClient()
    .from("tb_household_members")
    .select("id")
    .eq("household_id", householdId)
    .in("id", memberIds);
  if (error) throw new SharingRuleRepositoryError(error);
  return new Set((data ?? []).map((row) => row.id.toLowerCase()));
}
