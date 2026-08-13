"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type Section = "dashboard" | "expenses" | "incomes" | "balance";

type Expense = {
  id: string;
  merchant: string | null;
  description: string | null;
  totalAmount: number;
  expenseDate: string;
  status: string;
  category: { id: string; name: string } | null;
};

type Income = {
  id: string;
  memberId: string;
  amount: number;
  incomeDate: string;
  description: string;
  categoryId: string | null;
};

type Category = { id: string; name: string };
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

export default function HomePage() {
  const [section, setSection] = useState<Section>("dashboard");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [incomes, setIncomes] = useState<Income[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [rules, setRules] = useState<SharingRule[]>([]);
  const [expenseForm, setExpenseForm] = useState(initialExpense);
  const [incomeForm, setIncomeForm] = useState(initialIncome);
  const [editingExpense, setEditingExpense] = useState<string | null>(null);
  const [editDescription, setEditDescription] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const memberIds = useMemo(() => {
    const ids = new Set<string>();
    rules.forEach((rule) =>
      rule.splits.forEach((split) => ids.add(split.memberId)),
    );
    return [...ids];
  }, [rules]);

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      const [
        dashboardData,
        expenseData,
        incomeData,
        categoryData,
        ruleData,
        balanceData,
      ] = await Promise.all([
        api<Dashboard>("/api/dashboard/summary"),
        api<Expense[]>("/api/expenses"),
        api<Income[]>("/api/incomes"),
        api<Category[]>("/api/categories"),
        api<SharingRule[]>("/api/sharing-rules"),
        api<Balance>("/api/balance"),
      ]);
      setDashboard(dashboardData);
      setExpenses(expenseData);
      setIncomes(incomeData);
      setCategories(categoryData);
      setRules(ruleData);
      setBalance(balanceData);
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

  async function saveExpense(expenseId: string) {
    setBusy(true);
    setError("");
    try {
      await api<Expense>(`/api/expenses/${expenseId}`, {
        method: "PATCH",
        body: JSON.stringify({ description: editDescription || null }),
      });
      setEditingExpense(null);
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
        {(["dashboard", "expenses", "incomes", "balance"] as Section[]).map(
          (item) => (
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
                    : "Balance"}
            </button>
          ),
        )}
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
                  <span>{item.memberId}</span>
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
      {!loading && section === "expenses" && (
        <section>
          <div className="columns">
            <form className="panel form" onSubmit={submitExpense}>
              <h2>Registrar gasto</h2>
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
                      {id}
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
                    <div className="inline">
                      <input
                        value={editDescription}
                        onChange={(e) => setEditDescription(e.target.value)}
                      />
                      <button
                        onClick={() => void saveExpense(expense.id)}
                        disabled={busy}
                      >
                        Guardar
                      </button>
                    </div>
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
                          onClick={() => {
                            setEditingExpense(expense.id);
                            setEditDescription(expense.description ?? "");
                          }}
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
          <div className="columns">
            <form className="panel form" onSubmit={submitIncome}>
              <h2>Registrar ingreso</h2>
              <label>
                Integrante
                <input
                  required
                  value={incomeForm.memberId}
                  onChange={(e) =>
                    setIncomeForm({ ...incomeForm, memberId: e.target.value })
                  }
                  placeholder="ID del integrante"
                />
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
                      {income.memberId}
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
              <strong>{member.memberId}</strong>
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
      <footer>
        <span>Categorías: {categories.length}</span>
        <span>Reglas de reparto: {rules.length}</span>
      </footer>
    </main>
  );
}
