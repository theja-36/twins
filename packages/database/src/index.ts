export * as schema from "./schema/index";
export {
  getDb,
  getPool,
  createDb,
  createBoundedDb,
  attachPoolErrorHandler,
  closeDb,
  type Db,
  type BoundedDbHandle,
  type PoolErrorDiagnostic,
  type PoolErrorStats,
  type PoolErrorSink,
} from "./client";
