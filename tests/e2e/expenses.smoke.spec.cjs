const { test, expect } = require("@playwright/test");

test("opens the isolated Expenses page", async ({ page }) => {
  const expensesResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "GET" &&
      url.pathname === "/api/expenses" &&
      url.searchParams.get("page") === "1" &&
      url.searchParams.get("pageSize") === "25"
    );
  });

  await page.goto("/");

  const expensesResponse = await expensesResponsePromise;
  expect(expensesResponse.status()).toBe(200);
  const collection = await expensesResponse.json();
  expect(Array.isArray(collection.data)).toBe(true);
  expect(collection.pagination.page).toBe(1);
  expect(collection.pagination.pageSize).toBe(25);
  expect(collection.pagination.total).toBeGreaterThanOrEqual(2);
  expect(collection.pagination.totalPages).toBeGreaterThanOrEqual(1);
  expect(collection.summary).toBeDefined();

  await page.getByRole("button", { name: "Gastos", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Expenses" })).toBeVisible();
  await expect(page.locator(".expense-table")).toBeVisible();
  await expect(page.locator(".expense-table-row").first()).toBeVisible();
  await expect(
    page.getByText("Solicitud inválida.", { exact: true }),
  ).toHaveCount(0);
});
