const { test, expect } = require("@playwright/test");
const {
  interceptExpensePatch,
  updatedNotHydratedResponse,
} = require("./expense-api.cjs");

const EXPENSE_ID = "00000000-0000-4000-8000-000000000701";
const MEMBER_A = "00000000-0000-4000-8000-000000000021";
const MEMBER_B = "00000000-0000-4000-8000-000000000022";
const MACRO_FOOD = "00000000-0000-4000-8000-000000001002";
const MICRO_MARKET = "00000000-0000-4000-8000-000000002008";
const MACRO_TRANSPORT = "00000000-0000-4000-8000-000000001003";
const MICRO_FUEL = "00000000-0000-4000-8000-000000002014";
const RULE_70_30 = "00000000-0000-4000-8000-000000000801";
const RULE_100_0 = "00000000-0000-4000-8000-000000000802";
const RULE_50_50 = "00000000-0000-4000-8000-000000000803";
const members = [
  { id: MEMBER_A, displayName: "E2E Member A" },
  { id: MEMBER_B, displayName: "E2E Member B" },
];

const expenseCategories = [
  {
    id: MICRO_MARKET,
    name: "Supermercado",
    movementType: "EXPENSE",
    level: "MICRO",
    parentId: MACRO_FOOD,
    macroId: MACRO_FOOD,
    macroName: "Alimentación",
    isActive: true,
    path: "Alimentación → Supermercado",
  },
  {
    id: MICRO_FUEL,
    name: "Gasolina",
    movementType: "EXPENSE",
    level: "MICRO",
    parentId: MACRO_TRANSPORT,
    macroId: MACRO_TRANSPORT,
    macroName: "Transporte",
    isActive: true,
    path: "Transporte → Gasolina",
  },
];

function createExpenseData(overrides = {}) {
  return {
    id: EXPENSE_ID,
    merchant: "Mercado E2E",
    description: "Compra base E2E",
    totalAmount: 120000,
    expenseDate: "2026-09-20",
    status: "CONFIRMED",
    category: {
      id: MICRO_MARKET,
      name: "Supermercado",
      parentId: MACRO_FOOD,
      parentName: "Alimentación",
    },
    paidBy: { memberId: MEMBER_A, name: "E2E Member A" },
    distributions: [
      {
        memberId: MEMBER_A,
        memberName: "E2E Member A",
        percentage: 70,
        amount: 84000,
      },
      {
        memberId: MEMBER_B,
        memberName: "E2E Member B",
        percentage: 30,
        amount: 36000,
      },
    ],
    ...overrides,
  };
}

function createExpenseDetail(expense = createExpenseData()) {
  return {
    ...expense,
    paidByMemberId: expense.paidBy?.memberId ?? MEMBER_A,
    splits: (expense.distributions ?? []).map(({ memberId, percentage }) => ({
      memberId,
      percentage,
    })),
  };
}

function expenseCollection(expense) {
  return {
    data: [expense],
    pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
    summary: { totalCount: 1, totalAmount: expense.totalAmount },
  };
}

async function mockEditorReadApi(page, expense = createExpenseData()) {
  const detail = createExpenseDetail(expense);
  const routePattern = "**/api/**";
  const handler = async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (request.method() !== "GET") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "UNEXPECTED_MOCK_REQUEST", message: "Unexpected mock request." },
        }),
      });
      return;
    }

    let data;
    if (url.pathname === "/api/dashboard/summary") {
      data = {
        totalIncome: 0,
        totalSpent: expense.totalAmount,
        netAmount: -expense.totalAmount,
        expenseCount: 1,
        memberIncome: [],
        byCategory: [
          {
            categoryId: MICRO_MARKET,
            categoryName: "Supermercado",
            amount: expense.totalAmount,
          },
        ],
      };
    } else if (url.pathname === "/api/incomes") {
      data = [];
    } else if (url.pathname === "/api/categories") {
      data = [{ id: "legacy-category", name: "Categoría legacy" }];
    } else if (url.pathname === "/api/categories/hierarchical") {
      data = url.searchParams.get("movementType") === "EXPENSE"
        ? expenseCategories
        : [];
    } else if (url.pathname === "/api/household-members") {
      data = members;
    } else if (url.pathname === "/api/sharing-rules") {
      data = [
        {
          id: RULE_70_30,
          name: "Regla compartida",
          splits: [
            { memberId: MEMBER_A, percentage: 70 },
            { memberId: MEMBER_B, percentage: 30 },
          ],
        },
        {
          id: RULE_100_0,
          name: "Regla propia",
          splits: [
            { memberId: MEMBER_A, percentage: 100 },
            { memberId: MEMBER_B, percentage: 0 },
          ],
        },
        {
          id: RULE_50_50,
          name: "Regla equitativa",
          splits: [
            { memberId: MEMBER_A, percentage: 50 },
            { memberId: MEMBER_B, percentage: 50 },
          ],
        },
      ];
    } else if (url.pathname === "/api/balance") {
      data = { members: [] };
    } else if (url.pathname === "/api/expenses") {
      data = expenseCollection(expense);
    } else if (url.pathname === `/api/expenses/${expense.id}`) {
      data = detail;
    } else {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "UNEXPECTED_MOCK_REQUEST", message: "Unexpected mock request." },
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        url.pathname === "/api/expenses" ? data : { data },
      ),
    });
  };

  await page.route(routePattern, handler);
  return async () => page.unroute(routePattern, handler);
}

async function openExpenseEditor(page, expense = createExpenseData()) {
  await page.goto("/");
  await page.getByRole("button", { name: "Gastos", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Expenses" })).toBeVisible();
  await expect(page.getByText(expense.merchant, { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: `Editar gasto ${expense.merchant}`, exact: true })
    .click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Comercio del gasto")).toHaveValue(expense.merchant);
  return dialog;
}

async function openExpenseTable(page, expense) {
  await mockEditorReadApi(page, expense);
  await page.goto("/");
  await page.getByRole("button", { name: "Gastos", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Expenses" })).toBeVisible();
  return page.locator('.expense-table-cell[data-label="Fecha"]');
}

function collectPatchRequests(page) {
  const requests = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "PATCH" && url.pathname === `/api/expenses/${EXPENSE_ID}`) {
      requests.push(request.postDataJSON());
    }
  });
  return requests;
}

function countExpenseListRequests(page) {
  let count = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/expenses") count += 1;
  });
  return () => count;
}

test("hydrates the real expense editor fields", async ({ page }) => {
  const expense = createExpenseData({ expenseDate: "2026-09-03" });
  await mockEditorReadApi(page, expense);
  const dialog = await openExpenseEditor(page, expense);

  await expect(dialog.getByLabel("Comercio del gasto")).toHaveValue("Mercado E2E");
  await expect(dialog.getByLabel("Descripción del gasto")).toHaveValue("Compra base E2E");
  await expect(dialog.getByLabel("Monto del gasto")).toHaveValue("120000");
  await expect(dialog.getByLabel("Fecha del gasto")).toHaveAttribute("type", "text");
  await expect(dialog.getByLabel("Fecha del gasto")).toHaveValue("03/09/2026");
  await expect(dialog.locator('input[type="date"]')).toHaveCount(0);
  expect(await dialog.getByLabel("Fecha del gasto").inputValue()).toBe("03/09/2026");
  await expect(dialog.getByLabel("Categoría principal del gasto")).toHaveValue(MACRO_FOOD);
  await expect(dialog.getByLabel("Categoría específica del gasto")).toHaveValue(MICRO_MARKET);
  await expect(dialog.getByLabel("Pagado por")).toHaveValue(MEMBER_A);
});
test("renders the expense table date as DD/MM/YYYY", async ({ page }) => {
  const dateCell = await openExpenseTable(
    page,
    createExpenseData({ expenseDate: "2026-09-03" }),
  );

  await expect(dateCell).toHaveText("03/09/2026");
  await expect(dateCell).not.toHaveText("03 de sept de 2026");
});

test("renders another expense table date without locale formatting", async ({ page }) => {
  const dateCell = await openExpenseTable(
    page,
    createExpenseData({ expenseDate: "2026-12-25" }),
  );

  await expect(dateCell).toHaveText("25/12/2026");
  await expect(dateCell).not.toHaveText("25 de dic de 2026");
});

test("uses the normal table text color for expense descriptions", async ({ page }) => {
  const expense = createExpenseData({
    description: "Compra de mercado",
    merchant: "Supermercado",
  });
  await mockEditorReadApi(page, expense);
  await page.goto("/");
  await page.getByRole("button", { name: "Gastos", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Expenses" })).toBeVisible();

  const row = page.locator(".expense-table-row").filter({ hasText: expense.merchant });
  const descriptionCell = row.locator('[data-label="Detalle"]');
  const merchantCell = row.locator('[data-label="Comercio"]');
  const [descriptionColor, merchantColor] = await Promise.all([
    descriptionCell.evaluate((element) => getComputedStyle(element).color),
    merchantCell.evaluate((element) => getComputedStyle(element).color),
  ]);

  expect(descriptionColor).toBe(merchantColor);
});

test("keeps expense description text at the same color as other editor values", async ({ page }) => {
  const expense = createExpenseData();
  await mockEditorReadApi(page, expense);
  const dialog = await openExpenseEditor(page, expense);

  const colors = await dialog
    .getByLabel("Descripción del gasto")
    .evaluate((description) => {
      const merchant = description
        .closest("form")
        ?.querySelector('input[aria-label="Comercio del gasto"]');
      const descriptionStyle = getComputedStyle(description);
      const merchantStyle = merchant ? getComputedStyle(merchant) : null;
      return {
        descriptionColor: descriptionStyle.color,
        descriptionOpacity: descriptionStyle.opacity,
        merchantColor: merchantStyle?.color ?? null,
      };
    });

  expect(colors.descriptionColor).toBe(colors.merchantColor);
  expect(colors.descriptionOpacity).toBe("1");
});

test("centers the expense action icons inside their buttons", async ({ page }) => {
  const expense = createExpenseData();
  await mockEditorReadApi(page, expense);
  await page.goto("/");
  await page.getByRole("button", { name: "Gastos", exact: true }).click();

  const actionButtons = page.locator(".expense-icon-button");
  await expect(actionButtons).toHaveCount(2);
  for (const button of await actionButtons.all()) {
    await expect(button).toHaveCSS("display", "flex");
    await expect(button).toHaveCSS("align-items", "center");
    await expect(button).toHaveCSS("justify-content", "center");
    await expect(button.locator("svg")).toHaveCount(1);
    await expect(button).toHaveCSS("width", "32px");
    await expect(button).toHaveCSS("height", "32px");
    await expect(button.locator("svg")).toHaveCSS("width", "24px");
    await expect(button.locator("svg")).toHaveCSS("height", "24px");
  }
});

test("contains expense table overflow within the table wrapper", async ({ page }) => {
  const expense = createExpenseData();
  await mockEditorReadApi(page, expense);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "Gastos", exact: true }).click();

  const table = page.locator(".expense-table");
  const desktopMetrics = await table.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    bodyClientWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.documentElement.scrollWidth,
  }));
  expect(desktopMetrics.scrollWidth).toBeLessThanOrEqual(
    desktopMetrics.clientWidth + 1,
  );
  expect(desktopMetrics.bodyScrollWidth).toBeLessThanOrEqual(
    desktopMetrics.bodyClientWidth + 1,
  );

  await page.setViewportSize({ width: 600, height: 900 });
  const smallViewportMetrics = await table.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    bodyClientWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.documentElement.scrollWidth,
  }));
  expect(smallViewportMetrics.scrollWidth).toBeGreaterThan(
    smallViewportMetrics.clientWidth,
  );
  expect(smallViewportMetrics.bodyScrollWidth).toBeLessThanOrEqual(
    smallViewportMetrics.bodyClientWidth + 1,
  );
});

test("keeps the editor fields in the creation-flow order", async ({ page }) => {
  const expense = createExpenseData();
  await mockEditorReadApi(page, expense);
  const dialog = await openExpenseEditor(page, expense);

  const labels = await dialog.locator("label").evaluateAll((elements) =>
    elements.map((element) => (element.firstChild?.textContent ?? "").trim()),
  );
  expect(labels).toEqual([
    "Comercio",
    "Monto",
    "Fecha",
    "Pagado por",
    "Regla de reparto",
    "Categoría principal",
    "Categoría específica",
    "Descripción",
  ]);
});

test("sends the edited fields through the real Web PATCH", async ({ page }) => {
  const expense = createExpenseData();
  await mockEditorReadApi(page, expense);
  const patchRequests = collectPatchRequests(page);
  await interceptExpensePatch(page, EXPENSE_ID, {
    status: 200,
    body: { data: createExpenseDetail(expense) },
  });
  const dialog = await openExpenseEditor(page, expense);

  await dialog.getByLabel("Comercio del gasto").fill("Transporte E2E");
  await dialog.getByLabel("Descripción del gasto").fill("Carga de combustible");
  await dialog.getByLabel("Monto del gasto").fill("135000");
  await dialog.getByLabel("Fecha del gasto").fill("25/09/2026");
  await dialog.getByLabel("Categoría principal del gasto").selectOption(MACRO_TRANSPORT);
  await dialog.getByLabel("Categoría específica del gasto").selectOption(MICRO_FUEL);
  await dialog.getByLabel("Pagado por").selectOption(MEMBER_B);
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();

  await expect(dialog).toHaveCount(0);
  await expect.poll(() => patchRequests.length).toBe(1);
  expect(patchRequests[0]).toMatchObject({
    merchant: "Transporte E2E",
    description: "Carga de combustible",
    totalAmount: 135000,
    expenseDate: "2026-09-25",
    categoryId: MICRO_FUEL,
    paidByMemberId: MEMBER_B,
  });
  expect(patchRequests[0].splits).toEqual([
    { memberId: MEMBER_A, percentage: 70 },
    { memberId: MEMBER_B, percentage: 30 },
  ]);
  expect(patchRequests[0].splits.every((split) => !Object.hasOwn(split, "amount"))).toBe(true);
});
test("closes the editor after a successful PATCH", async ({ page }) => {
  const expense = createExpenseData();
  await mockEditorReadApi(page, expense);
  await interceptExpensePatch(page, EXPENSE_ID, {
    status: 200,
    body: { data: createExpenseDetail(expense) },
  });
  const dialog = await openExpenseEditor(page, expense);

  await dialog.getByLabel("Descripción del gasto").fill("Guardado correctamente");
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("p.alert")).toHaveCount(0);
});

test("keeps the editor open after a normal HTTP error", async ({ page }) => {
  const expense = createExpenseData();
  await mockEditorReadApi(page, expense);
  const getExpenseListCount = countExpenseListRequests(page);
  const patchRequests = collectPatchRequests(page);
  await interceptExpensePatch(page, EXPENSE_ID, {
    status: 422,
    body: { error: { code: "VALIDATION_ERROR", message: "Solicitud inválida." } },
  });
  const dialog = await openExpenseEditor(page, expense);
  const listRequestsBeforeSave = getExpenseListCount();

  await dialog.getByLabel("Descripción del gasto").fill("Edición pendiente");
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();

  await expect(page.locator("p.alert")).toContainText("Solicitud inválida.");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Descripción del gasto")).toHaveValue("Edición pendiente");
  await expect.poll(() => patchRequests.length).toBe(1);
  expect(getExpenseListCount()).toBe(listRequestsBeforeSave);
});

test("keeps the editor open for UPDATED_NOT_HYDRATED without retrying", async ({ page }) => {
  const expense = createExpenseData();
  await mockEditorReadApi(page, expense);
  const getExpenseListCount = countExpenseListRequests(page);
  const patchRequests = collectPatchRequests(page);
  await interceptExpensePatch(
    page,
    EXPENSE_ID,
    updatedNotHydratedResponse(EXPENSE_ID),
  );
  const dialog = await openExpenseEditor(page, expense);
  const listRequestsBeforeSave = getExpenseListCount();

  await dialog.getByLabel("Descripción del gasto").fill("Resultado incierto");
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();

  await expect(page.locator("p.alert")).toContainText(
    "El gasto pudo haberse actualizado, pero no se pudo confirmar la recarga. No lo envíes de nuevo para evitar repetir la operación.",
  );
  await expect(dialog).toBeVisible();
  await expect.poll(() => patchRequests.length).toBe(1);
  expect(getExpenseListCount()).toBe(listRequestsBeforeSave);
});

test("preserves the date-only editor contract", async ({ page }) => {
  const expense = createExpenseData({ expenseDate: "2026-09-20" });
  await mockEditorReadApi(page, expense);
  const patchRequests = collectPatchRequests(page);
  await interceptExpensePatch(page, EXPENSE_ID, {
    status: 200,
    body: { data: createExpenseDetail(expense) },
  });
  const dialog = await openExpenseEditor(page, expense);

  await expect(dialog.getByLabel("Fecha del gasto")).toHaveValue("20/09/2026");
  await dialog.getByLabel("Fecha del gasto").fill("25/09/2026");
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => patchRequests.length).toBe(1);
  expect(patchRequests[0].expenseDate).toBe("2026-09-25");
});

test("rejects an invalid displayed date before sending the PATCH", async ({ page }) => {
  const expense = createExpenseData({ expenseDate: "2026-09-20" });
  await mockEditorReadApi(page, expense);
  const patchRequests = collectPatchRequests(page);
  const dialog = await openExpenseEditor(page, expense);

  await dialog.getByLabel("Fecha del gasto").fill("31/02/2026");
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();

  await expect(page.locator("p.alert")).toContainText(
    "Usa una fecha válida con el formato DD/MM/AAAA.",
  );
  await expect(dialog).toBeVisible();
  expect(patchRequests).toHaveLength(0);
});

test("shows a saved 70/30 distribution as a flat rule", async ({ page }) => {
  const expense = createExpenseData();
  await mockEditorReadApi(page, expense);
  const dialog = await openExpenseEditor(page, expense);
  const ruleSelect = dialog.getByLabel("Regla de reparto");
  await expect(ruleSelect).toHaveValue(RULE_70_30);
  await expect(ruleSelect).not.toBeDisabled();
  await expect(ruleSelect.locator("option")).toHaveText([
    "Seleccionar",
    "70/30",
    "100/0",
    "50/50",
  ]);
  await expect(dialog.locator('select[aria-label^="Porcentaje de "]')).toHaveCount(0);
});

test("shows a saved 100/0 distribution as a flat rule", async ({ page }) => {
  const expense = createExpenseData({
    distributions: [
      {
        memberId: MEMBER_A,
        memberName: "E2E Member A",
        percentage: 100,
        amount: 120000,
      },
      {
        memberId: MEMBER_B,
        memberName: "E2E Member B",
        percentage: 0,
        amount: 0,
      },
    ],
  });
  await mockEditorReadApi(page, expense);
  const dialog = await openExpenseEditor(page, expense);
  const ruleSelect = dialog.getByLabel("Regla de reparto");
  await expect(ruleSelect).toHaveValue(RULE_100_0);
  await expect(ruleSelect).not.toBeDisabled();
  await expect(dialog.locator('select[aria-label^="Porcentaje de "]')).toHaveCount(0);
  await dialog.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("shows a saved 50/50 distribution as a flat rule", async ({ page }) => {
  const expense = createExpenseData({
    distributions: [
      {
        memberId: MEMBER_A,
        memberName: "E2E Member A",
        percentage: 50,
        amount: 60000,
      },
      {
        memberId: MEMBER_B,
        memberName: "E2E Member B",
        percentage: 50,
        amount: 60000,
      },
    ],
  });
  await mockEditorReadApi(page, expense);
  const dialog = await openExpenseEditor(page, expense);
  const ruleSelect = dialog.getByLabel("Regla de reparto");
  await expect(ruleSelect).toHaveValue(RULE_50_50);
  await expect(ruleSelect).not.toBeDisabled();
  await expect(dialog.locator('select[aria-label^="Porcentaje de "]')).toHaveCount(0);
});

test("shows a single full split as the two-part 100/0 rule", async ({ page }) => {
  const expense = createExpenseData({
    distributions: [
      {
        memberId: MEMBER_A,
        memberName: "E2E Member A",
        percentage: 100,
        amount: 120000,
      },
    ],
  });
  await mockEditorReadApi(page, expense);
  const dialog = await openExpenseEditor(page, expense);
  const ruleSelect = dialog.getByLabel("Regla de reparto");
  await expect(ruleSelect).toHaveValue(RULE_100_0);
  await expect(ruleSelect).not.toBeDisabled();
  await expect(dialog.locator('select[aria-label^="Porcentaje de "]')).toHaveCount(0);
});

test("keeps sharing-rule options separate from the saved editor rule", async ({ page }) => {
  const expense = createExpenseData({
    distributions: [
      {
        memberId: MEMBER_A,
        memberName: "E2E Member A",
        percentage: 100,
        amount: 120000,
      },
      {
        memberId: MEMBER_B,
        memberName: "E2E Member B",
        percentage: 0,
        amount: 0,
      },
    ],
  });
  await mockEditorReadApi(page, expense);
  await page.goto("/");
  await page.getByRole("button", { name: "Gastos", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Expenses" })).toBeVisible();
  await page.getByRole("button", { name: /Registrar gasto/ }).first().click();

  const sharingRuleSelect = page
    .locator("label")
    .filter({ hasText: "Regla de reparto" })
    .locator("select");
  await expect(sharingRuleSelect.locator("option")).toHaveText([
    "Seleccionar",
    "Regla compartida",
    "Regla propia",
    "Regla equitativa",
  ]);
  await page.getByRole("button", { name: "Cerrar formulario de gasto" }).click();

  const dialog = await openExpenseEditor(page, expense);
  const ruleSelect = dialog.getByLabel("Regla de reparto");
  await expect(ruleSelect).toHaveValue(RULE_100_0);
  await expect(ruleSelect).not.toBeDisabled();
  await expect(dialog.locator('select[aria-label^="Porcentaje de "]')).toHaveCount(0);
});

test("changes 100/0 to 50/50 and sends only the new splits", async ({ page }) => {
  const expense = createExpenseData({
    distributions: [
      {
        memberId: MEMBER_A,
        memberName: "E2E Member A",
        percentage: 100,
        amount: 120000,
      },
      {
        memberId: MEMBER_B,
        memberName: "E2E Member B",
        percentage: 0,
        amount: 0,
      },
    ],
  });
  await mockEditorReadApi(page, expense);
  const patchRequests = collectPatchRequests(page);
  await interceptExpensePatch(page, EXPENSE_ID, {
    status: 200,
    body: { data: createExpenseDetail(expense) },
  });
  const dialog = await openExpenseEditor(page, expense);
  const ruleSelect = dialog.getByLabel("Regla de reparto");

  await ruleSelect.selectOption(RULE_50_50);
  await expect(ruleSelect).toHaveValue(RULE_50_50);
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();

  await expect(dialog).toHaveCount(0);
  await expect.poll(() => patchRequests.length).toBe(1);
  expect(patchRequests[0]).toMatchObject({
    merchant: expense.merchant,
    description: expense.description,
    totalAmount: expense.totalAmount,
    expenseDate: expense.expenseDate,
    categoryId: MICRO_MARKET,
    paidByMemberId: MEMBER_A,
  });
  expect(patchRequests[0].splits).toEqual([
    { memberId: MEMBER_A, percentage: 50 },
    { memberId: MEMBER_B, percentage: 50 },
  ]);
  expect(patchRequests[0]).not.toHaveProperty("ruleId");
  expect(patchRequests[0]).not.toHaveProperty("name");
});

test("changes 50/50 to 100/0 and sends the corresponding splits", async ({ page }) => {
  const expense = createExpenseData({
    distributions: [
      {
        memberId: MEMBER_A,
        memberName: "E2E Member A",
        percentage: 50,
        amount: 60000,
      },
      {
        memberId: MEMBER_B,
        memberName: "E2E Member B",
        percentage: 50,
        amount: 60000,
      },
    ],
  });
  await mockEditorReadApi(page, expense);
  const patchRequests = collectPatchRequests(page);
  await interceptExpensePatch(page, EXPENSE_ID, {
    status: 200,
    body: { data: createExpenseDetail(expense) },
  });
  const dialog = await openExpenseEditor(page, expense);
  const ruleSelect = dialog.getByLabel("Regla de reparto");

  await expect(ruleSelect).toHaveValue(RULE_50_50);
  await ruleSelect.selectOption(RULE_100_0);
  await expect(ruleSelect).toHaveValue(RULE_100_0);
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();

  await expect(dialog).toHaveCount(0);
  await expect.poll(() => patchRequests.length).toBe(1);
  expect(patchRequests[0].splits).toEqual([
    { memberId: MEMBER_A, percentage: 100 },
    { memberId: MEMBER_B, percentage: 0 },
  ]);
  expect(patchRequests[0]).not.toHaveProperty("ruleId");
  expect(patchRequests[0]).not.toHaveProperty("name");
});

test("changes 70/30 to another existing rule", async ({ page }) => {
  const expense = createExpenseData();
  await mockEditorReadApi(page, expense);
  const patchRequests = collectPatchRequests(page);
  await interceptExpensePatch(page, EXPENSE_ID, {
    status: 200,
    body: { data: createExpenseDetail(expense) },
  });
  const dialog = await openExpenseEditor(page, expense);
  const ruleSelect = dialog.getByLabel("Regla de reparto");

  await expect(ruleSelect).toHaveValue(RULE_70_30);
  await ruleSelect.selectOption(RULE_100_0);
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();

  await expect(dialog).toHaveCount(0);
  await expect.poll(() => patchRequests.length).toBe(1);
  expect(patchRequests[0].splits).toEqual([
    { memberId: MEMBER_A, percentage: 100 },
    { memberId: MEMBER_B, percentage: 0 },
  ]);
});

test("sends the changed amount while preserving the saved distribution", async ({ page }) => {
  const expense = createExpenseData({
    totalAmount: 100000,
    distributions: [
      {
        memberId: MEMBER_A,
        memberName: "E2E Member A",
        percentage: 70,
        amount: 70000,
      },
      {
        memberId: MEMBER_B,
        memberName: "E2E Member B",
        percentage: 30,
        amount: 30000,
      },
    ],
  });
  await mockEditorReadApi(page, expense);
  const patchRequests = collectPatchRequests(page);
  await interceptExpensePatch(page, EXPENSE_ID, {
    status: 200,
    body: { data: createExpenseDetail(expense) },
  });
  const dialog = await openExpenseEditor(page, expense);

  await dialog.getByLabel("Monto del gasto").fill("200000");
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();

  await expect(dialog).toHaveCount(0);
  await expect.poll(() => patchRequests.length).toBe(1);
  expect(patchRequests[0].totalAmount).toBe(200000);
  expect(patchRequests[0].splits).toEqual([
    { memberId: MEMBER_A, percentage: 70 },
    { memberId: MEMBER_B, percentage: 30 },
  ]);
  expect(patchRequests[0].splits.every((split) => !Object.hasOwn(split, "amount"))).toBe(true);
});

test("preserves a 70/30 distribution when the amount changes", async ({ page }) => {
  const expense = createExpenseData({
    totalAmount: 100000,
    distributions: [
      {
        memberId: MEMBER_A,
        memberName: "E2E Member A",
        percentage: 70,
        amount: 70000,
      },
      {
        memberId: MEMBER_B,
        memberName: "E2E Member B",
        percentage: 30,
        amount: 30000,
      },
    ],
  });
  await mockEditorReadApi(page, expense);
  const patchRequests = collectPatchRequests(page);
  await interceptExpensePatch(page, EXPENSE_ID, {
    status: 200,
    body: { data: createExpenseDetail(expense) },
  });
  const dialog = await openExpenseEditor(page, expense);

  await dialog.getByLabel("Monto del gasto").fill("200000");
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();

  await expect(dialog).toHaveCount(0);
  await expect.poll(() => patchRequests.length).toBe(1);
  expect(patchRequests[0].totalAmount).toBe(200000);
  expect(patchRequests[0].splits).toEqual([
    { memberId: MEMBER_A, percentage: 70 },
    { memberId: MEMBER_B, percentage: 30 },
  ]);
  expect(patchRequests[0].splits.every((split) => !Object.hasOwn(split, "amount"))).toBe(true);
});

test("preserves a non-uniform 55/45 distribution when the amount changes", async ({ page }) => {
  const expense = createExpenseData({
    totalAmount: 100000,
    distributions: [
      {
        memberId: MEMBER_A,
        memberName: "E2E Member A",
        percentage: 55,
        amount: 55000,
      },
      {
        memberId: MEMBER_B,
        memberName: "E2E Member B",
        percentage: 45,
        amount: 45000,
      },
    ],
  });
  await mockEditorReadApi(page, expense);
  const patchRequests = collectPatchRequests(page);
  await interceptExpensePatch(page, EXPENSE_ID, {
    status: 200,
    body: { data: createExpenseDetail(expense) },
  });
  const dialog = await openExpenseEditor(page, expense);

  await dialog.getByLabel("Monto del gasto").fill("123000");
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();

  await expect(dialog).toHaveCount(0);
  await expect.poll(() => patchRequests.length).toBe(1);
  expect(patchRequests[0].totalAmount).toBe(123000);
  expect(patchRequests[0].splits).toEqual([
    { memberId: MEMBER_A, percentage: 55 },
    { memberId: MEMBER_B, percentage: 45 },
  ]);
  expect(patchRequests[0].splits.every((split) => !Object.hasOwn(split, "amount"))).toBe(true);
});

test("preserves a 100/0 distribution when the amount changes", async ({ page }) => {
  const expense = createExpenseData({
    totalAmount: 100000,
    distributions: [
      {
        memberId: MEMBER_A,
        memberName: "E2E Member A",
        percentage: 100,
        amount: 100000,
      },
      {
        memberId: MEMBER_B,
        memberName: "E2E Member B",
        percentage: 0,
        amount: 0,
      },
    ],
  });
  await mockEditorReadApi(page, expense);
  const patchRequests = collectPatchRequests(page);
  await interceptExpensePatch(page, EXPENSE_ID, {
    status: 200,
    body: { data: createExpenseDetail(expense) },
  });
  const dialog = await openExpenseEditor(page, expense);

  await dialog.getByLabel("Monto del gasto").fill("200000");
  await dialog.getByRole("button", { name: "Guardar", exact: true }).click();

  await expect(dialog).toHaveCount(0);
  await expect.poll(() => patchRequests.length).toBe(1);
  expect(patchRequests[0].totalAmount).toBe(200000);
  expect(patchRequests[0].splits).toEqual([
    { memberId: MEMBER_A, percentage: 100 },
    { memberId: MEMBER_B, percentage: 0 },
  ]);
  expect(patchRequests[0].splits.every((split) => !Object.hasOwn(split, "amount"))).toBe(true);
});
