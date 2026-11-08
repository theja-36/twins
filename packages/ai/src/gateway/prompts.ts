import { createHash } from "node:crypto";

/** A versioned prompt template. The registry hashes system text + template so a changed prompt can never reuse an old version label. */
export interface PromptTemplate { id: string; version: string; task: string; system: string; template: string; variables: readonly string[] }
export interface RegisteredPrompt extends PromptTemplate { sha256: string }
const FORBIDDEN_KEYS = /^(message|messagetext|raw|rawtext|text|body|content)$/i;
const MAX_VALUE = 2000;
const VERSION = /^\d+\.\d+\.\d+$/;

export class PromptRegistry {
  private readonly byId = new Map<string, RegisteredPrompt>();
  register(p: PromptTemplate): RegisteredPrompt {
    if (!/^[a-z][a-z0-9_.-]{2,60}$/.test(p.id) || !VERSION.test(p.version)) throw new Error("invalid prompt id or version");
    for (const v of p.variables) if (FORBIDDEN_KEYS.test(v)) throw new Error(`prompt variable "${v}" could carry message text and is refused`);
    for (const m of p.template.matchAll(/\{\{(\w+)\}\}/g)) if (!p.variables.includes(m[1] as string)) throw new Error(`template uses undeclared variable ${m[1]}`);
    const sha256 = createHash("sha256").update(JSON.stringify([p.id, p.version, p.task, p.system, p.template, [...p.variables]])).digest("hex");
    const prior = this.byId.get(p.id);
    if (prior && prior.sha256 !== sha256) throw new Error("a registered prompt cannot change: publish a new id or version");
    const reg = { ...p, sha256 }; this.byId.set(p.id, reg); return reg;
  }
  get(id: string): RegisteredPrompt | undefined { return this.byId.get(id); }
  forTask(task: string): RegisteredPrompt | undefined { return [...this.byId.values()].filter((p) => p.task === task).sort((a, b) => (a.version < b.version ? 1 : -1))[0]; }
  /** Fills the template from DECLARED variables only; every variable is required, bounded and a primitive. */
  render(p: RegisteredPrompt, vars: Readonly<Record<string, string | number | boolean>>): string {
    for (const k of Object.keys(vars)) if (!p.variables.includes(k)) throw new Error(`undeclared prompt variable ${k}`);
    return p.template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
      const v = vars[k];
      if (v === undefined) throw new Error(`missing prompt variable ${k}`);
      const s = String(v);
      if (s.length > MAX_VALUE) throw new Error(`prompt variable ${k} is too long`);
      return s;
    });
  }
}
