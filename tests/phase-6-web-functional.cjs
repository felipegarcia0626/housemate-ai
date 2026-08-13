const fs = require("node:fs");
const path = require("node:path");

const page = fs.readFileSync(
  path.join(__dirname, "..", "app", "page.tsx"),
  "utf8",
);

for (const endpoint of [
  "/api/dashboard/summary",
  "/api/expenses",
  "/api/incomes",
  "/api/categories",
  "/api/sharing-rules",
  "/api/balance",
]) {
  if (!page.includes(endpoint))
    throw new Error(`Missing UI API integration: ${endpoint}`);
}

for (const operation of ["POST", "PATCH", "DELETE"]) {
  if (!page.includes(`method: \"${operation}\"`))
    throw new Error(`Missing UI mutation: ${operation}`);
}

for (const forbidden of [
  "getSupabaseAdminClient",
  ".from(",
  ".rpc(",
  "householdId",
]) {
  if (page.includes(forbidden))
    throw new Error(`UI must not contain ${forbidden}`);
}

for (const label of [
  "Dashboard",
  "Gastos",
  "Ingresos",
  "Balance",
  "Crear gasto",
  "Crear ingreso",
]) {
  if (!page.includes(label)) throw new Error(`Missing UI label: ${label}`);
}

console.log(
  "PASS Web/PWA consumes the existing HTTP APIs without direct persistence access",
);
