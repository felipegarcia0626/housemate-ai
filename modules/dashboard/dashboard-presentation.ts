import type { DashboardResult } from "./dashboard.types";

export type DashboardPeriod = "month-to-date" | "last-90-days" | "year-to-date";
export type DashboardRangePreset =
  | "last-12-months"
  | "this-month"
  | "previous-month"
  | "last-30-days"
  | "last-90-days"
  | "this-year"
  | "custom";
export type DashboardTrendGranularity =
  "day" | "week" | "month" | "quarter" | "year";

export const MAX_DASHBOARD_TREND_BUCKETS = 400;

export interface DashboardTrendGranularityOption {
  granularity: DashboardTrendGranularity;
  label: string;
  bucketCount: number;
  available: boolean;
}

export interface DashboardDateRange {
  from: string;
  to: string;
}

export type DashboardDateRangeValidation =
  | { valid: true; range: DashboardDateRange }
  | { valid: false; message: string };

export interface DashboardTrendRecord {
  date: string;
  amount: number;
}

export interface DashboardTrendPoint {
  start: string;
  end: string;
  incomeAmount: number;
  expenseAmount: number;
  incomeCount: number;
  expenseCount: number;
}

export interface DashboardTrendSeries {
  range: DashboardDateRange;
  granularity: DashboardTrendGranularity;
  durationDays: number;
  points: DashboardTrendPoint[];
  totalIncome: number;
  totalExpenses: number;
  incomeCount: number;
  expenseCount: number;
}

export interface DashboardPayerSlice {
  memberId: string | null;
  memberName: string;
  amount: number;
  percentage: number | null;
  expenseCount: number;
}

export interface DashboardPayerRecord {
  totalAmount: number;
  paidBy: { memberId: string; name: string } | null;
}

export interface DashboardExpenseAllocation {
  memberId: string;
  memberName: string;
  amount: number;
}

export interface DashboardMemberExpenseRecord {
  id: string;
  expenseDate: string;
  totalAmount: number;
  paidBy: { memberId: string; name: string } | null;
  distributions: readonly DashboardExpenseAllocation[];
}

export interface DashboardMemberExpenseSlice {
  memberId: string | null;
  memberName: string;
  paidAmount: number;
  assignedAmount: number;
  paidExpenseCount: number;
  assignedExpenseCount: number;
}

export interface DashboardMemberExpenseDistribution {
  range: DashboardDateRange;
  members: DashboardMemberExpenseSlice[];
  expenseCount: number;
  expensesWithoutDistribution: number;
  totalPaid: number;
  totalAssigned: number;
}

export interface DashboardFinancialComposition {
  totalIncome: number;
  totalExpenses: number;
  netAmount: number;
  expensesAsPercentOfIncome: number | null;
}

export interface DashboardWeekdayExpenseRecord {
  id: string;
  expenseDate: string;
  totalAmount: number;
}

export interface DashboardWeekdaySlice {
  weekday: string;
  weekdayIndex: number;
  totalAmount: number;
  averageAmount: number | null;
  calendarDayCount: number;
  expenseCount: number;
}

export interface DashboardWeekdayDistribution {
  range: DashboardDateRange;
  days: DashboardWeekdaySlice[];
  expenseCount: number;
  totalAmount: number;
}

export interface DashboardPeriodRanges {
  current: DashboardDateRange;
  previous: DashboardDateRange;
  periodLabel: string;
  comparisonLabel: string;
}

export interface DashboardAmountDelta {
  amount: number;
  percentage: number | null;
  direction: "increase" | "decrease" | "unchanged";
}

export interface DashboardCategorySlice {
  categoryId: string | null;
  categoryName: string;
  amount: number;
  percentage: number | null;
  aggregated: boolean;
}

export type DashboardExecutiveInsight =
  | {
      kind: "concentration";
      categoryName: string;
      amount: number;
      percentage: number;
    }
  | {
      kind: "category-change";
      categoryName: string;
      changeAmount: number;
      currentAmount: number;
      previousAmount: number;
    }
  | { kind: "opposing-trends"; expenseChange: number; incomeChange: number };

export interface DashboardCategoryChange {
  categoryId: string | null;
  categoryName: string;
  currentAmount: number;
  previousAmount: number;
  changeAmount: number;
  direction: "increase" | "decrease";
}

export interface DashboardCategoryComparisonSlice {
  categoryId: string | null;
  categoryName: string;
  currentAmount: number;
  previousAmount: number;
  changeAmount: number;
  percentageChange: number | null;
  aggregated: boolean;
}

export interface DashboardExpenseBridge {
  previousAmount: number;
  currentAmount: number;
  steps: Array<
    DashboardCategoryComparisonSlice & { fromAmount: number; toAmount: number }
  >;
}

export interface DashboardTrendExtreme {
  point: DashboardTrendPoint;
  movementAmount: number;
  recordCount: number;
}

export interface DashboardTrendExtremes {
  mostActive: DashboardTrendExtreme | null;
  leastActive: DashboardTrendExtreme | null;
}

export interface DashboardActivityExpenseSource {
  id: string;
  merchant: string | null;
  description?: string | null;
  totalAmount: number;
  expenseDate: string;
  categoryName: string | null;
}

export interface DashboardActivityIncomeSource {
  id: string;
  amount: number;
  incomeDate: string;
  description: string;
  memberName: string;
}

export interface DashboardActivityItem {
  id: string;
  kind: "expense" | "income";
  date: string;
  amount: number;
  title: string;
  detail: string;
}

function toCents(amount: number, field: string): bigint {
  if (!Number.isFinite(amount)) {
    throw new Error(`${field} must be finite.`);
  }

  const scaled = amount * 100;
  const rounded = Math.round(scaled);
  if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > 0.00001) {
    throw new Error(`${field} must have at most two decimal places.`);
  }
  return BigInt(rounded);
}

function fromCents(cents: bigint, field: string): number {
  const absolute = cents < BigInt(0) ? -cents : cents;
  if (absolute > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${field} exceeds the safe numeric result range.`);
  }
  return Number(cents) / 100;
}

function percentFromRatio(numerator: bigint, denominator: bigint): number {
  if (denominator <= BigInt(0)) {
    throw new Error("Percentage denominator must be positive.");
  }

  const negative = numerator < BigInt(0);
  const absolute = negative ? -numerator : numerator;
  const scaled = absolute * BigInt(10_000);
  const rounded = (scaled + denominator / BigInt(2)) / denominator;
  return Number(negative ? -rounded : rounded) / 100;
}

function dateKey(date: Date): string {
  return [
    String(date.getUTCFullYear()).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function dateOnly(date: Date): Date {
  return new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function range(from: Date, to: Date): DashboardDateRange {
  return { from: dateKey(from), to: dateKey(to) };
}

function parseDateKey(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(0);
  parsed.setUTCHours(0, 0, 0, 0);
  parsed.setUTCFullYear(year, month - 1, day);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return parsed;
}

function startOfWeek(date: Date): Date {
  const mondayBasedDay = (date.getUTCDay() + 6) % 7;
  return addDays(date, -mondayBasedDay);
}

function isoWeekParts(date: Date): { year: number; week: number } {
  const monday = startOfWeek(date);
  const thursday = addDays(monday, 3);
  const year = thursday.getUTCFullYear();
  const januaryFourth = new Date(0);
  januaryFourth.setUTCHours(0, 0, 0, 0);
  januaryFourth.setUTCFullYear(year, 0, 4);
  const firstMonday = startOfWeek(januaryFourth);
  const week =
    Math.floor((monday.getTime() - firstMonday.getTime()) / 604_800_000) + 1;
  return { year, week };
}

function startOfBucket(
  date: Date,
  granularity: DashboardTrendGranularity,
): Date {
  if (granularity === "day") return date;
  if (granularity === "week") return startOfWeek(date);
  if (granularity === "month") {
    const result = new Date(0);
    result.setUTCHours(0, 0, 0, 0);
    result.setUTCFullYear(date.getUTCFullYear(), date.getUTCMonth(), 1);
    return result;
  }
  if (granularity === "quarter") {
    const result = new Date(0);
    result.setUTCHours(0, 0, 0, 0);
    const firstMonth = Math.floor(date.getUTCMonth() / 3) * 3;
    result.setUTCFullYear(date.getUTCFullYear(), firstMonth, 1);
    return result;
  }
  const result = new Date(0);
  result.setUTCHours(0, 0, 0, 0);
  result.setUTCFullYear(date.getUTCFullYear(), 0, 1);
  return result;
}

function advanceBucket(
  date: Date,
  granularity: DashboardTrendGranularity,
): Date {
  if (granularity === "day") return addDays(date, 1);
  if (granularity === "week") return addDays(date, 7);
  if (granularity === "month") {
    const result = new Date(0);
    result.setUTCHours(0, 0, 0, 0);
    result.setUTCFullYear(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    return result;
  }
  if (granularity === "quarter") {
    const result = new Date(0);
    result.setUTCHours(0, 0, 0, 0);
    result.setUTCFullYear(date.getUTCFullYear(), date.getUTCMonth() + 3, 1);
    return result;
  }
  const result = new Date(0);
  result.setUTCHours(0, 0, 0, 0);
  result.setUTCFullYear(date.getUTCFullYear() + 1, 0, 1);
  return result;
}

export function formatDashboardTrendBucketLabel(
  value: string,
  granularity: DashboardTrendGranularity,
): string {
  const date = parseDateKey(value);
  if (!date) throw new Error("Dashboard bucket date must be YYYY-MM-DD.");
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  if (granularity === "day") return value;
  if (granularity === "week") {
    const iso = isoWeekParts(date);
    return `${String(iso.year).padStart(4, "0")}-W${String(iso.week).padStart(2, "0")}`;
  }
  if (granularity === "month") return value.slice(0, 7);
  if (granularity === "quarter") {
    return `${year}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
  }
  return year;
}

export function getDashboardTrendGranularityOptions(
  selectedRange: DashboardDateRange,
): DashboardTrendGranularityOption[] {
  const validation = validateDashboardDateRange(
    selectedRange.from,
    selectedRange.to,
  );
  if (!validation.valid) return [];

  const from = parseDateKey(selectedRange.from)!;
  const to = parseDateKey(selectedRange.to)!;
  const definitions: Array<{
    granularity: DashboardTrendGranularity;
    label: string;
  }> = [
    { granularity: "day", label: "Diaria" },
    { granularity: "week", label: "Semanal (ISO 8601)" },
    { granularity: "month", label: "Mensual" },
    { granularity: "quarter", label: "Trimestral (calendario)" },
    { granularity: "year", label: "Anual" },
  ];

  return definitions.map(({ granularity, label }) => {
    let bucketCount = 0;
    for (
      let cursor = startOfBucket(from, granularity);
      cursor.getTime() <= to.getTime();
      cursor = advanceBucket(cursor, granularity)
    ) {
      bucketCount += 1;
      if (bucketCount > MAX_DASHBOARD_TREND_BUCKETS) break;
    }
    return {
      granularity,
      label,
      bucketCount,
      available: bucketCount <= MAX_DASHBOARD_TREND_BUCKETS,
    };
  });
}

export function validateDashboardDateRange(
  from: string,
  to: string,
): DashboardDateRangeValidation {
  const fromDate = parseDateKey(from);
  const toDate = parseDateKey(to);
  if (!fromDate || !toDate) {
    return {
      valid: false,
      message: "Selecciona dos fechas válidas para el rango.",
    };
  }
  if (fromDate.getTime() > toDate.getTime()) {
    return {
      valid: false,
      message: "La fecha Desde no puede ser posterior a Hasta.",
    };
  }
  return { valid: true, range: { from, to } };
}

export function buildDashboardRangePreset(
  preset: Exclude<DashboardRangePreset, "custom">,
  referenceDate: Date = new Date(),
): DashboardDateRange {
  if (Number.isNaN(referenceDate.getTime())) {
    throw new Error("Dashboard reference date must be valid.");
  }
  const today = dateOnly(referenceDate);
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();
  const makeDate = (dateYear: number, dateMonth: number, dateDay: number) => {
    const result = new Date(0);
    result.setUTCHours(0, 0, 0, 0);
    result.setUTCFullYear(dateYear, dateMonth, dateDay);
    return result;
  };

  if (preset === "this-month") {
    return range(makeDate(year, month, 1), today);
  }
  if (preset === "last-12-months") {
    return range(makeDate(year, month - 11, 1), today);
  }
  if (preset === "previous-month") {
    return range(makeDate(year, month - 1, 1), makeDate(year, month, 0));
  }
  if (preset === "last-30-days" || preset === "last-90-days") {
    const length = preset === "last-30-days" ? 30 : 90;
    return range(addDays(today, 1 - length), today);
  }
  return range(makeDate(year, 0, 1), today);
}

export function buildDashboardComparisonRanges(
  current: DashboardDateRange,
): DashboardPeriodRanges {
  const validation = validateDashboardDateRange(current.from, current.to);
  if (!validation.valid) throw new Error(validation.message);

  const from = parseDateKey(current.from)!;
  const to = parseDateKey(current.to)!;
  const durationDays = (to.getTime() - from.getTime()) / 86_400_000 + 1;
  const previousTo = addDays(from, -1);
  const previousFrom = addDays(previousTo, 1 - durationDays);
  return {
    current,
    previous: range(previousFrom, previousTo),
    periodLabel: "Rango seleccionado",
    comparisonLabel: "el período anterior de duración equivalente",
  };
}

export function buildDashboardMonthComparisonRanges(
  current: DashboardDateRange,
): DashboardPeriodRanges {
  const validation = validateDashboardDateRange(current.from, current.to);
  if (!validation.valid) throw new Error(validation.message);
  const from = parseDateKey(current.from)!;
  const to = parseDateKey(current.to)!;
  if (
    from.getUTCDate() !== 1 ||
    from.getUTCFullYear() !== to.getUTCFullYear() ||
    from.getUTCMonth() !== to.getUTCMonth()
  ) {
    throw new Error(
      "Monthly comparison requires one calendar month starting on day one.",
    );
  }

  const previousFrom = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - 1, 1),
  );
  const previousLastDay = daysInMonth(
    previousFrom.getUTCFullYear(),
    previousFrom.getUTCMonth(),
  );
  const currentLastDay = daysInMonth(to.getUTCFullYear(), to.getUTCMonth());
  const fullMonth = to.getUTCDate() === currentLastDay;
  const previousTo = new Date(
    Date.UTC(
      previousFrom.getUTCFullYear(),
      previousFrom.getUTCMonth(),
      fullMonth ? previousLastDay : Math.min(to.getUTCDate(), previousLastDay),
    ),
  );
  return {
    current,
    previous: range(previousFrom, previousTo),
    periodLabel: "Mes seleccionado",
    comparisonLabel: fullMonth
      ? "el mes calendario anterior completo"
      : "el mismo día del mes anterior (o su último día disponible)",
  };
}

export function buildDashboardPriorYearComparisonRanges(
  current: DashboardDateRange,
): DashboardPeriodRanges {
  const validation = validateDashboardDateRange(current.from, current.to);
  if (!validation.valid) throw new Error(validation.message);
  const from = parseDateKey(current.from)!;
  const to = parseDateKey(current.to)!;
  const priorDate = (date: Date) => {
    const year = date.getUTCFullYear() - 1;
    const month = date.getUTCMonth();
    return new Date(
      Date.UTC(
        year,
        month,
        Math.min(date.getUTCDate(), daysInMonth(year, month)),
      ),
    );
  };
  return {
    current,
    previous: range(priorDate(from), priorDate(to)),
    periodLabel: "Últimos 12 meses",
    comparisonLabel: "los mismos meses del año anterior",
  };
}

export function buildDashboardTrendSeries(
  expenses: readonly DashboardTrendRecord[],
  incomes: readonly DashboardTrendRecord[],
  selectedRange: DashboardDateRange,
  granularity: DashboardTrendGranularity,
): DashboardTrendSeries {
  const validation = validateDashboardDateRange(
    selectedRange.from,
    selectedRange.to,
  );
  if (!validation.valid) throw new Error(validation.message);

  const from = parseDateKey(selectedRange.from)!;
  const to = parseDateKey(selectedRange.to)!;
  const durationDays = (to.getTime() - from.getTime()) / 86_400_000 + 1;
  const availability = getDashboardTrendGranularityOptions(selectedRange).find(
    (option) => option.granularity === granularity,
  );
  if (!availability?.available) {
    throw new Error(
      "Selected dashboard trend granularity exceeds the point limit.",
    );
  }

  const buckets = new Map<
    string,
    {
      start: string;
      end: string;
      incomeCents: bigint;
      expenseCents: bigint;
      incomeCount: number;
      expenseCount: number;
    }
  >();

  for (
    let cursor = startOfBucket(from, granularity);
    cursor.getTime() <= to.getTime();
    cursor = advanceBucket(cursor, granularity)
  ) {
    const next = advanceBucket(cursor, granularity);
    const bucketStart = cursor.getTime() < from.getTime() ? from : cursor;
    const bucketEnd =
      addDays(next, -1).getTime() > to.getTime() ? to : addDays(next, -1);
    buckets.set(dateKey(cursor), {
      start: dateKey(bucketStart),
      end: dateKey(bucketEnd),
      incomeCents: BigInt(0),
      expenseCents: BigInt(0),
      incomeCount: 0,
      expenseCount: 0,
    });
  }

  let totalIncomeCents = BigInt(0);
  let totalExpenseCents = BigInt(0);
  let incomeCount = 0;
  let expenseCount = 0;

  const addRecords = (
    records: readonly DashboardTrendRecord[],
    kind: "income" | "expense",
  ) => {
    for (const [index, record] of records.entries()) {
      const date = parseDateKey(record.date);
      if (!date) throw new Error(`${kind}[${index}].date must be YYYY-MM-DD.`);
      if (date.getTime() < from.getTime() || date.getTime() > to.getTime()) {
        continue;
      }
      const cents = toCents(record.amount, `${kind}[${index}].amount`);
      if (cents < BigInt(0)) {
        throw new Error(`${kind}[${index}].amount cannot be negative.`);
      }
      const key = dateKey(startOfBucket(date, granularity));
      const bucket = buckets.get(key);
      if (!bucket) throw new Error("Dashboard trend bucket is missing.");

      if (kind === "income") {
        bucket.incomeCents += cents;
        bucket.incomeCount += 1;
        totalIncomeCents += cents;
        incomeCount += 1;
      } else {
        bucket.expenseCents += cents;
        bucket.expenseCount += 1;
        totalExpenseCents += cents;
        expenseCount += 1;
      }
    }
  };

  addRecords(incomes, "income");
  addRecords(expenses, "expense");

  return {
    range: { ...selectedRange },
    granularity,
    durationDays,
    points: [...buckets.values()].map((bucket) => ({
      start: bucket.start,
      end: bucket.end,
      incomeAmount: fromCents(bucket.incomeCents, "trend income amount"),
      expenseAmount: fromCents(bucket.expenseCents, "trend expense amount"),
      incomeCount: bucket.incomeCount,
      expenseCount: bucket.expenseCount,
    })),
    totalIncome: fromCents(totalIncomeCents, "trend total income"),
    totalExpenses: fromCents(totalExpenseCents, "trend total expenses"),
    incomeCount,
    expenseCount,
  };
}

export function getDashboardTrendExtremes(
  series: DashboardTrendSeries,
): DashboardTrendExtremes {
  const activePeriods = series.points
    .filter((point) => point.incomeCount + point.expenseCount > 0)
    .map((point) => ({
      point,
      movementCents:
        toCents(point.incomeAmount, "trend income amount") +
        toCents(point.expenseAmount, "trend expense amount"),
      recordCount: point.incomeCount + point.expenseCount,
    }));
  if (activePeriods.length === 0) {
    return { mostActive: null, leastActive: null };
  }
  const chronological = (
    left: (typeof activePeriods)[number],
    right: (typeof activePeriods)[number],
  ) => left.point.start.localeCompare(right.point.start);
  const mostActive = [...activePeriods].sort(
    (left, right) =>
      (left.movementCents === right.movementCents
        ? 0
        : left.movementCents > right.movementCents
          ? -1
          : 1) || chronological(left, right),
  )[0];
  const leastActive = [...activePeriods].sort(
    (left, right) =>
      (left.movementCents === right.movementCents
        ? 0
        : left.movementCents < right.movementCents
          ? -1
          : 1) || chronological(left, right),
  )[0];
  return {
    mostActive: {
      point: mostActive.point,
      movementAmount: fromCents(
        mostActive.movementCents,
        "trend movement amount",
      ),
      recordCount: mostActive.recordCount,
    },
    leastActive: {
      point: leastActive.point,
      movementAmount: fromCents(
        leastActive.movementCents,
        "trend movement amount",
      ),
      recordCount: leastActive.recordCount,
    },
  };
}

export function buildDashboardPayerDistribution(
  expenses: readonly DashboardPayerRecord[],
): DashboardPayerSlice[] {
  const rows = new Map<
    string,
    {
      memberId: string | null;
      memberName: string;
      cents: bigint;
      count: number;
    }
  >();

  for (const [index, expense] of expenses.entries()) {
    const cents = toCents(
      expense.totalAmount,
      `expenses[${index}].totalAmount`,
    );
    if (cents < BigInt(0)) {
      throw new Error(`expenses[${index}].totalAmount cannot be negative.`);
    }
    const memberId = expense.paidBy?.memberId.trim() || null;
    const key = memberId?.toLowerCase() ?? "__unknown_payer__";
    const existing = rows.get(key);
    if (existing) {
      existing.cents += cents;
      existing.count += 1;
    } else {
      rows.set(key, {
        memberId,
        memberName: expense.paidBy?.name.trim() || "Pagador no identificado",
        cents,
        count: 1,
      });
    }
  }

  const totalCents = [...rows.values()].reduce(
    (total, row) => total + row.cents,
    BigInt(0),
  );

  return [...rows.values()]
    .sort((left, right) => {
      if (left.cents !== right.cents) return left.cents > right.cents ? -1 : 1;
      return left.memberName.localeCompare(right.memberName, "es");
    })
    .map((row) => ({
      memberId: row.memberId,
      memberName: row.memberName,
      amount: fromCents(row.cents, "payer amount"),
      percentage:
        totalCents > BigInt(0) ? percentFromRatio(row.cents, totalCents) : null,
      expenseCount: row.count,
    }));
}

export function buildDashboardMemberExpenseDistribution(
  expenses: readonly DashboardMemberExpenseRecord[],
  selectedRange: DashboardDateRange,
): DashboardMemberExpenseDistribution {
  const validation = validateDashboardDateRange(
    selectedRange.from,
    selectedRange.to,
  );
  if (!validation.valid) throw new Error("Dashboard range is invalid.");

  const rows = new Map<
    string,
    {
      memberId: string | null;
      memberName: string;
      paidCents: bigint;
      assignedCents: bigint;
      paidExpenseCount: number;
      assignedExpenseCount: number;
    }
  >();
  const seenExpenseIds = new Set<string>();
  let totalPaidCents = BigInt(0);
  let totalAssignedCents = BigInt(0);
  let expenseCount = 0;
  let expensesWithoutDistribution = 0;

  const getRow = (memberId: string | null, memberName: string) => {
    const key = memberId?.toLowerCase() ?? "__unknown_payer__";
    const existing = rows.get(key);
    if (existing) return existing;
    const row = {
      memberId,
      memberName:
        memberName ||
        (memberId === null
          ? "Pagador no identificado"
          : "Integrante del hogar"),
      paidCents: BigInt(0),
      assignedCents: BigInt(0),
      paidExpenseCount: 0,
      assignedExpenseCount: 0,
    };
    rows.set(key, row);
    return row;
  };

  for (const [index, expense] of expenses.entries()) {
    const date = parseDateKey(expense.expenseDate);
    if (!date)
      throw new Error(`expenses[${index}].expenseDate must be YYYY-MM-DD.`);
    if (
      expense.expenseDate < selectedRange.from ||
      expense.expenseDate > selectedRange.to
    ) {
      continue;
    }
    const expenseId = expense.id.trim().toLowerCase();
    if (!expenseId || seenExpenseIds.has(expenseId)) {
      throw new Error("Dashboard expense IDs must be present and unique.");
    }
    seenExpenseIds.add(expenseId);
    const amount = toCents(
      expense.totalAmount,
      `expenses[${index}].totalAmount`,
    );
    if (amount < BigInt(0)) {
      throw new Error(`expenses[${index}].totalAmount cannot be negative.`);
    }
    expenseCount += 1;
    totalPaidCents += amount;

    const paidById = expense.paidBy?.memberId.trim() || null;
    const paidBy = getRow(
      paidById,
      expense.paidBy?.name.trim() || "Pagador no identificado",
    );
    paidBy.paidCents += amount;
    paidBy.paidExpenseCount += 1;

    if (expense.distributions.length === 0) {
      expensesWithoutDistribution += 1;
      continue;
    }
    const distributionIds = new Set<string>();
    for (const [
      distributionIndex,
      distribution,
    ] of expense.distributions.entries()) {
      const memberId = distribution.memberId.trim();
      if (!memberId || distributionIds.has(memberId.toLowerCase())) {
        throw new Error(
          `expenses[${index}].distributions contains duplicate or missing members.`,
        );
      }
      distributionIds.add(memberId.toLowerCase());
      const assignedCents = toCents(
        distribution.amount,
        `expenses[${index}].distributions[${distributionIndex}].amount`,
      );
      if (assignedCents < BigInt(0)) {
        throw new Error("Dashboard assigned amounts cannot be negative.");
      }
      const member = getRow(memberId, distribution.memberName.trim());
      member.assignedCents += assignedCents;
      member.assignedExpenseCount += 1;
      totalAssignedCents += assignedCents;
    }
  }

  return {
    range: validation.range,
    members: [...rows.values()]
      .sort((left, right) => {
        const leftMaximum =
          left.paidCents > left.assignedCents
            ? left.paidCents
            : left.assignedCents;
        const rightMaximum =
          right.paidCents > right.assignedCents
            ? right.paidCents
            : right.assignedCents;
        if (leftMaximum !== rightMaximum)
          return leftMaximum > rightMaximum ? -1 : 1;
        return left.memberName.localeCompare(right.memberName, "es");
      })
      .map((row) => ({
        memberId: row.memberId,
        memberName: row.memberName,
        paidAmount: fromCents(row.paidCents, "member paid amount"),
        assignedAmount: fromCents(row.assignedCents, "member assigned amount"),
        paidExpenseCount: row.paidExpenseCount,
        assignedExpenseCount: row.assignedExpenseCount,
      })),
    expenseCount,
    expensesWithoutDistribution,
    totalPaid: fromCents(totalPaidCents, "total paid amount"),
    totalAssigned: fromCents(totalAssignedCents, "total assigned amount"),
  };
}

export function buildDashboardFinancialComposition(
  totalIncome: number,
  totalExpenses: number,
): DashboardFinancialComposition {
  const incomeCents = toCents(totalIncome, "totalIncome");
  const expenseCents = toCents(totalExpenses, "totalExpenses");
  if (incomeCents < BigInt(0) || expenseCents < BigInt(0)) {
    throw new Error("Dashboard income and expenses cannot be negative.");
  }
  const ratioHundredths =
    incomeCents > BigInt(0)
      ? (expenseCents * BigInt(10_000) + incomeCents / BigInt(2)) / incomeCents
      : null;
  return {
    totalIncome: fromCents(incomeCents, "totalIncome"),
    totalExpenses: fromCents(expenseCents, "totalExpenses"),
    netAmount: fromCents(incomeCents - expenseCents, "netAmount"),
    expensesAsPercentOfIncome:
      ratioHundredths !== null &&
      ratioHundredths <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(ratioHundredths) / 100
        : null,
  };
}

const DASHBOARD_WEEKDAYS = [
  "Lunes",
  "Martes",
  "Miércoles",
  "Jueves",
  "Viernes",
  "Sábado",
  "Domingo",
] as const;

export function buildDashboardWeekdayDistribution(
  expenses: readonly DashboardWeekdayExpenseRecord[],
  selectedRange: DashboardDateRange,
): DashboardWeekdayDistribution {
  const validation = validateDashboardDateRange(
    selectedRange.from,
    selectedRange.to,
  );
  if (!validation.valid) throw new Error("Dashboard range is invalid.");
  const from = parseDateKey(selectedRange.from)!;
  const to = parseDateKey(selectedRange.to)!;
  const totalDays =
    Math.floor((to.getTime() - from.getTime()) / 86_400_000) + 1;
  const calendarDayCounts = Array<number>(7).fill(Math.floor(totalDays / 7));
  const firstWeekday = (from.getUTCDay() + 6) % 7;
  const remainder = totalDays % 7;
  for (let offset = 0; offset < remainder; offset += 1) {
    calendarDayCounts[(firstWeekday + offset) % 7] += 1;
  }

  const amountByWeekday = Array<bigint>(7).fill(BigInt(0));
  const countByWeekday = Array<number>(7).fill(0);
  const seenExpenseIds = new Set<string>();
  let totalAmountCents = BigInt(0);
  let expenseCount = 0;

  for (const [index, expense] of expenses.entries()) {
    const date = parseDateKey(expense.expenseDate);
    if (!date)
      throw new Error(`expenses[${index}].expenseDate must be YYYY-MM-DD.`);
    if (
      expense.expenseDate < selectedRange.from ||
      expense.expenseDate > selectedRange.to
    ) {
      continue;
    }
    const expenseId = expense.id.trim().toLowerCase();
    if (!expenseId || seenExpenseIds.has(expenseId)) {
      throw new Error("Dashboard expense IDs must be present and unique.");
    }
    seenExpenseIds.add(expenseId);
    const amount = toCents(
      expense.totalAmount,
      `expenses[${index}].totalAmount`,
    );
    if (amount < BigInt(0)) {
      throw new Error(`expenses[${index}].totalAmount cannot be negative.`);
    }
    const weekdayIndex = (date.getUTCDay() + 6) % 7;
    amountByWeekday[weekdayIndex] += amount;
    countByWeekday[weekdayIndex] += 1;
    totalAmountCents += amount;
    expenseCount += 1;
  }

  return {
    range: validation.range,
    expenseCount,
    totalAmount: fromCents(totalAmountCents, "weekday total amount"),
    days: DASHBOARD_WEEKDAYS.map((weekday, weekdayIndex) => {
      const dayCount = BigInt(calendarDayCounts[weekdayIndex]);
      const averageCents =
        dayCount > BigInt(0)
          ? (amountByWeekday[weekdayIndex] + dayCount / BigInt(2)) / dayCount
          : BigInt(0);
      return {
        weekday,
        weekdayIndex,
        totalAmount: fromCents(amountByWeekday[weekdayIndex], "weekday amount"),
        averageAmount:
          dayCount > BigInt(0)
            ? fromCents(averageCents, "weekday average amount")
            : null,
        calendarDayCount: calendarDayCounts[weekdayIndex],
        expenseCount: countByWeekday[weekdayIndex],
      };
    }),
  };
}

export function buildDashboardPeriodRanges(
  period: DashboardPeriod,
  referenceDate: Date = new Date(),
): DashboardPeriodRanges {
  if (Number.isNaN(referenceDate.getTime())) {
    throw new Error("Dashboard reference date must be valid.");
  }

  const today = dateOnly(referenceDate);
  if (period === "month-to-date") {
    const year = today.getUTCFullYear();
    const monthIndex = today.getUTCMonth();
    const currentFrom = new Date(Date.UTC(year, monthIndex, 1));
    const previousYear = monthIndex === 0 ? year - 1 : year;
    const previousMonth = monthIndex === 0 ? 11 : monthIndex - 1;
    const previousDay = Math.min(
      today.getUTCDate(),
      daysInMonth(previousYear, previousMonth),
    );
    return {
      current: range(currentFrom, today),
      previous: range(
        new Date(Date.UTC(previousYear, previousMonth, 1)),
        new Date(Date.UTC(previousYear, previousMonth, previousDay)),
      ),
      periodLabel: "Mes en curso",
      comparisonLabel: "el mismo tramo del mes anterior",
    };
  }

  if (period === "last-90-days") {
    const currentFrom = addDays(today, -89);
    return {
      current: range(currentFrom, today),
      previous: range(addDays(currentFrom, -90), addDays(currentFrom, -1)),
      periodLabel: "Últimos 90 días",
      comparisonLabel: "los 90 días anteriores",
    };
  }

  const currentYear = today.getUTCFullYear();
  const previousYear = currentYear - 1;
  const previousEnd = new Date(
    Date.UTC(
      previousYear,
      today.getUTCMonth(),
      Math.min(
        today.getUTCDate(),
        daysInMonth(previousYear, today.getUTCMonth()),
      ),
    ),
  );
  return {
    current: range(new Date(Date.UTC(currentYear, 0, 1)), today),
    previous: range(new Date(Date.UTC(previousYear, 0, 1)), previousEnd),
    periodLabel: "Año en curso",
    comparisonLabel: "el mismo tramo del año anterior",
  };
}

export function compareDashboardAmounts(
  currentAmount: number,
  previousAmount: number,
): DashboardAmountDelta {
  const current = toCents(currentAmount, "currentAmount");
  const previous = toCents(previousAmount, "previousAmount");
  const delta = current - previous;

  return {
    amount: fromCents(delta, "amount delta"),
    percentage: previous > BigInt(0) ? percentFromRatio(delta, previous) : null,
    direction:
      delta > BigInt(0)
        ? "increase"
        : delta < BigInt(0)
          ? "decrease"
          : "unchanged",
  };
}

export function getDashboardSharePercent(
  partAmount: number,
  totalAmount: number,
): number | null {
  const part = toCents(partAmount, "partAmount");
  const total = toCents(totalAmount, "totalAmount");
  return total > BigInt(0) ? percentFromRatio(part, total) : null;
}

export function getDashboardCategorySlices(
  summary: DashboardResult,
  limit = 5,
): DashboardCategorySlice[] {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Category slice limit must be a positive integer.");
  }

  const totalCents = toCents(summary.totalSpent, "totalSpent");
  const categories = summary.byCategory
    .map((category) => ({
      ...category,
      cents: toCents(category.amount, "category amount"),
    }))
    .sort((left, right) => {
      if (left.cents !== right.cents) return left.cents > right.cents ? -1 : 1;
      return (left.categoryName ?? "Sin categoría").localeCompare(
        right.categoryName ?? "Sin categoría",
        "es",
      );
    });

  const visible = categories.slice(0, limit).map((category) => ({
    categoryId: category.categoryId,
    categoryName: category.categoryName ?? "Sin categoría",
    amount: fromCents(category.cents, "category amount"),
    percentage:
      totalCents > BigInt(0)
        ? percentFromRatio(category.cents, totalCents)
        : null,
    aggregated: false,
  }));

  const remainder = categories.slice(limit);
  if (remainder.length > 0) {
    const remainderCents = remainder.reduce(
      (total, category) => total + category.cents,
      BigInt(0),
    );
    visible.push({
      categoryId: null,
      categoryName: "Otras categorías",
      amount: fromCents(remainderCents, "other category amount"),
      percentage:
        totalCents > BigInt(0)
          ? percentFromRatio(remainderCents, totalCents)
          : null,
      aggregated: true,
    });
  }

  return visible;
}

export function getDashboardDonutSlices(
  summary: DashboardResult,
): DashboardCategorySlice[] {
  const total = toCents(summary.totalSpent, "totalSpent");
  if (total <= BigInt(0)) return [];
  const slices = getDashboardCategorySlices(summary);
  const attributed = slices.reduce(
    (sum, slice) => sum + toCents(slice.amount, "category amount"),
    BigInt(0),
  );
  const positiveSlices = slices.filter((slice) => slice.amount > 0);
  return slices.every((slice) => slice.amount >= 0) &&
    positiveSlices.length >= 2 &&
    attributed === total
    ? positiveSlices
    : [];
}

export function getDashboardExecutiveInsights(
  current: DashboardResult,
  previous: DashboardResult | null,
): DashboardExecutiveInsight[] {
  const insights: DashboardExecutiveInsight[] = [];
  const top = getDashboardDonutSlices(current)[0];
  if (
    top &&
    !top.aggregated &&
    top.percentage !== null &&
    top.percentage >= 35
  ) {
    insights.push({
      kind: "concentration",
      categoryName: top.categoryName,
      amount: top.amount,
      percentage: top.percentage,
    });
  }
  if (previous) {
    const change = getLargestDashboardCategoryChange(current, previous);
    const comparisonBase = [current.totalSpent, previous.totalSpent]
      .map((amount) => toCents(amount, "period spending"))
      .reduce(
        (largest, amount) => (amount > largest ? amount : largest),
        BigInt(0),
      );
    const changeCents = change
      ? toCents(Math.abs(change.changeAmount), "category change")
      : BigInt(0);
    if (
      change &&
      comparisonBase > BigInt(0) &&
      changeCents * BigInt(100) >= comparisonBase * BigInt(5)
    ) {
      insights.push({
        kind: "category-change",
        categoryName: change.categoryName,
        changeAmount: change.changeAmount,
        currentAmount: change.currentAmount,
        previousAmount: change.previousAmount,
      });
    }
    const expense = compareDashboardAmounts(
      current.totalSpent,
      previous.totalSpent,
    );
    const income = compareDashboardAmounts(
      current.totalIncome,
      previous.totalIncome,
    );
    if (expense.direction === "increase" && income.direction === "decrease") {
      insights.push({
        kind: "opposing-trends",
        expenseChange: expense.amount,
        incomeChange: income.amount,
      });
    }
  }
  return insights.slice(0, 3);
}

export function getTopThreeCategorySharePercent(
  summary: DashboardResult,
): number | null {
  if (summary.byCategory.length < 2) return null;
  const totalCents = toCents(summary.totalSpent, "totalSpent");
  if (totalCents <= BigInt(0)) return null;

  const topThreeCents = [...summary.byCategory]
    .map((category) => toCents(category.amount, "category amount"))
    .sort((left, right) => (left === right ? 0 : left > right ? -1 : 1))
    .slice(0, 3)
    .reduce((total, amount) => total + amount, BigInt(0));

  return percentFromRatio(topThreeCents, totalCents);
}

export function getLargestDashboardCategoryChange(
  current: DashboardResult,
  previous: DashboardResult,
): DashboardCategoryChange | null {
  const categories = new Map<
    string,
    {
      categoryId: string | null;
      categoryName: string;
      currentCents: bigint;
      previousCents: bigint;
    }
  >();
  const keyFor = (categoryId: string | null) =>
    categoryId?.toLowerCase() ?? "__uncategorized__";

  for (const category of previous.byCategory) {
    categories.set(keyFor(category.categoryId), {
      categoryId: category.categoryId,
      categoryName: category.categoryName ?? "Sin categoría",
      currentCents: BigInt(0),
      previousCents: toCents(category.amount, "previous category amount"),
    });
  }
  for (const category of current.byCategory) {
    const key = keyFor(category.categoryId);
    const existing = categories.get(key);
    if (existing) {
      existing.categoryName = category.categoryName ?? "Sin categoría";
      existing.currentCents = toCents(
        category.amount,
        "current category amount",
      );
    } else {
      categories.set(key, {
        categoryId: category.categoryId,
        categoryName: category.categoryName ?? "Sin categoría",
        currentCents: toCents(category.amount, "current category amount"),
        previousCents: BigInt(0),
      });
    }
  }

  const changes = [...categories.values()]
    .map((category) => ({
      ...category,
      deltaCents: category.currentCents - category.previousCents,
    }))
    .filter((category) => category.deltaCents !== BigInt(0))
    .sort((left, right) => {
      const leftAbs =
        left.deltaCents < BigInt(0) ? -left.deltaCents : left.deltaCents;
      const rightAbs =
        right.deltaCents < BigInt(0) ? -right.deltaCents : right.deltaCents;
      if (leftAbs !== rightAbs) return leftAbs > rightAbs ? -1 : 1;
      return left.categoryName.localeCompare(right.categoryName, "es");
    });

  const largest = changes[0];
  if (!largest) return null;
  return {
    categoryId: largest.categoryId,
    categoryName: largest.categoryName,
    currentAmount: fromCents(largest.currentCents, "current category amount"),
    previousAmount: fromCents(
      largest.previousCents,
      "previous category amount",
    ),
    changeAmount: fromCents(largest.deltaCents, "category change"),
    direction: largest.deltaCents > BigInt(0) ? "increase" : "decrease",
  };
}

export function getDashboardCategoryComparisonSlices(
  current: DashboardResult,
  previous: DashboardResult,
  limit = 5,
): DashboardCategoryComparisonSlice[] {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Category comparison limit must be a positive integer.");
  }
  const categories = new Map<
    string,
    {
      categoryId: string | null;
      categoryName: string;
      currentCents: bigint;
      previousCents: bigint;
    }
  >();
  const keyFor = (categoryId: string | null) =>
    categoryId?.toLowerCase() ?? "__uncategorized__";

  for (const category of previous.byCategory) {
    categories.set(keyFor(category.categoryId), {
      categoryId: category.categoryId,
      categoryName: category.categoryName ?? "Sin categoría",
      currentCents: BigInt(0),
      previousCents: toCents(category.amount, "previous category amount"),
    });
  }
  for (const category of current.byCategory) {
    const key = keyFor(category.categoryId);
    const existing = categories.get(key);
    if (existing) {
      existing.categoryName = category.categoryName ?? "Sin categoría";
      existing.currentCents = toCents(
        category.amount,
        "current category amount",
      );
    } else {
      categories.set(key, {
        categoryId: category.categoryId,
        categoryName: category.categoryName ?? "Sin categoría",
        currentCents: toCents(category.amount, "current category amount"),
        previousCents: BigInt(0),
      });
    }
  }

  const rows = [...categories.values()].map((category) => ({
    ...category,
    changeCents: category.currentCents - category.previousCents,
  }));
  const changedRows = rows
    .filter((category) => category.changeCents !== BigInt(0))
    .sort((left, right) => {
      const leftAbs =
        left.changeCents < BigInt(0) ? -left.changeCents : left.changeCents;
      const rightAbs =
        right.changeCents < BigInt(0) ? -right.changeCents : right.changeCents;
      if (leftAbs !== rightAbs) return leftAbs > rightAbs ? -1 : 1;
      return left.categoryName.localeCompare(right.categoryName, "es");
    });
  if (changedRows.length === 0) return [];

  const visibleRows = changedRows.slice(0, limit);
  const visibleKeys = new Set(
    visibleRows.map((category) => keyFor(category.categoryId)),
  );
  const visible = visibleRows.map((category) => ({
    categoryId: category.categoryId,
    categoryName: category.categoryName,
    currentAmount: fromCents(category.currentCents, "current category amount"),
    previousAmount: fromCents(
      category.previousCents,
      "previous category amount",
    ),
    changeAmount: fromCents(category.changeCents, "category change"),
    percentageChange:
      category.previousCents > BigInt(0)
        ? percentFromRatio(category.changeCents, category.previousCents)
        : null,
    aggregated: false,
  }));
  const remainder = rows.filter(
    (category) => !visibleKeys.has(keyFor(category.categoryId)),
  );
  if (remainder.length > 0) {
    const currentCents = remainder.reduce(
      (sum, category) => sum + category.currentCents,
      BigInt(0),
    );
    const previousCents = remainder.reduce(
      (sum, category) => sum + category.previousCents,
      BigInt(0),
    );
    const changeCents = currentCents - previousCents;
    visible.push({
      categoryId: null,
      categoryName: "Otras categorías",
      currentAmount: fromCents(currentCents, "other current category amount"),
      previousAmount: fromCents(
        previousCents,
        "other previous category amount",
      ),
      changeAmount: fromCents(changeCents, "other category change"),
      percentageChange:
        previousCents > BigInt(0)
          ? percentFromRatio(changeCents, previousCents)
          : null,
      aggregated: true,
    });
  }
  return visible;
}

export function getDashboardExpenseBridge(
  current: DashboardResult,
  previous: DashboardResult,
): DashboardExpenseBridge | null {
  const previousCents = toCents(previous.totalSpent, "previous expense total");
  const currentCents = toCents(current.totalSpent, "current expense total");
  if (previousCents < BigInt(0) || currentCents < BigInt(0)) return null;
  const attributedPrevious = previous.byCategory.reduce(
    (sum, category) =>
      sum + toCents(category.amount, "previous category amount"),
    BigInt(0),
  );
  const attributedCurrent = current.byCategory.reduce(
    (sum, category) =>
      sum + toCents(category.amount, "current category amount"),
    BigInt(0),
  );
  if (
    attributedPrevious !== previousCents ||
    attributedCurrent !== currentCents
  )
    return null;

  let cursor = previousCents;
  let crossedBelowZero = false;
  const steps = getDashboardCategoryComparisonSlices(current, previous)
    .filter((category) => category.changeAmount !== 0)
    .map((category) => {
      const fromAmount = fromCents(cursor, "expense bridge start");
      cursor += toCents(category.changeAmount, "category expense change");
      if (cursor < BigInt(0)) crossedBelowZero = true;
      return {
        ...category,
        fromAmount,
        toAmount: fromCents(cursor, "expense bridge end"),
      };
    });

  // The visual bridge is shown only when category attribution reconciles exactly.
  if (cursor !== currentCents || steps.length === 0 || crossedBelowZero)
    return null;
  return {
    previousAmount: previous.totalSpent,
    currentAmount: current.totalSpent,
    steps,
  };
}

export function buildDashboardActivity(
  expenses: readonly DashboardActivityExpenseSource[],
  incomes: readonly DashboardActivityIncomeSource[],
  limit = 6,
): DashboardActivityItem[] {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error("Activity limit must be a non-negative integer.");
  }

  const items: DashboardActivityItem[] = [
    ...expenses.map((expense) => ({
      id: expense.id,
      kind: "expense" as const,
      date: expense.expenseDate,
      amount: expense.totalAmount,
      title:
        expense.merchant?.trim() ||
        expense.description?.trim() ||
        "Gasto registrado",
      detail: expense.categoryName ?? "Sin categoría",
    })),
    ...incomes.map((income) => ({
      id: income.id,
      kind: "income" as const,
      date: income.incomeDate,
      amount: income.amount,
      title: income.description.trim() || "Ingreso registrado",
      detail: income.memberName || "Integrante del hogar",
    })),
  ];

  return items
    .sort(
      (left, right) =>
        right.date.localeCompare(left.date) ||
        left.kind.localeCompare(right.kind) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, limit);
}
