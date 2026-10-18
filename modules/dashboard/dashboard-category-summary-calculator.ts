import { normalizeCategoryName } from "@/modules/categories/category.types";
import { calculateExpenseCategoryAttribution } from "./dashboard-calculator";
import type {
  DashboardCategoryTaxonomyRow,
  DashboardExpenseRow,
  ExpenseCategorySummaryEntry,
  ExpenseCategorySummaryFailureReason,
  ExpenseCategorySummaryLevel,
  PeriodExpenseCategoryData,
  PeriodExpenseCategorySummary,
} from "./dashboard.types";

export interface CategorySummaryCalculationInput {
  from: string;
  to: string;
  level: ExpenseCategorySummaryLevel;
  categoryName: string | null;
}

export interface CategorySummaryCalculationData {
  expenses: readonly DashboardExpenseRow[];
  categories: readonly DashboardCategoryTaxonomyRow[];
}

const MAX_SAFE_CENTS = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_EXPENSE_ROWS = 5000;
const MAX_ITEM_ROWS = 50000;

export function validatePeriodExpenseCategoryData(
  value: unknown,
): asserts value is PeriodExpenseCategoryData {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expense category data is invalid.");
  }
  const data = value as Record<string, unknown>;
  if (!Array.isArray(data.expenses) || !Array.isArray(data.categories) ||
    !Number.isSafeInteger(data.expenseCount) || data.expenseCount !== data.expenses.length ||
    (data.expenseCount as number) > MAX_EXPENSE_ROWS || !Number.isSafeInteger(data.itemCount) ||
    (data.itemCount as number) < 0 || (data.itemCount as number) > MAX_ITEM_ROWS) {
    throw new Error("Expense category data is incomplete.");
  }
  let itemCount = 0;
  for (const expense of data.expenses) {
    if (typeof expense !== "object" || expense === null || Array.isArray(expense) ||
      !Array.isArray((expense as Record<string, unknown>).items)) {
      throw new Error("Expense category row is invalid.");
    }
    itemCount += ((expense as Record<string, unknown>).items as unknown[]).length;
    if (!Number.isSafeInteger(itemCount)) throw new Error("Expense item count is invalid.");
  }
  if (itemCount !== data.itemCount) throw new Error("Expense category data is incomplete.");
}

function failure(
  input: CategorySummaryCalculationInput,
  failureReason: ExpenseCategorySummaryFailureReason,
): PeriodExpenseCategorySummary {
  return {
    from: input.from,
    to: input.to,
    level: input.level,
    categoryName: input.categoryName,
    complete: false,
    failureReason,
  };
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function categoryMap(rows: readonly DashboardCategoryTaxonomyRow[]): Map<string, DashboardCategoryTaxonomyRow> {
  const result = new Map<string, DashboardCategoryTaxonomyRow>();
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || typeof row.name !== "string" ||
      typeof row.isActive !== "boolean" ||
      (row.movementType !== null && row.movementType !== "EXPENSE" && row.movementType !== "INCOME") ||
      (row.level !== null && row.level !== "MACRO" && row.level !== "MICRO") ||
      (row.parentId !== null && typeof row.parentId !== "string")) {
      throw new Error("Invalid category taxonomy.");
    }
    const key = row.id.toLowerCase();
    if (result.has(key)) throw new Error("Duplicate category taxonomy id.");
    result.set(key, row);
  }
  return result;
}

function validMacro(row: DashboardCategoryTaxonomyRow): boolean {
  return row.movementType === "EXPENSE" && row.level === "MACRO" && row.parentId === null;
}

function validMicro(
  row: DashboardCategoryTaxonomyRow,
  byId: ReadonlyMap<string, DashboardCategoryTaxonomyRow>,
): DashboardCategoryTaxonomyRow | null {
  if (row.movementType !== "EXPENSE" || row.level !== "MICRO" || row.parentId === null) return null;
  const parent = byId.get(row.parentId.toLowerCase());
  return parent && validMacro(parent) ? parent : null;
}

function canSelect(
  row: DashboardCategoryTaxonomyRow,
  level: ExpenseCategorySummaryLevel,
  byId: ReadonlyMap<string, DashboardCategoryTaxonomyRow>,
): boolean {
  if (!row.isActive) return false;
  if (level === "MACRO") return validMacro(row);
  const parent = validMicro(row, byId);
  return parent !== null && parent.isActive;
}

function money(cents: bigint): number {
  const absolute = cents < BigInt(0) ? -cents : cents;
  if (absolute > MAX_SAFE_CENTS) throw new Error("Category summary exceeds the safe amount range.");
  const amount = Number(cents) / 100;
  const text = String(Math.abs(amount));
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!Number.isFinite(amount) || !match) throw new Error("Category summary amount is invalid.");
  const recovered = BigInt(match[1]) * BigInt(100) + BigInt((match[2] ?? "").padEnd(2, "0"));
  if (recovered !== absolute) throw new Error("Category summary amount cannot preserve exact cents.");
  return amount;
}

export function calculatePeriodExpenseCategorySummary(
  data: CategorySummaryCalculationData,
  input: CategorySummaryCalculationInput,
): PeriodExpenseCategorySummary {
  const byId = categoryMap(data.categories);
  let selected: DashboardCategoryTaxonomyRow | null = null;
  if (input.categoryName !== null) {
    const normalized = normalizeCategoryName(input.categoryName);
    const candidates = data.categories.filter((row) =>
      row.movementType === "EXPENSE" &&
      row.level === input.level &&
      normalizeCategoryName(row.name) === normalized,
    );
    if (candidates.length > 1) return failure(input, "CATEGORY_AMBIGUOUS");
    if (candidates.length === 0) return failure(input, "CATEGORY_UNRESOLVED");
    selected = candidates[0];
    if (!canSelect(selected, input.level, byId)) {
      return failure(input, "CATEGORY_INACTIVE");
    }
  }

  const attributed = calculateExpenseCategoryAttribution(data.expenses);
  let uncategorizedCents = BigInt(0);
  let unmappedCents = BigInt(0);
  const grouped = new Map<string, { row: DashboardCategoryTaxonomyRow; cents: bigint }>();
  const add = (row: DashboardCategoryTaxonomyRow, cents: bigint): void => {
    const key = row.id.toLowerCase();
    const current = grouped.get(key);
    if (current) current.cents += cents;
    else grouped.set(key, { row, cents });
  };

  for (const category of attributed.byCategoryCents) {
    if (category.categoryId === null) {
      uncategorizedCents += category.amount;
      continue;
    }
    const row = byId.get(category.categoryId.toLowerCase());
    if (!row) {
      unmappedCents += category.amount;
      continue;
    }
    if (row.name !== category.categoryName) {
      throw new Error("Expense category name changed during summary reads.");
    }
    if (input.level === "MACRO") {
      if (validMacro(row)) {
        add(row, category.amount);
        continue;
      }
      const parent = validMicro(row, byId);
      if (parent) {
        add(parent, category.amount);
        continue;
      }
    } else if (row.level === "MICRO" && validMicro(row, byId)) {
      add(row, category.amount);
      continue;
    }
    unmappedCents += category.amount;
  }

  const categoryTotal = [...grouped.values()].reduce((sum, value) => sum + value.cents, BigInt(0));
  if (categoryTotal + uncategorizedCents + unmappedCents !== attributed.totalSpentCents) {
    throw new Error("Category buckets do not equal total expenses.");
  }
  const ranking = [...grouped.values()]
    .filter((value) => value.cents > BigInt(0))
    .sort((left, right) =>
      left.cents === right.cents
        ? compareText(
            normalizeCategoryName(left.row.name),
            normalizeCategoryName(right.row.name),
          ) || compareText(left.row.id.toLowerCase(), right.row.id.toLowerCase())
        : left.cents > right.cents ? -1 : 1,
    )
    .map((value): ExpenseCategorySummaryEntry => ({
      categoryName: value.row.name,
      amount: money(value.cents),
      isActive: value.row.isActive,
    }));
  const selectedAmount = selected ? grouped.get(selected.id.toLowerCase())?.cents ?? BigInt(0) : null;
  const matchedCategory = selected && selectedAmount !== null
    ? {
        categoryName: selected.name,
        amount: money(selectedAmount),
        isActive: selected.isActive,
      }
    : null;
  return {
    from: input.from,
    to: input.to,
    level: input.level,
    categoryName: input.categoryName,
    complete: true,
    totalSpent: money(attributed.totalSpentCents),
    expenseCount: data.expenses.length,
    categories: ranking,
    topCategory: ranking[0] ?? null,
    matchedCategory,
    uncategorizedAmount: money(uncategorizedCents),
    unmappedAmount: money(unmappedCents),
  };
}
