import {
  SharingRuleDomainError,
  type CalculateSplitInput,
} from "./sharing-rule.types";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function invalid(message: string): never {
  throw new SharingRuleDomainError("VALIDATION_ERROR", message);
}
export function validateSharingRuleUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) invalid(`${field} must be a valid UUID.`);
}
function scaled(
  value: number,
  scale: number,
  precision: number,
  field: string,
): bigint {
  if (!Number.isFinite(value)) invalid(`${field} must be a finite number.`);
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match)
    invalid(
      `${field} must be a non-negative decimal without exponent notation.`,
    );
  const fraction = match[2] ?? "";
  if (fraction.length > scale)
    invalid(`${field} supports at most ${scale} decimal places.`);
  const representation = `${match[1]}${fraction.padEnd(scale, "0")}`.replace(
    /^0+(?=\d)/,
    "",
  );
  if (representation.length > precision)
    invalid(`${field} exceeds the supported precision.`);
  return BigInt(representation);
}
export function validateCalculateSplitInput(input: CalculateSplitInput): {
  amountCents: bigint;
  percentageBasisPoints: bigint[];
} {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    invalid("input must be an object.");
  if ("householdId" in input)
    invalid("householdId must come from the controlled context.");
  const amountCents = scaled(input.amount, 2, 14, "amount");
  if (amountCents <= BigInt(0)) invalid("amount must be greater than zero.");
  if (!Array.isArray(input.splits) || input.splits.length === 0)
    invalid("splits must be a non-empty array.");
  const seen = new Set<string>();
  const percentageBasisPoints = input.splits.map((split, index) => {
    if (typeof split !== "object" || split === null)
      invalid(`splits[${index}] must be an object.`);
    validateSharingRuleUuid(split.memberId, `splits[${index}].memberId`);
    const member = split.memberId.toLowerCase();
    if (seen.has(member)) invalid("splits cannot contain duplicate members.");
    seen.add(member);
    const percentage = scaled(
      split.percentage,
      2,
      5,
      `splits[${index}].percentage`,
    );
    if (percentage > BigInt(10_000))
      invalid(`splits[${index}].percentage must be between 0 and 100.`);
    return percentage;
  });
  if (
    percentageBasisPoints.reduce((sum, value) => sum + value, BigInt(0)) !==
    BigInt(10_000)
  )
    invalid("split percentages must sum exactly to 100.00.");
  return { amountCents, percentageBasisPoints };
}
