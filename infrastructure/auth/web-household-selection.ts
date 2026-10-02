import { cookies } from "next/headers";

export const WEB_SELECTED_HOUSEHOLD_COOKIE = "housemate_selected_household";

export async function getSelectedWebHouseholdId(): Promise<string | null> {
  const value = (await cookies()).get(WEB_SELECTED_HOUSEHOLD_COOKIE)?.value;
  return value || null;
}

export async function setSelectedWebHouseholdId(householdId: string): Promise<void> {
  (await cookies()).set(WEB_SELECTED_HOUSEHOLD_COOKIE, householdId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function clearSelectedWebHouseholdId(): Promise<void> {
  (await cookies()).set(WEB_SELECTED_HOUSEHOLD_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}
