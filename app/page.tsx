"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type Section = "dashboard" | "expenses" | "incomes" | "balance" | "agent";
type ResourceKey =
  | "dashboard"
  | "expenses"
  | "incomes"
  | "categories"
  | "members"
  | "sharingRules"
  | "balance";

type Expense = {
  id: string;
  merchant: string | null;
  description: string | null;
  totalAmount: number;
  expenseDate: string;
  status: string;
  category: { id: string; name: string } | null;
};
type ExpenseDetail = Expense & { paidByMemberId: string };

type Income = {
  id: string;
  memberId: string;
  amount: number;
  incomeDate: string;
  description: string;
  categoryId: string | null;
};

type Category = { id: string; name: string };
type HouseholdMember = { id: string; displayName: string };
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
  status?: string;
  proposalId?: string;
  data?: unknown;
};

const initialExpense = {
  merchant: "",
  description: "",
  totalAmount: "",
  expenseDate: new Date().toISOString().slice(0, 10),
  paidByMemberId: "",
  categoryId: "",
  ruleId: "",
};
const initialIncome = {
  memberId: "",
  amount: "",
  incomeDate: new Date().toISOString().slice(0, 10),
  description: "",
  categoryId: "",
};
const initialExpenseEdit = {
  description: "",
  totalAmount: "",
  categoryId: "",
  paidByMemberId: "",
};

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });
  const body = (await response.json().catch(() => ({}))) as {
    data?: T;
    error?: { message?: string };
  };
  if (!response.ok)
    throw new Error(
      body.error?.message ?? "No fue posible completar la operación.",
    );
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
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function percentage(value: number): string {
  return `${new Intl.NumberFormat("es-CO", {
    maximumFractionDigits: 2,
  }).format(value)}%`;
}

export default function HomePage() {
  const [section, setSection] = useState<Section>("dashboard");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [incomes, setIncomes] = useState<Income[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [members, setMembers] = useState<HouseholdMember[]>([]);
  const [rules, setRules] = useState<SharingRule[]>([]);
  const [expenseForm, setExpenseForm] = useState(initialExpense);
  const [incomeForm, setIncomeForm] = useState(initialIncome);
  const [agentMessage, setAgentMessage] = useState("");
  const [agentResult, setAgentResult] = useState<AgentResult | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentError, setAgentError] = useState("");
  const [editingExpense, setEditingExpense] = useState<string | null>(null);
  const [editExpenseForm, setEditExpenseForm] = useState(initialExpenseEdit);
  const [editLoading, setEditLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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

  function memberLabel(memberId: string): string {
    return memberNames[memberId] ?? memberId;
  }

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const [
        dashboardResult,
        expenseResult,
        incomeResult,
        categoryResult,
        memberResult,
        ruleResult,
        balanceResult,
      ] = await Promise.allSettled([
        api<Dashboard>("/api/dashboard/summary"),
        api<Expense[]>("/api/expenses"),
        api<Income[]>("/api/incomes"),
        api<Category[]>("/api/categories"),
        api<HouseholdMember[]>("/api/household-members"),
        api<SharingRule[]>("/api/sharing-rules"),
        api<Balance>("/api/balance"),
      ]);
      const nextErrors: Partial<Record<ResourceKey, string>> = {};
      const failed = (key: ResourceKey) => {
        nextErrors[key] = "No fue posible cargar esta secciÃ³n.";
      };
      if (dashboardResult.status === "fulfilled")
        setDashboard(dashboardResult.value);
      else failed("dashboard");
      if (expenseResult.status === "fulfilled")
        setExpenses(expenseResult.value);
      else failed("expenses");
      if (incomeResult.status === "fulfilled") setIncomes(incomeResult.value);
      else failed("incomes");
      if (categoryResult.status === "fulfilled")
        setCategories(categoryResult.value);
      else failed("categories");
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
          ruleId: current.ruleId || ruleData[0]?.id || "",
        }));
      } else failed("sharingRules");
      if (balanceResult.status === "fulfilled") setBalance(balanceResult.value);
      else failed("balance");
      setResourceErrors(nextErrors);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "No fue posible cargar la información.",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function submitExpense(event: FormEvent) {
    event.preventDefault();
    const rule = rules.find((item) => item.id === expenseForm.ruleId);
    if (!rule || !expenseForm.paidByMemberId) {
      setError("Selecciona una regla de reparto y un pagador.");
      return;
    }
    setBusy(true);
    setError("");
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
          splits: rule.splits,
        }),
      });
      setExpenseForm(initialExpense);
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "No fue posible crear el gasto.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function startExpenseEdit(expenseId: string) {
    setEditingExpense(expenseId);
    setEditExpenseForm(initialExpenseEdit);
    setEditLoading(true);
    setError("");
    try {
      const expense = await api<ExpenseDetail>(`/api/expenses/${expenseId}`);
      setEditExpenseForm({
        description: expense.description ?? "",
        totalAmount: String(expense.totalAmount),
        categoryId: expense.category?.id ?? "",
        paidByMemberId: expense.paidByMemberId,
      });
    } catch (cause) {
      setEditingExpense(null);
      setError(
        cause instanceof Error
          ? cause.message
          : "No fue posible cargar el gasto.",
      );
    } finally {
      setEditLoading(false);
    }
  }

  async function saveExpense(expenseId: string) {
    setBusy(true);
    setError("");
    try {
      await api<Expense>(`/api/expenses/${expenseId}`, {
        method: "PATCH",
        body: JSON.stringify({
          description: editExpenseForm.description || null,
          totalAmount: Number(editExpenseForm.totalAmount),
          categoryId: editExpenseForm.categoryId || null,
          paidByMemberId: editExpenseForm.paidByMemberId,
        }),
      });
      setEditingExpense(null);
      setEditExpenseForm(initialExpenseEdit);
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "No fue posible actualizar el gasto.",
      );
    } finally {
      setBusy(false);
    }
  }

  function cancelExpenseEdit() {
    setEditingExpense(null);
    setEditExpenseForm(initialExpenseEdit);
    setEditLoading(false);
    setError("");
  }

  async function removeExpense(expenseId: string) {
    if (!window.confirm("¿Eliminar este gasto?")) return;
    setBusy(true);
    setError("");
    try {
      await api<unknown>(`/api/expenses/${expenseId}`, { method: "DELETE" });
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "No fue posible eliminar el gasto.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitIncome(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
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
      setIncomeForm(initialIncome);
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "No fue posible crear el ingreso.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function removeIncome(incomeId: string) {
    if (!window.confirm("¿Eliminar este ingreso?")) return;
    setBusy(true);
    setError("");
    try {
      await api<unknown>(`/api/incomes/${incomeId}`, { method: "DELETE" });
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "No fue posible eliminar el ingreso.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function sendAgentMessage(event: FormEvent) {
    event.preventDefault();
    if (!agentMessage.trim()) return;
    setAgentBusy(true);
    setAgentError("");
    try {
      const result = await api<AgentResult>("/api/agent", {
        method: "POST",
        body: JSON.stringify({ message: agentMessage }),
      });
      setAgentResult(result);
      setAgentMessage("");
      if (result.type === "CONFIRMED") await refresh();
    } catch (cause) {
      setAgentError(
        cause instanceof Error
          ? cause.message
          : "No fue posible consultar HouseMate AI.",
      );
    } finally {
      setAgentBusy(false);
    }
  }

  function describeAgentResult(result: AgentResult): string {
    if (result.message) return result.message;
    if (result.type === "READ_RESULT") return "Consulta completada.";
    if (result.type === "PROPOSAL_CREATED")
      return "Propuesta creada. Escribe “Sí, confirmar” para continuar.";
    if (result.type === "CONFIRMED")
      return "Operación confirmada correctamente.";
    if (result.type === "REJECTED") return "Operación rechazada.";
    return "Respuesta recibida.";
  }

  function presentAgentResult(result: AgentResult): string {
    if (result.type !== "READ_RESULT") return describeAgentResult(result);
    const agentMemberLabel = (memberId: string): string =>
      memberNames[memberId] ?? "Integrante";

    if (result.operation === "GET_EXPENSES") {
      const items = Array.isArray(result.data) ? result.data : [];
      if (items.length === 0) return "No encontré gastos con esos criterios.";
      const total = items.reduce(
        (sum, item) =>
          sum +
          (typeof item === "object" && item !== null &&
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
      return [`Encontré ${items.length} ${items.length === 1 ? "gasto" : "gastos"}:`, ...lines, `Total: ${money(total)}`].join("\n");
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

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">HOUSEMATE AI</p>
          <h1>Finanzas del hogar</h1>
        </div>
        <button
          className="refresh"
          onClick={() => void refresh()}
          disabled={loading}
        >
          Actualizar
        </button>
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
                    : "HouseMate AI"}
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
              <h2>Gastos por categoría</h2>
              {dashboard.byCategory.map((item) => (
                <p className="row" key={item.categoryId ?? "none"}>
                  <span>{item.categoryName ?? "Sin categoría"}</span>
                  <strong>{money(item.amount)}</strong>
                </p>
              ))}
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
        <section>
          {resourceErrors.expenses && (
            <p className="alert" role="alert">
              {resourceErrors.expenses}
            </p>
          )}
          <div className="columns">
            <form className="panel form" onSubmit={submitExpense}>
              <h2>Registrar gasto</h2>
              {resourceErrors.sharingRules && (
                <p className="muted">{resourceErrors.sharingRules}</p>
              )}
              {resourceErrors.categories && (
                <p className="muted">{resourceErrors.categories}</p>
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
              <label>
                Regla de reparto
                <select
                  required
                  value={expenseForm.ruleId}
                  onChange={(e) =>
                    setExpenseForm({ ...expenseForm, ruleId: e.target.value })
                  }
                >
                  <option value="">Seleccionar</option>
                  {rules.map((rule) => (
                    <option key={rule.id} value={rule.id}>
                      {rule.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Categoría
                <select
                  value={expenseForm.categoryId}
                  onChange={(e) =>
                    setExpenseForm({
                      ...expenseForm,
                      categoryId: e.target.value,
                    })
                  }
                >
                  <option value="">Sin categoría</option>
                  {categories.map((category) => (
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
              <button className="primary" disabled={busy}>
                Crear gasto
              </button>
            </form>
            <article className="panel">
              <h2>Gastos recientes</h2>
              {expenses.length === 0 && <p className="muted">No hay gastos.</p>}
              {expenses.map((expense) => (
                <div className="list-item" key={expense.id}>
                  {editingExpense === expense.id ? (
                    editLoading ? (
                      <p className="muted">Cargando gasto...</p>
                    ) : (
                      <form
                        className="inline"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void saveExpense(expense.id);
                        }}
                      >
                        <label>
                          Descripción
                          <input
                            aria-label="Descripción del gasto"
                            value={editExpenseForm.description}
                            onChange={(e) =>
                              setEditExpenseForm({
                                ...editExpenseForm,
                                description: e.target.value,
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
                            onChange={(e) =>
                              setEditExpenseForm({
                                ...editExpenseForm,
                                totalAmount: e.target.value,
                              })
                            }
                          />
                        </label>
                        <label>
                          Categoría
                          <select
                            aria-label="Categoría del gasto"
                            value={editExpenseForm.categoryId}
                            onChange={(e) =>
                              setEditExpenseForm({
                                ...editExpenseForm,
                                categoryId: e.target.value,
                              })
                            }
                          >
                            <option value="">Sin categoría</option>
                            {categories.map((category) => (
                              <option key={category.id} value={category.id}>
                                {category.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Pagado por
                          <select
                            aria-label="Pagador del gasto"
                            required
                            value={editExpenseForm.paidByMemberId}
                            onChange={(e) =>
                              setEditExpenseForm({
                                ...editExpenseForm,
                                paidByMemberId: e.target.value,
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
                        <button type="submit" disabled={busy}>
                          Guardar
                        </button>
                        <button
                          type="button"
                          onClick={cancelExpenseEdit}
                          disabled={busy}
                        >
                          Cancelar
                        </button>
                      </form>
                    )
                  ) : (
                    <>
                      <div>
                        <strong>{expense.merchant ?? "Gasto"}</strong>
                        <p>
                          {expense.expenseDate} · {money(expense.totalAmount)} ·{" "}
                          {expense.category?.name ?? "Sin categoría"}
                        </p>
                      </div>
                      <div className="actions">
                        <button
                          onClick={() => void startExpenseEdit(expense.id)}
                          disabled={busy || editLoading}
                        >
                          Editar
                        </button>
                        <button
                          className="danger"
                          onClick={() => void removeExpense(expense.id)}
                          disabled={busy}
                        >
                          Eliminar
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </article>
          </div>
        </section>
      )}
      {!loading && section === "incomes" && (
        <section>
          {resourceErrors.incomes && (
            <p className="alert" role="alert">
              {resourceErrors.incomes}
            </p>
          )}
          <div className="columns">
            <form className="panel form" onSubmit={submitIncome}>
              <h2>Registrar ingreso</h2>
              {resourceErrors.categories && (
                <p className="muted">{resourceErrors.categories}</p>
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
                Categoría
                <select
                  value={incomeForm.categoryId}
                  onChange={(e) =>
                    setIncomeForm({ ...incomeForm, categoryId: e.target.value })
                  }
                >
                  <option value="">Sin categoría</option>
                  {categories.map((category) => (
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
              <button className="primary" disabled={busy}>
                Crear ingreso
              </button>
            </form>
            <article className="panel">
              <h2>Ingresos recientes</h2>
              {incomes.length === 0 && (
                <p className="muted">No hay ingresos.</p>
              )}
              {incomes.map((income) => (
                <div className="list-item" key={income.id}>
                  <div>
                    <strong>{income.description}</strong>
                    <p>
                      {income.incomeDate} · {money(income.amount)} ·{" "}
                      {memberLabel(income.memberId)}
                    </p>
                  </div>
                  <button
                    className="danger"
                    onClick={() => void removeIncome(income.id)}
                    disabled={busy}
                  >
                    Eliminar
                  </button>
                </div>
              ))}
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
          <h2>HouseMate AI</h2>
          <p className="muted">
            Consulta tus finanzas o prepara una operación para confirmarla.
          </p>
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
          {agentError && (
            <p className="alert" role="alert">
              {agentError}
            </p>
          )}
          {agentResult && (
            <article className="panel" aria-live="polite">
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
