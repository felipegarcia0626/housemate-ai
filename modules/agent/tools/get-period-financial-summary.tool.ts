import {
  getPeriodFinancialCategoryData,
  getPeriodFinancialSnapshot,
} from "@/modules/dashboard/dashboard.service";
import {
  calculatePeriodExpenseCategorySummary,
  validatePeriodExpenseCategoryData,
} from "@/modules/dashboard/dashboard-category-summary-calculator";
import type {
  ExpenseCategorySummaryLevel,
  PeriodExpenseCategorySummary,
} from "@/modules/dashboard/dashboard.types";
import type { AgentContext } from "../agent.types";

export interface PeriodFinancialSummaryArguments {
  from: string;
  to: string;
  categoryLevel: ExpenseCategorySummaryLevel | null;
  categoryName: string | null;
}

export type PeriodFinancialSummaryFailureReason =
  | "INVALID_ARGUMENTS"
  | "PERIOD_TOO_LONG"
  | "INCOMPLETE";

export interface PeriodFinancialSummary {
  from: string;
  to: string;
  complete: boolean;
  failureReason?: PeriodFinancialSummaryFailureReason;
  totalIncome?: number;
  totalSpent?: number;
  netAmount?: number;
  incomeCount?: number;
  expenseCount?: number;
  movementCount?: number;
  categorySummary?: PeriodExpenseCategorySummary;
}

type PeriodFinancialData =
  | Awaited<ReturnType<typeof getPeriodFinancialSnapshot>>
  | Awaited<ReturnType<typeof getPeriodFinancialCategoryData>>;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_DAYS = 366;
const MAX_ROWS_PER_KIND = 5000;
const QUERY_TIMEOUT_MS = 15000;
const MAX_SAFE_CENTS = BigInt(Number.MAX_SAFE_INTEGER);
const activeHouseholds = new Set<string>();
const cooldownUntil = new Map<string, number>();

function dayNumber(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = DATE.exec(value);
  if (!match || match[1] === "0000") return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) return null;
  return Math.floor(date.getTime() / 86400000);
}

function parseArguments(value: unknown): {
  args: PeriodFinancialSummaryArguments | null;
  from: string;
  to: string;
  failureReason: PeriodFinancialSummaryFailureReason | null;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { args: null, from: "", to: "", failureReason: "INVALID_ARGUMENTS" };
  }
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).sort().join(",") !== "categoryLevel,categoryName,from,to" ||
    (fields.categoryLevel !== null && fields.categoryLevel !== "MACRO" && fields.categoryLevel !== "MICRO") ||
    (fields.categoryName !== null &&
      (typeof fields.categoryName !== "string" ||
        !fields.categoryName.trim() ||
        fields.categoryName.trim().length > 120)) ||
    (fields.categoryLevel === null && fields.categoryName !== null)) {
    return { args: null, from: "", to: "", failureReason: "INVALID_ARGUMENTS" };
  }
  const fromDay = dayNumber(fields.from);
  const toDay = dayNumber(fields.to);
  if (fromDay === null || toDay === null || toDay < fromDay) {
    return { args: null, from: "", to: "", failureReason: "INVALID_ARGUMENTS" };
  }
  const from = fields.from as string;
  const to = fields.to as string;
  if (toDay - fromDay + 1 > MAX_DAYS) {
    return { args: null, from, to, failureReason: "PERIOD_TOO_LONG" };
  }
  return {
    args: {
      from,
      to,
      categoryLevel: fields.categoryLevel as ExpenseCategorySummaryLevel | null,
      categoryName: typeof fields.categoryName === "string" ? fields.categoryName.trim() : null,
    },
    from,
    to,
    failureReason: null,
  };
}

export function parsePeriodFinancialSummaryArguments(
  value: unknown,
): PeriodFinancialSummaryArguments | null {
  return parseArguments(value).args;
}

function cents(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new Error("Invalid monetary summary.");
  const result = BigInt(match[1]) * BigInt(100) + BigInt((match[2] ?? "").padEnd(2, "0"));
  if (result > MAX_SAFE_CENTS) throw new Error("Monetary summary exceeds safe range.");
  return result;
}

function safeAmount(value: bigint): number {
  const result = Number(value) / 100;
  if (!Number.isFinite(result) || cents(String(Math.abs(result))) !== (value < 0 ? -value : value)) {
    throw new Error("Monetary summary cannot be represented exactly.");
  }
  return result;
}

/**
 * Summarizes validated rows returned by independent offset-paginated reads.
 * Combined category results reuse their expense read; neither path provides a
 * shared transactional snapshot when financial records change concurrently.
 */
export async function getPeriodFinancialSummaryTool(
  context: AgentContext,
  value: unknown,
  dependencies: {
    snapshot: typeof getPeriodFinancialSnapshot;
    combinedData: typeof getPeriodFinancialCategoryData;
  } = {
    snapshot: getPeriodFinancialSnapshot,
    combinedData: getPeriodFinancialCategoryData,
  },
): Promise<PeriodFinancialSummary> {
  const parsed = parseArguments(value);
  const interval = parsed.args;
  if (!interval) {
    return {
      from: parsed.from,
      to: parsed.to,
      complete: false,
      failureReason: parsed.failureReason ?? "INVALID_ARGUMENTS",
    };
  }
  const householdId = context.householdId;
  if (activeHouseholds.has(householdId) || (cooldownUntil.get(householdId) ?? 0) > Date.now()) {
    return { from: interval.from, to: interval.to, complete: false, failureReason: "INCOMPLETE" };
  }
  cooldownUntil.delete(householdId);
  activeHouseholds.add(householdId);
  const controller = new AbortController();
  const dashboardInterval = { from: interval.from, to: interval.to };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const query = Promise.resolve().then(async (): Promise<PeriodFinancialData> => {
      if (interval.categoryLevel === null) {
        return dependencies.snapshot({ householdId }, dashboardInterval, controller.signal);
      }
      return dependencies.combinedData({ householdId }, dashboardInterval, controller.signal);
    });
    const data = await Promise.race([
      query,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          cooldownUntil.set(householdId, Date.now() + QUERY_TIMEOUT_MS);
          reject(new Error("Financial summary timed out."));
        }, QUERY_TIMEOUT_MS);
      }),
    ]);
    if (controller.signal.aborted) throw new Error("Financial summary timed out.");

    let incomeCount: number;
    let expenseCount: number;
    let incomeCents: bigint;
    let expenseCents: bigint;
    let categorySummary: PeriodExpenseCategorySummary | undefined;
    if (interval.categoryLevel === null) {
      if ("categoryData" in data) {
        throw new Error("Unexpected category data for financial snapshot.");
      }
      const snapshot = data;
      incomeCount = snapshot.incomeCount;
      expenseCount = snapshot.expenseCount;
      incomeCents = cents(snapshot.incomeAmount);
      expenseCents = cents(snapshot.expenseAmount);
    } else {
      if (!("categoryData" in data)) {
        throw new Error("Category summary data is missing.");
      }
      const combined = data;
      validatePeriodExpenseCategoryData(combined.categoryData);
      if (!Number.isSafeInteger(combined.incomeCount) || combined.incomeCount < 0) {
        throw new Error("Financial income count is invalid.");
      }
      categorySummary = calculatePeriodExpenseCategorySummary(
        combined.categoryData,
        {
          from: interval.from,
          to: interval.to,
          level: interval.categoryLevel,
          categoryName: interval.categoryName,
        },
      );
      if (!categorySummary.complete) {
        return {
          from: interval.from,
          to: interval.to,
          complete: false,
          failureReason: "INCOMPLETE",
          categorySummary,
        };
      }
      incomeCount = combined.incomeCount;
      expenseCount = categorySummary.expenseCount!;
      incomeCents = cents(combined.incomeAmount);
      expenseCents = cents(String(categorySummary.totalSpent));
    }

    if (!Number.isSafeInteger(expenseCount) || expenseCount < 0 ||
      !Number.isSafeInteger(incomeCount) || incomeCount < 0 ||
      expenseCount > MAX_ROWS_PER_KIND || incomeCount > MAX_ROWS_PER_KIND) {
      throw new Error("Incomplete financial summary.");
    }
    if ((incomeCount === 0 && incomeCents !== BigInt(0)) ||
      (expenseCount === 0 && expenseCents !== BigInt(0))) {
      throw new Error("Financial summary count and amount disagree.");
    }
    const netCents = incomeCents - expenseCents;
    if (netCents > MAX_SAFE_CENTS || netCents < -MAX_SAFE_CENTS) {
      throw new Error("Monetary summary exceeds safe range.");
    }
    const movementCount = expenseCount + incomeCount;
    if (!Number.isSafeInteger(movementCount)) throw new Error("Movement count exceeds safe range.");
    return {
      from: interval.from,
      to: interval.to,
      complete: true,
      totalIncome: safeAmount(incomeCents),
      totalSpent: safeAmount(expenseCents),
      netAmount: safeAmount(netCents),
      incomeCount,
      expenseCount,
      movementCount,
      ...(categorySummary ? { categorySummary } : {}),
    };
  } catch {
    return {
      from: interval.from,
      to: interval.to,
      complete: false,
      failureReason: "INCOMPLETE",
    };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    activeHouseholds.delete(householdId);
  }
}
