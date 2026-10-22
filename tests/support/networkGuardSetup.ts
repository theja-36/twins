import { installNetworkGuard } from "./networkGuard";

// vitest `setupFiles` entry: runs in each test worker before any test file is imported.
installNetworkGuard();
