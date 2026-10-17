import { getPeriodFinancialSnapshot } from "@/modules/dashboard/dashboard.service";
import type { AgentContext } from "../agent.types";

export interface PeriodFinancialSummary {
  from: string;
  to: string;
  complete: boolean;
  totalIncome?: number;
  totalSpent?: number;
  netAmount?: number;
  incomeCount?: number;
  expenseCount?: number;
  movementCount?: number;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_DAYS = 31;
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

export function parsePeriodFinancialSummaryArguments(value: unknown): { from: string; to: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).sort().join(",") !== "from,to") return null;
  const fromDay = dayNumber(fields.from);
  const toDay = dayNumber(fields.to);
  if (fromDay === null || toDay === null || toDay < fromDay || toDay - fromDay + 1 > MAX_DAYS) return null;
  return { from: fields.from as string, to: fields.to as string };
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
 * Summarizes the rows retrieved and validated from separately paginated income
 * and expense reads. The result is complete for those reads, not a shared
 * transactional snapshot when financial records change concurrently.
 */
export async function getPeriodFinancialSummaryTool(
  context: AgentContext,
  args: { from: string; to: string },
  dependencies: {
    snapshot: typeof getPeriodFinancialSnapshot;
  } = { snapshot: getPeriodFinancialSnapshot },
): Promise<PeriodFinancialSummary> {
  const interval = parsePeriodFinancialSummaryArguments(args);
  if (!interval) return { from: args.from, to: args.to, complete: false };
  const householdId = context.householdId;
  if (activeHouseholds.has(householdId) || (cooldownUntil.get(householdId) ?? 0) > Date.now()) {
    return { ...interval, complete: false };
  }
  cooldownUntil.delete(householdId);
  activeHouseholds.add(householdId);
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const snapshot = await Promise.race([
      Promise.resolve().then(() => dependencies.snapshot({ householdId }, interval, controller.signal)),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          cooldownUntil.set(householdId, Date.now() + QUERY_TIMEOUT_MS);
          reject(new Error("Financial summary timed out."));
        }, QUERY_TIMEOUT_MS);
      }),
    ]);
    if (controller.signal.aborted) throw new Error("Financial summary timed out.");
    if (
      !Number.isSafeInteger(snapshot.expenseCount) || snapshot.expenseCount < 0 ||
      !Number.isSafeInteger(snapshot.incomeCount) || snapshot.incomeCount < 0 ||
      snapshot.expenseCount > MAX_ROWS_PER_KIND || snapshot.incomeCount > MAX_ROWS_PER_KIND
    ) throw new Error("Incomplete financial summary.");
    const incomeCents = cents(snapshot.incomeAmount);
    const expenseCents = cents(snapshot.expenseAmount);
    if ((snapshot.incomeCount === 0 && incomeCents !== BigInt(0)) ||
      (snapshot.expenseCount === 0 && expenseCents !== BigInt(0))) {
      throw new Error("Financial summary count and amount disagree.");
    }
    const netCents = incomeCents - expenseCents;
    if (netCents > MAX_SAFE_CENTS || netCents < -MAX_SAFE_CENTS) throw new Error("Monetary summary exceeds safe range.");
    const movementCount = snapshot.expenseCount + snapshot.incomeCount;
    if (!Number.isSafeInteger(movementCount)) throw new Error("Movement count exceeds safe range.");
    return {
      ...interval,
      complete: true,
      totalIncome: safeAmount(incomeCents),
      totalSpent: safeAmount(expenseCents),
      netAmount: safeAmount(netCents),
      incomeCount: snapshot.incomeCount,
      expenseCount: snapshot.expenseCount,
      movementCount,
    };
  } catch {
    return { ...interval, complete: false };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    activeHouseholds.delete(householdId);
  }
}
