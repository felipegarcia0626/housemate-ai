import {
  CategoryRepositoryError,
  createOrReuseMicroCategory as createOrReuseMicroCategoryInRepository,
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

export async function createOrReuseMicroCategory(input: {
  name: string;
  movementType: CategoryMovementType;
  parentMacroId: string;
}): Promise<HierarchicalCategory> {
  try {
    return await createOrReuseMicroCategoryInRepository(input);
  } catch (error) {
    if (!(error instanceof CategoryRepositoryError)) {
      throw new CategoryDomainError(
        "PERSISTENCE_ERROR",
        "Categories could not be created.",
      );
    }

    if (error.code === "INVALID_NAME") {
      throw new CategoryDomainError(
        "VALIDATION_ERROR",
        "The category name is invalid.",
      );
    }
    if (error.code === "PARENT_NOT_FOUND") {
      throw new CategoryDomainError(
        "VALIDATION_ERROR",
        "The category parent does not exist.",
      );
    }
    if (error.code === "PARENT_INVALID") {
      throw new CategoryDomainError(
        "VALIDATION_ERROR",
        "The category parent is not a valid macro for this movement.",
      );
    }
    if (error.code === "PARENT_INACTIVE") {
      throw new CategoryDomainError(
        "VALIDATION_ERROR",
        "The category parent is inactive.",
      );
    }
    if (error.code === "INACTIVE_CONFLICT") {
      throw new CategoryDomainError(
        "CATEGORY_INACTIVE",
        "An inactive category with this name already exists.",
      );
    }
    throw new CategoryDomainError(
      "PERSISTENCE_ERROR",
      "Categories could not be created.",
    );
  }
}
