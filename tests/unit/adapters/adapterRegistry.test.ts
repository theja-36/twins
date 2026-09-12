import { describe, expect, it } from "vitest";
import {
  createAdapterRegistry,
  ProviderNotRegisteredError,
} from "../../../packages/shared/src/index";

describe("createAdapterRegistry", () => {
  it("registers and retrieves an adapter by name", () => {
    const registry = createAdapterRegistry<{ ping: () => string }>("test");
    registry.register("fixture", { ping: () => "pong" });

    expect(registry.has("fixture")).toBe(true);
    expect(registry.get("fixture").ping()).toBe("pong");
    expect(registry.list()).toEqual(["fixture"]);
  });

  it("throws ProviderNotRegisteredError for an unknown name, listing known providers", () => {
    const registry = createAdapterRegistry<{ ping: () => string }>("test");
    registry.register("known", { ping: () => "pong" });

    expect(() => registry.get("missing")).toThrow(ProviderNotRegisteredError);
    try {
      registry.get("missing");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderNotRegisteredError);
      expect((err as Error).message).toContain("known");
    }
  });

  it("replaces an adapter registered under the same name", () => {
    const registry = createAdapterRegistry<{ value: number }>("test");
    registry.register("a", { value: 1 });
    registry.register("a", { value: 2 });
    expect(registry.get("a").value).toBe(2);
  });

  it("unregisters an adapter", () => {
    const registry = createAdapterRegistry<{ value: number }>("test");
    registry.register("a", { value: 1 });
    registry.unregister("a");
    expect(registry.has("a")).toBe(false);
    expect(() => registry.get("a")).toThrow(ProviderNotRegisteredError);
  });
});
