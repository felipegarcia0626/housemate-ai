"use client";

import { FormEvent, startTransition, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { HierarchicalCategory } from "@/modules/categories/category.types";
import { createSupabaseBrowserClient } from "@/infrastructure/auth/supabase-browser.client";
import { LoginForm } from "@/components/auth/login-form";
import { OnboardingForm } from "@/components/auth/onboarding-form";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { createHouseholdRequest } from "@/components/household/household-client";

type Section = "dashboard" | "expenses" | "incomes" | "balance" | "agent";
type ResourceKey =
  | "dashboard"
  | "expenses"
  | "incomes"
  | "categories"
  | "expenseCategories"
  | "incomeCategories"
  | "members"
  | "sharingRules"
  | "balance";

type Expense = {
  id: string;
  merchant: string | null;
  description: string | null;
  totalAmount: number;
  expenseDate: string;
  status?: string;
  category: {
    id: string;
    name: string;
    parentId?: string | null;
    parentName?: string | null;
  } | null;
  paidBy?: { memberId: string; name: string } | null;
  distributions?: {
    memberId: string;
    memberName: string;
    percentage: number;
    amount: number;
  }[];
};
type ExpenseDetail = Expense & {
  paidByMemberId: string;
  splits?: { memberId: string; percentage: number }[];
};
type ExpensePageSize = 25 | 50 | 100;
type ExpenseCollection = {
  data: Expense[];
  pagination: {
    page: number;
    pageSize: ExpensePageSize;
    total: number;
    totalPages: number;
  };
  summary: {
    totalCount: number;
    totalAmount: number;
  };
};

type Income = {
  id: string;
  memberId: string;
  amount: number;
  incomeDate: string;
  description: string;
  categoryId: string | null;
};
type IncomePageSize = 25 | 50 | 100;
type IncomeListSort = "incomeDate" | "amount" | "description";
type IncomeCollection = {
  data: Income[];
  pagination: {
    page: number;
    pageSize: IncomePageSize;
    total: number;
    totalPages: number;
  };
  summary: {
    totalIncome: number;
  };
};

type Category = { id: string; name: string };
type HouseholdMember = { id: string; displayName: string };
type ExpenseSplitDraft = { memberId: string; percentage: number | string };
type SelectableHousehold = { householdId: string; householdName: string; selected?: boolean };
type SharingRule = {
  id: string;
  name: string;
  splits: { memberId: string; percentage: number }[];
};
type Dashboard = {
  totalIncome: number;
  totalSpent: number;
  netAmount: number;
  expenseCount: number;
  memberIncome: { memberId: string; amount: number }[];
  byCategory: {
    categoryId: string | null;
    categoryName: string | null;
    amount: number;
  }[];
};
type Balance = {
  members: { memberId: string; paid: number; share: number; balance: number }[];
};
type AgentResult = {
  type?: string;
  message?: string;
  operation?: string;
  operationType?: "CREATE_EXPENSE" | "CREATE_INCOME";
  status?: string;
  proposalId?: string;
  data?: unknown;
  payload?: {
    expense?: {
      merchant?: string | null;
      description?: string | null;
      totalAmount?: number;
      expenseDate?: string;
      paidByMemberId?: string;
      categoryId?: string | null;
      categoryPath?: string | null;
    };
    income?: {
      memberId?: string;
      amount?: number;
      incomeDate?: string;
      description?: string;
      categoryId?: string | null;
      categoryPath?: string | null;
    };
  };
};

const agentSuggestions = [
  "¿Cuánto gastamos este mes?",
  "¿Cuál es el balance entre nosotros?",
  "¿Cuánto gastamos en alimentación?",
] as const;

const initialExpense = {
  merchant: "",
  description: "",
  totalAmount: "",
  expenseDate: new Date().toISOString().slice(0, 10),
  paidByMemberId: "",
  categoryId: "",
  splits: [] as ExpenseSplitDraft[],
};
const initialIncome = {
  memberId: "",
  amount: "",
  incomeDate: new Date().toISOString().slice(0, 10),
  description: "",
  categoryId: "",
};
const initialExpenseEdit = {
  merchant: "",
  description: "",
  totalAmount: "",
  expenseDate: "",
  categoryId: "",
  paidByMemberId: "",
  splits: [] as ExpenseSplitDraft[],
};
const initialIncomeEdit = {
  memberId: "",
  amount: "",
  incomeDate: "",
  description: "",
  categoryId: "",
};

type JsonResponseObserver = (response: {
  status: number;
  ok: boolean;
  body: unknown;
}) => void;

function percentageBasisPoints(value: unknown): bigint | null {
  const text = typeof value === "number" ? String(value) : String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const basisPoints = BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0"));
  return basisPoints <= BigInt(10000) ? basisPoints : null;
}

function splitTotalMessage(
  splits: readonly ExpenseSplitDraft[],
): string {
  const total = splits.reduce(
    (sum, split) => sum + (percentageBasisPoints(split.percentage) ?? BigInt(0)),
    BigInt(0),
  );
  if (total === BigInt(10000)) return "Total: 100.00% ✓";
  const difference = total > BigInt(10000) ? total - BigInt(10000) : BigInt(10000) - total;
  const amount = `${difference / BigInt(100)}.${String(difference % BigInt(100)).padStart(2, "0")}`;
  return total > BigInt(10000)
    ? `Total: ${Number(total) / 100}% — Hay ${amount}% de más`
    : `Total: ${Number(total) / 100}% — Faltan ${amount}%`;
}

function normalizeExpenseSplits(splits: readonly ExpenseSplitDraft[]) {
  return splits.map((split) => ({
    memberId: split.memberId,
    percentage: Number(split.percentage),
  }));
}

function equalSplits(memberIds: readonly string[]): { memberId: string; percentage: number }[] {
  if (memberIds.length === 0) return [];
  const base = Math.floor(10000 / memberIds.length);
  const remainder = 10000 - base * memberIds.length;
  const bonusIds = [...memberIds].sort((left, right) => left.localeCompare(right));
  const bonuses = new Set(bonusIds.slice(0, remainder));
  return memberIds.map((memberId) => ({
    memberId,
    percentage: (base + (bonuses.has(memberId) ? 1 : 0)) / 100,
  }));
}

function logExpenseEditDiagnostic(
  label: string,
  payload: Record<string, unknown>,
): void {
  if (process.env.NODE_ENV !== "development") return;
  try {
    console.info(label, payload);
  } catch {
    // Diagnostic logging must never alter the application flow.
  }
}

function summarizeExpenseEditPayload(payload: {
  merchant: string | null;
  description: string | null;
  totalAmount: number;
  categoryId: string | null;
  paidByMemberId: string;
  splits?: { memberId: string; percentage: number }[];
}): Record<string, unknown> {
  return {
    fields: Object.keys(payload),
    merchantPresent: payload.merchant !== null,
    descriptionPresent: payload.description !== null,
    totalAmountPresent: payload.totalAmount !== null,
    totalAmountType: typeof payload.totalAmount,
    totalAmountFinite:
      typeof payload.totalAmount === "number" &&
      Number.isFinite(payload.totalAmount),
    categoryIdPresent: payload.categoryId !== null,
    paidByMemberIdPresent: Boolean(payload.paidByMemberId),
    splitsCount: payload.splits?.length ?? 0,
    splitPercentagesValid:
      payload.splits?.every(
        (split) =>
          typeof split.percentage === "number" &&
          Number.isFinite(split.percentage),
      ) ?? true,
  };
}

function diagnosticMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/[\r\n]+/g, " ")
    .replace(
      /\b(?:bearer|token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
      "<redacted-secret>",
    )
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
      "<id>",
    )
    .trim();
  return normalized ? normalized.slice(0, 200) : undefined;
}

function summarizeExpenseEditResponse(
  body: unknown,
  targetExpenseId?: string | null,
): Record<string, unknown> {
  if (!body || typeof body !== "object")
    return { bodyType: typeof body };

  const record = body as {
    data?: unknown;
    error?: { code?: unknown; message?: unknown };
  };
  const error = record.error;
  const data = record.data;
  const items = Array.isArray(data) ? data : null;
  const matchingItem = items?.find(
    (item) =>
      item &&
      typeof item === "object" &&
      (item as { id?: unknown }).id === targetExpenseId,
  );
  const item =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : matchingItem && typeof matchingItem === "object"
        ? (matchingItem as Record<string, unknown>)
        : null;
  const category =
    item?.category && typeof item.category === "object"
      ? (item.category as { id?: unknown })
      : null;

  return {
    bodyKind: items ? "array" : item ? "object" : typeof data,
    errorCode:
      typeof error?.code === "string" ? diagnosticMessage(error.code) : undefined,
    errorMessage: diagnosticMessage(error?.message),
    dataCount: items?.length,
    targetExpenseFound: Boolean(
      item && typeof item.id === "string" && item.id === targetExpenseId,
    ),
    expenseIdPresent: typeof item?.id === "string",
    totalAmountPresent: typeof item?.totalAmount === "number",
    merchantPresent: typeof item?.merchant === "string" || item?.merchant === null,
    descriptionPresent:
      typeof item?.description === "string" || item?.description === null,
    categoryIdPresent: typeof category?.id === "string" || category?.id === null,
    paidByMemberIdPresent: typeof item?.paidByMemberId === "string",
  };
}

function createExpenseEditResponseObserver({
  expenseId,
  method,
  url,
}: {
  expenseId: string;
  method: "GET" | "PATCH";
  url?: string;
}): JsonResponseObserver {
  return ({ status, ok, body }) => {
    const errorCode =
      body && typeof body === "object" && "error" in body
        ? (body as { error?: { code?: unknown } }).error?.code
        : undefined;
    const updatedNotHydrated =
      status === 202 && errorCode === "UPDATED_NOT_HYDRATED";
    logExpenseEditDiagnostic(`[ExpenseEdit] ${method} response`, {
      expenseId,
      method,
      ...(url ? { url } : {}),
      status,
      ok,
      result: updatedNotHydrated ? "uncertain" : ok ? "success" : "failure",
      response: summarizeExpenseEditResponse(body, expenseId),
    });
  };
}

async function requestJson<T>(
  path: string,
  options?: RequestInit,
  observe?: JsonResponseObserver,
): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  try {
    observe?.({ status: response.status, ok: response.ok, body });
  } catch {
    // Diagnostic observers must never alter the request outcome.
  }
  const errorPayload =
    body && typeof body === "object" && "error" in body
      ? (body as { error?: { code?: unknown; message?: unknown } }).error
      : undefined;
  const updatedNotHydrated =
    response.status === 202 && errorPayload?.code === "UPDATED_NOT_HYDRATED";
  if (!response.ok || updatedNotHydrated) {
    const error = new Error(
      typeof errorPayload?.message === "string"
        ? errorPayload.message
        : "No fue posible completar la operación.",
    ) as Error & { code?: string; status?: number };
    if (typeof errorPayload?.code === "string")
      error.code = errorPayload.code;
    error.status = response.status;
    throw error;
  }
  return body as T;
}

function isUpdatedNotHydratedError(cause: unknown): boolean {
  return (
    cause !== null &&
    typeof cause === "object" &&
    "code" in cause &&
    (cause as { code?: unknown }).code === "UPDATED_NOT_HYDRATED"
  );
}

async function api<T>(
  path: string,
  options?: RequestInit,
  observe?: JsonResponseObserver,
): Promise<T> {
  const body = await requestJson<{ data?: T }>(path, options, observe);
  return body.data as T;
}

function money(value: number): string {
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 2,
  }).format(value);
}

function humanDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function formatExpenseDateForTable(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
}

function formatExpenseDateForDisplay(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  return match ? `${match[3]}/${match[2]}/${match[1]}` : value;
}

function parseExpenseDateForApi(value: string): string | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const daysInMonth = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];

  if (
    !Number.isInteger(day) ||
    !Number.isInteger(month) ||
    !Number.isInteger(year) ||
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1]
  ) {
    return null;
  }

  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function percentage(value: number): string {
  return `${new Intl.NumberFormat("es-CO", {
    maximumFractionDigits: 2,
  }).format(value)}%`;
}

function EditIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z" />
      <path d="m14.5 7.5 2 2" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 7h16M10 11v5M14 11v5M6 7l1 13h10l1-13M9 7V4h6v3" />
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 6h16M7 12h10M10 18h4" />
    </svg>
  );
}

function SortIcon({
  direction,
  active,
}: {
  direction: "asc" | "desc";
  active: boolean;
}) {
  return (
    <svg
      aria-hidden="true"
      className={active ? "sort-icon is-active" : "sort-icon"}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d={direction === "asc" ? "m7 15 5-5 5 5" : "m7 9 5 5 5-5"} />
    </svg>
  );
}

function formatDistribution(distributions?: Expense["distributions"]): string {
  if (!distributions || distributions.length === 0) return "—";
  return distributions
    .map(({ percentage: share, memberName }) => `${percentage(share)} ${memberName}`)
    .join(" · ");
}

function formatExpenseSplitRule(
  splits?: { percentage: number }[],
): string {
  if (!splits || splits.length === 0) return "—";
  const percentages = splits.slice(0, 2).map(({ percentage: share }) => share);
  if (percentages.length === 1) return `${percentages[0]}/0`;
  return percentages.join("/");
}

function splitSignature(
  splits: readonly { memberId: string; percentage: number }[],
): string {
  return [...splits]
    .sort((left, right) => left.memberId.localeCompare(right.memberId))
    .map(({ memberId, percentage: share }) => `${memberId}:${share}`)
    .join("|");
}

function sharingRuleMatchesSplits(
  ruleSplits: readonly { memberId: string; percentage: number }[],
  expenseSplits: readonly { memberId: string; percentage: number }[],
): boolean {
  if (splitSignature(ruleSplits) === splitSignature(expenseSplits)) return true;
  if (expenseSplits.length !== 1 || expenseSplits[0].percentage !== 100) {
    return false;
  }
  return (
    ruleSplits.length === 2 &&
    ruleSplits.some(
      (split) =>
        split.memberId === expenseSplits[0].memberId &&
        split.percentage === 100,
    ) &&
    ruleSplits.some(
      (split) =>
        split.memberId !== expenseSplits[0].memberId &&
        split.percentage === 0,
    )
  );
}

function findSharingRuleForSplits(
  rules: readonly SharingRule[],
  expenseSplits: readonly { memberId: string; percentage: number }[],
): SharingRule | undefined {
  return rules.find((rule) =>
    sharingRuleMatchesSplits(rule.splits, expenseSplits),
  );
}

function paginationItems(current: number, total: number): (number | "ellipsis")[] {
  if (total <= 1) return [1];
  const items: (number | "ellipsis")[] = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  if (start > 2) items.push("ellipsis");
  for (let page = start; page <= end; page += 1) items.push(page);
  if (end < total - 1) items.push("ellipsis");
  items.push(total);
  return items;
}

function HomePageContent() {
  const searchParams = useSearchParams();
  const [supabase] = useState<SupabaseClient | null>(() =>
    typeof window === "undefined" ? null : createSupabaseBrowserClient(),
  );
  const [authReady, setAuthReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [authError, setAuthError] = useState(() =>
    typeof window !== "undefined" &&
    window.location.search.includes("authError=oauth_callback")
      ? "No fue posible completar el inicio de sesión con Google. Intenta nuevamente."
      : "",
  );
  const [section, setSection] = useState<Section>(() => {
    if (typeof window === "undefined") return "dashboard";
    const value = new URLSearchParams(window.location.search).get("section");
    return value === "dashboard" || value === "expenses" || value === "incomes" || value === "balance" || value === "agent"
      ? value
      : "dashboard";
  });
  const consumedSectionParam = useRef<string | null>(null);
  useEffect(() => {
    const value = searchParams.get("section");
    if (value === null) return;
    if (consumedSectionParam.current === value) return;
    consumedSectionParam.current = value;
    const nextSection = value === "dashboard" || value === "expenses" || value === "incomes" || value === "balance" || value === "agent" ? value : "dashboard";
    if (nextSection !== section) startTransition(() => setSection(nextSection));
    const url = new URL(window.location.href);
    url.searchParams.delete("section");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }, [searchParams, section]);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [expenseListPagination, setExpenseListPagination] =
    useState<ExpenseCollection["pagination"]>({
      page: 1,
      pageSize: 25,
      total: 0,
      totalPages: 0,
    });
  const [expenseListSummary, setExpenseListSummary] =
    useState<ExpenseCollection["summary"]>({
      totalCount: 0,
      totalAmount: 0,
    });
  const [expenseListSearch, setExpenseListSearch] = useState("");
  const [expenseListFrom, setExpenseListFrom] = useState("");
  const [expenseListTo, setExpenseListTo] = useState("");
  const [expenseListMacroId, setExpenseListMacroId] = useState("");
  const [expenseListMicroId, setExpenseListMicroId] = useState("");
  const [expenseListMinAmount, setExpenseListMinAmount] = useState("");
  const [expenseListMaxAmount, setExpenseListMaxAmount] = useState("");
  const [expenseFiltersOpen, setExpenseFiltersOpen] = useState(false);
  const [expenseFilterDraft, setExpenseFilterDraft] = useState({
    minAmount: "",
    maxAmount: "",
  });
  const [expenseHeaderFilterOpen, setExpenseHeaderFilterOpen] = useState<
    "macro" | "micro" | null
  >(null);
  const [expenseMacroFilterQuery, setExpenseMacroFilterQuery] = useState("");
  const [expenseMicroFilterQuery, setExpenseMicroFilterQuery] = useState("");
  const [expenseListPage, setExpenseListPage] = useState(1);
  const [expenseListPageSize, setExpenseListPageSize] =
    useState<ExpensePageSize>(25);
  const [expenseListSort, setExpenseListSort] = useState<
    "date" | "amount" | "merchant"
  >("date");
  const [expenseListSortDirection, setExpenseListSortDirection] = useState<
    "asc" | "desc"
  >("desc");
  const [expenseListLoading, setExpenseListLoading] = useState(false);
  const [expenseListError, setExpenseListError] = useState("");
  const [expenseListReady, setExpenseListReady] = useState(false);
  const [expenseListRefreshToken, setExpenseListRefreshToken] = useState(0);
  const [showExpenseForm, setShowExpenseForm] = useState(false);
  const [incomes, setIncomes] = useState<Income[]>([]);
  const [showIncomeForm, setShowIncomeForm] = useState(false);
  const [incomeListPagination, setIncomeListPagination] =
    useState<IncomeCollection["pagination"]>({
      page: 1,
      pageSize: 25,
      total: 0,
      totalPages: 0,
    });
  const [incomeListSummary, setIncomeListSummary] =
    useState<IncomeCollection["summary"]>({ totalIncome: 0 });
  const [incomeListSearch, setIncomeListSearch] = useState("");
  const [incomeListFrom, setIncomeListFrom] = useState("");
  const [incomeListTo, setIncomeListTo] = useState("");
  const [incomeListMemberId, setIncomeListMemberId] = useState("");
  const [incomeListMacroId, setIncomeListMacroId] = useState("");
  const [incomeListMicroId, setIncomeListMicroId] = useState("");
  const [incomeListMinAmount, setIncomeListMinAmount] = useState("");
  const [incomeListMaxAmount, setIncomeListMaxAmount] = useState("");
  const [incomeFiltersOpen, setIncomeFiltersOpen] = useState(false);
  const [incomeFilterDraft, setIncomeFilterDraft] = useState({
    minAmount: "",
    maxAmount: "",
  });
  const [incomeHeaderFilterOpen, setIncomeHeaderFilterOpen] = useState<
    "macro" | "micro" | "member" | null
  >(null);
  const [incomeMacroFilterQuery, setIncomeMacroFilterQuery] = useState("");
  const [incomeMicroFilterQuery, setIncomeMicroFilterQuery] = useState("");
  const [incomeMemberFilterQuery, setIncomeMemberFilterQuery] = useState("");
  const [incomeListPage, setIncomeListPage] = useState(1);
  const [incomeListPageSize, setIncomeListPageSize] =
    useState<IncomePageSize>(25);
  const [incomeListSort, setIncomeListSort] =
    useState<IncomeListSort>("incomeDate");
  const [incomeListSortOrder, setIncomeListSortOrder] = useState<
    "asc" | "desc"
  >("desc");
  const [incomeListLoading, setIncomeListLoading] = useState(false);
  const [incomeListError, setIncomeListError] = useState("");
  const [incomeListReady, setIncomeListReady] = useState(false);
  const [incomeListRefreshToken, setIncomeListRefreshToken] = useState(0);
  const [categories, setCategories] = useState<Category[]>([]);
  const [expenseCategories, setExpenseCategories] = useState<
    HierarchicalCategory[]
  >([]);
  const [incomeCategories, setIncomeCategories] = useState<
    HierarchicalCategory[]
  >([]);
  const [members, setMembers] = useState<HouseholdMember[]>([]);
  const [rules, setRules] = useState<SharingRule[]>([]);
  const [expenseForm, setExpenseForm] = useState(initialExpense);
  const [incomeForm, setIncomeForm] = useState(initialIncome);
  const [agentMessage, setAgentMessage] = useState("");
  const [agentResult, setAgentResult] = useState<AgentResult | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentError, setAgentError] = useState("");
  const [editingExpense, setEditingExpense] = useState<string | null>(null);
  const expenseEditTargetId = useRef<string | null>(null);
  const [editExpenseForm, setEditExpenseForm] = useState(initialExpenseEdit);
  const [expenseMacroId, setExpenseMacroId] = useState("");
  const [editExpenseMacroId, setEditExpenseMacroId] = useState("");
  const [editExpenseLegacyCategoryName, setEditExpenseLegacyCategoryName] =
    useState<string | null>(null);
  const [incomeMacroId, setIncomeMacroId] = useState("");
  const [editingIncome, setEditingIncome] = useState<string | null>(null);
  const [editIncomeForm, setEditIncomeForm] = useState(initialIncomeEdit);
  const [editIncomeMacroId, setEditIncomeMacroId] = useState("");
  const [editIncomeLegacyCategoryName, setEditIncomeLegacyCategoryName] =
    useState<string | null>(null);
  const [editLoading, setEditLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [expenseFormError, setExpenseFormError] = useState("");
  const [editExpenseFormError, setEditExpenseFormError] = useState("");
  const [authBoundaryError, setAuthBoundaryError] = useState("");
  const [householdOptions, setHouseholdOptions] = useState<SelectableHousehold[]>([]);
  const [householdOptionsLoading, setHouseholdOptionsLoading] = useState(false);
  const [householdSelectionBusy, setHouseholdSelectionBusy] = useState(false);
  const [householdSelectionError, setHouseholdSelectionError] = useState("");
  const [householdSelectionRequired, setHouseholdSelectionRequired] = useState(false);
  const [householdCreateOpen, setHouseholdCreateOpen] = useState(false);
  const [householdModuleOpen, setHouseholdModuleOpen] = useState(false);
  const [householdCreateName, setHouseholdCreateName] = useState("");
  const [householdCreateError, setHouseholdCreateError] = useState("");
  const [onboardingRequired, setOnboardingRequired] = useState(false);
  const householdGeneration = useRef(0);
  const preparedAuthUserId = useRef<string | null>(null);

  function invalidateHouseholdOperations(): number {
    householdGeneration.current += 1;
    return householdGeneration.current;
  }

  function clearHouseholdData(): void {
    setDashboard(null);
    setBalance(null);
    setExpenses([]);
    setIncomes([]);
    setCategories([]);
    setExpenseCategories([]);
    setIncomeCategories([]);
    setMembers([]);
    setRules([]);
    setAgentResult(null);
    setAgentMessage("");
    setAgentError("");
    setBusy(false);
    setEditLoading(false);
    setAgentBusy(false);
    setEditingExpense(null);
    setEditingIncome(null);
    setEditExpenseForm(initialExpenseEdit);
    setEditIncomeForm(initialIncomeEdit);
    setExpenseListPagination({ page: 1, pageSize: 25, total: 0, totalPages: 0 });
    setExpenseListSummary({ totalCount: 0, totalAmount: 0 });
    setIncomeListPagination({ page: 1, pageSize: 25, total: 0, totalPages: 0 });
    setIncomeListSummary({ totalIncome: 0 });
    setExpenseListSearch("");
    setExpenseListFrom("");
    setExpenseListTo("");
    setExpenseListMacroId("");
    setExpenseListMicroId("");
    setExpenseListMinAmount("");
    setExpenseListMaxAmount("");
    setIncomeListSearch("");
    setIncomeListFrom("");
    setIncomeListTo("");
    setIncomeListMemberId("");
    setIncomeListMacroId("");
    setIncomeListMicroId("");
    setIncomeListMinAmount("");
    setIncomeListMaxAmount("");
    setExpenseListPage(1);
    setIncomeListPage(1);
    setExpenseListReady(false);
    setIncomeListReady(false);
  }

  async function loadHouseholdOptions(generation = householdGeneration.current): Promise<void> {
    if (generation !== householdGeneration.current) return;
    setHouseholdOptionsLoading(true);
    setHouseholdSelectionError("");
    try {
      const options = await api<SelectableHousehold[]>("/api/auth/households");
      if (generation !== householdGeneration.current) return;
      setHouseholdOptions(options);
    } catch {
      if (generation !== householdGeneration.current) return;
      setHouseholdSelectionError("No fue posible cargar tus hogares.");
    } finally {
      if (generation === householdGeneration.current) setHouseholdOptionsLoading(false);
    }
  }

  useEffect(() => {
    if (typeof window !== "undefined" && window.location.search.includes("authError=oauth_callback")) {
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);
  const [resourceErrors, setResourceErrors] = useState<
    Partial<Record<ResourceKey, string>>
  >({});

  const memberIds = useMemo(() => {
    const ids = new Set(members.map((member) => member.id));
    rules.forEach((rule) =>
      rule.splits.forEach((split) => ids.add(split.memberId)),
    );
    return [...ids];
  }, [members, rules]);

  const memberNames = useMemo(
    () =>
      Object.fromEntries(
        members.map((member) => [member.id, member.displayName]),
      ) as Record<string, string>,
    [members],
  );

  const expenseMacros = useMemo(() => {
    const macros = new Map<string, { id: string; name: string }>();
    expenseCategories.forEach((category) => {
      macros.set(category.macroId, {
        id: category.macroId,
        name: category.macroName,
      });
    });
    return [...macros.values()].sort((left, right) =>
      left.name.localeCompare(right.name, "es"),
    );
  }, [expenseCategories]);

  const expenseMicros = useMemo(
    () =>
      expenseCategories.filter(
        (category) => category.macroId === expenseMacroId,
      ),
    [expenseCategories, expenseMacroId],
  );

  const expenseFilterMacros = useMemo(
    () =>
      expenseMacros.filter((macro) =>
        macro.name.toLocaleLowerCase("es").includes(
          expenseMacroFilterQuery.trim().toLocaleLowerCase("es"),
        ),
      ),
    [expenseMacroFilterQuery, expenseMacros],
  );

  const expenseFilterMicros = useMemo(
    () =>
      expenseCategories.filter(
        (category) =>
          (!expenseListMacroId || category.macroId === expenseListMacroId) &&
          category.name
            .toLocaleLowerCase("es")
            .includes(expenseMicroFilterQuery.trim().toLocaleLowerCase("es")),
      ),
    [expenseCategories, expenseListMacroId, expenseMicroFilterQuery],
  );

  const editExpenseMicros = useMemo(
    () =>
      expenseCategories.filter(
        (category) => category.macroId === editExpenseMacroId,
      ),
    [editExpenseMacroId, expenseCategories],
  );

  const incomeMacros = useMemo(() => {
    const macros = new Map<string, { id: string; name: string }>();
    incomeCategories.forEach((category) => {
      macros.set(category.macroId, {
        id: category.macroId,
        name: category.macroName,
      });
    });
    return [...macros.values()].sort((left, right) =>
      left.name.localeCompare(right.name, "es"),
    );
  }, [incomeCategories]);

  const incomeMicros = useMemo(
    () =>
      incomeCategories.filter(
        (category) => category.macroId === incomeMacroId,
      ),
    [incomeCategories, incomeMacroId],
  );

  const incomeFilterMicros = useMemo(
    () =>
      incomeCategories.filter(
        (category) =>
          (!incomeListMacroId || category.macroId === incomeListMacroId) &&
          category.name
            .toLocaleLowerCase("es")
            .includes(incomeMicroFilterQuery.trim().toLocaleLowerCase("es")),
      ),
    [incomeCategories, incomeListMacroId, incomeMicroFilterQuery],
  );

  const incomeFilterMacros = useMemo(
    () =>
      incomeMacros.filter((macro) =>
        macro.name
          .toLocaleLowerCase("es")
          .includes(incomeMacroFilterQuery.trim().toLocaleLowerCase("es")),
      ),
    [incomeMacroFilterQuery, incomeMacros],
  );

  const incomeFilterMembers = useMemo(
    () =>
      members.filter((member) =>
        member.displayName
          .toLocaleLowerCase("es")
          .includes(incomeMemberFilterQuery.trim().toLocaleLowerCase("es")),
      ),
    [incomeMemberFilterQuery, members],
  );

  const editIncomeMicros = useMemo(
    () =>
      incomeCategories.filter(
        (category) => category.macroId === editIncomeMacroId,
      ),
    [editIncomeMacroId, incomeCategories],
  );

  function expenseCategoryLabel(
    category: Expense["category"],
  ): string {
    if (category === null) return "Sin categoría";
    const hierarchicalCategory = expenseCategories.find(
      (candidate) => candidate.id === category.id,
    );
    return hierarchicalCategory
      ? `${hierarchicalCategory.macroName} → ${hierarchicalCategory.name}`
      : category.name;
  }

  function expenseCategoryParts(category: Expense["category"]): {
    macro: string;
    micro: string;
  } {
    if (category === null)
      return { macro: "Sin macro", micro: "Sin categoría" };
    const hierarchicalCategory = expenseCategories.find(
      (candidate) => candidate.id === category.id,
    );
    return {
      macro:
        category.parentName ?? hierarchicalCategory?.macroName ?? "Sin macro",
      micro: category.name,
    };
  }

  function incomeCategoryLabel(categoryId: string | null): string {
    if (!categoryId) return "Sin categoría";
    const hierarchicalCategory = incomeCategories.find(
      (category) => category.id === categoryId,
    );
    if (hierarchicalCategory)
      return `${hierarchicalCategory.macroName} → ${hierarchicalCategory.name}`;
    return categories.find((category) => category.id === categoryId)?.name ??
      "Sin categoría";
  }

  function incomeCategoryParts(categoryId: string | null): {
    macro: string;
    micro: string;
  } {
    if (!categoryId) return { macro: "Sin macro", micro: "Sin categoría" };
    const hierarchicalCategory = incomeCategories.find(
      (category) => category.id === categoryId,
    );
    if (hierarchicalCategory) {
      return {
        macro: hierarchicalCategory.macroName,
        micro: hierarchicalCategory.name,
      };
    }
    return {
      macro: "Sin macro",
      micro:
        categories.find((category) => category.id === categoryId)?.name ??
        "Sin categoría",
    };
  }

  const topCategory = useMemo(() => {
    if (!dashboard || dashboard.byCategory.length === 0) return null;
    return dashboard.byCategory.reduce((top, current) =>
      current.amount > top.amount ? current : top,
    );
  }, [dashboard]);
  const activeHousehold = householdOptions.find((household) => household.selected)
    ?? (householdOptions.length === 1 ? householdOptions[0] : undefined);

  const maxCategoryAmount = useMemo(
    () =>
      Math.max(1, ...(dashboard?.byCategory.map((item) => item.amount) ?? [])),
    [dashboard],
  );

  const expenseFilterCount = [
    expenseListFrom,
    expenseListTo,
    expenseListMacroId,
    expenseListMicroId,
    expenseListMinAmount,
    expenseListMaxAmount,
  ].filter(Boolean).length;
  const expenseHasActiveFilters =
    expenseListSearch.trim().length > 0 || expenseFilterCount > 0;

  const incomeHasActiveFilters = Boolean(
    incomeListSearch.trim() ||
      incomeListFrom ||
      incomeListTo ||
      incomeListMemberId ||
      incomeListMacroId ||
      incomeListMicroId ||
      incomeListMinAmount ||
      incomeListMaxAmount,
  );

  function memberLabel(memberId: string): string {
    return memberNames[memberId] ?? memberId;
  }

  function openExpenseFilters(): void {
    setExpenseFilterDraft({
      minAmount: expenseListMinAmount,
      maxAmount: expenseListMaxAmount,
    });
    setExpenseFiltersOpen(true);
  }

  function applyExpenseFilters(): void {
    setExpenseListMinAmount(expenseFilterDraft.minAmount);
    setExpenseListMaxAmount(expenseFilterDraft.maxAmount);
    setExpenseListPage(1);
    setExpenseFiltersOpen(false);
  }

  function clearExpenseFilters(): void {
    const emptyFilters = {
      minAmount: "",
      maxAmount: "",
    };
    setExpenseFilterDraft(emptyFilters);
    setExpenseListSearch("");
    setExpenseListFrom("");
    setExpenseListTo("");
    setExpenseListMacroId("");
    setExpenseListMicroId("");
    setExpenseListMinAmount("");
    setExpenseListMaxAmount("");
    setExpenseListPage(1);
    setExpenseFiltersOpen(false);
    setExpenseHeaderFilterOpen(null);
    setExpenseMacroFilterQuery("");
    setExpenseMicroFilterQuery("");
  }

  function selectExpenseMacroFilter(macroId: string): void {
    setExpenseListMacroId(macroId);
    if (
      expenseListMicroId &&
      macroId &&
      !expenseCategories.some(
        (category) =>
          category.id === expenseListMicroId && category.macroId === macroId,
      )
    ) {
      setExpenseListMicroId("");
    }
    setExpenseListPage(1);
    setExpenseHeaderFilterOpen(null);
    setExpenseMacroFilterQuery("");
  }

  function selectExpenseMicroFilter(microId: string): void {
    setExpenseListMicroId(microId);
    setExpenseListPage(1);
    setExpenseHeaderFilterOpen(null);
    setExpenseMicroFilterQuery("");
  }

  function toggleExpenseSort(sort: "date" | "amount" | "merchant"): void {
    if (expenseListSort === sort) {
      setExpenseListSortDirection((direction) =>
        direction === "asc" ? "desc" : "asc",
      );
    } else {
      setExpenseListSort(sort);
      setExpenseListSortDirection("desc");
    }
    setExpenseListPage(1);
  }

  function clearIncomeFilters(): void {
    const emptyFilters = {
      minAmount: "",
      maxAmount: "",
    };
    setIncomeListSearch("");
    setIncomeListFrom("");
    setIncomeListTo("");
    setIncomeListMemberId("");
    setIncomeListMacroId("");
    setIncomeListMicroId("");
    setIncomeListMinAmount("");
    setIncomeListMaxAmount("");
    setIncomeListPage(1);
    setIncomeFilterDraft(emptyFilters);
    setIncomeFiltersOpen(false);
    setIncomeHeaderFilterOpen(null);
    setIncomeMacroFilterQuery("");
    setIncomeMicroFilterQuery("");
    setIncomeMemberFilterQuery("");
  }

  function openIncomeFilters(): void {
    setIncomeFilterDraft({
      minAmount: incomeListMinAmount,
      maxAmount: incomeListMaxAmount,
    });
    setIncomeFiltersOpen(true);
  }

  function applyIncomeFilters(): void {
    setIncomeListMinAmount(incomeFilterDraft.minAmount);
    setIncomeListMaxAmount(incomeFilterDraft.maxAmount);
    setIncomeListPage(1);
    setIncomeFiltersOpen(false);
  }

  function selectIncomeMacroFilter(macroId: string): void {
    setIncomeListMacroId(macroId);
    if (
      incomeListMicroId &&
      macroId &&
      !incomeCategories.some(
        (category) =>
          category.id === incomeListMicroId && category.macroId === macroId,
      )
    ) {
      setIncomeListMicroId("");
    }
    setIncomeListPage(1);
    setIncomeHeaderFilterOpen(null);
    setIncomeMacroFilterQuery("");
  }

  function selectIncomeMicroFilter(microId: string): void {
    setIncomeListMicroId(microId);
    setIncomeListPage(1);
    setIncomeHeaderFilterOpen(null);
    setIncomeMicroFilterQuery("");
  }

  function selectIncomeMemberFilter(memberId: string): void {
    setIncomeListMemberId(memberId);
    setIncomeListPage(1);
    setIncomeHeaderFilterOpen(null);
    setIncomeMemberFilterQuery("");
  }

  function toggleIncomeSort(sort: IncomeListSort): void {
    if (incomeListSort === sort) {
      setIncomeListSortOrder((direction) =>
        direction === "asc" ? "desc" : "asc",
      );
    } else {
      setIncomeListSort(sort);
      setIncomeListSortOrder("desc");
    }
    setIncomeListPage(1);
  }

  function chooseAgentSuggestion(message: string): void {
    setSection("agent");
    setAgentMessage(message);
    setAgentResult(null);
    setAgentError("");
  }

  useEffect(() => {
    if (!supabase) return;
    let mounted = true;
    void supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (!mounted) return;
      if (sessionError) setAuthError("No fue posible recuperar la sesión.");
      setSession(data.session);
      setAuthReady(true);
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!mounted) return;
      setSession(nextSession);
      setAuthReady(true);
      if (!nextSession) {
        preparedAuthUserId.current = null;
        setLoading(false);
        setExpenseListReady(false);
        setIncomeListReady(false);
        setAuthBoundaryError("");
        setOnboardingRequired(false);
      }
    });
    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [supabase]);

  async function refresh(
    householdOptionsOverride?: SelectableHousehold[],
  ) {
    if (!session || !supabase) return;
    const generation = householdGeneration.current;
    setLoading(true);
    setError("");
    setAuthBoundaryError("");
    let authRefreshAborted = false;
    try {
      const [
        dashboardResult,
        categoryResult,
        expenseCategoryResult,
        incomeCategoryResult,
        memberResult,
        ruleResult,
        balanceResult,
      ] = await Promise.allSettled([
        api<Dashboard>("/api/dashboard/summary"),
        api<Category[]>("/api/categories"),
        api<HierarchicalCategory[]>(
          "/api/categories/hierarchical?movementType=EXPENSE",
        ),
        api<HierarchicalCategory[]>(
          "/api/categories/hierarchical?movementType=INCOME",
        ),
        api<HouseholdMember[]>("/api/household-members"),
        api<SharingRule[]>("/api/sharing-rules"),
        api<Balance>("/api/balance"),
      ]);
      if (generation !== householdGeneration.current) return;
      const rejectionStatus = (
        result: PromiseSettledResult<unknown>,
      ): number | undefined =>
        result.status === "rejected" && result.reason instanceof Error
          ? (result.reason as Error & { status?: number }).status
          : undefined;
      const authFailure = [
        dashboardResult,
        memberResult,
        ruleResult,
        balanceResult,
      ].find(
        (result) => rejectionStatus(result) === 401,
      );
      if (authFailure) {
        authRefreshAborted = true;
        setSession(null);
        setAuthBoundaryError("Tu sesión ya no es válida. Inicia sesión nuevamente.");
        return;
      }
      const contextFailure = [
        dashboardResult,
        memberResult,
        ruleResult,
        balanceResult,
      ].find(
        (result) => [403, 409].includes(rejectionStatus(result) ?? 0),
      );
      if (contextFailure) {
        const status = rejectionStatus(contextFailure);
        setAuthBoundaryError(
          status === 409
            ? "Tu usuario tiene más de un hogar. La selección de hogar estará disponible próximamente."
            : "Tu usuario todavía no tiene acceso a un hogar de HouseMate AI.",
        );
        if (status === 409) {
          authRefreshAborted = true;
          setHouseholdSelectionRequired(true);
          try {
            await loadHouseholdOptions(generation);
          } catch {
            setHouseholdSelectionError("No fue posible cargar tus hogares.");
          }
          return;
        }
      }
      const nextErrors: Partial<Record<ResourceKey, string>> = {};
      const failed = (key: ResourceKey) => {
        nextErrors[key] = "No fue posible cargar esta secciÃ³n.";
      };
      if (dashboardResult.status === "fulfilled")
        setDashboard(dashboardResult.value);
      else failed("dashboard");
      if (categoryResult.status === "fulfilled")
        setCategories(categoryResult.value);
      else failed("categories");
      if (expenseCategoryResult.status === "fulfilled")
        setExpenseCategories(expenseCategoryResult.value);
      else failed("expenseCategories");
      if (incomeCategoryResult.status === "fulfilled")
        setIncomeCategories(incomeCategoryResult.value);
      else failed("incomeCategories");
      if (memberResult.status === "fulfilled") {
        setMembers(memberResult.value);
        const firstMemberId = memberResult.value[0]?.id ?? "";
        setIncomeForm((current) => ({
          ...current,
          memberId: current.memberId || firstMemberId,
        }));
        setExpenseForm((current) => ({
          ...current,
          paidByMemberId: current.paidByMemberId || firstMemberId,
          splits: current.splits.length > 0
            ? current.splits
            : equalSplits(memberResult.value.map((member) => member.id)),
        }));
      } else failed("members");
      if (ruleResult.status === "fulfilled") {
        const ruleData = ruleResult.value;
        setRules(ruleData);
        const firstMemberId = ruleData[0]?.splits[0]?.memberId ?? "";
        setIncomeForm((current) => ({
          ...current,
          memberId: current.memberId || firstMemberId,
        }));
        setExpenseForm((current) => ({
          ...current,
          paidByMemberId: current.paidByMemberId || firstMemberId,
        }));
      } else failed("sharingRules");
      if (balanceResult.status === "fulfilled") setBalance(balanceResult.value);
      else failed("balance");
      setResourceErrors(nextErrors);
      if (householdOptionsOverride) {
        if (generation === householdGeneration.current)
          setHouseholdOptions(householdOptionsOverride);
      } else {
        await loadHouseholdOptions(generation);
      }
    } catch (cause) {
      if (generation !== householdGeneration.current) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "No fue posible cargar la información.",
      );
    } finally {
      if (generation !== householdGeneration.current) return;
      setLoading(false);
      if (!authRefreshAborted) {
        setExpenseListReady(true);
        setExpenseListRefreshToken((value) => value + 1);
        setIncomeListReady(true);
        setIncomeListRefreshToken((value) => value + 1);
      }
    }
  }

  async function prepareAuthenticatedSession(): Promise<void> {
    if (!session) return;
    const generation = householdGeneration.current;
    setLoading(true);
    setAuthBoundaryError("");
    try {
      const householdOptions = await api<SelectableHousehold[]>(
        "/api/auth/households",
      );
      if (generation !== householdGeneration.current) return;
      setOnboardingRequired(false);
      setHouseholdOptions(householdOptions);
      await refresh(householdOptions);
    } catch (cause) {
      if (generation !== householdGeneration.current) return;
      const status = cause instanceof Error
        ? (cause as Error & { status?: number }).status
        : undefined;
      const code = cause instanceof Error
        ? (cause as Error & { code?: string }).code
        : undefined;
      if (status === 401 || code === "UNAUTHENTICATED") {
        setSession(null);
        setAuthError("Tu sesión ya no es válida. Inicia sesión nuevamente.");
      } else if (status === 403 && code === "APPLICATION_USER_NOT_FOUND") {
        setOnboardingRequired(true);
        setExpenseListReady(false);
        setIncomeListReady(false);
      } else {
        setError("No fue posible verificar el estado de tu cuenta.");
      }
    } finally {
      if (generation === householdGeneration.current) setLoading(false);
    }
  }

  async function completeOnboarding(): Promise<void> {
    invalidateHouseholdOperations();
    setOnboardingRequired(false);
    clearHouseholdData();
    await prepareAuthenticatedSession();
  }

  async function signOut(): Promise<void> {
    if (!supabase) return;
    invalidateHouseholdOperations();
    await fetch("/api/auth/household-selection", { method: "DELETE" }).catch(() => undefined);
    await supabase.auth.signOut();
    setSession(null);
    setAuthBoundaryError("");
    setHouseholdSelectionRequired(false);
    setHouseholdOptions([]);
  }

  async function selectHousehold(householdId: string): Promise<void> {
    const generation = invalidateHouseholdOperations();
    setHouseholdSelectionBusy(true);
    setHouseholdSelectionError("");
    try {
      await requestJson("/api/auth/household-selection", {
        method: "POST",
        body: JSON.stringify({ householdId }),
      });
      if (generation !== householdGeneration.current) return;
      setHouseholdSelectionRequired(false);
      setHouseholdOptions([]);
      setAuthBoundaryError("");
      clearHouseholdData();
      await refresh();
    } catch {
      if (generation !== householdGeneration.current) return;
      setHouseholdSelectionError("No fue posible seleccionar ese hogar.");
    } finally {
      if (generation === householdGeneration.current) setHouseholdSelectionBusy(false);
    }
  }

  async function createHousehold(): Promise<void> {
    if (householdSelectionBusy || !householdCreateName.trim()) {
      setHouseholdCreateError("Ingresa el nombre del hogar.");
      return;
    }
    const generation = invalidateHouseholdOperations();
    setHouseholdSelectionBusy(true);
    setHouseholdCreateError("");
    try {
      const created = await createHouseholdRequest(householdCreateName);
      if (generation !== householdGeneration.current) return;
      const options = await api<SelectableHousehold[]>("/api/auth/households");
      if (generation !== householdGeneration.current) return;
      setHouseholdOptions(options);
      await requestJson("/api/auth/household-selection", {
        method: "POST",
        body: JSON.stringify({ householdId: created.householdId }),
      });
      if (generation !== householdGeneration.current) return;
      setHouseholdCreateOpen(false);
      setHouseholdCreateName("");
      setHouseholdSelectionRequired(false);
      clearHouseholdData();
      await refresh(options);
    } catch {
      if (generation === householdGeneration.current) setHouseholdCreateError("No fue posible crear el hogar.");
    } finally {
      if (generation === householdGeneration.current) setHouseholdSelectionBusy(false);
    }
  }

  useEffect(() => {
    if (!authReady || !session) {
      if (!session) preparedAuthUserId.current = null;
      return;
    }
    const authUserId = session.user.id;
    if (preparedAuthUserId.current === authUserId) return;
    preparedAuthUserId.current = authUserId;
    void prepareAuthenticatedSession();
  }, [authReady, session?.user.id]);

  useEffect(() => {
    if (!expenseListReady || !session) return;
    const controller = new AbortController();
    const generation = householdGeneration.current;
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({
        page: String(expenseListPage),
        pageSize: String(expenseListPageSize),
        sort: expenseListSort,
        sortDirection: expenseListSortDirection,
      });
      if (expenseListSearch.trim())
        params.set("search", expenseListSearch.trim());
      if (expenseListFrom) params.set("from", expenseListFrom);
      if (expenseListTo) params.set("to", expenseListTo);
      if (expenseListMacroId) params.set("macroId", expenseListMacroId);
      if (expenseListMicroId) params.set("categoryId", expenseListMicroId);
      if (expenseListMinAmount) params.set("minAmount", expenseListMinAmount);
      if (expenseListMaxAmount) params.set("maxAmount", expenseListMaxAmount);

      setExpenseListLoading(true);
      setExpenseListError("");
      const expenseListUrl = `/api/expenses?${params.toString()}`;
      const diagnosticExpenseId = expenseEditTargetId.current;
      if (diagnosticExpenseId) {
        logExpenseEditDiagnostic("[ExpenseEdit] GET request", {
          expenseId: diagnosticExpenseId,
          method: "GET",
          page: expenseListPage,
          pageSize: expenseListPageSize,
          sort: expenseListSort,
          sortDirection: expenseListSortDirection,
          hasSearch: Boolean(expenseListSearch.trim()),
          hasDateFilters: Boolean(expenseListFrom || expenseListTo),
          hasCategoryFilters: Boolean(expenseListMacroId || expenseListMicroId),
          hasAmountFilters: Boolean(
            expenseListMinAmount || expenseListMaxAmount,
          ),
        });
      }
      void requestJson<ExpenseCollection>(
        expenseListUrl,
        { signal: controller.signal },
        diagnosticExpenseId
          ? (response) => {
              createExpenseEditResponseObserver({
                expenseId: diagnosticExpenseId,
                method: "GET",
              })(response);
              expenseEditTargetId.current = null;
            }
          : undefined,
      )
        .then((result) => {
          if (generation !== householdGeneration.current) return;
          const nextPage =
            result.pagination.totalPages === 0
              ? 1
              : Math.min(result.pagination.page, result.pagination.totalPages);
          setExpenses(result.data);
          setExpenseListPagination(result.pagination);
          setExpenseListSummary(result.summary);
          if (nextPage !== expenseListPage) setExpenseListPage(nextPage);
        })
        .catch((cause: unknown) => {
          if (generation !== householdGeneration.current) return;
          if (cause instanceof DOMException && cause.name === "AbortError")
            return;
          setExpenseListError(
            cause instanceof Error
              ? cause.message
              : "No fue posible cargar los gastos.",
          );
        })
        .finally(() => {
          if (!controller.signal.aborted && generation === householdGeneration.current)
            setExpenseListLoading(false);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    expenseListFrom,
    expenseListMacroId,
    expenseListMaxAmount,
    expenseListMicroId,
    expenseListMinAmount,
    expenseListPage,
    expenseListPageSize,
    expenseListReady,
    expenseListRefreshToken,
    expenseListSearch,
    expenseListSort,
    expenseListSortDirection,
    expenseListTo,
    session?.user.id,
  ]);

  useEffect(() => {
    if (!incomeListReady || !session) return;
    const controller = new AbortController();
    const generation = householdGeneration.current;
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({
        page: String(incomeListPage),
        pageSize: String(incomeListPageSize),
        sortBy: incomeListSort,
        sortOrder: incomeListSortOrder,
      });
      if (incomeListSearch.trim())
        params.set("search", incomeListSearch.trim());
      if (incomeListMemberId) params.set("memberId", incomeListMemberId);
      if (incomeListMacroId) params.set("macroId", incomeListMacroId);
      if (incomeListMicroId) params.set("categoryId", incomeListMicroId);
      if (incomeListMinAmount) params.set("minAmount", incomeListMinAmount);
      if (incomeListMaxAmount) params.set("maxAmount", incomeListMaxAmount);
      if (incomeListFrom) params.set("from", incomeListFrom);
      if (incomeListTo) params.set("to", incomeListTo);

      setIncomeListLoading(true);
      setIncomeListError("");
      void requestJson<IncomeCollection>(
        `/api/incomes?${params.toString()}`,
        { signal: controller.signal },
      )
        .then((result) => {
          if (generation !== householdGeneration.current) return;
          const nextPage =
            result.pagination.totalPages === 0
              ? 1
              : Math.min(result.pagination.page, result.pagination.totalPages);
          setIncomes(result.data);
          setIncomeListPagination(result.pagination);
          setIncomeListSummary(result.summary);
          if (nextPage !== incomeListPage) setIncomeListPage(nextPage);
        })
        .catch((cause: unknown) => {
          if (generation !== householdGeneration.current) return;
          if (cause instanceof DOMException && cause.name === "AbortError")
            return;
          setIncomeListError(
            cause instanceof Error
              ? cause.message
              : "No fue posible cargar los ingresos.",
          );
        })
        .finally(() => {
          if (!controller.signal.aborted && generation === householdGeneration.current)
            setIncomeListLoading(false);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    incomeListFrom,
    incomeListMacroId,
    incomeListMemberId,
    incomeListMaxAmount,
    incomeListMinAmount,
    incomeListMicroId,
    incomeListPage,
    incomeListPageSize,
    incomeListReady,
    incomeListRefreshToken,
    incomeListSearch,
    incomeListSort,
    incomeListSortOrder,
    incomeListTo,
    session?.user.id,
  ]);

  async function submitExpense(event: FormEvent) {
    event.preventDefault();
    if (!expenseForm.paidByMemberId) {
      setExpenseFormError("Selecciona un pagador.");
      return;
    }
    if (expenseForm.splits.length === 0 || expenseForm.splits.some((split) => percentageBasisPoints(split.percentage) === null)) {
      setExpenseFormError("Ingresa porcentajes válidos entre 0 y 100.");
      return;
    }
    if (expenseForm.splits.reduce((sum, split) => sum + (percentageBasisPoints(split.percentage) ?? BigInt(0)), BigInt(0)) !== BigInt(10000)) {
      setExpenseFormError("El reparto debe sumar exactamente 100.00%.");
      return;
    }
    setBusy(true);
    setExpenseFormError("");
    setError("");
    const generation = householdGeneration.current;
    try {
      await api<Expense>("/api/expenses", {
        method: "POST",
        body: JSON.stringify({
          merchant: expenseForm.merchant || null,
          description: expenseForm.description || null,
          totalAmount: Number(expenseForm.totalAmount),
          expenseDate: expenseForm.expenseDate,
          paidByMemberId: expenseForm.paidByMemberId,
          categoryId: expenseForm.categoryId || null,
          items: [],
          splits: normalizeExpenseSplits(expenseForm.splits),
        }),
      });
      if (generation !== householdGeneration.current) return;
      setExpenseForm(initialExpense);
      setExpenseFormError("");
      setExpenseMacroId("");
      setShowExpenseForm(false);
      await refresh();
    } catch (cause) {
      if (generation !== householdGeneration.current) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "No fue posible crear el gasto.",
      );
    } finally {
      if (generation === householdGeneration.current) setBusy(false);
    }
  }

  async function startExpenseEdit(expenseId: string) {
    const generation = householdGeneration.current;
    setEditingExpense(expenseId);
    setEditExpenseFormError("");
    setEditExpenseForm(initialExpenseEdit);
    setEditLoading(true);
    setError("");
    try {
      const expense = await api<ExpenseDetail>(`/api/expenses/${expenseId}`);
      if (generation !== householdGeneration.current) return;
      const hierarchicalCategory = expense.category
        ? expenseCategories.find(
            (category) => category.id === expense.category?.id,
          )
        : undefined;
      setEditExpenseMacroId(hierarchicalCategory?.macroId ?? "");
      setEditExpenseLegacyCategoryName(
        hierarchicalCategory || !expense.category
          ? null
          : expense.category.name,
      );
      setEditExpenseForm({
        merchant: expense.merchant ?? "",
        description: expense.description ?? "",
        totalAmount: String(expense.totalAmount),
        expenseDate: formatExpenseDateForDisplay(expense.expenseDate),
        categoryId: expense.category?.id ?? "",
        paidByMemberId: expense.paidByMemberId,
        splits: (expense.splits ?? []).map(({ memberId, percentage }) => ({
          memberId,
          percentage,
        })),
      });
    } catch (cause) {
      if (generation !== householdGeneration.current) return;
      setEditingExpense(null);
      setEditExpenseMacroId("");
      setEditExpenseLegacyCategoryName(null);
      setError(
        cause instanceof Error
          ? cause.message
          : "No fue posible cargar el gasto.",
      );
    } finally {
      if (generation === householdGeneration.current) setEditLoading(false);
    }
  }

  async function saveExpense(expenseId: string) {
    const normalizedExpenseDate = parseExpenseDateForApi(
      editExpenseForm.expenseDate,
    );
    if (!normalizedExpenseDate) {
      setError("Usa una fecha válida con el formato DD/MM/AAAA.");
      return;
    }
    if (editExpenseForm.splits.length === 0 || editExpenseForm.splits.some((split) => percentageBasisPoints(split.percentage) === null)) {
      setEditExpenseFormError("Ingresa porcentajes válidos entre 0 y 100.");
      return;
    }
    if (editExpenseForm.splits.reduce((sum, split) => sum + (percentageBasisPoints(split.percentage) ?? BigInt(0)), BigInt(0)) !== BigInt(10000)) {
      setEditExpenseFormError("El reparto debe sumar exactamente 100.00%.");
      return;
    }

    setBusy(true);
    setEditExpenseFormError("");
    setError("");
    const generation = householdGeneration.current;
    expenseEditTargetId.current = expenseId;
    try {
      const payload = {
        merchant: editExpenseForm.merchant || null,
        description: editExpenseForm.description || null,
        totalAmount: Number(editExpenseForm.totalAmount),
        expenseDate: normalizedExpenseDate,
        categoryId: editExpenseForm.categoryId || null,
        paidByMemberId: editExpenseForm.paidByMemberId,
        ...(editExpenseForm.splits.length > 0
          ? { splits: normalizeExpenseSplits(editExpenseForm.splits) }
          : {}),
      };
      const expenseEditUrl = `/api/expenses/${expenseId}`;
      logExpenseEditDiagnostic("[ExpenseEdit] PATCH request", {
        expenseId,
        method: "PATCH",
        url: expenseEditUrl,
        payload: summarizeExpenseEditPayload(payload),
      });
      await api<Expense>(expenseEditUrl, {
        method: "PATCH",
        body: JSON.stringify(payload),
      }, createExpenseEditResponseObserver({
        expenseId,
        method: "PATCH",
        url: expenseEditUrl,
      }));
      setEditingExpense(null);
      setEditExpenseForm(initialExpenseEdit);
      setEditExpenseFormError("");
      setEditExpenseMacroId("");
      setEditExpenseLegacyCategoryName(null);
      logExpenseEditDiagnostic("[ExpenseEdit] Refresh triggered", {
        expenseId,
      });
      if (generation !== householdGeneration.current) return;
      await refresh();
      logExpenseEditDiagnostic("[ExpenseEdit] Refresh completed", {
        expenseId,
      });
    } catch (cause) {
      if (generation !== householdGeneration.current) return;
      if (isUpdatedNotHydratedError(cause)) {
        setError(
          "El gasto pudo haberse actualizado, pero no se pudo confirmar la recarga. No lo envíes de nuevo para evitar repetir la operación.",
        );
      } else {
        setError(
          cause instanceof Error
            ? cause.message
            : "No fue posible actualizar el gasto.",
        );
      }
    } finally {
      if (generation === householdGeneration.current) setBusy(false);
    }
  }

  function cancelExpenseEdit() {
    setEditingExpense(null);
    setEditExpenseForm(initialExpenseEdit);
    setEditExpenseMacroId("");
    setEditExpenseLegacyCategoryName(null);
    setEditLoading(false);
    setError("");
    setEditExpenseFormError("");
  }

  async function removeExpense(expenseId: string) {
    if (!window.confirm("¿Eliminar este gasto?")) return;
    setBusy(true);
    setError("");
    const generation = householdGeneration.current;
    try {
      await api<unknown>(`/api/expenses/${expenseId}`, { method: "DELETE" });
      if (generation !== householdGeneration.current) return;
      await refresh();
    } catch (cause) {
      if (generation !== householdGeneration.current) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "No fue posible eliminar el gasto.",
      );
    } finally {
      if (generation === householdGeneration.current) setBusy(false);
    }
  }

  async function submitIncome(event: FormEvent) {
    event.preventDefault();
    if (incomeMacroId !== "" && incomeForm.categoryId === "") {
      setError("Selecciona una categoría específica para continuar.");
      return;
    }
    setBusy(true);
    setError("");
    const generation = householdGeneration.current;
    try {
      await api<Income>("/api/incomes", {
        method: "POST",
        body: JSON.stringify({
          memberId: incomeForm.memberId,
          amount: Number(incomeForm.amount),
          incomeDate: incomeForm.incomeDate,
          description: incomeForm.description,
          categoryId: incomeForm.categoryId || null,
        }),
      });
      if (generation !== householdGeneration.current) return;
      setIncomeForm(initialIncome);
      setIncomeMacroId("");
      setShowIncomeForm(false);
      await refresh();
    } catch (cause) {
      if (generation !== householdGeneration.current) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "No fue posible crear el ingreso.",
      );
    } finally {
      if (generation === householdGeneration.current) setBusy(false);
    }
  }

  function startIncomeEdit(income: Income) {
    setEditingIncome(income.id);
    setError("");
    const hierarchicalCategory = income.categoryId
      ? incomeCategories.find((category) => category.id === income.categoryId)
      : undefined;
    const legacyCategory = income.categoryId
      ? categories.find((category) => category.id === income.categoryId)
      : undefined;
    setEditIncomeMacroId(hierarchicalCategory?.macroId ?? "");
    setEditIncomeLegacyCategoryName(
      hierarchicalCategory || !income.categoryId
        ? null
        : legacyCategory?.name ?? "Categoría histórica",
    );
    setEditIncomeForm({
      memberId: income.memberId,
      amount: String(income.amount),
      incomeDate: income.incomeDate,
      description: income.description,
      categoryId: income.categoryId ?? "",
    });
  }

  async function saveIncome(incomeId: string) {
    if (
      (editIncomeLegacyCategoryName !== null && editIncomeMacroId === "") ||
      (editIncomeMacroId !== "" && editIncomeForm.categoryId === "")
    ) {
      setError("Selecciona una categoría específica válida antes de guardar.");
      return;
    }
    setBusy(true);
    setError("");
    const generation = householdGeneration.current;
    try {
      await api<Income>(`/api/incomes/${incomeId}`, {
        method: "PATCH",
        body: JSON.stringify({
          memberId: editIncomeForm.memberId,
          amount: Number(editIncomeForm.amount),
          incomeDate: editIncomeForm.incomeDate,
          description: editIncomeForm.description,
          categoryId: editIncomeForm.categoryId || null,
        }),
      });
      if (generation !== householdGeneration.current) return;
      setEditingIncome(null);
      setEditIncomeForm(initialIncomeEdit);
      setEditIncomeMacroId("");
      setEditIncomeLegacyCategoryName(null);
      await refresh();
    } catch (cause) {
      if (generation !== householdGeneration.current) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "No fue posible actualizar el ingreso.",
      );
    } finally {
      if (generation === householdGeneration.current) setBusy(false);
    }
  }

  function cancelIncomeEdit() {
    setEditingIncome(null);
    setEditIncomeForm(initialIncomeEdit);
    setEditIncomeMacroId("");
    setEditIncomeLegacyCategoryName(null);
    setError("");
  }

  async function removeIncome(incomeId: string) {
    const income = incomes.find((item) => item.id === incomeId);
    const description = income?.description?.trim();
    const amount = income ? ` de ${money(income.amount)}` : "";
    const label = description ? ` "${description}"` : "";
    if (!window.confirm(`¿Eliminar el ingreso${label}${amount}?`)) return;
    setBusy(true);
    setError("");
    const generation = householdGeneration.current;
    try {
      await api<unknown>(`/api/incomes/${incomeId}`, { method: "DELETE" });
      if (generation !== householdGeneration.current) return;
      await refresh();
    } catch (cause) {
      if (generation !== householdGeneration.current) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "No fue posible eliminar el ingreso.",
      );
    } finally {
      if (generation === householdGeneration.current) setBusy(false);
    }
  }

  async function sendAgentMessage(event: FormEvent) {
    event.preventDefault();
    if (!agentMessage.trim()) return;
    setAgentBusy(true);
    setAgentError("");
    const generation = householdGeneration.current;
    try {
      const result = await api<AgentResult>("/api/agent", {
        method: "POST",
        body: JSON.stringify({ message: agentMessage }),
      });
      if (generation !== householdGeneration.current) return;
      setAgentResult(result);
      setAgentMessage("");
      if (result.type === "CONFIRMED") await refresh();
    } catch (cause) {
      if (generation !== householdGeneration.current) return;
      setAgentError(
        cause instanceof Error
          ? cause.message
          : "No fue posible consultar HouseMate AI.",
      );
    } finally {
      if (generation === householdGeneration.current) setAgentBusy(false);
    }
  }

  function describeAgentResult(result: AgentResult): string {
    if (result.message) return result.message;
    if (result.type === "READ_RESULT") return "Consulta completada.";
    if (result.type === "PROPOSAL_CREATED")
      return "Propuesta creada. Escribe “Sí, confirmar” para continuar.";
    if (result.type === "PROPOSAL_UPDATED")
      return 'Propuesta actualizada. Responde "Sí" para confirmar o "No" para rechazar.';
    if (result.type === "CONFIRMED")
      return "Operación confirmada correctamente.";
    if (result.type === "REJECTED") return "Operación rechazada.";
    return "Respuesta recibida.";
  }

  function presentUpdatedProposal(result: AgentResult): string {
    const lines = [
      "Propuesta actualizada. Revisa la información antes de confirmar:",
    ];
    const isExpense = result.operationType === "CREATE_EXPENSE";
    if (
      result.operationType !== "CREATE_EXPENSE" &&
      result.operationType !== "CREATE_INCOME"
    )
      return describeAgentResult(result);
    const proposal = isExpense
      ? result.payload?.expense
      : result.payload?.income;
    if (!proposal) return describeAgentResult(result);

    if (isExpense) {
      const expense = proposal as NonNullable<AgentResult["payload"]>["expense"];
      if (expense?.merchant?.trim())
        lines.push(`Comercio: ${expense.merchant.trim()}`);
      if (typeof expense?.totalAmount === "number")
        lines.push(`Monto: ${money(expense.totalAmount)}`);
      if (expense?.expenseDate?.trim())
        lines.push(`Fecha: ${humanDate(expense.expenseDate)}`);
      if (expense?.description?.trim())
        lines.push(`Descripción: ${expense.description.trim()}`);
      const categoryName = expense?.categoryId
        ? categories.find((category) => category.id === expense.categoryId)?.name
        : undefined;
      if (categoryName) lines.push(`Categoría: ${categoryName}`);
      const payerName = expense?.paidByMemberId
        ? members.find((member) => member.id === expense.paidByMemberId)
            ?.displayName
        : undefined;
      if (payerName) lines.push(`Pagador: ${payerName}`);
    } else {
      const income = proposal as NonNullable<AgentResult["payload"]>["income"];
      if (typeof income?.amount === "number")
        lines.push(`Monto: ${money(income.amount)}`);
      if (income?.incomeDate?.trim())
        lines.push(`Fecha: ${humanDate(income.incomeDate)}`);
      if (income?.description?.trim())
        lines.push(`Descripción: ${income.description.trim()}`);
      const categoryName = income?.categoryId
        ? categories.find((category) => category.id === income.categoryId)?.name
        : undefined;
      if (categoryName) lines.push(`Categoría: ${categoryName}`);
      const memberName = income?.memberId
        ? members.find((member) => member.id === income.memberId)?.displayName
        : undefined;
      if (memberName) lines.push(`Integrante: ${memberName}`);
    }

    lines.push('Responde "Sí" para confirmar o "No" para rechazar.');
    return lines.join("\n");
  }

  function presentCreatedProposal(result: AgentResult): string {
    const isExpense = result.operationType === "CREATE_EXPENSE";
    if (
      result.operationType !== "CREATE_EXPENSE" &&
      result.operationType !== "CREATE_INCOME"
    )
      return describeAgentResult(result);
    const proposal = isExpense
      ? result.payload?.expense
      : result.payload?.income;
    if (!proposal) return describeAgentResult(result);

    const lines = [
      `Voy a guardar este ${isExpense ? "gasto" : "ingreso"}:`,
    ];
    if (isExpense) {
      const expense = proposal as NonNullable<AgentResult["payload"]>["expense"];
      if (typeof expense?.totalAmount === "number")
        lines.push(`💰 Monto: ${money(expense.totalAmount)}`);
      if (expense?.expenseDate?.trim())
        lines.push(`📅 Fecha: ${humanDate(expense.expenseDate)}`);
      if (expense?.description?.trim())
        lines.push(`📝 Descripción: ${expense.description.trim()}`);
      if (expense?.merchant?.trim())
        lines.push(`🏪 Comercio: ${expense.merchant.trim()}`);
      const payerName = expense?.paidByMemberId
        ? memberNames[expense.paidByMemberId]
        : undefined;
      if (payerName) lines.push(`👤 Pagado por: ${payerName}`);
      const categoryName = expense?.categoryPath ??
        (expense?.categoryId
          ? expenseCategories.find((category) => category.id === expense.categoryId)
              ?.path
          : undefined);
      if (categoryName) lines.push(`📂 Categoría: ${categoryName}`);
    } else {
      const income = proposal as NonNullable<AgentResult["payload"]>["income"];
      if (typeof income?.amount === "number")
        lines.push(`💰 Monto: ${money(income.amount)}`);
      if (income?.incomeDate?.trim())
        lines.push(`📅 Fecha: ${humanDate(income.incomeDate)}`);
      if (income?.description?.trim())
        lines.push(`📝 Descripción: ${income.description.trim()}`);
      const categoryName = income?.categoryPath ??
        (income?.categoryId
          ? incomeCategoryLabel(income.categoryId)
          : undefined);
      if (categoryName) lines.push(`📂 Categoría: ${categoryName}`);
      const memberName = income?.memberId
        ? memberNames[income.memberId]
        : undefined;
      if (memberName) lines.push(`👤 Integrante: ${memberName}`);
    }
    lines.push('Escribe “Sí, confirmar” para continuar o “No” para rechazar.');
    return lines.join("\n");
  }

  function presentAgentResult(result: AgentResult): string {
    if (result.type === "PROPOSAL_CREATED")
      return presentCreatedProposal(result);
    if (result.type === "PROPOSAL_UPDATED")
      return presentUpdatedProposal(result);
    if (result.type !== "READ_RESULT") return describeAgentResult(result);
    const agentMemberLabel = (memberId: string): string =>
      memberNames[memberId] ?? "Integrante";

    if (result.operation === "GET_EXPENSES") {
      const items = Array.isArray(result.data) ? result.data : [];
      if (items.length === 0) return "No encontré gastos con esos criterios.";
      const total = items.reduce(
        (sum, item) =>
          sum +
          (typeof item === "object" &&
          item !== null &&
          typeof (item as { totalAmount?: unknown }).totalAmount === "number"
            ? (item as { totalAmount: number }).totalAmount
            : 0),
        0,
      );
      const lines = items.map((item) => {
        const expense = item as {
          merchant?: string | null;
          totalAmount?: number;
          expenseDate?: string;
          category?: { name?: string } | null;
        };
        return `• ${expense.merchant ?? "Gasto"} — ${money(expense.totalAmount ?? 0)} — ${humanDate(expense.expenseDate ?? "")} — ${expense.category?.name ?? "Sin categoría"}`;
      });
      return [
        `Encontré ${items.length} ${items.length === 1 ? "gasto" : "gastos"}:`,
        ...lines,
        `Total: ${money(total)}`,
      ].join("\n");
    }

    if (result.operation === "GET_INCOMES") {
      const value = result.data as {
        incomes?: {
          amount?: number;
          incomeDate?: string;
          description?: string;
        }[];
        summary?: { totalIncome?: number };
      };
      const items = Array.isArray(value?.incomes) ? value.incomes : [];
      if (items.length === 0) return "No encontré ingresos con esos criterios.";
      const lines = items.map(
        (income) =>
          `• ${income.description ?? "Ingreso"} — ${money(income.amount ?? 0)} — ${humanDate(income.incomeDate ?? "")}`,
      );
      return [
        `Encontré ${items.length} ${items.length === 1 ? "ingreso" : "ingresos"}:`,
        ...lines,
        `Total: ${money(value.summary?.totalIncome ?? 0)}`,
      ].join("\n");
    }

    if (result.operation === "GET_BALANCE") {
      const value = result.data as {
        members?: { memberId?: string; balance?: number }[];
      };
      const members = Array.isArray(value?.members) ? value.members : [];
      if (members.length === 0) return "No hay balances para mostrar.";
      return [
        "Balance del hogar:",
        ...members.map((member) => {
          const amount = member.balance ?? 0;
          return `• ${agentMemberLabel(member.memberId ?? "")}: ${amount < 0 ? "-" : ""}${money(Math.abs(amount))}`;
        }),
      ].join("\n");
    }

    if (result.operation === "GET_CATEGORIES") {
      const categories = Array.isArray(result.data) ? result.data : [];
      if (categories.length === 0) return "No hay categorías disponibles.";
      return [
        "Estas son las categorías disponibles:",
        ...categories.map((category) => {
          const item = category as { name?: string };
          return `• ${item.name ?? "Sin nombre"}`;
        }),
      ].join("\n");
    }

    if (result.operation === "GET_SHARING_RULES") {
      const rules = Array.isArray(result.data) ? result.data : [];
      if (rules.length === 0) return "No hay reglas de reparto disponibles.";
      return rules
        .map((rule) => {
          const item = rule as {
            name?: string;
            splits?: { memberId?: string; percentage?: number }[];
          };
          const splits = Array.isArray(item.splits) ? item.splits : [];
          return [
            `Regla de reparto: ${item.name ?? "Sin nombre"}`,
            ...splits.map(
              (split) =>
                `• ${agentMemberLabel(split.memberId ?? "")}: ${percentage(split.percentage ?? 0)}`,
            ),
          ].join("\n");
        })
        .join("\n\n");
    }

    return "Consulta completada.";
  }

  function renderExpenseEditForm() {
    if (!editingExpense) return null;
    return (
      <form
        className="panel form expense-edit-modal-form"
        onSubmit={(event) => {
          event.preventDefault();
          void saveExpense(editingExpense);
        }}
      >
        <div className="expense-create-modal-header">
          <div>
            <p className="section-kicker">EDITAR MOVIMIENTO</p>
            <h2 id="expense-edit-title">Editar gasto</h2>
          </div>
          <button
            type="button"
            className="filter-panel-close"
            aria-label="Cerrar edición de gasto"
            onClick={cancelExpenseEdit}
            disabled={busy}
          >
            ×
          </button>
        </div>
        {editLoading ? (
          <p className="loading">Cargando gasto...</p>
        ) : (
          <>
            <label>
              Comercio
              <input
                aria-label="Comercio del gasto"
                value={editExpenseForm.merchant}
                onChange={(event) =>
                  setEditExpenseForm({
                    ...editExpenseForm,
                    merchant: event.target.value,
                  })
                }
              />
            </label>
            <label>
              Monto
              <input
                aria-label="Monto del gasto"
                required
                type="number"
                min="0.01"
                step="0.01"
                value={editExpenseForm.totalAmount}
                onChange={(event) =>
                  setEditExpenseForm({
                    ...editExpenseForm,
                    totalAmount: event.target.value,
                  })
                }
              />
            </label>
            <label>
              Fecha
              <input
                aria-label="Fecha del gasto"
                required
                type="text"
                inputMode="numeric"
                maxLength={10}
                placeholder="DD/MM/AAAA"
                value={editExpenseForm.expenseDate}
                onChange={(event) =>
                  setEditExpenseForm({
                    ...editExpenseForm,
                    expenseDate: event.target.value,
                  })
                }
              />
            </label>
            <label>
              Pagado por
              <select
                aria-label="Pagado por"
                required
                value={editExpenseForm.paidByMemberId}
                onChange={(event) =>
                  setEditExpenseForm({
                    ...editExpenseForm,
                    paidByMemberId: event.target.value,
                  })
                }
              >
                <option value="">Seleccionar</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.displayName}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="expense-split-editor">
              <legend>¿Cómo se reparte este gasto?</legend>
              {members.map((member) => {
                const split = editExpenseForm.splits.find((item) => item.memberId === member.id);
                return (
                  <label key={member.id}>
                    {member.displayName}
                    <input
                      aria-label={`Porcentaje de ${member.displayName}`}
                      type="number"
                      min="0"
                      max="100"
                      step="0.01"
                      value={split?.percentage ?? 0}
                      onChange={(event) => {
                        setEditExpenseFormError("");
                        setEditExpenseForm((current) => ({
                          ...current,
                          splits: current.splits.some((item) => item.memberId === member.id)
                            ? current.splits.map((item) => item.memberId === member.id ? { ...item, percentage: event.target.value } : item)
                            : [...current.splits, { memberId: member.id, percentage: event.target.value }],
                        }));
                      }}
                    /> %
                  </label>
                );
              })}
              <p className={editExpenseFormError ? "alert" : "muted"}>{splitTotalMessage(editExpenseForm.splits)}</p>
              {editExpenseFormError && <p className="alert" role="alert">{editExpenseFormError}</p>}
              <button type="button" onClick={() => setEditExpenseForm((current) => ({ ...current, splits: equalSplits(members.map((member) => member.id)) }))} disabled={busy || members.length === 0}>
                Repartir por partes iguales
              </button>
            </fieldset>
            <label>
              Categoría principal
              <select
                aria-label="Categoría principal del gasto"
                value={editExpenseMacroId}
                onChange={(event) => {
                  setEditExpenseMacroId(event.target.value);
                  setEditExpenseLegacyCategoryName(null);
                  setEditExpenseForm({ ...editExpenseForm, categoryId: "" });
                }}
              >
                <option value="">
                  {editExpenseLegacyCategoryName
                    ? `Categoría histórica: ${editExpenseLegacyCategoryName}`
                    : "Sin categoría"}
                </option>
                {expenseMacros.map((macro) => (
                  <option key={macro.id} value={macro.id}>
                    {macro.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Categoría específica
              <select
                aria-label="Categoría específica del gasto"
                disabled={editExpenseMacroId === ""}
                value={editExpenseForm.categoryId}
                onChange={(event) =>
                  setEditExpenseForm({
                    ...editExpenseForm,
                    categoryId: event.target.value,
                  })
                }
              >
                <option value="">
                  {editExpenseMacroId === ""
                    ? "Selecciona una categoría principal"
                    : "Sin categoría específica"}
                </option>
                {editExpenseMicros.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Descripción
              <input
                aria-label="Descripción del gasto"
                className="expense-edit-description"
                value={editExpenseForm.description}
                onChange={(event) =>
                  setEditExpenseForm({
                    ...editExpenseForm,
                    description: event.target.value,
                  })
                }
              />
            </label>
            <div className="expense-create-modal-actions">
              <button
                type="button"
                onClick={cancelExpenseEdit}
                disabled={busy}
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="primary"
                disabled={
                  busy ||
                  (editExpenseLegacyCategoryName !== null &&
                    editExpenseMacroId === "")
                }
              >
                Guardar
              </button>
            </div>
          </>
        )}
      </form>
    );
  }

  function renderIncomeEditForm() {
    if (!editingIncome) return null;
    return (
      <form
        className="panel form expense-edit-modal-form"
        onSubmit={(event) => {
          event.preventDefault();
          void saveIncome(editingIncome);
        }}
      >
        <div className="expense-create-modal-header">
          <div>
            <p className="section-kicker">EDITAR MOVIMIENTO</p>
            <h2 id="income-edit-title">Editar ingreso</h2>
          </div>
          <button
            type="button"
            className="filter-panel-close"
            aria-label="Cerrar edición de ingreso"
            onClick={cancelIncomeEdit}
            disabled={busy}
          >
            ×
          </button>
        </div>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        <label>
          Integrante
          <select
            required
            value={editIncomeForm.memberId}
            onChange={(event) =>
              setEditIncomeForm({
                ...editIncomeForm,
                memberId: event.target.value,
              })
            }
          >
            <option value="">Seleccionar</option>
            {memberIds.map((id) => (
              <option key={id} value={id}>
                {memberLabel(id)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Monto
          <input
            required
            type="number"
            min="0.01"
            step="0.01"
            value={editIncomeForm.amount}
            onChange={(event) =>
              setEditIncomeForm({
                ...editIncomeForm,
                amount: event.target.value,
              })
            }
          />
        </label>
        <label>
          Fecha
          <input
            required
            type="date"
            value={editIncomeForm.incomeDate}
            onChange={(event) =>
              setEditIncomeForm({
                ...editIncomeForm,
                incomeDate: event.target.value,
              })
            }
          />
        </label>
        <label>
          Categoría principal
          <select
            aria-label="Categoría principal del ingreso"
            value={editIncomeMacroId}
            onChange={(event) => {
              setEditIncomeMacroId(event.target.value);
              setEditIncomeLegacyCategoryName(null);
              setEditIncomeForm({ ...editIncomeForm, categoryId: "" });
            }}
          >
            <option value="">
              {editIncomeLegacyCategoryName
                ? `Categoría histórica: ${editIncomeLegacyCategoryName}`
                : "Sin categoría"}
            </option>
            {incomeMacros.map((macro) => (
              <option key={macro.id} value={macro.id}>
                {macro.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Categoría específica
          <select
            aria-label="Categoría específica del ingreso"
            disabled={editIncomeMacroId === ""}
            value={editIncomeForm.categoryId}
            onChange={(event) =>
              setEditIncomeForm({
                ...editIncomeForm,
                categoryId: event.target.value,
              })
            }
          >
            <option value="">
              {editIncomeMacroId === ""
                ? "Selecciona una categoría principal"
                : "Sin categoría específica"}
            </option>
            {editIncomeMicros.map((categoryOption) => (
              <option key={categoryOption.id} value={categoryOption.id}>
                {categoryOption.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Descripción
          <textarea
            required
            value={editIncomeForm.description}
            onChange={(event) =>
              setEditIncomeForm({
                ...editIncomeForm,
                description: event.target.value,
              })
            }
          />
        </label>
        <div className="expense-create-modal-actions">
          <button type="button" onClick={cancelIncomeEdit} disabled={busy}>
            Cancelar
          </button>
          <button
            type="submit"
            className="primary"
            disabled={
              busy ||
              (editIncomeLegacyCategoryName !== null &&
                editIncomeMacroId === "") ||
              (editIncomeMacroId !== "" && editIncomeForm.categoryId === "")
            }
          >
            Guardar
          </button>
        </div>
      </form>
    );
  }

  if (!authReady) {
    return (
      <main className="shell">
        <p className="loading">Comprobando sesión…</p>
      </main>
    );
  }

  if (!session) {
    return <LoginForm initialError={authError} onError={setAuthError} />;
  }

  if (onboardingRequired) {
    return (
      <OnboardingForm
        onComplete={completeOnboarding}
        onLogout={signOut}
      />
    );
  }

  if (householdSelectionRequired) {
    return (
      <main className="shell">
        <section className="panel auth-panel" aria-labelledby="household-selection-title">
          <p className="eyebrow">HOUSEMATE AI</p>
          <h1 id="household-selection-title">Selecciona tu hogar</h1>
          <p className="muted">Elige el hogar que quieres utilizar en esta sesión.</p>
          {householdSelectionError && <p className="alert" role="alert">{householdSelectionError}</p>}
          {householdOptionsLoading ? (
            <p className="loading" role="status">Cargando tus hogares…</p>
          ) : householdOptions.length === 0 ? (
            <div className="form">
              <p className="muted">No hay hogares disponibles para esta cuenta.</p>
              <button className="refresh" type="button" onClick={() => void loadHouseholdOptions()}>Reintentar</button>
            </div>
          ) : (
          <div className="form">
            {householdOptions.map((household) => (
              <button
                className="primary"
                key={household.householdId}
                type="button"
                disabled={householdSelectionBusy}
                onClick={() => void selectHousehold(household.householdId)}
              >
                {household.householdName}
              </button>
            ))}
          </div>
          )}
          <button className="refresh" type="button" onClick={() => { setHouseholdCreateOpen(true); setHouseholdCreateError(""); }} disabled={householdSelectionBusy}>
            + Crear household
          </button>
          {householdCreateOpen && (
            <div className="form" aria-label="Crear household">
              {householdCreateError && <p className="alert" role="alert">{householdCreateError}</p>}
              <label>Nombre del household<input value={householdCreateName} onChange={(event) => setHouseholdCreateName(event.target.value)} disabled={householdSelectionBusy} /></label>
              <button className="primary" type="button" onClick={() => void createHousehold()} disabled={householdSelectionBusy}>Crear</button>
            </div>
          )}
          <button className="refresh" type="button" onClick={() => void signOut()} disabled={householdSelectionBusy}>
            Cerrar sesión
          </button>
        </section>
      </main>
    );
  }

  if (authBoundaryError) {
    return (
      <main className="shell">
        <section className="panel auth-panel" role="alert">
          <p className="alert">{authBoundaryError}</p>
          <button className="primary" type="button" onClick={() => void signOut()}>
            Cerrar sesión
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">HOUSEMATE AI</p>
          <h1>Finanzas del hogar</h1>
        </div>
        {activeHousehold && (
          <span className="active-household" aria-live="polite">
            {activeHousehold.householdName}
          </span>
        )}
        <button
          className="refresh"
          onClick={() => void refresh()}
          disabled={loading}
        >
          Actualizar
        </button>
        <button className="refresh" type="button" onClick={() => void signOut()}>
          Cerrar sesión
        </button>
        <Link
          className="refresh"
          href="/household"
          onClick={() => {
            const validSection = section === "dashboard" || section === "expenses" || section === "incomes" || section === "balance" || section === "agent";
            if (!validSection) return;
            window.sessionStorage.setItem("housemate.household.returnTo", section);
          }}
        >
          Household
        </Link>
      </header>
      <nav className="nav" aria-label="Navegación principal">
        {(
          ["dashboard", "expenses", "incomes", "balance", "agent"] as Section[]
        ).map((item) => (
          <button
            key={item}
            className={section === item ? "active" : ""}
            onClick={() => setSection(item)}
          >
            {item === "dashboard"
              ? "Dashboard"
              : item === "expenses"
                ? "Gastos"
                : item === "incomes"
                  ? "Ingresos"
                  : item === "balance"
                    ? "Balance"
                    : "Agente IA"}
          </button>
        ))}
      </nav>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {loading && <p className="loading">Cargando información…</p>}
      {!loading && section === "dashboard" && dashboard && (
        <section>
          <div className="dashboard-heading">
            <div>
              <p className="section-kicker">RESUMEN DEL HOGAR</p>
              <h2>Tu dinero, en una sola vista</h2>
              <p className="muted">
                Una lectura rápida de los ingresos, gastos y categorías que
                alimentan tu balance.
              </p>
            </div>
            <div className="dashboard-insight">
              <span className="insight-label">Lectura principal</span>
              <strong>
                {dashboard.netAmount > 0
                  ? "Los ingresos superan los gastos"
                  : dashboard.netAmount < 0
                    ? "Los gastos superan los ingresos"
                    : "Los ingresos y los gastos son iguales"}
              </strong>
              {topCategory && (
                <small>
                  Mayor categoría: {topCategory.categoryName ?? "Sin categoría"}
                </small>
              )}
            </div>
          </div>
          <div className="cards">
            {[
              ["Ingresos", dashboard.totalIncome],
              ["Gastos", dashboard.totalSpent],
              ["Neto", dashboard.netAmount],
              ["Gastos registrados", dashboard.expenseCount],
            ].map(([label, value]) => (
              <article className="card" key={String(label)}>
                <span>{label}</span>
                <strong>
                  {typeof value === "number" && label !== "Gastos registrados"
                    ? money(value)
                    : value}
                </strong>
              </article>
            ))}
          </div>
          <div className="columns">
            <article className="panel">
              <h2>Ingresos por integrante</h2>
              {dashboard.memberIncome.map((item) => (
                <p className="row" key={item.memberId}>
                  <span>{memberLabel(item.memberId)}</span>
                  <strong>{money(item.amount)}</strong>
                </p>
              ))}
            </article>
            <article className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Gastos por categoría</h2>
                  <p className="muted">Distribución del gasto confirmado</p>
                </div>
                <span className="panel-tag">Detalle</span>
              </div>
              <div className="category-list">
                {dashboard.byCategory.map((item) => (
                  <div
                    className="category-item"
                    key={item.categoryId ?? "none"}
                  >
                    <div className="category-item-heading">
                      <span>{item.categoryName ?? "Sin categoría"}</span>
                      <strong>{money(item.amount)}</strong>
                    </div>
                    <div className="bar-track" aria-hidden="true">
                      <span
                        className="bar-fill"
                        style={{
                          width: `${Math.max(6, (item.amount / maxCategoryAmount) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </article>
          </div>
        </section>
      )}
      {!loading && section === "dashboard" && !dashboard && (
        <section className="panel">
          <p className="alert">{resourceErrors.dashboard}</p>
        </section>
      )}
      {!loading && section === "expenses" && (
        <section className="expenses-page">
          <div className="expenses-page-header">
            <div>
              <p className="section-kicker">MOVIMIENTOS</p>
              <h2>Expenses</h2>
              <p className="muted">Gestiona los gastos del hogar.</p>
            </div>
            <button
              className="primary expenses-create-button"
              type="button"
              onClick={() => { setExpenseFormError(""); setShowExpenseForm(true); }}
            >
              + Registrar gasto
            </button>
          </div>
          {expenseListError && (
            <p className="alert" role="alert">
              {expenseListError}
            </p>
          )}
          <div className="panel expense-list-toolbar">
            <div className="expenses-toolbar-main">
              <label className="expense-search-field">
                <span aria-hidden="true">⌕</span>
                <input
                  aria-label="Buscar gastos"
                  value={expenseListSearch}
                  placeholder="Buscar gastos..."
                  onChange={(event) => {
                    setExpenseListSearch(event.target.value);
                    setExpenseListPage(1);
                  }}
                />
              </label>
              <div className="expense-date-range" aria-label="Rango de fechas">
                <label className="expense-date-control">
                  Desde
                  <input
                    type="date"
                    aria-label="Fecha inicial"
                    value={expenseListFrom}
                    onChange={(event) => {
                      setExpenseListFrom(event.target.value);
                      setExpenseListPage(1);
                    }}
                  />
                </label>
                <label className="expense-date-control">
                  Hasta
                  <input
                    type="date"
                    aria-label="Fecha final"
                    value={expenseListTo}
                    onChange={(event) => {
                      setExpenseListTo(event.target.value);
                      setExpenseListPage(1);
                    }}
                  />
                </label>
              </div>
              <button
                type="button"
                className={expenseFiltersOpen ? "secondary-control is-active" : "secondary-control"}
                onClick={() => {
                  if (expenseFiltersOpen) setExpenseFiltersOpen(false);
                  else openExpenseFilters();
                }}
              >
                <FilterIcon />
                Más filtros{expenseFilterCount > 0 ? ` · ${expenseFilterCount}` : ""}
              </button>
            </div>
            {expenseFiltersOpen && (
              <div className="expense-filter-panel expense-amount-filter-panel">
                <div className="expense-filter-panel-heading">
                  <div>
                    <strong>Más filtros</strong>
                    <span>Filtra por monto sin salir del listado.</span>
                  </div>
                  <button
                    type="button"
                    className="filter-panel-close"
                    aria-label="Cerrar filtros"
                    onClick={() => setExpenseFiltersOpen(false)}
                  >
                    ×
                  </button>
                </div>
                <div className="expense-list-filter-grid">
                  <label>
                    Monto mínimo
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={expenseFilterDraft.minAmount}
                      onChange={(event) =>
                        setExpenseFilterDraft({
                          ...expenseFilterDraft,
                          minAmount: event.target.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    Monto máximo
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={expenseFilterDraft.maxAmount}
                      onChange={(event) =>
                        setExpenseFilterDraft({
                          ...expenseFilterDraft,
                          maxAmount: event.target.value,
                        })
                      }
                    />
                  </label>
                </div>
                <div className="expense-filter-panel-actions">
                  <button type="button" onClick={clearExpenseFilters}>
                    Limpiar
                  </button>
                  <button
                    type="button"
                    className="primary"
                    onClick={applyExpenseFilters}
                  >
                    Aplicar
                  </button>
                </div>
              </div>
            )}
          </div>
          <div className="panel expense-list-summary" aria-live="polite">
            <span>
              {expenseListSummary.totalCount}{" "}
              {expenseListSummary.totalCount === 1 ? "gasto" : "gastos"}
            </span>
            <strong>{money(expenseListSummary.totalAmount)}</strong>
          </div>
          <div className="expense-list-layout">
            {showExpenseForm && (
              <div
                className="expense-form-backdrop"
                role="dialog"
                aria-modal="true"
                aria-labelledby="expense-create-title"
              >
                <div className="expense-create-modal">
                <form className="panel form" onSubmit={submitExpense}>
              <div className="expense-create-modal-header">
                <div>
                  <p className="section-kicker">NUEVO MOVIMIENTO</p>
                  <h2 id="expense-create-title">Registrar gasto</h2>
                </div>
                <button
                  type="button"
                  className="filter-panel-close"
                  aria-label="Cerrar formulario de gasto"
                  onClick={() => setShowExpenseForm(false)}
                >
                  ×
                </button>
              </div>
              {resourceErrors.sharingRules && (
                <p className="muted">{resourceErrors.sharingRules}</p>
              )}
              {resourceErrors.expenseCategories && (
                <p className="muted">{resourceErrors.expenseCategories}</p>
              )}
              {resourceErrors.members && (
                <p className="muted">{resourceErrors.members}</p>
              )}
              <label>
                Comercio
                <input
                  value={expenseForm.merchant}
                  onChange={(e) =>
                    setExpenseForm({ ...expenseForm, merchant: e.target.value })
                  }
                />
              </label>
              <label>
                Total
                <input
                  required
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={expenseForm.totalAmount}
                  onChange={(e) =>
                    setExpenseForm({
                      ...expenseForm,
                      totalAmount: e.target.value,
                    })
                  }
                />
              </label>
              <label>
                Fecha
                <input
                  required
                  type="date"
                  value={expenseForm.expenseDate}
                  onChange={(e) =>
                    setExpenseForm({
                      ...expenseForm,
                      expenseDate: e.target.value,
                    })
                  }
                />
              </label>
              <label>
                Pagado por
                <select
                  required
                  value={expenseForm.paidByMemberId}
                  onChange={(e) =>
                    setExpenseForm({
                      ...expenseForm,
                      paidByMemberId: e.target.value,
                    })
                  }
                >
                  <option value="">Seleccionar</option>
                  {memberIds.map((id) => (
                    <option key={id} value={id}>
                      {memberLabel(id)}
                    </option>
                  ))}
                </select>
              </label>
              <fieldset className="expense-split-editor">
                <legend>¿Cómo se reparte este gasto?</legend>
                {members.map((member) => {
                  const split = expenseForm.splits.find((item) => item.memberId === member.id);
                  return (
                    <label key={member.id}>
                      {member.displayName}
                      <input
                        aria-label={`Porcentaje de ${member.displayName}`}
                        type="number"
                        min="0"
                        max="100"
                        step="0.01"
                        value={split?.percentage ?? 0}
                        onChange={(event) => {
                          setExpenseFormError("");
                          setExpenseForm((current) => ({
                            ...current,
                            splits: current.splits.some((item) => item.memberId === member.id)
                              ? current.splits.map((item) => item.memberId === member.id ? { ...item, percentage: event.target.value } : item)
                              : [...current.splits, { memberId: member.id, percentage: event.target.value }],
                          }));
                        }}
                      /> %
                    </label>
                  );
                })}
                <p className={expenseFormError ? "alert" : "muted"}>{splitTotalMessage(expenseForm.splits)}</p>
                {expenseFormError && <p className="alert" role="alert">{expenseFormError}</p>}
                <button type="button" onClick={() => setExpenseForm((current) => ({ ...current, splits: equalSplits(members.map((member) => member.id)) }))} disabled={busy || members.length === 0}>
                  Repartir por partes iguales
                </button>
              </fieldset>
              <label>
                Categoría principal
                <select
                  aria-label="Categoría principal del gasto"
                  value={expenseMacroId}
                  onChange={(e) => {
                    setExpenseMacroId(e.target.value);
                    setExpenseForm({ ...expenseForm, categoryId: "" });
                  }}
                >
                  <option value="">Sin categoría</option>
                  {expenseMacros.map((macro) => (
                    <option key={macro.id} value={macro.id}>
                      {macro.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Categoría específica
                <select
                  aria-label="Categoría específica del gasto"
                  disabled={expenseMacroId === ""}
                  value={expenseForm.categoryId}
                  onChange={(e) =>
                    setExpenseForm({
                      ...expenseForm,
                      categoryId: e.target.value,
                    })
                  }
                >
                  <option value="">
                    {expenseMacroId === ""
                      ? "Selecciona una categoría principal"
                      : "Sin categoría específica"}
                  </option>
                  {expenseMicros.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Descripción
                <textarea
                  value={expenseForm.description}
                  onChange={(e) =>
                    setExpenseForm({
                      ...expenseForm,
                      description: e.target.value,
                    })
                  }
                />
              </label>
              <div className="expense-create-modal-actions">
                <button
                  type="button"
                  onClick={() => setShowExpenseForm(false)}
                  disabled={busy}
                >
                  Cancelar
                </button>
                <button className="primary" disabled={busy}>
                  Crear gasto
                </button>
              </div>
                </form>
                </div>
              </div>
            )}
            <article className="panel expense-results">
              <div className="panel-heading">
                <div>
                  <h2>Gastos</h2>
                  <p className="muted">
                    {expenseListLoading
                      ? "Actualizando resultados..."
                      : "Resultados según los filtros seleccionados."}
                  </p>
                </div>
              </div>
              {expenseListLoading && (
                <p className="loading" role="status">
                  Cargando gastos...
                </p>
              )}
              {!expenseListLoading && !expenseListError && expenses.length === 0 && (
                <div className="expense-empty-state">
                  <strong>
                    {expenseHasActiveFilters
                      ? "No encontramos gastos con estos filtros."
                      : "Aún no tienes gastos"}
                  </strong>
                  <p className="muted">
                    {expenseHasActiveFilters
                      ? "Prueba con otros criterios o limpia los filtros."
                      : "Registra tu primer gasto para comenzar a llevar el control."}
                  </p>
                  {expenseHasActiveFilters ? (
                    <button type="button" onClick={clearExpenseFilters}>
                      Limpiar filtros
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="primary"
                      onClick={() => setShowExpenseForm(true)}
                    >
                      + Registrar gasto
                    </button>
                  )}
                </div>
              )}
              {expenses.length > 0 && (
                <div className="expense-table" role="table">
                  <div className="expense-table-row expense-table-head" role="row">
                    <button
                      type="button"
                      className="expense-sort-button"
                      data-sort="date"
                      onClick={() => toggleExpenseSort("date")}
                    >
                      Fecha
                      <SortIcon
                        direction={expenseListSortDirection}
                        active={expenseListSort === "date"}
                      />
                    </button>
                    <div className="expense-header-filter">
                      <button
                        type="button"
                        className="expense-header-button"
                        aria-label="Filtrar por Macro"
                        aria-expanded={expenseHeaderFilterOpen === "macro"}
                        onClick={() =>
                          setExpenseHeaderFilterOpen((current) =>
                            current === "macro" ? null : "macro",
                          )
                        }
                      >
                        Macro
                        <FilterIcon />
                        {expenseListMacroId && (
                          <span className="expense-filter-indicator" aria-label="Filtro activo" />
                        )}
                      </button>
                      {expenseHeaderFilterOpen === "macro" && (
                        <div className="expense-header-popover">
                          <input
                            className="expense-header-search"
                            aria-label="Buscar macro"
                            placeholder="Buscar macro..."
                            value={expenseMacroFilterQuery}
                            onChange={(event) =>
                              setExpenseMacroFilterQuery(event.target.value)
                            }
                          />
                          <button
                            type="button"
                            className={!expenseListMacroId ? "expense-filter-option is-selected" : "expense-filter-option"}
                            onClick={() => selectExpenseMacroFilter("")}
                          >
                            Todas las macros
                          </button>
                          {expenseFilterMacros.map((macro) => (
                            <button
                              type="button"
                              className={expenseListMacroId === macro.id ? "expense-filter-option is-selected" : "expense-filter-option"}
                              key={macro.id}
                              onClick={() => selectExpenseMacroFilter(macro.id)}
                            >
                              {macro.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="expense-header-filter">
                      <button
                        type="button"
                        className="expense-header-button"
                        aria-label="Filtrar por Micro"
                        aria-expanded={expenseHeaderFilterOpen === "micro"}
                        onClick={() =>
                          setExpenseHeaderFilterOpen((current) =>
                            current === "micro" ? null : "micro",
                          )
                        }
                      >
                        Micro
                        <FilterIcon />
                        {expenseListMicroId && (
                          <span className="expense-filter-indicator" aria-label="Filtro activo" />
                        )}
                      </button>
                      {expenseHeaderFilterOpen === "micro" && (
                        <div className="expense-header-popover">
                          <input
                            className="expense-header-search"
                            aria-label="Buscar micro"
                            placeholder="Buscar micro..."
                            value={expenseMicroFilterQuery}
                            onChange={(event) =>
                              setExpenseMicroFilterQuery(event.target.value)
                            }
                          />
                          <button
                            type="button"
                            className={!expenseListMicroId ? "expense-filter-option is-selected" : "expense-filter-option"}
                            onClick={() => selectExpenseMicroFilter("")}
                          >
                            Todas las micros
                          </button>
                          {expenseFilterMicros.map((category) => (
                              <button
                                type="button"
                                className={expenseListMicroId === category.id ? "expense-filter-option is-selected" : "expense-filter-option"}
                                key={category.id}
                                onClick={() => selectExpenseMicroFilter(category.id)}
                              >
                                {category.name}
                              </button>
                            ))}
                        </div>
                      )}
                    </div>
                    <span>Detalle</span>
                    <button
                      type="button"
                      className="expense-sort-button"
                      data-sort="merchant"
                      onClick={() => toggleExpenseSort("merchant")}
                    >
                      Comercio
                      <SortIcon
                        direction={expenseListSortDirection}
                        active={expenseListSort === "merchant"}
                      />
                    </button>
                    <button
                      type="button"
                      className="expense-sort-button"
                      data-sort="amount"
                      onClick={() => toggleExpenseSort("amount")}
                    >
                      Monto
                      <SortIcon
                        direction={expenseListSortDirection}
                        active={expenseListSort === "amount"}
                      />
                    </button>
                    <span>Pagador</span>
                    <span>Distribución</span>
                    <span>Acciones</span>
                  </div>
                  {expenses.map((expense) => (
                    <div className="expense-table-row" key={expense.id} role="row">
                      <div className="expense-table-cell" data-label="Fecha">
                        {formatExpenseDateForTable(expense.expenseDate)}
                      </div>
                      <div className="expense-table-cell" data-label="Macro">
                        {expenseCategoryParts(expense.category).macro}
                      </div>
                      <div
                        className="expense-table-cell"
                        data-label="Micro"
                        title={expenseCategoryLabel(expense.category)}
                      >
                        {expenseCategoryParts(expense.category).micro}
                      </div>
                      <div className="expense-table-cell" data-label="Detalle">
                        {expense.description || "—"}
                      </div>
                      <div className="expense-table-cell" data-label="Comercio">
                        {expense.merchant || "—"}
                      </div>
                      <strong className="expense-table-cell" data-label="Monto">
                        {money(expense.totalAmount)}
                      </strong>
                      <div className="expense-table-cell expense-payer-cell" data-label="Pagador">
                        {expense.paidBy?.name ?? "—"}
                      </div>
                      <div className="expense-table-cell expense-distribution-cell" data-label="Distribución">
                        {formatDistribution(expense.distributions)}
                      </div>
                      <div
                        className="actions expense-actions"
                        data-label="Acciones"
                      >
                        <button
                          type="button"
                          className="expense-icon-button"
                          aria-label={`Editar gasto ${expense.merchant ?? ""}`}
                          title="Editar gasto"
                          onClick={() => void startExpenseEdit(expense.id)}
                          disabled={busy || editLoading}
                        >
                          <EditIcon />
                        </button>
                        <button
                          type="button"
                          className="expense-icon-button danger"
                          aria-label={`Eliminar gasto ${expense.merchant ?? ""}`}
                          title="Eliminar gasto"
                          onClick={() => void removeExpense(expense.id)}
                          disabled={busy}
                        >
                          <TrashIcon />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {editingExpense && (
                <div
                  className="expense-form-backdrop"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="expense-edit-title"
                >
                  <div className="expense-create-modal">
                    {renderExpenseEditForm()}
                  </div>
                </div>
              )}
              <div className="expense-pagination" aria-label="Paginación de gastos">
                <button
                  type="button"
                  className="expense-page-button"
                  aria-label="Página anterior"
                  disabled={expenseListLoading || expenseListPagination.page <= 1}
                  onClick={() =>
                    setExpenseListPage((page) => Math.max(1, page - 1))
                  }
                >
                  ‹
                </button>
                <div className="expense-page-controls">
                  {paginationItems(
                    expenseListPagination.page,
                    Math.max(1, expenseListPagination.totalPages),
                  ).map((item, index) =>
                    item === "ellipsis" ? (
                      <span className="expense-page-ellipsis" key={`ellipsis-${index}`}>
                        …
                      </span>
                    ) : (
                      <button
                        type="button"
                        className={
                          item === expenseListPagination.page
                            ? "expense-page-button active"
                            : "expense-page-button"
                        }
                        aria-current={
                          item === expenseListPagination.page ? "page" : undefined
                        }
                        onClick={() => setExpenseListPage(item)}
                        disabled={expenseListLoading}
                        key={item}
                      >
                        {item}
                      </button>
                    ),
                  )}
                </div>
                <span className="expense-pagination-range">
                  {expenseListPagination.total === 0
                    ? "0 de 0"
                    : `${(expenseListPagination.page - 1) * expenseListPagination.pageSize + 1}–${Math.min(
                        expenseListPagination.page * expenseListPagination.pageSize,
                        expenseListPagination.total,
                      )} de ${expenseListPagination.total}`}
                </span>
                <label className="expense-page-size-control">
                  <span>Gastos por página</span>
                  <select
                    aria-label="Gastos por página"
                    value={expenseListPageSize}
                    onChange={(event) => {
                      setExpenseListPageSize(
                        Number(event.target.value) as ExpensePageSize,
                      );
                      setExpenseListPage(1);
                    }}
                  >
                    <option value={25}>25</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="expense-page-button"
                  aria-label="Página siguiente"
                  disabled={
                    expenseListLoading ||
                    expenseListPagination.page >= expenseListPagination.totalPages
                  }
                  onClick={() =>
                    setExpenseListPage((page) =>
                      Math.min(expenseListPagination.totalPages, page + 1),
                    )
                  }
                >
                  ›
                </button>
              </div>
            </article>
          </div>
        </section>
      )}
      {!loading && section === "incomes" && (
        <section className="expenses-page">
          <div className="expenses-page-header">
            <div>
              <p className="section-kicker">MOVIMIENTOS</p>
              <h2>Ingresos</h2>
              <p className="muted">Gestiona los ingresos de tu hogar.</p>
            </div>
            <button
              className="primary expenses-create-button"
              type="button"
              onClick={() => {
                setError("");
                setShowIncomeForm(true);
              }}
            >
              + Agregar ingreso
            </button>
          </div>
          {incomeListError && (
            <p className="alert" role="alert">
              {incomeListError}
            </p>
          )}
          <div className="panel expense-list-toolbar">
            <div className="expenses-toolbar-main">
              <label className="expense-search-field">
                <span aria-hidden="true">⌕</span>
                <input
                  aria-label="Buscar ingresos"
                  value={incomeListSearch}
                  placeholder="Buscar ingresos..."
                  onChange={(event) => {
                    setIncomeListSearch(event.target.value);
                    setIncomeListPage(1);
                  }}
                />
              </label>
              <div
                className="expense-date-range"
                aria-label="Rango de fechas de ingresos"
              >
                <label className="expense-date-control">
                  Desde
                  <input
                    type="date"
                    aria-label="Fecha inicial de ingresos"
                    value={incomeListFrom}
                    onChange={(event) => {
                      setIncomeListFrom(event.target.value);
                      setIncomeListPage(1);
                    }}
                  />
                </label>
                <label className="expense-date-control">
                  Hasta
                  <input
                    type="date"
                    aria-label="Fecha final de ingresos"
                    value={incomeListTo}
                    onChange={(event) => {
                      setIncomeListTo(event.target.value);
                      setIncomeListPage(1);
                    }}
                  />
                </label>
              </div>
              <button
                type="button"
                className={
                  incomeFiltersOpen
                    ? "secondary-control is-active"
                    : "secondary-control"
                }
                onClick={() => {
                  if (incomeFiltersOpen) setIncomeFiltersOpen(false);
                  else openIncomeFilters();
                }}
              >
                <FilterIcon />
                Más filtros
              </button>
            </div>
            {incomeFiltersOpen && (
              <div className="expense-filter-panel expense-amount-filter-panel">
                <div className="expense-filter-panel-heading">
                  <div>
                    <strong>Más filtros</strong>
                    <span>Filtra por monto sin salir del listado.</span>
                  </div>
                  <button
                    type="button"
                    className="filter-panel-close"
                    aria-label="Cerrar filtros de ingresos"
                    onClick={() => setIncomeFiltersOpen(false)}
                  >
                    ×
                  </button>
                </div>
                <div className="expense-list-filter-grid">
                  <label>
                    Monto mínimo
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={incomeFilterDraft.minAmount}
                      onChange={(event) =>
                        setIncomeFilterDraft({
                          ...incomeFilterDraft,
                          minAmount: event.target.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    Monto máximo
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={incomeFilterDraft.maxAmount}
                      onChange={(event) =>
                        setIncomeFilterDraft({
                          ...incomeFilterDraft,
                          maxAmount: event.target.value,
                        })
                      }
                    />
                  </label>
                </div>
                <div className="expense-filter-panel-actions">
                  <button type="button" onClick={clearIncomeFilters}>
                    Limpiar
                  </button>
                  <button
                    type="button"
                    className="primary"
                    onClick={applyIncomeFilters}
                  >
                    Aplicar
                  </button>
                </div>
              </div>
            )}
          </div>
          <div className="panel expense-list-summary" aria-live="polite">
            <span>
              {incomeListPagination.total}{" "}
              {incomeListPagination.total === 1 ? "ingreso" : "ingresos"}
            </span>
            <strong>{money(incomeListSummary.totalIncome)}</strong>
          </div>
          <div className="expense-list-layout">
          {showIncomeForm && (
              <div
                className="expense-form-backdrop"
                role="dialog"
                aria-modal="true"
                aria-labelledby="income-create-title"
              >
                <div className="expense-create-modal">
                  <form className="panel form" onSubmit={submitIncome}>
                    <div className="expense-create-modal-header">
                      <div>
                        <p className="section-kicker">NUEVO MOVIMIENTO</p>
                        <h2 id="income-create-title">Agregar ingreso</h2>
                      </div>
                      <button
                        type="button"
                        className="filter-panel-close"
                        aria-label="Cerrar formulario de ingreso"
                        onClick={() => setShowIncomeForm(false)}
                        disabled={busy}
                      >
                        ×
                      </button>
                    </div>
                    {error && (
                      <p className="alert" role="alert">
                        {error}
                      </p>
                    )}
              {resourceErrors.categories && (
                <p className="muted">{resourceErrors.categories}</p>
              )}
              {resourceErrors.incomeCategories && (
                <p className="muted">{resourceErrors.incomeCategories}</p>
              )}
              {resourceErrors.members && (
                <p className="muted">{resourceErrors.members}</p>
              )}
              <label>
                Integrante
                <select
                  required
                  value={incomeForm.memberId}
                  onChange={(e) =>
                    setIncomeForm({ ...incomeForm, memberId: e.target.value })
                  }
                >
                  <option value="">Seleccionar</option>
                  {memberIds.map((id) => (
                    <option key={id} value={id}>
                      {memberLabel(id)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Monto
                <input
                  required
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={incomeForm.amount}
                  onChange={(e) =>
                    setIncomeForm({ ...incomeForm, amount: e.target.value })
                  }
                />
              </label>
              <label>
                Fecha
                <input
                  required
                  type="date"
                  value={incomeForm.incomeDate}
                  onChange={(e) =>
                    setIncomeForm({ ...incomeForm, incomeDate: e.target.value })
                  }
                />
              </label>
              <label>
                Categoría principal
                <select
                  aria-label="Categoría principal del ingreso"
                  value={incomeMacroId}
                  onChange={(e) => {
                    setIncomeMacroId(e.target.value);
                    setIncomeForm({ ...incomeForm, categoryId: "" });
                  }}
                >
                  <option value="">Sin categoría</option>
                  {incomeMacros.map((macro) => (
                    <option key={macro.id} value={macro.id}>
                      {macro.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Categoría específica
                <select
                  aria-label="Categoría específica del ingreso"
                  disabled={incomeMacroId === ""}
                  value={incomeForm.categoryId}
                  onChange={(e) =>
                    setIncomeForm({ ...incomeForm, categoryId: e.target.value })
                  }
                >
                  <option value="">
                    {incomeMacroId === ""
                      ? "Selecciona una categoría principal"
                      : "Sin categoría específica"}
                  </option>
                  {incomeMicros.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Descripción
                <textarea
                  required
                  value={incomeForm.description}
                  onChange={(e) =>
                    setIncomeForm({
                      ...incomeForm,
                      description: e.target.value,
                    })
                  }
                />
              </label>
                    <div className="expense-create-modal-actions">
                      <button
                        type="button"
                        onClick={() => setShowIncomeForm(false)}
                        disabled={busy}
                      >
                        Cancelar
                      </button>
                      <button className="primary" disabled={busy}>
                        Crear ingreso
                      </button>
                    </div>
                  </form>
                </div>
              </div>
          )}
          <article className="panel expense-results">
              <div className="panel-heading">
                <div>
                  <h2>Ingresos</h2>
                </div>
              </div>
              {incomeListLoading && (
                <p className="loading" role="status">
                  Cargando ingresos...
                </p>
              )}
              {!incomeListLoading && !incomeListError && incomes.length === 0 && (
                <div className="expense-empty-state">
                  <strong>
                    {incomeHasActiveFilters
                      ? "No encontramos ingresos con estos filtros."
                      : "Aún no tienes ingresos"}
                  </strong>
                  <p className="muted">
                    {incomeHasActiveFilters
                      ? "Prueba con otros criterios o limpia los filtros."
                      : "Registra tu primer ingreso para comenzar a llevar el control."}
                  </p>
                  {incomeHasActiveFilters && (
                    <button type="button" onClick={clearIncomeFilters}>
                      Limpiar filtros
                    </button>
                  )}
                </div>
              )}
              {incomes.length > 0 && (
                <div className="expense-table income-table" role="table">
                  <div
                    className="expense-table-row income-table-row expense-table-head"
                    role="row"
                  >
                    <button
                      type="button"
                      className="expense-sort-button"
                      data-sort="incomeDate"
                      onClick={() => toggleIncomeSort("incomeDate")}
                    >
                      Fecha
                      <SortIcon
                        direction={incomeListSortOrder}
                        active={incomeListSort === "incomeDate"}
                      />
                    </button>
                    <div className="expense-header-filter">
                      <button
                        type="button"
                        className="expense-header-button"
                        aria-label="Filtrar ingresos por macro"
                        aria-expanded={incomeHeaderFilterOpen === "macro"}
                        onClick={() =>
                          setIncomeHeaderFilterOpen((current) =>
                            current === "macro" ? null : "macro",
                          )
                        }
                      >
                        Macro
                        <FilterIcon />
                        {incomeListMacroId && (
                          <span
                            className="expense-filter-indicator"
                            aria-label="Filtro activo"
                          />
                        )}
                      </button>
                      {incomeHeaderFilterOpen === "macro" && (
                        <div className="expense-header-popover">
                          <input
                            className="expense-header-search"
                            aria-label="Buscar macro de ingresos"
                            placeholder="Buscar macro..."
                            value={incomeMacroFilterQuery}
                            onChange={(event) =>
                              setIncomeMacroFilterQuery(event.target.value)
                            }
                          />
                          <button
                            type="button"
                            className={
                              !incomeListMacroId
                                ? "expense-filter-option is-selected"
                                : "expense-filter-option"
                            }
                            onClick={() => selectIncomeMacroFilter("")}
                          >
                            Todas las macros
                          </button>
                          {incomeFilterMacros.map((macro) => (
                            <button
                              type="button"
                              className={
                                incomeListMacroId === macro.id
                                  ? "expense-filter-option is-selected"
                                  : "expense-filter-option"
                              }
                              key={macro.id}
                              onClick={() => selectIncomeMacroFilter(macro.id)}
                            >
                              {macro.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="expense-header-filter">
                      <button
                        type="button"
                        className="expense-header-button"
                        aria-label="Filtrar ingresos por micro"
                        aria-expanded={incomeHeaderFilterOpen === "micro"}
                        onClick={() =>
                          setIncomeHeaderFilterOpen((current) =>
                            current === "micro" ? null : "micro",
                          )
                        }
                      >
                        Micro
                        <FilterIcon />
                        {incomeListMicroId && (
                          <span
                            className="expense-filter-indicator"
                            aria-label="Filtro activo"
                          />
                        )}
                      </button>
                      {incomeHeaderFilterOpen === "micro" && (
                        <div className="expense-header-popover">
                          <input
                            className="expense-header-search"
                            aria-label="Buscar micro de ingresos"
                            placeholder="Buscar micro..."
                            value={incomeMicroFilterQuery}
                            onChange={(event) =>
                              setIncomeMicroFilterQuery(event.target.value)
                            }
                          />
                          <button
                            type="button"
                            className={
                              !incomeListMicroId
                                ? "expense-filter-option is-selected"
                                : "expense-filter-option"
                            }
                            onClick={() => selectIncomeMicroFilter("")}
                          >
                            Todas las micros
                          </button>
                          {incomeFilterMicros.map((category) => (
                            <button
                              type="button"
                              className={
                                incomeListMicroId === category.id
                                  ? "expense-filter-option is-selected"
                                  : "expense-filter-option"
                              }
                              key={category.id}
                              onClick={() => selectIncomeMicroFilter(category.id)}
                            >
                              {category.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      className="expense-sort-button"
                      data-sort="description"
                      onClick={() => toggleIncomeSort("description")}
                    >
                      Descripción
                      <SortIcon
                        direction={incomeListSortOrder}
                        active={incomeListSort === "description"}
                      />
                    </button>
                    <div className="expense-header-filter">
                      <button
                        type="button"
                        className="expense-header-button"
                        aria-label="Filtrar ingresos por integrante"
                        aria-expanded={incomeHeaderFilterOpen === "member"}
                        onClick={() =>
                          setIncomeHeaderFilterOpen((current) =>
                            current === "member" ? null : "member",
                          )
                        }
                      >
                        Integrante
                        <FilterIcon />
                        {incomeListMemberId && (
                          <span
                            className="expense-filter-indicator"
                            aria-label="Filtro activo"
                          />
                        )}
                      </button>
                      {incomeHeaderFilterOpen === "member" && (
                        <div className="expense-header-popover">
                          <input
                            className="expense-header-search"
                            aria-label="Buscar integrante de ingresos"
                            placeholder="Buscar integrante..."
                            value={incomeMemberFilterQuery}
                            onChange={(event) =>
                              setIncomeMemberFilterQuery(event.target.value)
                            }
                          />
                          <button
                            type="button"
                            className={
                              !incomeListMemberId
                                ? "expense-filter-option is-selected"
                                : "expense-filter-option"
                            }
                            onClick={() => selectIncomeMemberFilter("")}
                          >
                            Todos los integrantes
                          </button>
                          {incomeFilterMembers.map((member) => (
                            <button
                              type="button"
                              className={
                                incomeListMemberId === member.id
                                  ? "expense-filter-option is-selected"
                                  : "expense-filter-option"
                              }
                              key={member.id}
                              onClick={() => selectIncomeMemberFilter(member.id)}
                            >
                              {member.displayName}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      className="expense-sort-button"
                      data-sort="amount"
                      onClick={() => toggleIncomeSort("amount")}
                    >
                      Monto
                      <SortIcon
                        direction={incomeListSortOrder}
                        active={incomeListSort === "amount"}
                      />
                    </button>
                    <span>Acciones</span>
                  </div>
                  {incomes.map((income) => {
                    const category = incomeCategoryParts(income.categoryId);
                    return (
                      <div
                        className="expense-table-row income-table-row"
                        key={income.id}
                        role="row"
                      >
                        <div
                              className="expense-table-cell"
                              data-label="Fecha"
                            >
                              {formatExpenseDateForTable(income.incomeDate)}
                            </div>
                        <div
                              className="expense-table-cell"
                              data-label="Macro"
                            >
                              {category.macro}
                            </div>
                        <div
                              className="expense-table-cell"
                              data-label="Micro"
                              title={incomeCategoryLabel(income.categoryId)}
                            >
                              {category.micro}
                            </div>
                        <div
                              className="expense-table-cell"
                              data-label="Descripción"
                            >
                              {income.description || "—"}
                            </div>
                        <div
                              className="expense-table-cell"
                              data-label="Miembro"
                            >
                              {memberLabel(income.memberId)}
                            </div>
                        <strong
                              className="expense-table-cell"
                              data-label="Monto"
                            >
                              {money(income.amount)}
                            </strong>
                        <div
                              className="actions expense-actions"
                              data-label="Acciones"
                            >
                              <button
                                type="button"
                                className="expense-icon-button"
                                aria-label={`Editar ingreso ${income.description}`}
                                title="Editar ingreso"
                                onClick={() => startIncomeEdit(income)}
                                disabled={busy}
                              >
                                <EditIcon />
                              </button>
                              <button
                                type="button"
                                className="expense-icon-button danger"
                                aria-label={`Eliminar ingreso ${income.description}`}
                                title="Eliminar ingreso"
                                onClick={() => void removeIncome(income.id)}
                                disabled={busy}
                              >
                                <TrashIcon />
                              </button>
                            </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {editingIncome && (
                <div
                  className="expense-form-backdrop"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="income-edit-title"
                >
                  <div className="expense-create-modal">
                    {renderIncomeEditForm()}
                  </div>
                </div>
              )}
              <div className="expense-pagination" aria-label="Paginación de ingresos">
                <button
                  type="button"
                  className="expense-page-button"
                  aria-label="Página anterior de ingresos"
                  disabled={incomeListLoading || incomeListPagination.page <= 1}
                  onClick={() =>
                    setIncomeListPage((page) => Math.max(1, page - 1))
                  }
                >
                  ‹
                </button>
                <div className="expense-page-controls">
                  {paginationItems(
                    incomeListPagination.page,
                    Math.max(1, incomeListPagination.totalPages),
                  ).map((item, index) =>
                    item === "ellipsis" ? (
                      <span
                        className="expense-page-ellipsis"
                        key={`income-ellipsis-${index}`}
                      >
                        …
                      </span>
                    ) : (
                      <button
                        type="button"
                        className={
                          item === incomeListPagination.page
                            ? "expense-page-button active"
                            : "expense-page-button"
                        }
                        aria-current={
                          item === incomeListPagination.page ? "page" : undefined
                        }
                        onClick={() => setIncomeListPage(item)}
                        disabled={incomeListLoading}
                        key={`income-page-${item}`}
                      >
                        {item}
                      </button>
                    ),
                  )}
                </div>
                <span className="expense-pagination-range">
                  {incomeListPagination.total === 0
                    ? "0 de 0"
                    : `${(incomeListPagination.page - 1) * incomeListPagination.pageSize + 1}–${Math.min(
                        incomeListPagination.page * incomeListPagination.pageSize,
                        incomeListPagination.total,
                      )} de ${incomeListPagination.total}`}
                </span>
                <label className="expense-page-size-control">
                  <span>Ingresos por página</span>
                  <select
                    aria-label="Ingresos por página"
                    value={incomeListPageSize}
                    onChange={(event) => {
                      setIncomeListPageSize(
                        Number(event.target.value) as IncomePageSize,
                      );
                      setIncomeListPage(1);
                    }}
                  >
                    <option value={25}>25</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="expense-page-button"
                  aria-label="Página siguiente de ingresos"
                  disabled={
                    incomeListLoading ||
                    incomeListPagination.totalPages === 0 ||
                    incomeListPagination.page >= incomeListPagination.totalPages
                  }
                  onClick={() =>
                    setIncomeListPage((page) =>
                      Math.min(incomeListPagination.totalPages, page + 1),
                    )
                  }
                >
                  ›
                </button>
              </div>
          </article>
          </div>
        </section>
      )}
      {!loading && section === "balance" && balance && (
        <section className="panel">
          <h2>Balance entre integrantes</h2>
          {balance.members.map((member) => (
            <div className="balance-row" key={member.memberId}>
              <strong>{memberLabel(member.memberId)}</strong>
              <span>Pagó {money(member.paid)}</span>
              <span>Le corresponde {money(member.share)}</span>
              <b className={member.balance >= 0 ? "positive" : "negative"}>
                {member.balance >= 0 ? "Debe recibir " : "Debe pagar "}
                {money(Math.abs(member.balance))}
              </b>
            </div>
          ))}
        </section>
      )}
      {!loading && section === "balance" && !balance && (
        <section className="panel">
          <p className="alert">{resourceErrors.balance}</p>
        </section>
      )}
      {section === "agent" && (
        <section className="panel">
          <div className="agent-heading">
            <div>
              <p className="section-kicker">INTERFAZ CONVERSACIONAL</p>
              <h2>Habla con tus finanzas</h2>
              <p className="muted">
                Consulta tus datos o prepara una operación. La IA propone y tú
                confirmas antes de guardar.
              </p>
            </div>
            <span className="ai-badge">IA + datos del hogar</span>
          </div>
          <form className="form" onSubmit={sendAgentMessage}>
            <label>
              Mensaje
              <textarea
                value={agentMessage}
                onChange={(event) => setAgentMessage(event.target.value)}
                placeholder="¿Cuánto gastamos este mes?"
                disabled={agentBusy}
              />
            </label>
            <button className="primary" type="submit" disabled={agentBusy}>
              {agentBusy ? "Enviando…" : "Enviar"}
            </button>
          </form>
          <div className="suggestions">
            <span>Prueba con:</span>
            <div className="suggestion-list">
              {agentSuggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="suggestion"
                  onClick={() => chooseAgentSuggestion(suggestion)}
                  disabled={agentBusy}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
          {agentError && (
            <p className="alert" role="alert">
              {agentError}
            </p>
          )}
          {agentResult && (
            <article
              className={`agent-result ${agentResult.type === "ERROR" ? "is-error" : ""}`}
              aria-live="polite"
            >
              <div className="result-heading">
                <strong>Respuesta de HouseMate AI</strong>
                <span>
                  {agentResult.type === "READ_RESULT"
                    ? "Consulta completada"
                    : agentResult.type === "PROPOSAL_CREATED"
                      ? "Revisión requerida"
                      : "Estado actualizado"}
                </span>
              </div>
              <p style={{ whiteSpace: "pre-line" }}>
                {presentAgentResult(agentResult)}
              </p>
            </article>
          )}
        </section>
      )}
      <footer>
        <span>Categorías: {categories.length}</span>
        <span>Reglas de reparto: {rules.length}</span>
      </footer>
    </main>
  );
}

export default function HomePage() {
  return (
    <Suspense fallback={<main className="shell"><p className="loading">Cargando información…</p></main>}>
      <HomePageContent />
    </Suspense>
  );
}
