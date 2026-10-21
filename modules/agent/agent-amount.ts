const MAX_AMOUNT_CENTS = BigInt("99999999999999"); // NUMERIC(14,2)
const ZERO = BigInt(0);
const ONE_HUNDRED = BigInt(100);

const SMALL_SPANISH_NUMBERS: Record<string, bigint> = {
  un: BigInt(1),
  una: BigInt(1),
  uno: BigInt(1),
  dos: BigInt(2),
  tres: BigInt(3),
  cuatro: BigInt(4),
  cinco: BigInt(5),
  seis: BigInt(6),
  siete: BigInt(7),
  ocho: BigInt(8),
  nueve: BigInt(9),
  diez: BigInt(10),
};

function numericCents(value: string): bigint | null {
  const grouped = /^(\d{1,3}(?:\.\d{3})+)(?:,(\d{1,2}))?$/.exec(value);
  const plain = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(value);
  if (!grouped && !plain) return null;

  const integer = (grouped?.[1] ?? plain![1]).replace(/\./g, "");
  const fraction = (grouped?.[2] ?? plain?.[2] ?? "").padEnd(2, "0");
  return BigInt(integer) * ONE_HUNDRED + BigInt(fraction);
}

function coefficientCents(value: string): bigint | null {
  const word = SMALL_SPANISH_NUMBERS[value];
  return word === undefined ? numericCents(value) : word * ONE_HUNDRED;
}

function amountCents(value: string): bigint | null {
  const normalized = value
    .trim()
    .toLocaleLowerCase("es")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
  let amount = normalized.replace(/^cop\s*/, "").replace(/^\$\s*/, "");
  amount = amount.replace(/\s+(?:de\s+)?pesos?$/, "").trim();

  if (amount === "mil") return BigInt(100000);
  if (amount === "medio millon") return BigInt(50000000);

  const scaled = /^(.+?)\s+(mil|millon|millones)(\s+y\s+medio)?$/.exec(amount);
  if (!scaled) return numericCents(amount);

  const coefficient = coefficientCents(scaled[1]);
  if (coefficient === null || (scaled[3] && scaled[2] === "mil")) return null;
  const multiplier = scaled[2] === "mil" ? BigInt(1000) : BigInt(1000000);
  return (
    coefficient * multiplier + (scaled[3] ? BigInt(50) * multiplier : ZERO)
  );
}

export function normalizeAgentAmount(
  value: string | null,
): { decimal: string; amount: number } | null {
  if (typeof value !== "string") return null;
  const cents = amountCents(value);
  if (cents === null || cents <= ZERO || cents > MAX_AMOUNT_CENTS) return null;

  const whole = cents / ONE_HUNDRED;
  const fraction = cents % ONE_HUNDRED;
  const decimal =
    fraction === ZERO
      ? String(whole)
      : `${whole}.${String(fraction).padStart(2, "0").replace(/0$/, "")}`;
  const amount = Number(decimal);
  if (!Number.isFinite(amount) || numericCents(String(amount)) !== cents) {
    return null;
  }
  return { decimal, amount };
}
