const MAX_SAFE_CENTS = BigInt(Number.MAX_SAFE_INTEGER);
const COP_INTEGER_FORMATTER = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
const DECIMAL_SEPARATOR =
  new Intl.NumberFormat("es-CO", { useGrouping: false })
    .formatToParts(1.1)
    .find((part) => part.type === "decimal")?.value ?? ",";

/** Converts a numeric COP amount to integer cents via its decimal text. */
export function copMoneyToCents(value: number): bigint {
  if (!Number.isFinite(value)) {
    throw new RangeError("Monetary amount must be finite.");
  }

  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(value.toString());
  if (!match) {
    throw new RangeError(
      "Monetary amount must have at most two decimal places.",
    );
  }

  const [, sign, integer, decimal = ""] = match;
  const cents = BigInt(integer) * BigInt(100) + BigInt(decimal.padEnd(2, "0"));
  if (cents > MAX_SAFE_CENTS) {
    throw new RangeError("Monetary amount exceeds the safe cent range.");
  }

  return sign ? -cents : cents;
}

/** Formats COP cents without converting them to floating point. */
export function formatCopCents(cents: bigint): string {
  if (typeof cents !== "bigint") {
    throw new TypeError("COP cents must be a bigint.");
  }

  const absoluteCents = cents < BigInt(0) ? -cents : cents;
  const integer = absoluteCents / BigInt(100);
  const fraction = (absoluteCents % BigInt(100)).toString().padStart(2, "0");
  const integerAmount = COP_INTEGER_FORMATTER.format(integer);
  const localizedInteger = integerAmount.replace(/[\u00a0\u202f]/g, " ");
  const signPrefix = cents < BigInt(0) ? "-" : "";
  const decimalAmount =
    fraction === "00" ? "" : `${DECIMAL_SEPARATOR}${fraction}`;

  return `${signPrefix}${localizedInteger}${decimalAmount}`;
}

/** Formats a COP amount from the domain's decimal number representation. */
export function formatCopMoney(value: number): string {
  return formatCopCents(copMoneyToCents(value));
}

/** Renders a proposal category only when its state or label is explicit. */
export function proposalCategoryLine(
  categoryId: string | null | undefined,
  categoryLabel?: string | null,
): string | null {
  if (categoryId === null) return "Categoría: Sin categoría";
  const label = categoryLabel?.trim();
  return label ? `Categoría: ${label}` : null;
}
