export interface PersistenceDiagnosticContext {
  repository: string;
  operation: string;
  database: "supabase";
  tableOrRpc: string;
}
