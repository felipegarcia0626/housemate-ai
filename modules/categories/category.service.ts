import {
  CategoryRepositoryError,
  listHierarchicalCategories as listHierarchicalCategoriesInRepository,
  listCategories as listCategoriesInRepository,
} from "./category.repository";
import {
  CategoryDomainError,
  type Category,
  type CategoryMovementType,
  type HierarchicalCategory,
} from "./category.types";

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

export async function listHierarchicalCategories(
  movementType: CategoryMovementType,
): Promise<HierarchicalCategory[]> {
  try {
    return await listHierarchicalCategoriesInRepository(movementType);
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
