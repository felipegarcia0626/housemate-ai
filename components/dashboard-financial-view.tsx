"use client";

import { useEffect, useMemo, useState } from "react";
import type { HierarchicalCategory } from "@/modules/categories/category.types";
import type { BalanceResult } from "@/modules/expenses/balance.types";
import type { DashboardResult } from "@/modules/dashboard/dashboard.types";
import {
  buildDashboardActivity,
  formatDashboardTrendBucketLabel,
  buildDashboardComparisonRanges,
  buildDashboardMonthComparisonRanges,
  buildDashboardPriorYearComparisonRanges,
  buildDashboardFinancialComposition,
  buildDashboardMemberExpenseDistribution,
  getDashboardCategoryComparisonSlices,
  buildDashboardRangePreset,
  buildDashboardTrendSeries,
  getDashboardTrendExtremes,
  getDashboardTrendGranularityOptions,
  buildDashboardWeekdayDistribution,
  MAX_DASHBOARD_TREND_BUCKETS,
  compareDashboardAmounts,
  getDashboardCategorySlices,
  getDashboardDonutSlices,
  getDashboardExpenseBridge,
  getDashboardExecutiveInsights,
  getDashboardSharePercent,
  getLargestDashboardCategoryChange,
  getTopThreeCategorySharePercent,
  validateDashboardDateRange,
  type DashboardDateRange,
  type DashboardActivityItem,
  type DashboardRangePreset,
  type DashboardTrendGranularity,
  type DashboardTrendSeries,
  type DashboardExpenseBridge,
} from "@/modules/dashboard/dashboard-presentation";

interface DashboardMember {
  id: string;
  displayName: string;
}

interface RecentExpense {
  id: string;
  merchant: string | null;
  description?: string | null;
  totalAmount: number;
  expenseDate: string;
  category: { id: string; name: string; parentName?: string | null } | null;
  paidBy?: { memberId: string; name: string } | null;
  distributions?: {
    memberId: string;
    memberName: string;
    percentage: number;
    amount: number;
  }[];
}

interface RecentIncome {
  id: string;
  memberId: string;
  amount: number;
  incomeDate: string;
  description: string;
}

interface FinancialDashboardProps {
  householdName?: string;
  refreshVersion: number;
  members: readonly DashboardMember[];
  expenseCategories: readonly HierarchicalCategory[];
  balance: BalanceResult | null;
  balanceError?: string;
  onOpenExpenses: (range: DashboardDateRange) => void;
  onOpenIncomes: (range: DashboardDateRange) => void;
  onOpenBalance: () => void;
}

interface CollectionPagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

interface CollectionPage<T> {
  data: T[];
  pagination: CollectionPagination;
}

interface DashboardRequestState {
  key: string;
  summary: DashboardResult | null;
  previousSummary: DashboardResult | null;
  summaryError: string;
  comparisonError: string;
  expenses: RecentExpense[] | null;
  incomes: RecentIncome[] | null;
  expenseActivityError: string;
  incomeActivityError: string;
}

const currencyFormatter = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 2,
});

const percentFormatter = new Intl.NumberFormat("es-CO", {
  maximumFractionDigits: 1,
});

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const monthFormatter = new Intl.DateTimeFormat("es-CO", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

function money(value: number): string {
  return currencyFormatter.format(value);
}

function signedMoney(value: number): string {
  if (value === 0) return money(0);
  return `${value > 0 ? "+" : "−"}${money(Math.abs(value))}`;
}

function percent(value: number): string {
  return `${percentFormatter.format(value)}%`;
}

function displayDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
}

function displayMonth(value: string): string {
  return monthFormatter.format(new Date(`${value.slice(0, 7)}-01T00:00:00Z`));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isDashboardResult(value: unknown): value is DashboardResult {
  if (!isRecord(value)) return false;
  if (
    !["totalIncome", "totalSpent", "netAmount", "expenseCount"].every((key) =>
      isFiniteNumber(value[key]),
    ) ||
    !Array.isArray(value.memberIncome) ||
    !Array.isArray(value.byCategory)
  ) {
    return false;
  }
  return (
    value.memberIncome.every(
      (member) =>
        isRecord(member) &&
        typeof member.memberId === "string" &&
        isFiniteNumber(member.amount),
    ) &&
    value.byCategory.every(
      (category) =>
        isRecord(category) &&
        (typeof category.categoryId === "string" ||
          category.categoryId === null) &&
        (typeof category.categoryName === "string" ||
          category.categoryName === null) &&
        isFiniteNumber(category.amount),
    )
  );
}

function isRecentExpense(value: unknown): value is RecentExpense {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (typeof value.merchant === "string" || value.merchant === null) &&
    (typeof value.description === "string" ||
      value.description === null ||
      value.description === undefined) &&
    isFiniteNumber(value.totalAmount) &&
    typeof value.expenseDate === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value.expenseDate) &&
    (value.category === null ||
      (isRecord(value.category) && typeof value.category.name === "string")) &&
    (value.paidBy === undefined ||
      value.paidBy === null ||
      (isRecord(value.paidBy) &&
        typeof value.paidBy.memberId === "string" &&
        typeof value.paidBy.name === "string")) &&
    (value.distributions === undefined ||
      (Array.isArray(value.distributions) &&
        value.distributions.every(
          (distribution) =>
            isRecord(distribution) &&
            typeof distribution.memberId === "string" &&
            typeof distribution.memberName === "string" &&
            isFiniteNumber(distribution.percentage) &&
            isFiniteNumber(distribution.amount),
        )))
  );
}

function isRecentIncome(value: unknown): value is RecentIncome {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.memberId === "string" &&
    isFiniteNumber(value.amount) &&
    typeof value.incomeDate === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value.incomeDate) &&
    typeof value.description === "string"
  );
}

function isRecentExpenses(value: unknown): value is RecentExpense[] {
  return Array.isArray(value) && value.every(isRecentExpense);
}

function isRecentIncomes(value: unknown): value is RecentIncome[] {
  return Array.isArray(value) && value.every(isRecentIncome);
}

function isCollectionPayload<T>(
  value: unknown,
  isRow: (item: unknown) => item is T,
): value is CollectionPage<T> {
  if (
    !isRecord(value) ||
    !Array.isArray(value.data) ||
    !isRecord(value.pagination)
  ) {
    return false;
  }
  const pagination = value.pagination;
  return (
    value.data.every(isRow) &&
    Number.isInteger(pagination.page) &&
    Number.isInteger(pagination.pageSize) &&
    Number.isInteger(pagination.total) &&
    Number.isInteger(pagination.totalPages) &&
    (pagination.page as number) >= 1 &&
    (pagination.pageSize as number) >= 1 &&
    (pagination.total as number) >= 0 &&
    (pagination.totalPages as number) >= 0
  );
}

async function fetchData<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Respuesta inválida.");
  }

  if (!response.ok || !isRecord(payload) || !("data" in payload)) {
    throw new Error("No fue posible cargar estos datos.");
  }
  return payload.data as T;
}

async function fetchCollectionPage<T>(
  path: string,
  range: DashboardDateRange,
  page: number,
  sort: Record<string, string>,
  isRow: (item: unknown) => item is T,
  signal: AbortSignal,
): Promise<CollectionPage<T>> {
  const query = new URLSearchParams({
    ...sort,
    from: range.from,
    to: range.to,
    page: String(page),
    pageSize: "100",
  });
  const response = await fetch(`${path}?${query.toString()}`, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Respuesta de lista inválida.");
  }
  if (
    !response.ok ||
    !isRecord(payload) ||
    !isCollectionPayload(payload, isRow)
  ) {
    throw new Error("No fue posible cargar la lista completa del período.");
  }
  return payload;
}

async function fetchCompleteCollection<T>(
  path: string,
  range: DashboardDateRange,
  sort: Record<string, string>,
  isRow: (item: unknown) => item is T,
  getId: (item: T) => string,
  signal: AbortSignal,
): Promise<T[]> {
  const first = await fetchCollectionPage(path, range, 1, sort, isRow, signal);
  const { total, totalPages, pageSize } = first.pagination;
  const expectedPages = total === 0 ? 0 : Math.ceil(total / pageSize);
  if (
    first.pagination.page !== 1 ||
    totalPages !== expectedPages ||
    first.data.length !== Math.min(pageSize, total)
  ) {
    throw new Error("La paginación del período está incompleta.");
  }

  const allRows = [...first.data];
  const ids = new Set(first.data.map(getId));
  for (let page = 2; page <= totalPages; page += 1) {
    const next = await fetchCollectionPage(
      path,
      range,
      page,
      sort,
      isRow,
      signal,
    );
    if (
      next.pagination.page !== page ||
      next.pagination.pageSize !== pageSize ||
      next.pagination.total !== total ||
      next.pagination.totalPages !== totalPages ||
      next.data.length !== Math.min(pageSize, total - allRows.length)
    ) {
      throw new Error("La lista cambió durante la carga; vuelve a intentarlo.");
    }
    for (const row of next.data) {
      const id = getId(row);
      if (ids.has(id)) {
        throw new Error("La paginación devolvió registros repetidos.");
      }
      ids.add(id);
    }
    allRows.push(...next.data);
  }

  if (allRows.length !== total) {
    throw new Error("La lista completa del período no está disponible.");
  }
  return allRows;
}

function makeUrl(path: string, range: DashboardDateRange): string {
  const query = new URLSearchParams({ from: range.from, to: range.to });
  return `${path}?${query.toString()}`;
}

function periodRangeLabel(range: DashboardDateRange): string {
  return `${displayDate(range.from)} – ${displayDate(range.to)}`;
}

function presetLabel(preset: DashboardRangePreset): string {
  if (preset === "last-12-months") return "Últimos 12 meses";
  if (preset === "this-month") return "Este mes";
  if (preset === "previous-month") return "Mes anterior";
  if (preset === "last-30-days") return "Últimos 30 días";
  if (preset === "last-90-days") return "Últimos 90 días";
  if (preset === "this-year") return "Este año";
  return "Rango personalizado";
}

function granularityLabel(granularity: DashboardTrendGranularity): string {
  if (granularity === "day") return "día";
  if (granularity === "week") return "semana";
  if (granularity === "month") return "mes";
  if (granularity === "quarter") return "trimestre";
  return "año";
}

function compactMoney(value: number): string {
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function deltaLabel(
  delta: ReturnType<typeof compareDashboardAmounts>,
  comparisonLabel: string,
): string {
  if (delta.direction === "unchanged") {
    return `Sin variación frente a ${comparisonLabel}.`;
  }
  const direction = delta.direction === "increase" ? "Subió" : "Bajó";
  const percentageLabel =
    delta.percentage === null
      ? " · sin base previa para calcular porcentaje"
      : ` · ${percent(delta.percentage)}`;
  return `${direction} ${money(Math.abs(delta.amount))}${percentageLabel} frente a ${comparisonLabel}. Cambio descriptivo.`;
}

function DashboardTrendChart({ series }: { series: DashboardTrendSeries }) {
  const width = 760;
  const height = 246;
  const left = 78;
  const right = 18;
  const top = 18;
  const bottom = 48;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const useBars =
    series.points.length <= 36 &&
    ((series.granularity === "day" && series.points.length <= 31) ||
      series.granularity === "week" ||
      series.granularity === "month" ||
      series.granularity === "quarter" ||
      series.granularity === "year");
  const barWidth = Math.min(
    18,
    (plotWidth / Math.max(1, series.points.length)) * 0.3,
  );
  const maximum = Math.max(
    0,
    ...series.points.flatMap((point) => [
      point.incomeAmount,
      point.expenseAmount,
    ]),
  );
  const axisMaximum = maximum > 0 ? maximum * 1.12 : 1;
  const xFor = (index: number) =>
    left +
    (series.points.length <= 1
      ? plotWidth / 2
      : (index / (series.points.length - 1)) * plotWidth);
  const yFor = (amount: number) =>
    top + plotHeight * (1 - amount / axisMaximum);
  const incomePoints = series.points
    .map((point, index) => `${xFor(index)},${yFor(point.incomeAmount)}`)
    .join(" ");
  const expensePoints = series.points
    .map((point, index) => `${xFor(index)},${yFor(point.expenseAmount)}`)
    .join(" ");
  const labelIndexes = new Set<number>();
  if (series.points.length > 0) {
    for (let index = 0; index < Math.min(5, series.points.length); index += 1) {
      labelIndexes.add(
        Math.round(
          (index * (series.points.length - 1)) /
            Math.min(4, series.points.length - 1 || 1),
        ),
      );
    }
  }

  return (
    <figure className="dashboard-trend-figure">
      <div className="dashboard-chart-legend" aria-label="Leyenda de tendencia">
        <span>
          <i className="dashboard-legend-income" /> Ingresos registrados
        </span>
        <span>
          <i className="dashboard-legend-expense" /> Gastos confirmados
        </span>
      </div>
      <div
        className="dashboard-trend-scroll"
        tabIndex={0}
        aria-label="Gráfica temporal desplazable horizontalmente para consultar los períodos del rango"
      >
        <svg
          className="dashboard-trend-svg"
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-labelledby="dashboard-trend-title dashboard-trend-description"
        >
          <title id="dashboard-trend-title">
            Ingresos frente a gastos en el tiempo
          </title>
          <desc id="dashboard-trend-description">
            {series.points.length} períodos agrupados por{" "}
            {granularityLabel(series.granularity)}. Cada punto suma registros
            fechados dentro del rango seleccionado.
          </desc>
          {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
            const y = top + plotHeight * (1 - fraction);
            return (
              <g key={fraction} aria-hidden="true">
                <line
                  x1={left}
                  x2={width - right}
                  y1={y}
                  y2={y}
                  className="dashboard-trend-gridline"
                />
                <text
                  x={left - 10}
                  y={y + 4}
                  textAnchor="end"
                  className="dashboard-trend-axis-label"
                >
                  {compactMoney(axisMaximum * fraction)}
                </text>
              </g>
            );
          })}
          {!useBars && (
            <>
              <polyline
                points={incomePoints}
                className="dashboard-trend-line is-income"
              />
              <polyline
                points={expensePoints}
                className="dashboard-trend-line is-expense"
              />
            </>
          )}
          {series.points.map((point, index) => {
            const dateLabel =
              point.start === point.end
                ? displayDate(point.start)
                : `${displayDate(point.start)} – ${displayDate(point.end)}`;
            return (
              <g key={point.start}>
                {useBars ? (
                  <>
                    {point.incomeAmount > 0 ? (
                      <rect
                        x={xFor(index) - barWidth - 1}
                        y={yFor(point.incomeAmount)}
                        width={barWidth}
                        height={top + plotHeight - yFor(point.incomeAmount)}
                        className="dashboard-trend-bar is-income"
                        tabIndex={0}
                      >
                        <title>{`Ingresos · ${dateLabel} · ${money(point.incomeAmount)} · ${point.incomeCount} registros`}</title>
                      </rect>
                    ) : null}
                    {point.expenseAmount > 0 ? (
                      <rect
                        x={xFor(index) + 1}
                        y={yFor(point.expenseAmount)}
                        width={barWidth}
                        height={top + plotHeight - yFor(point.expenseAmount)}
                        className="dashboard-trend-bar is-expense"
                        tabIndex={0}
                      >
                        <title>{`Gastos · ${dateLabel} · ${money(point.expenseAmount)} · ${point.expenseCount} registros`}</title>
                      </rect>
                    ) : null}
                  </>
                ) : (
                  <>
                    <circle
                      cx={xFor(index)}
                      cy={yFor(point.incomeAmount)}
                      r="4.5"
                      className="dashboard-trend-point is-income"
                      tabIndex={0}
                    >
                      <title>{`Ingresos · ${dateLabel} · ${money(point.incomeAmount)} · ${point.incomeCount} registros`}</title>
                    </circle>
                    <circle
                      cx={xFor(index)}
                      cy={yFor(point.expenseAmount)}
                      r="4.5"
                      className="dashboard-trend-point is-expense"
                      tabIndex={0}
                    >
                      <title>{`Gastos · ${dateLabel} · ${money(point.expenseAmount)} · ${point.expenseCount} registros`}</title>
                    </circle>
                  </>
                )}
                {labelIndexes.has(index) && (
                  <text
                    x={xFor(index)}
                    y={height - 18}
                    textAnchor="middle"
                    className="dashboard-trend-axis-label"
                    aria-hidden="true"
                  >
                    {series.granularity === "month"
                      ? displayMonth(point.start)
                      : formatDashboardTrendBucketLabel(
                          point.start,
                          series.granularity,
                        )}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <details className="dashboard-trend-data">
        <summary>Consultar valores y registros por período</summary>
        <div className="dashboard-trend-table-scroll">
          <table>
            <caption>
              Valores agrupados por {granularityLabel(series.granularity)} en el
              rango seleccionado.
            </caption>
            <thead>
              <tr>
                <th scope="col">Período</th>
                <th scope="col">Ingresos</th>
                <th scope="col">Gastos</th>
                <th scope="col">Registros</th>
              </tr>
            </thead>
            <tbody>
              {series.points.map((point) => (
                <tr key={`table-${point.start}`}>
                  <th scope="row">
                    {formatDashboardTrendBucketLabel(
                      point.start,
                      series.granularity,
                    )}
                    <span>
                      {point.start === point.end
                        ? ` · ${displayDate(point.start)}`
                        : ` · ${displayDate(point.start)} – ${displayDate(point.end)}`}
                    </span>
                  </th>
                  <td>{money(point.incomeAmount)}</td>
                  <td>{money(point.expenseAmount)}</td>
                  <td>{point.incomeCount + point.expenseCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <figcaption className="dashboard-trend-caption">
        {series.durationDays} días · agrupación por{" "}
        {granularityLabel(series.granularity)} ·{" "}
        {useBars ? "barras comparativas" : "líneas de tendencia"} · Ingresos{" "}
        {money(series.totalIncome)} · Gastos {money(series.totalExpenses)}. Los
        valores se suman desde registros reales del período; no se interpolan
        movimientos. La paginación valida metadatos e IDs, pero las API no
        ofrecen una instantánea entre páginas; cambios concurrentes pueden
        alterar la lectura.
      </figcaption>
    </figure>
  );
}

function DashboardExpenseBridgeChart({
  bridge,
}: {
  bridge: DashboardExpenseBridge;
}) {
  const width = 760;
  const height = 225;
  const left = 42;
  const right = 16;
  const top = 26;
  const bottom = 47;
  const plotHeight = height - top - bottom;
  const plotWidth = width - left - right;
  const maximum =
    Math.max(
      1,
      bridge.previousAmount,
      bridge.currentAmount,
      ...bridge.steps.map((step) => Math.max(step.fromAmount, step.toAmount)),
    ) * 1.12;
  const yFor = (amount: number) => top + plotHeight * (1 - amount / maximum);
  const entries = [
    {
      kind: "total" as const,
      label: "Anterior",
      amount: bridge.previousAmount,
    },
    ...bridge.steps.map((step) => ({
      kind: "step" as const,
      label: step.categoryName,
      step,
    })),
    { kind: "total" as const, label: "Actual", amount: bridge.currentAmount },
  ];
  const gap = plotWidth / entries.length;
  const barWidth = Math.min(52, gap * 0.52);

  return (
    <figure className="dashboard-waterfall-figure">
      <div
        className="dashboard-waterfall-scroll"
        tabIndex={0}
        aria-label="Cascada desplazable del cambio de gasto entre períodos"
      >
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-labelledby="dashboard-waterfall-title dashboard-waterfall-description"
        >
          <title id="dashboard-waterfall-title">
            Puente del gasto entre períodos
          </title>
          <desc id="dashboard-waterfall-description">
            Gasto anterior {money(bridge.previousAmount)}; variaciones de
            categorías; gasto actual {money(bridge.currentAmount)}. Los
            escalones son cambios descriptivos, no causas demostradas.
          </desc>
          {[0, 0.5, 1].map((fraction) => {
            const y = yFor((maximum / 1.12) * fraction);
            return (
              <g key={fraction} aria-hidden="true">
                <line
                  x1={left}
                  x2={width - right}
                  y1={y}
                  y2={y}
                  className="dashboard-trend-gridline"
                />
                <text
                  x={left - 8}
                  y={y + 4}
                  textAnchor="end"
                  className="dashboard-trend-axis-label"
                >
                  {compactMoney((maximum / 1.12) * fraction)}
                </text>
              </g>
            );
          })}
          {entries.map((entry, index) => {
            const x = left + gap * (index + 0.5);
            const isStep = entry.kind === "step";
            const from = isStep ? entry.step.fromAmount : 0;
            const to = isStep ? entry.step.toAmount : entry.amount;
            const higher = Math.max(from, to);
            const lower = Math.min(from, to);
            const label =
              entry.label.length > 13
                ? `${entry.label.slice(0, 12)}…`
                : entry.label;
            return (
              <g key={`${entry.kind}-${index}`}>
                {index > 0 && (
                  <line
                    x1={x - gap + barWidth / 2}
                    x2={x - barWidth / 2}
                    y1={yFor(isStep ? from : bridge.currentAmount)}
                    y2={yFor(isStep ? from : bridge.currentAmount)}
                    className="dashboard-waterfall-connector"
                    aria-hidden="true"
                  />
                )}
                <rect
                  x={x - barWidth / 2}
                  y={yFor(higher)}
                  width={barWidth}
                  height={Math.max(2, yFor(lower) - yFor(higher))}
                  className={
                    isStep
                      ? entry.step.changeAmount > 0
                        ? "dashboard-waterfall-bar is-spend-up"
                        : "dashboard-waterfall-bar is-spend-down"
                      : "dashboard-waterfall-bar is-total"
                  }
                  tabIndex={0}
                >
                  <title>
                    {isStep
                      ? `${entry.label}: ${signedMoney(entry.step.changeAmount)}; acumulado ${money(entry.step.toAmount)}`
                      : `${entry.label}: ${money(entry.amount)}`}
                  </title>
                </rect>
                <text
                  x={x}
                  y={height - 15}
                  textAnchor="middle"
                  className="dashboard-waterfall-label"
                >
                  {label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <figcaption className="dashboard-waterfall-caption">
        {money(bridge.previousAmount)} anterior + cambios por categoría ={" "}
        {money(bridge.currentAmount)} actual.
      </figcaption>
    </figure>
  );
}

function FinancialDashboard({
  householdName,
  refreshVersion,
  members,
  expenseCategories,
  balance,
  balanceError,
  onOpenExpenses,
  onOpenIncomes,
  onOpenBalance,
}: FinancialDashboardProps) {
  const [initialRange] = useState<DashboardDateRange>(() =>
    buildDashboardRangePreset("last-12-months"),
  );
  const [viewMode, setViewMode] = useState<"visual" | "analytic">("visual");
  const [trendGranularity, setTrendGranularity] =
    useState<DashboardTrendGranularity>("month");
  const [rangePreset, setRangePreset] =
    useState<DashboardRangePreset>("last-12-months");
  const [appliedPreset, setAppliedPreset] =
    useState<DashboardRangePreset>("last-12-months");
  const [monthDrilldown, setMonthDrilldown] = useState(false);
  const [draftFrom, setDraftFrom] = useState(initialRange.from);
  const [draftTo, setDraftTo] = useState(initialRange.to);
  const [activeRange, setActiveRange] =
    useState<DashboardDateRange>(initialRange);
  const draftValidation = validateDashboardDateRange(draftFrom, draftTo);
  const [rangeError, setRangeError] = useState("");
  const [dashboardRequest, setDashboardRequest] =
    useState<DashboardRequestState | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);

  const draftDiffersFromApplied = Boolean(
    activeRange &&
    (draftFrom !== activeRange.from || draftTo !== activeRange.to),
  );

  const ranges = useMemo(
    () =>
      activeRange
        ? monthDrilldown ||
          appliedPreset === "this-month" ||
          appliedPreset === "previous-month"
          ? buildDashboardMonthComparisonRanges(activeRange)
          : appliedPreset === "last-12-months"
            ? buildDashboardPriorYearComparisonRanges(activeRange)
            : buildDashboardComparisonRanges(activeRange)
        : null,
    [activeRange, appliedPreset, monthDrilldown],
  );
  const currentRange = ranges?.current ?? activeRange ?? { from: "", to: "" };
  const previousRange = ranges?.previous ?? currentRange;
  const comparisonLabel =
    ranges?.comparisonLabel ?? "el período anterior de duración equivalente";
  const periodLabel = presetLabel(appliedPreset);
  const requestKey = ranges
    ? [
        ranges.current.from,
        ranges.current.to,
        ranges.previous.from,
        ranges.previous.to,
        refreshVersion,
        retryVersion,
      ].join("|")
    : null;
  const currentDashboardRequest =
    dashboardRequest?.key === requestKey ? dashboardRequest : null;
  const summary = currentDashboardRequest?.summary ?? null;
  const previousSummary = currentDashboardRequest?.previousSummary ?? null;
  const summaryError = currentDashboardRequest?.summaryError ?? "";
  const comparisonError = currentDashboardRequest?.comparisonError ?? "";
  const expenses = currentDashboardRequest?.expenses ?? null;
  const incomes = currentDashboardRequest?.incomes ?? null;
  const expenseActivityError =
    currentDashboardRequest?.expenseActivityError ?? "";
  const incomeActivityError =
    currentDashboardRequest?.incomeActivityError ?? "";
  const summaryLoading =
    requestKey !== null && currentDashboardRequest === null;
  const activityLoading = summaryLoading;

  function handlePresetChange(nextPreset: DashboardRangePreset): void {
    setMonthDrilldown(false);
    setRangePreset(nextPreset);
    setRangeError("");
    if (nextPreset === "custom") return;
    const nextRange = buildDashboardRangePreset(nextPreset);
    setDraftFrom(nextRange.from);
    setDraftTo(nextRange.to);
    setActiveRange(nextRange);
    setAppliedPreset(nextPreset);
  }

  function handleApplyRange(): void {
    if (!draftValidation.valid) {
      setRangeError(draftValidation.message);
      return;
    }
    setRangeError("");
    setMonthDrilldown(false);
    setActiveRange(draftValidation.range);
    setAppliedPreset("custom");
  }

  function handleMonthDrilldown(monthStart: string): void {
    const point =
      trendSeries?.granularity === "month"
        ? trendSeries.points.find((candidate) => candidate.start === monthStart)
        : null;
    if (!point) return;
    const monthRange = { from: `${point.start.slice(0, 7)}-01`, to: point.end };
    setDraftFrom(monthRange.from);
    setDraftTo(monthRange.to);
    setActiveRange(monthRange);
    setRangePreset("custom");
    setAppliedPreset("custom");
    setMonthDrilldown(true);
    setTrendGranularity("day");
  }

  useEffect(() => {
    if (!ranges || requestKey === null) return;
    const controller = new AbortController();
    let active = true;

    const requests = [
      fetchData<unknown>(
        makeUrl("/api/dashboard/summary", ranges.current),
        controller.signal,
      ),
      fetchData<unknown>(
        makeUrl("/api/dashboard/summary", ranges.previous),
        controller.signal,
      ),
      fetchCompleteCollection(
        "/api/expenses",
        ranges.current,
        { sort: "date", sortDirection: "desc" },
        isRecentExpense,
        (expense: RecentExpense) => expense.id,
        controller.signal,
      ),
      fetchCompleteCollection(
        "/api/incomes",
        ranges.current,
        { sortBy: "incomeDate", sortOrder: "desc" },
        isRecentIncome,
        (income: RecentIncome) => income.id,
        controller.signal,
      ),
    ] as const;

    void Promise.allSettled(requests).then((results) => {
      if (!active) return;
      const [currentResult, previousResult, expensesResult, incomesResult] =
        results;
      const currentSummary =
        currentResult.status === "fulfilled" &&
        isDashboardResult(currentResult.value)
          ? currentResult.value
          : null;
      const priorSummary =
        previousResult.status === "fulfilled" &&
        isDashboardResult(previousResult.value)
          ? previousResult.value
          : null;
      const currentExpenses =
        expensesResult.status === "fulfilled" &&
        isRecentExpenses(expensesResult.value)
          ? expensesResult.value
          : null;
      const currentIncomes =
        incomesResult.status === "fulfilled" &&
        isRecentIncomes(incomesResult.value)
          ? incomesResult.value
          : null;

      setDashboardRequest({
        key: requestKey,
        summary: currentSummary,
        previousSummary: priorSummary,
        summaryError: currentSummary
          ? ""
          : "No fue posible cargar el resumen de este período.",
        comparisonError: priorSummary
          ? ""
          : "No fue posible cargar el período de comparación.",
        expenses: currentExpenses,
        incomes: currentIncomes,
        expenseActivityError: currentExpenses
          ? ""
          : "No fue posible cargar los gastos del período.",
        incomeActivityError: currentIncomes
          ? ""
          : "No fue posible cargar los ingresos del período.",
      });
    });

    return () => {
      active = false;
      controller.abort();
    };
  }, [ranges, requestKey]);

  const memberNames = useMemo(
    () => new Map(members.map((member) => [member.id, member.displayName])),
    [members],
  );
  const categoryPaths = useMemo(
    () =>
      new Map(
        expenseCategories.map((category) => [category.id, category.path]),
      ),
    [expenseCategories],
  );
  const categorySlices = useMemo(
    () => (summary ? getDashboardCategorySlices(summary) : []),
    [summary],
  );
  const donutSlices = useMemo(
    () => (summary ? getDashboardDonutSlices(summary) : []),
    [summary],
  );
  const executiveInsights = useMemo(
    () =>
      summary ? getDashboardExecutiveInsights(summary, previousSummary) : [],
    [summary, previousSummary],
  );
  const expenseDelta = useMemo(
    () =>
      summary && previousSummary
        ? compareDashboardAmounts(
            summary.totalSpent,
            previousSummary.totalSpent,
          )
        : null,
    [summary, previousSummary],
  );
  const allCategorySlices = useMemo(
    () =>
      summary
        ? getDashboardCategorySlices(
            summary,
            Math.max(1, summary.byCategory.length),
          )
        : [],
    [summary],
  );
  const categoryDistributionMaximum = Math.max(
    0,
    ...categorySlices.map((category) => category.amount),
  );
  const topThreeShare = useMemo(
    () => (summary ? getTopThreeCategorySharePercent(summary) : null),
    [summary],
  );
  const largestCategoryChange = useMemo(
    () =>
      summary && previousSummary
        ? getLargestDashboardCategoryChange(summary, previousSummary)
        : null,
    [summary, previousSummary],
  );
  const categoryComparisonSlices = useMemo(
    () =>
      summary && previousSummary
        ? getDashboardCategoryComparisonSlices(summary, previousSummary)
        : [],
    [summary, previousSummary],
  );
  const expenseBridge = useMemo(
    () =>
      summary && previousSummary
        ? getDashboardExpenseBridge(summary, previousSummary)
        : null,
    [summary, previousSummary],
  );
  const allCategoryComparisonSlices = useMemo(
    () =>
      summary && previousSummary
        ? getDashboardCategoryComparisonSlices(
            summary,
            previousSummary,
            Math.max(
              1,
              summary.byCategory.length + previousSummary.byCategory.length,
            ),
          )
        : [],
    [summary, previousSummary],
  );
  const categoryChangeMaximum = Math.max(
    0,
    ...categoryComparisonSlices.map((category) =>
      Math.abs(category.changeAmount),
    ),
  );
  const trendGranularityOptions = useMemo(
    () => (activeRange ? getDashboardTrendGranularityOptions(activeRange) : []),
    [activeRange],
  );
  const selectedGranularityOption = trendGranularityOptions.find(
    (option) => option.granularity === trendGranularity,
  );
  const selectedGranularityBucketCount =
    selectedGranularityOption?.bucketCount ?? 0;
  const selectedGranularityAvailable =
    selectedGranularityOption?.available === true;
  const unavailableGranularityLabels = trendGranularityOptions
    .filter((option) => !option.available)
    .map((option) => option.label);
  const selectedGranularityHelp = !activeRange
    ? "Selecciona un rango válido para calcular la serie."
    : !selectedGranularityOption?.available
      ? `Esta agrupación superaría ${MAX_DASHBOARD_TREND_BUCKETS} períodos; elige otra agrupación o acota el rango. La selección no cambiará automáticamente.`
      : selectedGranularityBucketCount === 1 &&
          (trendGranularity === "quarter" || trendGranularity === "year")
        ? "El rango cae dentro de un solo período calendario; la lectura será resumida, no se cambiará automáticamente."
        : `${selectedGranularityBucketCount} períodos; los intervalos sin registros se muestran en cero.${unavailableGranularityLabels.length > 0 ? ` Opciones no disponibles por superar el límite: ${unavailableGranularityLabels.join(", ")}.` : ""}`;

  const activity = useMemo<DashboardActivityItem[]>(() => {
    return buildDashboardActivity(
      (expenses ?? []).map((expense) => ({
        id: expense.id,
        merchant: expense.merchant,
        description: expense.description,
        totalAmount: expense.totalAmount,
        expenseDate: expense.expenseDate,
        categoryName: expense.category
          ? expense.category.parentName
            ? `${expense.category.parentName} · ${expense.category.name}`
            : expense.category.name
          : null,
      })),
      (incomes ?? []).map((income) => ({
        id: income.id,
        incomeDate: income.incomeDate,
        amount: income.amount,
        description: income.description,
        memberName: memberNames.get(income.memberId) ?? "Integrante del hogar",
      })),
      6,
    );
  }, [expenses, incomes, memberNames]);

  const sortedMemberIncome = useMemo(
    () =>
      [...(summary?.memberIncome ?? [])].sort(
        (left, right) => right.amount - left.amount,
      ),
    [summary],
  );
  const trendSeries =
    activeRange &&
    selectedGranularityAvailable &&
    expenses !== null &&
    incomes !== null
      ? buildDashboardTrendSeries(
          expenses.map((expense) => ({
            date: expense.expenseDate,
            amount: expense.totalAmount,
          })),
          incomes.map((income) => ({
            date: income.incomeDate,
            amount: income.amount,
          })),
          activeRange,
          trendGranularity,
        )
      : null;
  const monthsWithExpenses =
    trendSeries?.granularity === "month"
      ? trendSeries.points.filter((point) => point.expenseCount > 0)
      : [];
  const highestSpendMonth = monthsWithExpenses.reduce<
    DashboardTrendSeries["points"][number] | null
  >(
    (highest, point) =>
      !highest || point.expenseAmount > highest.expenseAmount ? point : highest,
    null,
  );
  const trendExtremes = trendSeries
    ? getDashboardTrendExtremes(trendSeries)
    : null;
  const memberExpenseDistribution = useMemo(
    () =>
      activeRange && expenses !== null
        ? buildDashboardMemberExpenseDistribution(
            expenses.map((expense) => ({
              id: expense.id,
              expenseDate: expense.expenseDate,
              totalAmount: expense.totalAmount,
              paidBy: expense.paidBy ?? null,
              distributions: expense.distributions ?? [],
            })),
            activeRange,
          )
        : null,
    [activeRange, expenses],
  );
  const memberExpenseScale = Math.max(
    0,
    ...(memberExpenseDistribution?.members.flatMap((member) => [
      member.paidAmount,
      member.assignedAmount,
    ]) ?? []),
  );
  const weekdayDistribution = useMemo(
    () =>
      activeRange && expenses !== null
        ? buildDashboardWeekdayDistribution(
            expenses.map((expense) => ({
              id: expense.id,
              expenseDate: expense.expenseDate,
              totalAmount: expense.totalAmount,
            })),
            activeRange,
          )
        : null,
    [activeRange, expenses],
  );
  const weekdayAmountMaximum = Math.max(
    0,
    ...(weekdayDistribution?.days.map((day) => day.totalAmount) ?? []),
  );
  const financialComposition = useMemo(
    () =>
      summary
        ? buildDashboardFinancialComposition(
            summary.totalIncome,
            summary.totalSpent,
          )
        : null,
    [summary],
  );
  const compositionMaximum = Math.max(
    0,
    financialComposition?.totalIncome ?? 0,
    financialComposition?.totalExpenses ?? 0,
  );

  const comparisonValues =
    summary && previousSummary
      ? [
          summary.totalIncome,
          previousSummary.totalIncome,
          summary.totalSpent,
          previousSummary.totalSpent,
        ]
      : [];
  const comparisonScale = Math.max(0, ...comparisonValues);
  const currentRangeLabel = activeRange
    ? periodRangeLabel(activeRange)
    : "Preparando rango…";
  const rangeDraftMessage =
    rangeError ||
    (draftDiffersFromApplied
      ? draftValidation.valid
        ? "Hay cambios sin aplicar; el dashboard conserva el rango indicado arriba."
        : draftValidation.message
      : "");
  return (
    <section className="financial-dashboard" aria-labelledby="dashboard-title">
      <header className="financial-dashboard-header">
        <div>
          <p className="section-kicker">PANORAMA DEL HOGAR</p>
          <h2 id="dashboard-title">
            {householdName
              ? `Finanzas de ${householdName}`
              : "Finanzas del hogar"}
          </h2>
        </div>
        <div className="dashboard-range-controls">
          <label className="dashboard-period-control">
            <span>Atajo de período</span>
            <select
              value={rangePreset}
              onChange={(event) =>
                handlePresetChange(event.target.value as DashboardRangePreset)
              }
            >
              <option value="last-12-months">Últimos 12 meses</option>
              <option value="this-month">Este mes</option>
              <option value="previous-month">Mes anterior</option>
              <option value="last-30-days">Últimos 30 días</option>
              <option value="last-90-days">Últimos 90 días</option>
              <option value="this-year">Este año</option>
              <option value="custom">Rango personalizado</option>
            </select>
          </label>
          <label className="dashboard-date-control">
            <span>Desde</span>
            <input
              type="date"
              value={draftFrom}
              onChange={(event) => {
                setRangePreset("custom");
                setRangeError("");
                setDraftFrom(event.target.value);
              }}
              aria-describedby="dashboard-range-status"
            />
          </label>
          <label className="dashboard-date-control">
            <span>Hasta</span>
            <input
              type="date"
              value={draftTo}
              onChange={(event) => {
                setRangePreset("custom");
                setRangeError("");
                setDraftTo(event.target.value);
              }}
              aria-describedby="dashboard-range-status"
            />
          </label>
          <button
            className="dashboard-apply-range"
            type="button"
            onClick={handleApplyRange}
            disabled={!draftValidation.valid || !draftDiffersFromApplied}
          >
            Aplicar
          </button>
        </div>
      </header>

      <div className="dashboard-range-status-row">
        <p
          id="dashboard-range-status"
          className="dashboard-range-status"
          role="status"
          aria-live="polite"
        >
          <strong>{currentRangeLabel}</strong>
          {activeRange && (
            <span className="dashboard-comparison-period">
              {" "}
              · vs. {periodRangeLabel(previousRange)}
            </span>
          )}
          <span className="dashboard-range-inclusivity">
            {" "}
            · fechas incluidas
          </span>
          {rangeDraftMessage && <span> · {rangeDraftMessage}</span>}
        </p>
        <div
          className="dashboard-view-switch"
          role="group"
          aria-label="Vista del dashboard"
        >
          <button
            type="button"
            aria-pressed={viewMode === "visual"}
            onClick={() => setViewMode("visual")}
          >
            Visual
          </button>
          <button
            type="button"
            aria-pressed={viewMode === "analytic"}
            onClick={() => setViewMode("analytic")}
          >
            Analítica
          </button>
        </div>
      </div>

      {summaryLoading && (
        <div className="dashboard-loading" role="status" aria-live="polite">
          <span className="dashboard-loading-mark" aria-hidden="true" />
          Actualizando el resumen y los movimientos del período…
        </div>
      )}

      {summaryError && (
        <section className="dashboard-error-panel" role="alert">
          <div>
            <strong>No se pudo calcular el panorama</strong>
            <p>{summaryError}</p>
          </div>
          <button
            type="button"
            onClick={() => setRetryVersion((value) => value + 1)}
          >
            Reintentar
          </button>
        </section>
      )}

      {summary && (
        <>
          {comparisonError && (
            <p className="dashboard-inline-error" role="status">
              {comparisonError} El resumen actual se muestra sin comparación.
            </p>
          )}

          {viewMode === "visual" && (
            <section
              className="dashboard-visual-view"
              aria-label="Vista visual de finanzas"
            >
              <section
                className="dashboard-executive-metrics"
                aria-label="Indicadores principales del período"
              >
                <article className="dashboard-executive-net">
                  <span>Neto del período</span>
                  <strong>{signedMoney(summary.netAmount)}</strong>
                  <small>
                    Ingresos − gastos; no es el balance entre miembros.
                  </small>
                </article>
                <article>
                  <span>Ingresos</span>
                  <strong>{money(summary.totalIncome)}</strong>
                </article>
                <article>
                  <span>Gastos confirmados</span>
                  <strong>{money(summary.totalSpent)}</strong>
                </article>
                <article>
                  <span>Variación del gasto</span>
                  <strong>
                    {expenseDelta ? (
                      <span aria-hidden="true">
                        {expenseDelta.direction === "increase"
                          ? "↑ "
                          : expenseDelta.direction === "decrease"
                            ? "↓ "
                            : "→ "}
                      </span>
                    ) : null}
                    {expenseDelta ? signedMoney(expenseDelta.amount) : "—"}
                  </strong>
                  <small>
                    {expenseDelta
                      ? `${expenseDelta.percentage === null ? "Sin %: base previa cero" : percent(expenseDelta.percentage)} · frente a ${comparisonLabel}`
                      : "Sin comparación válida"}
                  </small>
                </article>
              </section>
              <div className="dashboard-grid dashboard-grid-visual-main">
                <article className="dashboard-panel dashboard-trend-panel">
                  <div className="dashboard-panel-heading">
                    <div>
                      <p className="dashboard-panel-eyebrow">
                        TENDENCIA DEL RANGO
                      </p>
                      <h3>Ingresos frente a gastos</h3>
                    </div>
                    <span className="dashboard-panel-index" aria-hidden="true">
                      01
                    </span>
                  </div>
                  <div className="dashboard-trend-controls">
                    <label htmlFor="dashboard-trend-granularity">
                      Agrupar tendencia por
                    </label>
                    <select
                      id="dashboard-trend-granularity"
                      value={trendGranularity}
                      onChange={(event) =>
                        setTrendGranularity(
                          event.target.value as DashboardTrendGranularity,
                        )
                      }
                      disabled={!activeRange}
                      aria-describedby="dashboard-trend-granularity-help"
                    >
                      <option
                        value="day"
                        disabled={trendGranularityOptions.some(
                          (option) =>
                            option.granularity === "day" && !option.available,
                        )}
                      >
                        Diaria
                      </option>
                      <option
                        value="week"
                        disabled={trendGranularityOptions.some(
                          (option) =>
                            option.granularity === "week" && !option.available,
                        )}
                      >
                        Semanal · ISO 8601
                      </option>
                      <option
                        value="month"
                        disabled={trendGranularityOptions.some(
                          (option) =>
                            option.granularity === "month" && !option.available,
                        )}
                      >
                        Mensual
                      </option>
                      <option
                        value="quarter"
                        disabled={trendGranularityOptions.some(
                          (option) =>
                            option.granularity === "quarter" &&
                            !option.available,
                        )}
                      >
                        Trimestral · calendario
                      </option>
                      <option
                        value="year"
                        disabled={trendGranularityOptions.some(
                          (option) =>
                            option.granularity === "year" && !option.available,
                        )}
                      >
                        Anual
                      </option>
                    </select>
                    <p
                      id="dashboard-trend-granularity-help"
                      role="status"
                      aria-live="polite"
                    >
                      {selectedGranularityHelp}
                    </p>
                    {monthDrilldown && (
                      <button
                        className="dashboard-text-action dashboard-month-return"
                        type="button"
                        onClick={() => {
                          handlePresetChange("last-12-months");
                          setTrendGranularity("month");
                        }}
                      >
                        Volver al panorama de 12 meses{" "}
                        <span aria-hidden="true">→</span>
                      </button>
                    )}
                  </div>
                  {activityLoading ? (
                    <p className="dashboard-empty-note" role="status">
                      Cargando todas las páginas de movimientos del rango…
                    </p>
                  ) : expenseActivityError || incomeActivityError ? (
                    <div className="dashboard-inline-error" role="status">
                      No se muestra una tendencia parcial porque faltan
                      registros del rango.
                      {expenseActivityError && <p>{expenseActivityError}</p>}
                      {incomeActivityError && <p>{incomeActivityError}</p>}
                      <button
                        className="dashboard-text-action"
                        type="button"
                        onClick={() => setRetryVersion((value) => value + 1)}
                      >
                        Reintentar carga completa{" "}
                        <span aria-hidden="true">→</span>
                      </button>
                    </div>
                  ) : !selectedGranularityAvailable ? (
                    <div className="dashboard-empty-note" role="status">
                      La agrupación seleccionada no cabe en el límite de la
                      gráfica. Elige otra granularidad o acota el rango; el
                      período seleccionado se conserva.
                    </div>
                  ) : trendSeries &&
                    trendSeries.incomeCount + trendSeries.expenseCount === 0 ? (
                    <div className="dashboard-empty-note">
                      No hay movimientos registrados para{" "}
                      {periodRangeLabel(currentRange)}. La escala permanece
                      vacía; no se generan valores de muestra.
                    </div>
                  ) : trendSeries ? (
                    <>
                      <DashboardTrendChart series={trendSeries} />
                      {trendSeries.granularity === "month" &&
                        trendSeries.points.length > 1 && (
                          <div className="dashboard-month-focus">
                            <label htmlFor="dashboard-month-picker">
                              Examinar un mes y sus categorías
                            </label>
                            <select
                              id="dashboard-month-picker"
                              value=""
                              onChange={(event) =>
                                handleMonthDrilldown(event.target.value)
                              }
                            >
                              <option value="">Seleccionar mes…</option>
                              {trendSeries.points.map((point) => (
                                <option key={point.start} value={point.start}>
                                  {displayMonth(point.start)} · gastos{" "}
                                  {money(point.expenseAmount)} · ingresos{" "}
                                  {money(point.incomeAmount)}
                                </option>
                              ))}
                            </select>
                            <p>
                              Los importes mensuales son de movimientos
                              fechados. Al abrir un mes, categorías y KPIs se
                              recalculan con el resumen del backend.
                            </p>
                            <p className="dashboard-month-context">
                              {monthsWithExpenses.length < 2
                                ? `Hay gastos registrados en ${monthsWithExpenses.length} de ${trendSeries.points.length} meses; todavía no se puede establecer un patrón mensual.`
                                : `Mayor gasto observado: ${highestSpendMonth ? displayMonth(highestSpendMonth.start) : "—"} (${highestSpendMonth ? money(highestSpendMonth.expenseAmount) : "—"}). ${monthsWithExpenses.length} de ${trendSeries.points.length} meses tienen gastos; el mes actual puede estar incompleto.`}
                            </p>
                          </div>
                        )}
                      {(trendSeries.totalIncome !== summary.totalIncome ||
                        trendSeries.totalExpenses !== summary.totalSpent ||
                        trendSeries.expenseCount !== summary.expenseCount) && (
                        <p className="dashboard-data-note" role="status">
                          La lista de movimientos y el resumen se solicitaron
                          por separado y difieren en importes o cantidad de
                          gastos. El gráfico conserva solo los registros
                          cargados; actualiza para volver a consultar ambos.
                        </p>
                      )}
                      {(trendSeries.incomeCount === 0 ||
                        trendSeries.expenseCount === 0) && (
                        <p className="dashboard-data-note">
                          {trendSeries.incomeCount === 0
                            ? "No hubo ingresos en este rango; la línea de ingresos representa cero registros."
                            : "No hubo gastos confirmados en este rango; la línea de gastos representa cero registros."}
                        </p>
                      )}
                    </>
                  ) : (
                    <div className="dashboard-empty-note">
                      La serie aún no está disponible.
                    </div>
                  )}
                </article>

                <article className="dashboard-panel dashboard-visual-category-panel">
                  <div className="dashboard-panel-heading">
                    <div>
                      <p className="dashboard-panel-eyebrow">
                        COMPOSICIÓN DEL GASTO
                      </p>
                      <h3>Distribución de gastos por categoría</h3>
                    </div>
                    <span className="dashboard-panel-index" aria-hidden="true">
                      02
                    </span>
                  </div>
                  {summary.totalSpent <= 0 ||
                  categorySlices.some((category) => category.amount < 0) ? (
                    <div className="dashboard-empty-note">
                      {summary.totalSpent === 0
                        ? "No hay gasto confirmado que distribuir en este rango."
                        : "Composición proporcional no disponible con importes no positivos; consulta el desglose exacto en Analítica."}
                    </div>
                  ) : categorySlices.length === 0 ? (
                    <div className="dashboard-empty-note">
                      No hay desglose de categorías disponible para este gasto.
                    </div>
                  ) : (
                    <figure className="dashboard-category-chart">
                      {donutSlices.length > 0 && (
                        <div className="dashboard-donut-layout">
                          <svg
                            viewBox="0 0 192 192"
                            role="img"
                            aria-label={`Composición del gasto confirmado: ${donutSlices.map((slice) => `${slice.categoryName} ${slice.percentage === null ? "" : percent(slice.percentage)}`).join(", ")}`}
                          >
                            <circle
                              cx="96"
                              cy="96"
                              r="67"
                              fill="none"
                              stroke="#edf1ed"
                              strokeWidth="27"
                            />
                            {donutSlices.map((slice, index) => {
                              const circumference = 2 * Math.PI * 67;
                              const start =
                                donutSlices
                                  .slice(0, index)
                                  .reduce(
                                    (total, part) => total + part.amount,
                                    0,
                                  ) / summary.totalSpent;
                              const share = slice.amount / summary.totalSpent;
                              return (
                                <circle
                                  key={`${slice.categoryId ?? "uncategorized"}-${index}`}
                                  cx="96"
                                  cy="96"
                                  r="67"
                                  fill="none"
                                  className={`dashboard-donut-segment is-${index}`}
                                  strokeWidth="27"
                                  strokeDasharray={`${share * circumference} ${circumference}`}
                                  strokeDashoffset={-start * circumference}
                                  transform="rotate(-90 96 96)"
                                  tabIndex={0}
                                >
                                  <title>{`${slice.categoryName}: ${money(slice.amount)} · ${slice.percentage === null ? "proporción no disponible" : percent(slice.percentage)}`}</title>
                                </circle>
                              );
                            })}
                            <text
                              x="96"
                              y="91"
                              textAnchor="middle"
                              className="dashboard-donut-center-label"
                            >
                              GASTO
                            </text>
                            <text
                              x="96"
                              y="115"
                              textAnchor="middle"
                              className="dashboard-donut-center-value"
                            >
                              {compactMoney(summary.totalSpent)}
                            </text>
                          </svg>
                          <div className="dashboard-donut-legend">
                            {donutSlices.map((slice, index) => (
                              <div
                                key={`${slice.categoryId ?? "uncategorized"}-${index}`}
                                title={`${slice.categoryName}: ${money(slice.amount)}`}
                              >
                                <i
                                  className={`is-${index}`}
                                  aria-hidden="true"
                                />
                                <span>{slice.categoryName}</span>
                                <strong>
                                  {slice.percentage === null
                                    ? "—"
                                    : percent(slice.percentage)}
                                </strong>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      <details
                        className={`dashboard-category-bars-detail${donutSlices.length === 0 ? " is-primary" : ""}`}
                        open={donutSlices.length === 0}
                      >
                        <summary>Comparar importes por categoría</summary>
                        <div className="dashboard-category-chart-rows">
                          {categorySlices.map((category, index) => {
                            const label =
                              category.categoryId && !category.aggregated
                                ? (categoryPaths.get(category.categoryId) ??
                                  category.categoryName)
                                : category.categoryName;
                            const width =
                              categoryDistributionMaximum > 0
                                ? (category.amount /
                                    categoryDistributionMaximum) *
                                  100
                                : 0;
                            return (
                              <div
                                className="dashboard-category-chart-row"
                                key={`${category.categoryId ?? "uncategorized"}-${category.aggregated ? "other" : "category"}`}
                              >
                                <div className="dashboard-category-chart-heading">
                                  <span className="dashboard-category-rank">
                                    {String(index + 1).padStart(2, "0")}
                                  </span>
                                  <strong>{label}</strong>
                                  <span>{money(category.amount)}</span>
                                </div>
                                <div
                                  className="dashboard-category-chart-track"
                                  role="img"
                                  tabIndex={0}
                                  aria-label={`${label}: ${money(category.amount)}, ${category.percentage === null ? "porcentaje no disponible" : percent(category.percentage)} del gasto confirmado`}
                                  title={`${label}: ${money(category.amount)} · ${category.percentage === null ? "porcentaje no disponible" : `${percent(category.percentage)} del total`}`}
                                >
                                  <span style={{ width: `${width}%` }} />
                                </div>
                                <small>
                                  {category.percentage === null
                                    ? "Proporción no disponible"
                                    : `${percent(category.percentage)} del gasto confirmado`}
                                </small>
                              </div>
                            );
                          })}
                        </div>
                      </details>
                      <details className="dashboard-chart-data">
                        <summary>
                          Consultar importes exactos por categoría
                        </summary>
                        <div className="dashboard-chart-table-scroll">
                          <table>
                            <caption>
                              Gastos confirmados del rango {currentRangeLabel}.
                              «Otras categorías» conserva el importe restante.
                            </caption>
                            <thead>
                              <tr>
                                <th scope="col">Categoría</th>
                                <th scope="col">Importe</th>
                                <th scope="col">Participación</th>
                              </tr>
                            </thead>
                            <tbody>
                              {categorySlices.map((category) => (
                                <tr
                                  key={`category-table-${category.categoryId ?? "uncategorized"}-${category.aggregated ? "other" : "category"}`}
                                >
                                  <th scope="row">
                                    {category.categoryId && !category.aggregated
                                      ? (categoryPaths.get(
                                          category.categoryId,
                                        ) ?? category.categoryName)
                                      : category.categoryName}
                                  </th>
                                  <td>{money(category.amount)}</td>
                                  <td>
                                    {category.percentage === null
                                      ? "No disponible"
                                      : percent(category.percentage)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </details>
                      <figcaption className="dashboard-chart-caption">
                        Rango {currentRangeLabel}. Barras ordenadas por importe;
                        el máximo visible es{" "}
                        {money(categoryDistributionMaximum)}. Las categorías
                        pequeñas se agrupan en «Otras categorías» sin cambiar el
                        total.
                      </figcaption>
                    </figure>
                  )}
                  <p className="dashboard-data-note">
                    Se muestran importes atribuidos por el resumen. Los items
                    categorizados y el remanente del gasto general se presentan
                    sin duplicar importes.
                  </p>
                  <button
                    className="dashboard-text-action"
                    type="button"
                    onClick={() => onOpenExpenses(currentRange)}
                  >
                    Ver gastos del rango <span aria-hidden="true">→</span>
                  </button>
                </article>
                {memberExpenseDistribution?.members.length !== 1 && (
                  <article className="dashboard-panel dashboard-payer-panel">
                    <div className="dashboard-panel-heading">
                      <div>
                        <p className="dashboard-panel-eyebrow">
                          PAGO Y ASIGNACIÓN
                        </p>
                        <h3>Quién pagó y qué parte se asignó</h3>
                        <p className="dashboard-panel-subtitle">
                          Compara el importe registrado como pagado con las
                          distribuciones guardadas; no representa el balance
                          acumulado.
                        </p>
                      </div>
                      <span
                        className="dashboard-panel-index"
                        aria-hidden="true"
                      >
                        03
                      </span>
                    </div>
                    {activityLoading ? (
                      <p className="dashboard-empty-note" role="status">
                        Cargando registros completos…
                      </p>
                    ) : expenseActivityError ? (
                      <p className="dashboard-inline-error" role="status">
                        No se muestra una distribución parcial:{" "}
                        {expenseActivityError}
                      </p>
                    ) : !memberExpenseDistribution ||
                      memberExpenseDistribution.expenseCount === 0 ? (
                      <div className="dashboard-empty-note">
                        No hay gastos confirmados para atribuir a pagadores en
                        este rango.
                      </div>
                    ) : (
                      <figure className="dashboard-member-distribution-chart">
                        <div
                          className="dashboard-chart-legend"
                          aria-label="Series de distribución por integrante"
                        >
                          <span>
                            <i className="dashboard-legend-paid" /> Pagado
                          </span>
                          <span>
                            <i className="dashboard-legend-assigned" /> Parte
                            asignada
                          </span>
                        </div>
                        <div className="dashboard-member-distribution-list">
                          {memberExpenseDistribution.members.map((member) => {
                            const label =
                              memberNames.get(member.memberId ?? "") ??
                              member.memberName;
                            const paidWidth =
                              memberExpenseScale > 0
                                ? (member.paidAmount / memberExpenseScale) * 100
                                : 0;
                            const assignedWidth =
                              memberExpenseScale > 0
                                ? (member.assignedAmount / memberExpenseScale) *
                                  100
                                : 0;
                            const paidShare = getDashboardSharePercent(
                              member.paidAmount,
                              memberExpenseDistribution.totalPaid,
                            );
                            const assignedShare = getDashboardSharePercent(
                              member.assignedAmount,
                              memberExpenseDistribution.totalAssigned,
                            );
                            return (
                              <div
                                className="dashboard-member-distribution-row"
                                key={member.memberId ?? "unknown-payer"}
                              >
                                <strong className="dashboard-member-distribution-name">
                                  {label}
                                </strong>
                                <div className="dashboard-member-series-row">
                                  <div className="dashboard-member-series-heading">
                                    <span>Pagó</span>
                                    <strong>{money(member.paidAmount)}</strong>
                                  </div>
                                  <div
                                    className="dashboard-member-series-track is-paid"
                                    role="img"
                                    tabIndex={0}
                                    aria-label={`${label} pagó ${money(member.paidAmount)}`}
                                    title={`${label} · pagó ${money(member.paidAmount)}`}
                                  >
                                    <span style={{ width: `${paidWidth}%` }} />
                                  </div>
                                  <small>
                                    {member.paidExpenseCount}{" "}
                                    {member.paidExpenseCount === 1
                                      ? "gasto"
                                      : "gastos"}{" "}
                                    ·{" "}
                                    {paidShare === null
                                      ? "proporción no disponible"
                                      : `${percent(paidShare)} del total pagado`}
                                  </small>
                                </div>
                                <div className="dashboard-member-series-row">
                                  <div className="dashboard-member-series-heading">
                                    <span>Parte asignada</span>
                                    <strong>
                                      {money(member.assignedAmount)}
                                    </strong>
                                  </div>
                                  <div
                                    className="dashboard-member-series-track is-assigned"
                                    role="img"
                                    tabIndex={0}
                                    aria-label={`${label} tiene asignados ${money(member.assignedAmount)}`}
                                    title={`${label} · parte asignada ${money(member.assignedAmount)}`}
                                  >
                                    <span
                                      style={{ width: `${assignedWidth}%` }}
                                    />
                                  </div>
                                  <small>
                                    {member.assignedExpenseCount}{" "}
                                    {member.assignedExpenseCount === 1
                                      ? "distribución"
                                      : "distribuciones"}{" "}
                                    ·{" "}
                                    {assignedShare === null
                                      ? "proporción no disponible"
                                      : `${percent(assignedShare)} de las distribuciones cargadas`}
                                  </small>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        <details className="dashboard-chart-data">
                          <summary>
                            Consultar importes exactos por integrante
                          </summary>
                          <div className="dashboard-chart-table-scroll">
                            <table>
                              <caption>
                                Registros del rango {currentRangeLabel}; pagador
                                y distribución son dimensiones distintas.
                              </caption>
                              <thead>
                                <tr>
                                  <th scope="col">Integrante</th>
                                  <th scope="col">Pagado</th>
                                  <th scope="col">Parte asignada</th>
                                </tr>
                              </thead>
                              <tbody>
                                {memberExpenseDistribution.members.map(
                                  (member) => (
                                    <tr
                                      key={`member-distribution-${member.memberId ?? "unknown"}`}
                                    >
                                      <th scope="row">
                                        {memberNames.get(
                                          member.memberId ?? "",
                                        ) ?? member.memberName}
                                      </th>
                                      <td>{money(member.paidAmount)}</td>
                                      <td>{money(member.assignedAmount)}</td>
                                    </tr>
                                  ),
                                )}
                              </tbody>
                            </table>
                          </div>
                        </details>
                        <figcaption className="dashboard-chart-caption">
                          Rango {currentRangeLabel}. La escala común compara
                          importes COP; pagado total{" "}
                          {money(memberExpenseDistribution.totalPaid)} y partes
                          asignadas cargadas{" "}
                          {money(memberExpenseDistribution.totalAssigned)}. La
                          serie asignada no se presenta como balance.
                        </figcaption>
                        {(memberExpenseDistribution.expensesWithoutDistribution >
                          0 ||
                          memberExpenseDistribution.totalAssigned !==
                            memberExpenseDistribution.totalPaid ||
                          memberExpenseDistribution.totalPaid !==
                            summary.totalSpent ||
                          memberExpenseDistribution.expenseCount !==
                            summary.expenseCount) && (
                          <p className="dashboard-data-note" role="status">
                            La lista contiene{" "}
                            {memberExpenseDistribution.expenseCount} gastos y el
                            resumen {summary.expenseCount}; pagado en la lista{" "}
                            {money(memberExpenseDistribution.totalPaid)} y gasto
                            del resumen {money(summary.totalSpent)}. Hay{" "}
                            {
                              memberExpenseDistribution.expensesWithoutDistribution
                            }{" "}
                            gastos sin distribución. Las consultas separadas
                            pueden diferir; no se infiere una obligación
                            individual.
                          </p>
                        )}
                      </figure>
                    )}
                  </article>
                )}
                <article className="dashboard-panel dashboard-category-comparison-panel">
                  <div className="dashboard-panel-heading">
                    <div>
                      <p className="dashboard-panel-eyebrow">
                        CAMBIO ENTRE PERÍODOS
                      </p>
                      <h3>Qué categorías explican la variación</h3>
                      <p className="dashboard-panel-subtitle">
                        {periodRangeLabel(currentRange)} frente a{" "}
                        {periodRangeLabel(previousRange)}; categorías ordenadas
                        por magnitud del cambio.
                      </p>
                    </div>
                    <span className="dashboard-panel-index" aria-hidden="true">
                      04
                    </span>
                  </div>
                  {comparisonError ? (
                    <p className="dashboard-empty-note" role="status">
                      No se pueden comparar categorías: {comparisonError}
                    </p>
                  ) : categoryComparisonSlices.length === 0 ? (
                    <div className="dashboard-empty-note">
                      No hay variaciones por categoría entre estos períodos.
                    </div>
                  ) : (
                    <>
                      {expenseBridge && (
                        <DashboardExpenseBridgeChart bridge={expenseBridge} />
                      )}
                      <details
                        className="dashboard-waterfall-data"
                        open={!expenseBridge}
                      >
                        <summary>
                          Comparar variaciones exactas por categoría
                        </summary>
                        <div className="dashboard-category-comparison-list">
                          {categoryComparisonSlices.map((category) => {
                            const width =
                              categoryChangeMaximum > 0
                                ? (Math.abs(category.changeAmount) /
                                    categoryChangeMaximum) *
                                  50
                                : 0;
                            const label = category.categoryId
                              ? (categoryPaths.get(category.categoryId) ??
                                category.categoryName)
                              : category.categoryName;
                            return (
                              <div
                                className="dashboard-category-comparison-row dashboard-divergent-row"
                                key={`${category.categoryId ?? "uncategorized"}-${category.aggregated ? "other" : "category"}`}
                              >
                                <div className="dashboard-category-comparison-heading">
                                  <strong>{label}</strong>
                                  <span>
                                    {signedMoney(category.changeAmount)}
                                  </span>
                                </div>
                                <div
                                  className="dashboard-divergent-track"
                                  role="img"
                                  tabIndex={0}
                                  aria-label={`${label}: ${category.changeAmount > 0 ? "aumentó" : category.changeAmount < 0 ? "disminuyó" : "sin cambio neto"} ${money(Math.abs(category.changeAmount))}; actual ${money(category.currentAmount)}, anterior ${money(category.previousAmount)}${category.percentageChange === null ? "; sin porcentaje válido por base anterior cero" : `; ${percent(category.percentageChange)} de variación`}`}
                                  title={`${label} · actual ${money(category.currentAmount)} · anterior ${money(category.previousAmount)} · cambio ${signedMoney(category.changeAmount)}`}
                                >
                                  <span
                                    className={
                                      category.changeAmount > 0
                                        ? "is-increase"
                                        : category.changeAmount < 0
                                          ? "is-decrease"
                                          : "is-unchanged"
                                    }
                                    style={{
                                      width: `${width}%`,
                                      left: `${category.changeAmount > 0 ? 50 : 50 - width}%`,
                                    }}
                                  />
                                </div>
                                <small>
                                  Actual {money(category.currentAmount)} ·
                                  anterior {money(category.previousAmount)}
                                  {category.percentageChange === null
                                    ? " · porcentaje no disponible: sin base anterior positiva"
                                    : ` · ${percent(category.percentageChange)} de cambio`}
                                </small>
                              </div>
                            );
                          })}
                        </div>
                        <div
                          className="dashboard-chart-legend dashboard-category-comparison-legend"
                          aria-label="Leyenda de categorías"
                        >
                          <span>
                            <i className="dashboard-divergent-key is-decrease" />{" "}
                            Disminuyó
                          </span>
                          <span>
                            <i className="dashboard-divergent-key is-increase" />{" "}
                            Aumentó
                          </span>
                          <span>Centro = sin cambio</span>
                        </div>
                      </details>
                      <p className="dashboard-data-note">
                        “Otras categorías” agrupa importes restantes: sus
                        cambios pueden compensarse entre sí. La variación no
                        demuestra una causa.
                      </p>
                      <p className="dashboard-chart-caption">
                        Las barras comparten escala de cambio absoluto en COP.
                        Los importes actual y anterior están en el detalle y en
                        Analítica.
                      </p>
                    </>
                  )}
                </article>
              </div>

              {executiveInsights.length > 0 && (
                <section
                  className="dashboard-executive-insights"
                  aria-label="Cambios destacados del período"
                >
                  <h3>Señales del período</h3>
                  <div>
                    {executiveInsights.map((insight) => (
                      <article key={insight.kind}>
                        {insight.kind === "concentration" ? (
                          <>
                            <strong>
                              {insight.categoryName} ·{" "}
                              {percent(insight.percentage)}
                            </strong>
                            <span>
                              {money(insight.amount)} del gasto confirmado.
                            </span>
                          </>
                        ) : insight.kind === "category-change" ? (
                          <>
                            <strong>
                              {insight.categoryName} ·{" "}
                              {signedMoney(insight.changeAmount)}
                            </strong>
                            <span>
                              {money(insight.currentAmount)} actual frente a{" "}
                              {money(insight.previousAmount)} anterior.
                            </span>
                          </>
                        ) : (
                          <>
                            <strong>
                              Gastos ↑ {money(insight.expenseChange)} · ingresos
                              ↓ {money(Math.abs(insight.incomeChange))}
                            </strong>
                            <span>
                              Movimientos opuestos frente al período comparable.
                            </span>
                          </>
                        )}
                      </article>
                    ))}
                  </div>
                </section>
              )}

              <details className="dashboard-visual-more">
                <summary>Explorar composición y actividad semanal</summary>
                <div className="dashboard-grid dashboard-grid-visual-secondary">
                  <article className="dashboard-panel dashboard-composition-panel">
                    <div className="dashboard-panel-heading">
                      <div>
                        <p className="dashboard-panel-eyebrow">
                          COMPOSICIÓN DEL PERÍODO
                        </p>
                        <h3>Ingresos frente a gastos</h3>
                        <p className="dashboard-panel-subtitle">
                          Dos importes sobre una misma escala; no son partes de
                          un total combinado.
                        </p>
                      </div>
                      <span
                        className="dashboard-panel-index"
                        aria-hidden="true"
                      >
                        05
                      </span>
                    </div>
                    {!financialComposition ||
                    (financialComposition.totalIncome === 0 &&
                      financialComposition.totalExpenses === 0) ? (
                      <div className="dashboard-empty-note">
                        {!financialComposition
                          ? "Cargando composición del período…"
                          : `No hay ingresos ni gastos confirmados en ${currentRangeLabel}.`}
                      </div>
                    ) : (
                      <figure className="dashboard-composition-chart">
                        <div
                          className="dashboard-composition-columns"
                          role="group"
                          aria-label={`Ingresos y gastos del rango ${currentRangeLabel}; columnas independientes sobre una misma escala COP`}
                        >
                          {(
                            [
                              {
                                label: "Ingresos",
                                amount: financialComposition.totalIncome,
                                className: "is-income",
                              },
                              {
                                label: "Gastos",
                                amount: financialComposition.totalExpenses,
                                className: "is-expense",
                              },
                            ] as const
                          ).map((bar) => {
                            const barHeight =
                              compositionMaximum > 0
                                ? (bar.amount / compositionMaximum) * 100
                                : 0;
                            return (
                              <div
                                className="dashboard-composition-column-group"
                                key={bar.label}
                              >
                                <span className="dashboard-column-value">
                                  {compactMoney(bar.amount)}
                                </span>
                                <div className="dashboard-column-plot">
                                  <span
                                    className={`dashboard-composition-column ${bar.className}${bar.amount === 0 ? " is-zero" : ""}`}
                                    style={{
                                      height: `${bar.amount === 0 ? 2 : barHeight}%`,
                                    }}
                                    tabIndex={0}
                                    role="img"
                                    aria-label={`${bar.label}: ${money(bar.amount)} en ${currentRangeLabel}`}
                                    title={`${bar.label} · ${money(bar.amount)} · ${currentRangeLabel}`}
                                  />
                                </div>
                                <strong className="dashboard-column-category">
                                  {bar.label}
                                </strong>
                              </div>
                            );
                          })}
                        </div>
                        <p
                          className={`dashboard-composition-net ${financialComposition.netAmount < 0 ? "is-negative" : "is-positive"}`}
                        >
                          Diferencia (ingresos − gastos):{" "}
                          <strong>
                            {signedMoney(financialComposition.netAmount)}
                          </strong>
                        </p>
                        <p className="dashboard-composition-ratio">
                          {financialComposition.expensesAsPercentOfIncome ===
                          null
                            ? "Gastos / ingresos: no disponible con ingresos cero o fuera del rango numérico seguro."
                            : `Los gastos equivalen al ${percent(financialComposition.expensesAsPercentOfIncome)} de los ingresos.`}
                        </p>
                        <details className="dashboard-chart-data">
                          <summary>
                            Consultar cifras exactas de composición
                          </summary>
                          <div className="dashboard-chart-table-scroll">
                            <table>
                              <caption>
                                Resumen de {currentRangeLabel}. Ingresos y
                                gastos se mantienen separados.
                              </caption>
                              <thead>
                                <tr>
                                  <th scope="col">Concepto</th>
                                  <th scope="col">Importe</th>
                                </tr>
                              </thead>
                              <tbody>
                                <tr>
                                  <th scope="row">Ingresos registrados</th>
                                  <td>
                                    {money(financialComposition.totalIncome)}
                                  </td>
                                </tr>
                                <tr>
                                  <th scope="row">Gastos confirmados</th>
                                  <td>
                                    {money(financialComposition.totalExpenses)}
                                  </td>
                                </tr>
                                <tr>
                                  <th scope="row">Ingresos menos gastos</th>
                                  <td>
                                    {signedMoney(
                                      financialComposition.netAmount,
                                    )}
                                  </td>
                                </tr>
                              </tbody>
                            </table>
                          </div>
                        </details>
                        <figcaption className="dashboard-chart-caption">
                          Rango {currentRangeLabel}. Columnas sobre una escala
                          común en COP, con valores compactos encima y detalle
                          exacto al enfocar; el neto se muestra aparte y no es
                          un balance de obligaciones entre integrantes.
                        </figcaption>
                      </figure>
                    )}
                  </article>

                  <article className="dashboard-panel dashboard-weekday-panel">
                    <div className="dashboard-panel-heading">
                      <div>
                        <p className="dashboard-panel-eyebrow">
                          PATRÓN DE ACTIVIDAD
                        </p>
                        <h3>Gastos por día de semana</h3>
                        <p className="dashboard-panel-subtitle">
                          Importe total por día de calendario dentro del rango;
                          no se infieren horas ni momentos no registrados.
                        </p>
                      </div>
                      <span
                        className="dashboard-panel-index"
                        aria-hidden="true"
                      >
                        06
                      </span>
                    </div>
                    {activityLoading ? (
                      <p className="dashboard-empty-note" role="status">
                        Cargando gastos completos del rango…
                      </p>
                    ) : expenseActivityError ? (
                      <p className="dashboard-inline-error" role="status">
                        No se muestra un patrón parcial: {expenseActivityError}
                      </p>
                    ) : !weekdayDistribution ? (
                      <div className="dashboard-empty-note">
                        La serie semanal aún no está disponible.
                      </div>
                    ) : (
                      <figure className="dashboard-weekday-chart">
                        <div
                          className="dashboard-weekday-columns"
                          role="group"
                          aria-label={`Total de gastos por día de semana para ${currentRangeLabel}, en orden de lunes a domingo`}
                        >
                          {weekdayDistribution.days.map((day) => {
                            const noCalendarDay = day.calendarDayCount === 0;
                            const noExpenses = day.expenseCount === 0;
                            const zeroAmount =
                              day.totalAmount === 0 && !noExpenses;
                            const barHeight =
                              weekdayAmountMaximum > 0
                                ? (day.totalAmount / weekdayAmountMaximum) * 100
                                : 0;
                            const activityDetail = noCalendarDay
                              ? "no hay fechas de este día en el rango"
                              : noExpenses
                                ? `${day.calendarDayCount} fechas sin gastos registrados`
                                : `${day.expenseCount} gastos en ${day.calendarDayCount} fechas`;
                            const stateClass = noCalendarDay
                              ? "is-no-date"
                              : noExpenses
                                ? "is-no-expenses"
                                : zeroAmount
                                  ? "is-zero"
                                  : "";
                            return (
                              <div
                                className="dashboard-weekday-column-group"
                                key={day.weekday}
                              >
                                <span className="dashboard-column-value">
                                  {compactMoney(day.totalAmount)}
                                </span>
                                <div className="dashboard-column-plot">
                                  <span
                                    className={`dashboard-weekday-column ${stateClass}`}
                                    style={{
                                      height: `${day.totalAmount === 0 ? 2 : barHeight}%`,
                                    }}
                                    tabIndex={0}
                                    role="img"
                                    aria-label={`${day.weekday}: total ${money(day.totalAmount)}; ${activityDetail}`}
                                    title={`${day.weekday} · ${money(day.totalAmount)} · ${activityDetail}`}
                                  />
                                </div>
                                <abbr
                                  className="dashboard-column-category"
                                  title={day.weekday}
                                >
                                  {day.weekday.slice(0, 3)}
                                </abbr>
                              </div>
                            );
                          })}
                        </div>
                        <div
                          className="dashboard-chart-legend dashboard-weekday-legend"
                          aria-label="Estados de las barras semanales"
                        >
                          <span>
                            <i className="dashboard-weekday-key" /> Gasto
                            registrado
                          </span>
                          <span>
                            <i className="dashboard-weekday-key is-zero" />{" "}
                            Gasto con importe cero
                          </span>
                          <span>
                            <i className="dashboard-weekday-key is-no-expenses" />{" "}
                            Fecha sin gastos
                          </span>
                          <span>
                            <i className="dashboard-weekday-key is-no-date" />{" "}
                            Día sin fechas en el rango
                          </span>
                        </div>
                        {weekdayDistribution.expenseCount === 0 && (
                          <p className="dashboard-empty-note" role="status">
                            No hay gastos confirmados en {currentRangeLabel}; se
                            muestran los siete días con importe cero.
                          </p>
                        )}
                        <details className="dashboard-chart-data">
                          <summary>
                            Consultar totales y registros por día
                          </summary>
                          <div className="dashboard-chart-table-scroll">
                            <table>
                              <caption>
                                Gastos del rango {currentRangeLabel}; promedio
                                calculado por cada fecha del día de semana
                                presente en el rango.
                              </caption>
                              <thead>
                                <tr>
                                  <th scope="col">Día</th>
                                  <th scope="col">Promedio por fecha</th>
                                  <th scope="col">Total</th>
                                  <th scope="col">Gastos</th>
                                  <th scope="col">Fechas del rango</th>
                                </tr>
                              </thead>
                              <tbody>
                                {weekdayDistribution.days.map((day) => (
                                  <tr key={`weekday-table-${day.weekday}`}>
                                    <th scope="row">{day.weekday}</th>
                                    <td>
                                      {day.averageAmount === null
                                        ? "No aplica"
                                        : money(day.averageAmount)}
                                    </td>
                                    <td>{money(day.totalAmount)}</td>
                                    <td>{day.expenseCount}</td>
                                    <td>{day.calendarDayCount}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </details>
                        <figcaption className="dashboard-chart-caption">
                          Rango {currentRangeLabel}; suma semanal{" "}
                          {money(weekdayDistribution.totalAmount)}. La marca
                          punteada indica que no hay fechas de ese día; la marca
                          de línea indica total cero. El conteo distingue fechas
                          sin gastos de registros con importe cero.
                        </figcaption>
                      </figure>
                    )}
                  </article>
                </div>
              </details>
            </section>
          )}

          {viewMode === "analytic" && (
            <section
              className="dashboard-analytic-view"
              aria-label="Detalle analítico de finanzas"
            >
              <header className="dashboard-analytic-heading">
                <div>
                  <p className="section-kicker">ANÁLISIS DEL PERÍODO</p>
                  <h3>Cifras y desgloses</h3>
                </div>
                <p>
                  Ingresos {money(summary.totalIncome)} · gastos{" "}
                  {money(summary.totalSpent)} · neto{" "}
                  {signedMoney(summary.netAmount)}. El neto no representa deudas
                  entre miembros.
                </p>
              </header>
              <div className="dashboard-analytic-tables">
                <article className="dashboard-panel dashboard-analytic-table-panel">
                  <h3>Movimientos por período</h3>
                  {activityLoading ? (
                    <p role="status">Cargando movimientos completos…</p>
                  ) : expenseActivityError || incomeActivityError ? (
                    <p role="status">
                      No se muestra un desglose parcial: faltan registros del
                      rango.
                    </p>
                  ) : !selectedGranularityAvailable ? (
                    <p>
                      La granularidad seleccionada excede el límite de períodos.
                      Elige otra.
                    </p>
                  ) : trendSeries ? (
                    <div className="dashboard-chart-table-scroll">
                      <table>
                        <caption>
                          Ingresos y gastos por{" "}
                          {granularityLabel(trendGranularity)}; rango{" "}
                          {currentRangeLabel}
                        </caption>
                        <thead>
                          <tr>
                            <th scope="col">Período</th>
                            <th scope="col">Ingresos</th>
                            <th scope="col">Gastos</th>
                            <th scope="col">Registros</th>
                          </tr>
                        </thead>
                        <tbody>
                          {trendSeries.points.map((point) => (
                            <tr key={point.start}>
                              <th scope="row">
                                {formatDashboardTrendBucketLabel(
                                  point.start,
                                  trendGranularity,
                                )}
                              </th>
                              <td>{money(point.incomeAmount)}</td>
                              <td>{money(point.expenseAmount)}</td>
                              <td>{point.incomeCount + point.expenseCount}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p>Serie no disponible.</p>
                  )}
                </article>
                <article className="dashboard-panel dashboard-analytic-table-panel">
                  <h3>Gasto por categoría</h3>
                  {allCategorySlices.length === 0 ? (
                    <p>Sin gasto confirmado.</p>
                  ) : (
                    <div className="dashboard-chart-table-scroll">
                      <table>
                        <caption>
                          Desglose completo del gasto confirmado; sin duplicar
                          categorías
                        </caption>
                        <thead>
                          <tr>
                            <th scope="col">Categoría</th>
                            <th scope="col">Importe</th>
                            <th scope="col">Parte del gasto</th>
                          </tr>
                        </thead>
                        <tbody>
                          {allCategorySlices.map((item) => (
                            <tr key={item.categoryId ?? "uncategorized"}>
                              <th scope="row">
                                {item.categoryId
                                  ? (categoryPaths.get(item.categoryId) ??
                                    item.categoryName)
                                  : item.categoryName}
                              </th>
                              <td>{money(item.amount)}</td>
                              <td>
                                {item.percentage === null
                                  ? "No disponible"
                                  : percent(item.percentage)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </article>
                <article className="dashboard-panel dashboard-analytic-table-panel">
                  <h3>Cambio por categoría</h3>
                  {comparisonError ? (
                    <p role="status">
                      Comparación no disponible: {comparisonError}
                    </p>
                  ) : allCategoryComparisonSlices.length === 0 ? (
                    <p>Sin variaciones de categoría.</p>
                  ) : (
                    <div className="dashboard-chart-table-scroll">
                      <table>
                        <caption>
                          Período actual frente al anterior; variaciones
                          descriptivas
                        </caption>
                        <thead>
                          <tr>
                            <th scope="col">Categoría</th>
                            <th scope="col">Actual</th>
                            <th scope="col">Anterior</th>
                            <th scope="col">Diferencia</th>
                            <th scope="col">Variación</th>
                          </tr>
                        </thead>
                        <tbody>
                          {allCategoryComparisonSlices.map((item) => (
                            <tr
                              key={`${item.categoryId ?? "uncategorized"}-${item.aggregated ? "other" : "category"}`}
                            >
                              <th scope="row">
                                {item.categoryId
                                  ? (categoryPaths.get(item.categoryId) ??
                                    item.categoryName)
                                  : item.categoryName}
                              </th>
                              <td>{money(item.currentAmount)}</td>
                              <td>{money(item.previousAmount)}</td>
                              <td>{signedMoney(item.changeAmount)}</td>
                              <td>
                                {item.percentageChange === null
                                  ? "Sin base previa positiva"
                                  : percent(item.percentageChange)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </article>
                <article className="dashboard-panel dashboard-analytic-table-panel">
                  <h3>Pago y parte asignada</h3>
                  {activityLoading ? (
                    <p role="status">Cargando gastos completos…</p>
                  ) : expenseActivityError ? (
                    <p role="status">No se muestra una distribución parcial.</p>
                  ) : !memberExpenseDistribution ||
                    memberExpenseDistribution.expenseCount === 0 ? (
                    <p>Sin gastos confirmados.</p>
                  ) : (
                    <div className="dashboard-chart-table-scroll">
                      <table>
                        <caption>
                          Pagado y parte asignada son dimensiones distintas; no
                          son un balance
                        </caption>
                        <thead>
                          <tr>
                            <th scope="col">Integrante</th>
                            <th scope="col">Pagado</th>
                            <th scope="col">Parte asignada</th>
                            <th scope="col">Gastos pagados</th>
                          </tr>
                        </thead>
                        <tbody>
                          {memberExpenseDistribution.members.map((member) => (
                            <tr key={member.memberId ?? "unknown"}>
                              <th scope="row">
                                {memberNames.get(member.memberId ?? "") ??
                                  member.memberName}
                              </th>
                              <td>{money(member.paidAmount)}</td>
                              <td>{money(member.assignedAmount)}</td>
                              <td>{member.paidExpenseCount}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </article>
                <article className="dashboard-panel dashboard-analytic-table-panel">
                  <h3>Actividad semanal</h3>
                  {activityLoading ? (
                    <p role="status">Cargando gastos completos…</p>
                  ) : expenseActivityError ? (
                    <p role="status">No se muestra actividad parcial.</p>
                  ) : !weekdayDistribution ? (
                    <p>Actividad no disponible.</p>
                  ) : (
                    <div className="dashboard-chart-table-scroll">
                      <table>
                        <caption>
                          Totales de lunes a domingo; días sin fecha y registros
                          de importe cero se distinguen por conteo
                        </caption>
                        <thead>
                          <tr>
                            <th scope="col">Día</th>
                            <th scope="col">Total</th>
                            <th scope="col">Gastos</th>
                            <th scope="col">Fechas</th>
                            <th scope="col">Promedio por fecha</th>
                          </tr>
                        </thead>
                        <tbody>
                          {weekdayDistribution.days.map((day) => (
                            <tr key={day.weekday}>
                              <th scope="row">{day.weekday}</th>
                              <td>{money(day.totalAmount)}</td>
                              <td>{day.expenseCount}</td>
                              <td>{day.calendarDayCount}</td>
                              <td>
                                {day.averageAmount === null
                                  ? "No aplica"
                                  : money(day.averageAmount)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </article>
              </div>
              <div className="dashboard-grid dashboard-grid-featured">
                <article className="dashboard-panel dashboard-comparison-panel">
                  <div className="dashboard-panel-heading">
                    <div>
                      <p className="dashboard-panel-eyebrow">
                        LECTURA TEMPORAL
                      </p>
                      <h3>Este período frente al anterior</h3>
                      <p className="dashboard-panel-subtitle">
                        Comparación de totales equivalentes; no es una serie
                        diaria.
                      </p>
                    </div>
                    <span className="dashboard-panel-index" aria-hidden="true">
                      01
                    </span>
                  </div>
                  {previousSummary ? (
                    <figure className="dashboard-comparison-chart">
                      <div
                        className="dashboard-chart-legend"
                        aria-label="Leyenda"
                      >
                        <span>
                          <i className="dashboard-legend-current" />{" "}
                          {periodLabel}
                        </span>
                        <span>
                          <i className="dashboard-legend-previous" /> Período
                          anterior
                        </span>
                      </div>
                      {(
                        [
                          {
                            label: "Ingresos",
                            current: summary.totalIncome,
                            previous: previousSummary.totalIncome,
                          },
                          {
                            label: "Gastos",
                            current: summary.totalSpent,
                            previous: previousSummary.totalSpent,
                          },
                        ] as const
                      ).map((row) => (
                        <div className="dashboard-chart-row" key={row.label}>
                          <div className="dashboard-chart-row-heading">
                            <strong>{row.label}</strong>
                            <span>{money(row.current)}</span>
                          </div>
                          <div
                            className="dashboard-chart-bar-track"
                            role="img"
                            aria-label={`${row.label}: ${money(row.current)} en ${periodRangeLabel(currentRange)} y ${money(row.previous)} en ${periodRangeLabel(previousRange)}`}
                          >
                            <span
                              className="dashboard-chart-bar dashboard-chart-bar-current"
                              style={{
                                width: `${comparisonScale > 0 ? (row.current / comparisonScale) * 100 : 0}%`,
                              }}
                            />
                            <span
                              className="dashboard-chart-bar dashboard-chart-bar-previous"
                              style={{
                                width: `${comparisonScale > 0 ? (row.previous / comparisonScale) * 100 : 0}%`,
                              }}
                            />
                          </div>
                          <div className="dashboard-chart-row-footer">
                            <span>Anterior: {money(row.previous)}</span>
                            <span>
                              {deltaLabel(
                                compareDashboardAmounts(
                                  row.current,
                                  row.previous,
                                ),
                                comparisonLabel,
                              )}
                            </span>
                          </div>
                        </div>
                      ))}
                      <figcaption>
                        Actual: {periodRangeLabel(currentRange)} · anterior:{" "}
                        {periodRangeLabel(previousRange)}. Las variaciones son
                        descriptivas, no una calificación financiera.
                      </figcaption>
                    </figure>
                  ) : (
                    <div className="dashboard-empty-note">
                      La comparación aparecerá cuando el período anterior esté
                      disponible.
                    </div>
                  )}
                </article>

                <article className="dashboard-panel dashboard-insights-panel">
                  <div className="dashboard-panel-heading">
                    <div>
                      <p className="dashboard-panel-eyebrow">
                        QUÉ MERECE ATENCIÓN
                      </p>
                      <h3>Lecturas basadas en tus datos</h3>
                    </div>
                    <span className="dashboard-panel-index" aria-hidden="true">
                      02
                    </span>
                  </div>
                  {summary.totalIncome === 0 && summary.totalSpent === 0 ? (
                    <div className="dashboard-insight-item">
                      <span
                        className="dashboard-insight-marker"
                        aria-hidden="true"
                      >
                        —
                      </span>
                      <div>
                        <strong>Sin movimientos en el período</strong>
                        <p>
                          No hay ingresos ni gastos confirmados para estas
                          fechas.
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="dashboard-insight-item">
                      <span
                        className="dashboard-insight-marker"
                        aria-hidden="true"
                      >
                        {summary.netAmount < 0
                          ? "−"
                          : summary.netAmount > 0
                            ? "+"
                            : "="}
                      </span>
                      <div>
                        <strong>
                          {summary.netAmount < 0
                            ? "Los gastos confirmados superan los ingresos registrados"
                            : summary.netAmount > 0
                              ? "Los ingresos registrados superan los gastos confirmados"
                              : "Ingresos registrados y gastos confirmados coinciden"}
                        </strong>
                        <p>
                          Diferencia del período:{" "}
                          {money(Math.abs(summary.netAmount))}. Es un flujo
                          registrado, no una medida de deuda entre miembros.
                        </p>
                      </div>
                    </div>
                  )}
                  {topThreeShare !== null && (
                    <div className="dashboard-insight-item">
                      <span
                        className="dashboard-insight-marker"
                        aria-hidden="true"
                      >
                        %
                      </span>
                      <div>
                        <strong>Concentración descriptiva</strong>
                        <p>
                          Las categorías principales (hasta tres) reúnen{" "}
                          {percent(topThreeShare)} del gasto confirmado. Revisa
                          su detalle si quieres entender qué movimientos
                          componen esa proporción.
                        </p>
                      </div>
                    </div>
                  )}
                  {largestCategoryChange && previousSummary && (
                    <div className="dashboard-insight-item">
                      <span
                        className="dashboard-insight-marker"
                        aria-hidden="true"
                      >
                        {largestCategoryChange.direction === "increase"
                          ? "↗"
                          : "↘"}
                      </span>
                      <div>
                        <strong>Mayor variación por categoría</strong>
                        <p>
                          {largestCategoryChange.categoryName}:{" "}
                          {money(largestCategoryChange.currentAmount)} frente a{" "}
                          {money(largestCategoryChange.previousAmount)} (
                          {signedMoney(largestCategoryChange.changeAmount)}) en{" "}
                          {comparisonLabel}. Es una comparación, no una anomalía
                          ni una predicción.
                        </p>
                      </div>
                    </div>
                  )}
                  <div className="dashboard-insight-item">
                    <span
                      className="dashboard-insight-marker"
                      aria-hidden="true"
                    >
                      ↕
                    </span>
                    <div>
                      <strong>Períodos con más y menos movimiento</strong>
                      {activityLoading ? (
                        <p role="status">
                          Esperando la carga completa de movimientos.
                        </p>
                      ) : expenseActivityError || incomeActivityError ? (
                        <p role="status">
                          Lectura no disponible: faltan registros del rango y no
                          se infiere un mínimo a partir de datos parciales.
                        </p>
                      ) : !selectedGranularityAvailable ? (
                        <p role="status">
                          Elige una granularidad disponible para esta duración;
                          la selección no se cambiará automáticamente.
                        </p>
                      ) : trendExtremes?.mostActive &&
                        trendExtremes.leastActive ? (
                        <p>
                          Mayor suma de ingresos más gastos:{" "}
                          {formatDashboardTrendBucketLabel(
                            trendExtremes.mostActive.point.start,
                            trendGranularity,
                          )}{" "}
                          ({money(trendExtremes.mostActive.movementAmount)},{" "}
                          {trendExtremes.mostActive.recordCount} registros).
                          Menor período con registros:{" "}
                          {formatDashboardTrendBucketLabel(
                            trendExtremes.leastActive.point.start,
                            trendGranularity,
                          )}{" "}
                          ({money(trendExtremes.leastActive.movementAmount)},{" "}
                          {trendExtremes.leastActive.recordCount} registros).
                          Los intervalos sin movimientos no se presentan como
                          mínimos reales.
                        </p>
                      ) : (
                        <p>
                          No hay movimientos en el rango; no se asigna un mínimo
                          de cero a un período sin registros.
                        </p>
                      )}
                    </div>
                  </div>
                  {summary.byCategory.length < 2 && summary.totalSpent > 0 && (
                    <p className="dashboard-insight-footnote">
                      Hay muy pocas categorías para describir concentración
                      entre varias.
                    </p>
                  )}
                </article>
              </div>

              <div className="dashboard-grid dashboard-grid-details">
                <article className="dashboard-panel dashboard-category-panel">
                  <div className="dashboard-panel-heading">
                    <div>
                      <p className="dashboard-panel-eyebrow">
                        DESTINO DEL GASTO
                      </p>
                      <h3>En qué se concentró el hogar</h3>
                      <p className="dashboard-panel-subtitle">
                        Importes confirmados asignados por el resumen del
                        backend.
                      </p>
                    </div>
                    <span className="dashboard-panel-index" aria-hidden="true">
                      03
                    </span>
                  </div>
                  {categorySlices.length === 0 ? (
                    <div className="dashboard-empty-note">
                      No hay gastos confirmados para distribuir por categoría en
                      este período.
                    </div>
                  ) : (
                    <div className="dashboard-category-list">
                      {categorySlices.map((category, index) => (
                        <div
                          className="dashboard-category-row"
                          key={`${category.categoryId ?? "uncategorized"}-${category.aggregated ? "other" : "category"}`}
                        >
                          <div className="dashboard-category-copy">
                            <span className="dashboard-category-rank">
                              {String(index + 1).padStart(2, "0")}
                            </span>
                            <div className="dashboard-category-name">
                              <strong>
                                {category.categoryId && !category.aggregated
                                  ? (categoryPaths.get(category.categoryId) ??
                                    category.categoryName)
                                  : category.categoryName}
                              </strong>
                              <span>
                                {category.percentage === null
                                  ? "Proporción no disponible"
                                  : `${percent(category.percentage)} del gasto`}
                              </span>
                            </div>
                          </div>
                          <strong className="dashboard-category-amount">
                            {money(category.amount)}
                          </strong>
                          <div
                            className="dashboard-category-track"
                            aria-hidden="true"
                          >
                            <span
                              style={{ width: `${category.percentage ?? 0}%` }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="dashboard-data-note">
                    Los items categorizados y el remanente del gasto general se
                    presentan sin sumar dos veces el mismo importe.
                  </p>
                  <button
                    className="dashboard-text-action"
                    type="button"
                    onClick={() => onOpenExpenses(currentRange)}
                  >
                    Explorar gastos del período{" "}
                    <span aria-hidden="true">→</span>
                  </button>
                </article>

                <article className="dashboard-panel dashboard-member-income-panel">
                  <div className="dashboard-panel-heading">
                    <div>
                      <p className="dashboard-panel-eyebrow">
                        INGRESOS DEL HOGAR
                      </p>
                      <h3>Registrados por integrante</h3>
                      <p className="dashboard-panel-subtitle">
                        Participación sobre el ingreso registrado en este
                        período.
                      </p>
                    </div>
                    <span className="dashboard-panel-index" aria-hidden="true">
                      04
                    </span>
                  </div>
                  {sortedMemberIncome.length === 0 ? (
                    <div className="dashboard-empty-note">
                      No hay ingresos registrados por integrante en estas
                      fechas.
                    </div>
                  ) : (
                    <div className="dashboard-member-income-list">
                      {sortedMemberIncome.map((item) => {
                        const share = getDashboardSharePercent(
                          item.amount,
                          summary.totalIncome,
                        );
                        return (
                          <div
                            className="dashboard-member-income-row"
                            key={item.memberId}
                          >
                            <div className="dashboard-member-income-heading">
                              <strong>
                                {memberNames.get(item.memberId) ??
                                  "Integrante del hogar"}
                              </strong>
                              <span>{money(item.amount)}</span>
                            </div>
                            <div
                              className="dashboard-member-income-track"
                              aria-hidden="true"
                            >
                              <span style={{ width: `${share ?? 0}%` }} />
                            </div>
                            <small>
                              {share === null
                                ? "Participación no disponible"
                                : `${percent(share)} del ingreso`}
                            </small>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <button
                    className="dashboard-text-action"
                    type="button"
                    onClick={() => onOpenIncomes(currentRange)}
                  >
                    Explorar ingresos del período{" "}
                    <span aria-hidden="true">→</span>
                  </button>
                </article>
              </div>
            </section>
          )}
        </>
      )}

      {activeRange && viewMode === "analytic" && (
        <div className="dashboard-grid dashboard-grid-bottom">
          <article className="dashboard-panel dashboard-balance-panel">
            <div className="dashboard-panel-heading">
              <div>
                <p className="dashboard-panel-eyebrow">ECONOMÍA COMPARTIDA</p>
                <h3>Balance entre integrantes</h3>
                <p className="dashboard-panel-subtitle">
                  Acumulado de gastos confirmados; no cambia con el período
                  seleccionado.
                </p>
              </div>
              <span className="dashboard-panel-index" aria-hidden="true">
                05
              </span>
            </div>
            {balanceError ? (
              <p className="dashboard-inline-error" role="alert">
                {balanceError}
              </p>
            ) : balance === null ? (
              <p className="dashboard-empty-note">
                El balance estará disponible al terminar la carga.
              </p>
            ) : balance.members.length === 0 ? (
              <p className="dashboard-empty-note">
                No hay integrantes disponibles para mostrar el balance.
              </p>
            ) : balance.members.every(
                (member) => member.paid === 0 && member.share === 0,
              ) ? (
              <p className="dashboard-empty-note">
                Aún no hay gastos compartidos confirmados que generen
                diferencias.
              </p>
            ) : (
              <div className="dashboard-balance-list">
                {balance.members.map((member) => (
                  <div className="dashboard-balance-row" key={member.memberId}>
                    <div className="dashboard-balance-person">
                      <strong>
                        {memberNames.get(member.memberId) ??
                          "Integrante del hogar"}
                      </strong>
                      <span>
                        Pagó {money(member.paid)} · parte asignada{" "}
                        {money(member.share)}
                      </span>
                    </div>
                    <span
                      className={
                        member.balance >= 0
                          ? "dashboard-balance-status is-positive"
                          : "dashboard-balance-status is-negative"
                      }
                    >
                      {member.balance === 0
                        ? "Al día"
                        : `${member.balance > 0 ? "Pagó más que su parte" : "Pagó menos que su parte"}: ${money(Math.abs(member.balance))}`}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <p className="dashboard-data-note">
              Es la diferencia entre lo pagado y la distribución persistida. No
              afirma una deuda bilateral ni que el reparto sea incorrecto.
            </p>
            <button
              className="dashboard-text-action"
              type="button"
              onClick={onOpenBalance}
            >
              Ver balance completo <span aria-hidden="true">→</span>
            </button>
          </article>

          <article className="dashboard-panel dashboard-activity-panel">
            <div className="dashboard-panel-heading">
              <div>
                <p className="dashboard-panel-eyebrow">ACTIVIDAD DEL PERÍODO</p>
                <h3>Movimientos recientes</h3>
                <p className="dashboard-panel-subtitle">
                  Hasta seis movimientos ordenados por su fecha registrada.
                </p>
              </div>
              <span className="dashboard-panel-index" aria-hidden="true">
                06
              </span>
            </div>
            {activityLoading && (
              <p className="dashboard-empty-note" role="status">
                Cargando movimientos…
              </p>
            )}
            {(expenseActivityError || incomeActivityError) && (
              <div className="dashboard-activity-errors" role="status">
                {expenseActivityError && <p>{expenseActivityError}</p>}
                {incomeActivityError && <p>{incomeActivityError}</p>}
                {(expenses !== null || incomes !== null) && (
                  <p>
                    La lista puede estar incompleta; no se sustituyeron los
                    datos fallidos por cero.
                  </p>
                )}
              </div>
            )}
            {!activityLoading && activity.length === 0 ? (
              expenseActivityError && incomeActivityError ? null : (
                <p className="dashboard-empty-note">
                  {expenses !== null && incomes !== null
                    ? "No hay movimientos en este período."
                    : "No hay movimientos disponibles para mostrar."}
                </p>
              )
            ) : (
              <div className="dashboard-activity-list">
                {activity.map((item) => (
                  <button
                    className="dashboard-activity-row"
                    key={`${item.kind}-${item.id}`}
                    type="button"
                    onClick={() =>
                      item.kind === "expense"
                        ? onOpenExpenses(currentRange)
                        : onOpenIncomes(currentRange)
                    }
                    aria-label={`${item.kind === "expense" ? "Abrir gastos" : "Abrir ingresos"}: ${item.title}, ${money(item.amount)}, ${displayDate(item.date)}`}
                  >
                    <span
                      className={`dashboard-activity-kind is-${item.kind}`}
                      aria-hidden="true"
                    >
                      {item.kind === "expense" ? "−" : "+"}
                    </span>
                    <span className="dashboard-activity-copy">
                      <strong>{item.title}</strong>
                      <small>
                        {item.detail} · {displayDate(item.date)}
                      </small>
                    </span>
                    <strong
                      className={`dashboard-activity-amount is-${item.kind}`}
                    >
                      {item.kind === "expense" ? "−" : "+"}
                      {money(item.amount)}
                    </strong>
                  </button>
                ))}
              </div>
            )}
            <div className="dashboard-activity-actions">
              <button
                className="dashboard-text-action"
                type="button"
                onClick={() => onOpenExpenses(currentRange)}
              >
                Ver gastos <span aria-hidden="true">→</span>
              </button>
              <button
                className="dashboard-text-action"
                type="button"
                onClick={() => onOpenIncomes(currentRange)}
              >
                Ver ingresos <span aria-hidden="true">→</span>
              </button>
            </div>
          </article>
        </div>
      )}
    </section>
  );
}

export default FinancialDashboard;
