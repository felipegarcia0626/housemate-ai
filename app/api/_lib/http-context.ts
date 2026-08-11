import {
  resolveActorContext,
  resolveHouseholdContext,
} from "@/modules/context/context.service";
import type {
  HttpActorContext,
  HttpHouseholdContext,
} from "@/modules/context/context.types";

export function getConfiguredHttpHouseholdContext(): Promise<HttpHouseholdContext> {
  return resolveHouseholdContext(process.env.HOUSEMATE_MVP_HOUSEHOLD_ID);
}

export function getConfiguredHttpActorContext(): Promise<HttpActorContext> {
  return resolveActorContext(
    process.env.HOUSEMATE_MVP_HOUSEHOLD_ID,
    process.env.HOUSEMATE_MVP_MEMBER_ID,
  );
}
