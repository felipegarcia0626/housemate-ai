import { listCategories } from "@/modules/categories/category.service";
import type { Category } from "@/modules/categories/category.types";
import type { AgentContext } from "../agent.types";

export async function getCategoriesTool(
  _context: AgentContext,
): Promise<Category[]> {
  return listCategories();
}
