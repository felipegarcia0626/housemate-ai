import type { BalanceExpenseRecord, BalanceMember } from "./balance.types";

const MAX_MONEY_CENTS = BigInt("99999999999999");
const MAX_SAFE_CENTS = BigInt(Number.MAX_SAFE_INTEGER);

function moneyToCents(value: number | string, field: string): bigint {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error(`${field} must be finite.`);
  }

  const text = String(value);
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (match === null) {
    throw new Error(
      `${field} must be a non-negative amount with two decimals.`,
    );
  }

  const cents =
    BigInt(match[1]) * BigInt(100) + BigInt((match[2] ?? "").padEnd(2, "0"));
  if (cents > MAX_MONEY_CENTS) {
    throw new Error(`${field} exceeds NUMERIC(14,2).`);
  }

  return cents;
}

function centsToMoney(cents: bigint): number {
  const absolute = cents < BigInt(0) ? -cents : cents;
  if (absolute > MAX_SAFE_CENTS) {
    throw new Error("Balance result exceeds the safe numeric range.");
  }
  return Number(cents) / 100;
}

export function calculateBalance(
  memberIds: readonly string[],
  expenses: readonly BalanceExpenseRecord[],
): BalanceMember[] {
  const members = new Map<
    string,
    { memberId: string; paidCents: bigint; shareCents: bigint }
  >();

  for (const memberId of memberIds) {
    const key = memberId.toLowerCase();
    if (members.has(key)) throw new Error("Balance members must be unique.");
    members.set(key, { memberId, paidCents: BigInt(0), shareCents: BigInt(0) });
  }

  for (const [expenseIndex, expense] of expenses.entries()) {
    const payer = members.get(expense.paidByMemberId.toLowerCase());
    if (payer === undefined) {
      throw new Error(
        "Expense payer does not belong to the Balance household.",
      );
    }
    payer.paidCents += moneyToCents(
      expense.totalAmount,
      `expenses[${expenseIndex}].totalAmount`,
    );

    for (const [
      distributionIndex,
      distribution,
    ] of expense.distributions.entries()) {
      const member = members.get(distribution.memberId.toLowerCase());
      if (member === undefined) {
        throw new Error(
          "Expense distribution member does not belong to the Balance household.",
        );
      }
      member.shareCents += moneyToCents(
        distribution.amount,
        `expenses[${expenseIndex}].distributions[${distributionIndex}].amount`,
      );
    }
  }

  const calculated = [...members.values()].map((member) => ({
    ...member,
    balanceCents: member.paidCents - member.shareCents,
  }));
  const householdBalance = calculated.reduce(
    (total, member) => total + member.balanceCents,
    BigInt(0),
  );
  if (householdBalance !== BigInt(0)) {
    throw new Error("Balance members must sum exactly to zero.");
  }

  return calculated
    .sort((left, right) => {
      const leftId = left.memberId.toLowerCase();
      const rightId = right.memberId.toLowerCase();
      if (leftId === rightId) return 0;
      return leftId < rightId ? -1 : 1;
    })
    .map((member) => ({
      memberId: member.memberId,
      paid: centsToMoney(member.paidCents),
      share: centsToMoney(member.shareCents),
      balance: centsToMoney(member.balanceCents),
    }));
}
