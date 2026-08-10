import {
  CategoryRepositoryError,
  listCategories as listCategoriesInRepository,
} from "./category.repository";
import { CategoryDomainError, type Category } from "./category.types";

export async function listCategories(): Promise<Category[]> {
  try {
    return await listCategoriesInRepository();
  } catch (error) {
    if (error instanceof CategoryRepositoryError) {
      throw new CategoryDomainError(
        "PERSISTENCE_ERROR",
        "Categories could not be loaded.",
      );
    }

    throw new CategoryDomainError(
      "PERSISTENCE_ERROR",
      "Categories could not be loaded.",
    );
  }
}
