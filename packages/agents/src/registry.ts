import { AgentContractError, validateAgentContract, type AgentContract, type AgentDefinition } from "./contract";
import type { AgentEngineConfig } from "./config";

/**
 * The agent registry (Stage 5 / Task 1): registers validated agents, prevents duplicate ids, honours the enable / disable configuration and produces a deterministic dependency
 * ordering (execution "levels": agents in one level are independent and may run in parallel). An agent id has exactly ONE registered definition; changing an agent means a new
 * version of the same id (the persisted registry snapshots keep every version that ever ran).
 */
export interface ExecutionPlan {
  /** Enabled agents in deterministic order (level by level, then by id). */
  agents: AgentDefinition[];
  /** Independent groups: every agent depends only on agents of earlier levels. */
  levels: string[][];
  /** Required agents that are not registered or are disabled: they can never produce a result, so the run is INCOMPLETE. */
  missingRequired: Array<{ agentId: string; reason: "NOT_REGISTERED" | "DISABLED" }>;
}

export class AgentRegistry {
  private readonly defs = new Map<string, AgentDefinition>();

  register(def: AgentDefinition): void {
    if (typeof def?.run !== "function") throw new AgentContractError("AGENT_HAS_NO_RUN", "an agent must provide a run function");
    const contract = validateAgentContract(def.contract);
    if (this.defs.has(contract.agentId)) throw new AgentContractError("DUPLICATE_AGENT_ID", `agent id ${contract.agentId} is already registered`);
    this.defs.set(contract.agentId, Object.freeze({ contract: Object.freeze(contract) as AgentContract, run: def.run }));
  }
  has(agentId: string): boolean { return this.defs.has(agentId); }
  get(agentId: string): AgentDefinition | undefined { return this.defs.get(agentId); }
  /** Registered contracts, sorted by id (a registry snapshot). */
  snapshot(): AgentContract[] { return [...this.defs.values()].map((d) => d.contract).sort((a, b) => (a.agentId < b.agentId ? -1 : 1)); }

  /** Applies the configuration and orders the enabled agents. Throws on a broken graph (missing / disabled dependency, cycle): a mis-wired engine must not run. */
  resolve(config: Pick<AgentEngineConfig, "disabledAgents" | "requiredAgents">): ExecutionPlan {
    const enabled = [...this.defs.values()].filter((d) => !config.disabledAgents.includes(d.contract.agentId)).sort((a, b) => (a.contract.agentId < b.contract.agentId ? -1 : 1));
    const ids = new Set(enabled.map((d) => d.contract.agentId));
    for (const d of enabled) for (const dep of d.contract.dependsOn) {
      if (!ids.has(dep)) throw new AgentContractError(this.defs.has(dep) ? "DEPENDENCY_DISABLED" : "DEPENDENCY_NOT_REGISTERED", `agent ${d.contract.agentId} depends on ${dep}, which is ${this.defs.has(dep) ? "disabled" : "not registered"}`);
    }
    const levels: string[][] = [];
    const placed = new Set<string>();
    let remaining = enabled;
    while (remaining.length > 0) {
      // soft dependencies only order: a registered, enabled one must run first; an absent or disabled one is ignored
      const level = remaining.filter((d) => d.contract.dependsOn.every((dep) => placed.has(dep)) && (d.contract.softDependsOn ?? []).every((dep) => !ids.has(dep) || placed.has(dep)));
      if (level.length === 0) throw new AgentContractError("DEPENDENCY_CYCLE", "the agent dependency graph has a cycle");
      levels.push(level.map((d) => d.contract.agentId));
      for (const d of level) placed.add(d.contract.agentId);
      remaining = remaining.filter((d) => !placed.has(d.contract.agentId));
    }
    const byId = new Map(enabled.map((d) => [d.contract.agentId, d]));
    return {
      agents: levels.flat().map((id) => byId.get(id) as AgentDefinition), levels,
      missingRequired: config.requiredAgents.filter((id) => !ids.has(id)).map((agentId) => ({ agentId, reason: this.defs.has(agentId) ? ("DISABLED" as const) : ("NOT_REGISTERED" as const) })),
    };
  }
}
/** The production registry. NO research agent is implemented yet (later Stage 5 tasks add them); with the engine disabled this is never consulted. */
export function createDefaultRegistry(): AgentRegistry { return new AgentRegistry(); }
