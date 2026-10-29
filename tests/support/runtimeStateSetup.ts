import { configureRuntimeState, inMemoryStateSource } from "../../packages/runtime-state/src/index";

// vitest `setupFiles` entry: gives every test worker an explicit, in-memory runtime safety state with the SEEDED defaults
// (trading off, intake on, kill switch off), uncached so a test that flips it sees the change at once. Tests of the safety behaviour
// itself configure their own source (or use the real database); production entry points never import this file.
configureRuntimeState({ source: inMemoryStateSource(), ttlMs: 0, failureTtlMs: 0 });
