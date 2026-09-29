function updatedNotHydratedResponse(expenseId) {
  return {
    status: 202,
    body: {
      error: {
        code: "UPDATED_NOT_HYDRATED",
        message: "El gasto fue actualizado pero no pudo cargarse.",
        expenseId,
      },
    },
  };
}

async function interceptExpensePatch(page, expenseId, response) {
  const routePattern = "**/api/expenses/**";
  const handler = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      request.method() === "PATCH" &&
      url.pathname === `/api/expenses/${expenseId}`
    ) {
      await route.fulfill({
        status: response.status,
        contentType: "application/json",
        body: JSON.stringify(response.body),
      });
      return;
    }
    await route.fallback();
  };

  await page.route(routePattern, handler);
  return async () => page.unroute(routePattern, handler);
}

module.exports = {
  interceptExpensePatch,
  updatedNotHydratedResponse,
};
