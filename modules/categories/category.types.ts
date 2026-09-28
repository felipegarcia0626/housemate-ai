export interface Category {
  id: string;
  name: string;
}

export type CategoryMovementType = "EXPENSE" | "INCOME";

export type CategoryLevel = "MACRO" | "MICRO";

export function normalizeCategoryName(value: string): string {
  return value
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es");
}

export interface HierarchicalCategory {
  id: string;
  name: string;
  movementType: CategoryMovementType;
  level: CategoryLevel;
  parentId: string;
  isActive: true;
  macroId: string;
  macroName: string;
  path: string;
}

export type CategoryDomainErrorCode =
  | "PERSISTENCE_ERROR"
  | "VALIDATION_ERROR"
  | "CATEGORY_INACTIVE";

export class CategoryDomainError extends Error {
  readonly code: CategoryDomainErrorCode;

  constructor(code: CategoryDomainErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CategoryDomainError";
    this.code = code;
  }
}
