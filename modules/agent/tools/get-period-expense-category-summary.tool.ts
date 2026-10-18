import { getPeriodExpenseCategoryData } from "@/modules/dashboard/dashboard.service";
import {
  calculatePeriodExpenseCategorySummary,
  validatePeriodExpenseCategoryData,
} from "@/modules/dashboard/dashboard-category-summary-calculator";
import type {
  ExpenseCategorySummaryFailureReason,
  ExpenseCategorySummaryLevel,
  PeriodExpenseCategorySummary,
} from "@/modules/dashboard/dashboard.types";
import type { AgentContext } from "../agent.types";

const MAX_DAYS = 366;
const QUERY_TIMEOUT_MS = 15000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const activeHouseholds = new Set<string>();
const cooldownUntil = new Map<string, number>();

export interface PeriodExpenseCategorySummaryArguments {
  from: string;
  to: string;
  level: ExpenseCategorySummaryLevel;
  categoryName: string | null;
}

function dayNumber(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = DATE.exec(value);
  if (!match || match[1] === "0000") return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day) return null;
  return Math.floor(date.getTime() / 86400000);
}

export function parsePeriodExpenseCategorySummaryArguments(
  value: unknown,
): PeriodExpenseCategorySummaryArguments | null {
  return parsePeriodExpenseCategorySummaryArgumentsResult(value).arguments;
}

function parsePeriodExpenseCategorySummaryArgumentsResult(value: unknown): {
  arguments: PeriodExpenseCategorySummaryArguments | null;
  failureReason: "INVALID_ARGUMENTS" | "PERIOD_TOO_LONG" | null;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { arguments: null, failureReason: "INVALID_ARGUMENTS" };
  }
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).sort().join(",") !== "categoryName,from,level,to" ||
    (fields.level !== "MACRO" && fields.level !== "MICRO") ||
    (fields.categoryName !== null &&
      (typeof fields.categoryName !== "string" ||
        !fields.categoryName.trim() ||
        fields.categoryName.trim().length > 120))) {
    return { arguments: null, failureReason: "INVALID_ARGUMENTS" };
  }
  const fromDay = dayNumber(fields.from);
  const toDay = dayNumber(fields.to);
  if (fromDay === null || toDay === null || toDay < fromDay) {
    return { arguments: null, failureReason: "INVALID_ARGUMENTS" };
  }
  if (toDay - fromDay + 1 > MAX_DAYS) {
    return { arguments: null, failureReason: "PERIOD_TOO_LONG" };
  }
  return {
    arguments: {
      from: fields.from as string,
      to: fields.to as string,
      level: fields.level,
      categoryName: typeof fields.categoryName === "string" ? fields.categoryName.trim() : null,
    },
    failureReason: null,
  };
}

function incomplete(
  interval: PeriodExpenseCategorySummaryArguments | null,
  failureReason: ExpenseCategorySummaryFailureReason,
): PeriodExpenseCategorySummary {
  return {
    from: interval?.from ?? "",
    to: interval?.to ?? "",
    level: interval?.level ?? null,
    categoryName: interval?.categoryName ?? null,
    complete: false,
    failureReason,
  };
}

export async function getPeriodExpenseCategorySummaryTool(
  context: AgentContext,
  args: unknown,
  dependencies: {
    loadData: typeof getPeriodExpenseCategoryData;
    setTimeout?: typeof setTimeout;
    clearTimeout?: typeof clearTimeout;
  } = {
    loadData: getPeriodExpenseCategoryData,
  },
): Promise<PeriodExpenseCategorySummary> {
  const parsed = parsePeriodExpenseCategorySummaryArgumentsResult(args);
  const interval = parsed.arguments;
  if (!interval) return incomplete(null, parsed.failureReason ?? "INVALID_ARGUMENTS");
  const householdId = context.householdId;
  if (activeHouseholds.has(householdId) ||
    (cooldownUntil.get(householdId) ?? 0) > Date.now()) {
    return incomplete(interval, "INCOMPLETE");
  }
  cooldownUntil.delete(householdId);
  activeHouseholds.add(householdId);
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const setTimer = dependencies.setTimeout ?? setTimeout;
  const clearTimer = dependencies.clearTimeout ?? clearTimeout;
  try {
    const data = await Promise.race([
      Promise.resolve().then(() =>
        dependencies.loadData(
          { householdId },
          { from: interval.from, to: interval.to },
          controller.signal,
        ),
      ),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimer(() => {
          controller.abort();
          cooldownUntil.set(householdId, Date.now() + QUERY_TIMEOUT_MS);
          reject(new Error("Expense category summary timed out."));
        }, QUERY_TIMEOUT_MS);
      }),
    ]);
    if (controller.signal.aborted) throw new Error("Expense category summary timed out.");
    validatePeriodExpenseCategoryData(data);
    return calculatePeriodExpenseCategorySummary(data, interval);
  } catch {
    return incomplete(interval, "INCOMPLETE");
  } finally {
    if (timeout !== undefined) clearTimer(timeout);
    activeHouseholds.delete(householdId);
  }
}
