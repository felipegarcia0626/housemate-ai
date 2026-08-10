import type {
  DashboardCategoryAmount,
  DashboardExpenseRow,
  DashboardIncomeRow,
  DashboardMemberIncome,
  DashboardResult,
} from "./dashboard.types";

const MAX_MONEY_CENTS = BigInt("99999999999999");
const MAX_SAFE_CENTS = BigInt(Number.MAX_SAFE_INTEGER);
const UNCATEGORIZED_KEY = "__uncategorized__";

function moneyToCents(value: string, field: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (match === null) {
    throw new Error(
      `${field} must be a non-negative amount with at most two decimals.`,
    );
  }

  const cents =
    BigInt(match[1]) * BigInt(100) + BigInt((match[2] ?? "").padEnd(2, "0"));
  if (cents > MAX_MONEY_CENTS) {
    throw new Error(`${field} exceeds NUMERIC(14,2).`);
  }
  return cents;
}

function centsToMoney(cents: bigint, field: string): number {
  const absolute = cents < BigInt(0) ? -cents : cents;
  if (absolute > MAX_SAFE_CENTS) {
    throw new Error(`${field} exceeds the safe numeric result range.`);
  }
  return Number(cents) / 100;
}

function compareIds(left: string, right: string): number {
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();
  if (normalizedLeft === normalizedRight) return 0;
  return normalizedLeft < normalizedRight ? -1 : 1;
}

export function calculateDashboard(
  incomes: readonly DashboardIncomeRow[],
  expenses: readonly DashboardExpenseRow[],
): DashboardResult {
  let totalIncomeCents = BigInt(0);
  const memberIncomeCents = new Map<
    string,
    { memberId: string; amount: bigint }
  >();

  for (const [index, income] of incomes.entries()) {
    const amount = moneyToCents(income.amount, `incomes[${index}].amount`);
    totalIncomeCents += amount;
    const key = income.memberId.toLowerCase();
    const member = memberIncomeCents.get(key);
    if (member === undefined) {
      memberIncomeCents.set(key, { memberId: income.memberId, amount });
    } else {
      member.amount += amount;
    }
  }

  let totalSpentCents = BigInt(0);
  const categoryCents = new Map<
    string,
    { categoryId: string | null; categoryName: string | null; amount: bigint }
  >();

  const addCategoryAmount = (
    categoryId: string | null,
    categoryName: string | null,
    amount: bigint,
  ): void => {
    if (amount === BigInt(0)) return;
    if ((categoryId === null) !== (categoryName === null)) {
      throw new Error("Dashboard category identity is inconsistent.");
    }

    const key = categoryId?.toLowerCase() ?? UNCATEGORIZED_KEY;
    const existing = categoryCents.get(key);
    if (existing === undefined) {
      categoryCents.set(key, { categoryId, categoryName, amount });
      return;
    }
    if (existing.categoryName !== categoryName) {
      throw new Error("Dashboard category names are inconsistent.");
    }
    existing.amount += amount;
  };

  for (const [expenseIndex, expense] of expenses.entries()) {
    const expenseTotal = moneyToCents(
      expense.totalAmount,
      `expenses[${expenseIndex}].totalAmount`,
    );
    totalSpentCents += expenseTotal;

    let allItemsTotal = BigInt(0);
    let categorizedItemsTotal = BigInt(0);
    for (const [itemIndex, item] of expense.items.entries()) {
      const itemTotal = moneyToCents(
        item.totalAmount,
        `expenses[${expenseIndex}].items[${itemIndex}].totalAmount`,
      );
      allItemsTotal += itemTotal;
      if (item.categoryId !== null) {
        if (item.categoryName === null) {
          throw new Error("Dashboard item category is missing its name.");
        }
        categorizedItemsTotal += itemTotal;
        addCategoryAmount(item.categoryId, item.categoryName, itemTotal);
      }
    }

    if (allItemsTotal > expenseTotal) {
      throw new Error("Dashboard ExpenseItem total exceeds Expense total.");
    }

    const remaining = expenseTotal - categorizedItemsTotal;
    if (remaining < BigInt(0)) {
      throw new Error(
        "Dashboard categorized ExpenseItem total exceeds Expense total.",
      );
    }
    if (remaining > BigInt(0)) {
      if (expense.categoryId !== null && expense.categoryName === null) {
        throw new Error("Dashboard Expense category is missing its name.");
      }
      addCategoryAmount(
        expense.categoryId,
        expense.categoryId === null ? null : expense.categoryName,
        remaining,
      );
    }
  }

  const memberIncome: DashboardMemberIncome[] = [...memberIncomeCents.values()]
    .sort((left, right) => compareIds(left.memberId, right.memberId))
    .map((member) => ({
      memberId: member.memberId,
      amount: centsToMoney(member.amount, "memberIncome.amount"),
    }));
  const byCategory: DashboardCategoryAmount[] = [...categoryCents.values()]
    .sort((left, right) =>
      compareIds(left.categoryId ?? "", right.categoryId ?? ""),
    )
    .map((category) => ({
      categoryId: category.categoryId,
      categoryName: category.categoryName,
      amount: centsToMoney(category.amount, "byCategory.amount"),
    }));

  const memberIncomeTotal = [...memberIncomeCents.values()].reduce(
    (total, member) => total + member.amount,
    BigInt(0),
  );
  const byCategoryTotal = [...categoryCents.values()].reduce(
    (total, category) => total + category.amount,
    BigInt(0),
  );
  if (memberIncomeTotal !== totalIncomeCents) {
    throw new Error("Dashboard memberIncome does not equal totalIncome.");
  }
  if (byCategoryTotal !== totalSpentCents) {
    throw new Error("Dashboard byCategory does not equal totalSpent.");
  }

  const netAmountCents = totalIncomeCents - totalSpentCents;
  return {
    totalIncome: centsToMoney(totalIncomeCents, "totalIncome"),
    totalSpent: centsToMoney(totalSpentCents, "totalSpent"),
    netAmount: centsToMoney(netAmountCents, "netAmount"),
    expenseCount: expenses.length,
    memberIncome,
    byCategory,
  };
}
