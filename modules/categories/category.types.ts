export interface Category {
  id: string;
  name: string;
}

export type CategoryDomainErrorCode = "PERSISTENCE_ERROR";

export class CategoryDomainError extends Error {
  readonly code: CategoryDomainErrorCode;

  constructor(code: CategoryDomainErrorCode, message: string) {
    super(message);
    this.name = "CategoryDomainError";
    this.code = code;
  }
}
