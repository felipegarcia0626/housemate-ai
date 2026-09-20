import {
  listCategories,
  listHierarchicalCategories,
} from "@/modules/categories/category.service";
import type {
  Category,
  CategoryMovementType,
  HierarchicalCategory,
} from "@/modules/categories/category.types";
import type { AgentContext } from "../agent.types";

function isCategoryMovementType(value: unknown): value is CategoryMovementType {
  return value === "EXPENSE" || value === "INCOME";
}

export function getCategoriesTool(
  context: AgentContext,
  movementType: CategoryMovementType,
): Promise<HierarchicalCategory[]>;
export function getCategoriesTool(context: AgentContext): Promise<Category[]>;

export async function getCategoriesTool(
  _context: AgentContext,
  movementType?: CategoryMovementType,
): Promise<Category[]> {
  if (movementType !== undefined) {
    if (!isCategoryMovementType(movementType)) {
      throw new Error("Invalid category movement type.");
    }
    return listHierarchicalCategories(movementType);
  }

  return listCategories();
}
