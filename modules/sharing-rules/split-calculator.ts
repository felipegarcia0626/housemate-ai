import type { CalculatedSplit, SharingRuleSplit } from "./sharing-rule.types";
export function calculateSplitAmounts(
  totalCents: bigint,
  splits: readonly SharingRuleSplit[],
  percentages: readonly bigint[],
): CalculatedSplit[] {
  const allocations = splits.map((split, index) => {
    const numerator = totalCents * percentages[index];
    return {
      index,
      memberId: split.memberId,
      percentage: percentages[index],
      cents: numerator / BigInt(10_000),
      remainder: numerator % BigInt(10_000),
    };
  });
  const residual =
    totalCents - allocations.reduce((sum, item) => sum + item.cents, BigInt(0));
  const order = [...allocations].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    const leftMemberId = a.memberId.toLowerCase();
    const rightMemberId = b.memberId.toLowerCase();
    if (leftMemberId === rightMemberId) return 0;
    return leftMemberId < rightMemberId ? -1 : 1;
  });
  for (let index = 0; index < Number(residual); index += 1)
    order[index].cents += BigInt(1);
  return allocations
    .sort((a, b) => a.index - b.index)
    .map((item) => ({
      memberId: item.memberId,
      percentage: Number(item.percentage) / 100,
      amount: Number(item.cents) / 100,
    }));
}
