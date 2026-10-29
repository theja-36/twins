import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Config-template files that may travel in a backup bundle: templates and unit files only, never an environment file or a key. */
const ALLOWED = /^(?:[A-Za-z0-9_.-]+\.example|docker-compose[A-Za-z0-9_.-]*\.ya?ml|[A-Za-z0-9_.-]+\.(?:service|timer|sql|sh)|Dockerfile(?:\.[A-Za-z0-9_-]+)?|README\.md|[A-Za-z0-9_.-]+\.txt)$/;
const DENIED = /(?:^|\/)(?:\.env[^/]*|[^/]*\.(?:env|key|pem|p12|pfx|session|sqlite|db)|[^/]*(?:secret|credential|id_rsa|id_ed25519|identity)[^/]*)$/i;

export function isBundleableConfig(relPath: string): boolean {
  const name = basename(relPath);
  if (DENIED.test(relPath) && !/\.example$/.test(name)) return false;
  return ALLOWED.test(name);
}

export interface BundleInput {
  stageDir: string;
  dumpPath: string;
  anchorPath?: string | undefined;
  /** Absolute paths of candidate config files (filtered through isBundleableConfig and `acceptContent`). */
  configFiles: string[];
  info: unknown;
  /** Extra content check (the CLI wires the repository's secret scanner). Return a problem code to REJECT the file; the file name is reported, never content. */
  acceptContent?: (relPath: string, content: string) => string | undefined;
}

export interface BundleLayout {
  dump: string;
  anchor?: string;
  config: string[];
  info: string;
}

/** Lays the bundle out in `stageDir`: database.dump, audit-anchor.json (if present), config/<name>..., bundle-info.json. */
export async function stageBundle(input: BundleInput): Promise<BundleLayout> {
  await mkdir(input.stageDir, { recursive: true, mode: 0o700 });
  await copyFile(input.dumpPath, join(input.stageDir, "database.dump"));
  const layout: BundleLayout = { dump: "database.dump", config: [], info: "bundle-info.json" };
  if (input.anchorPath && (await stat(input.anchorPath).then((s) => s.isFile(), () => false))) {
    await copyFile(input.anchorPath, join(input.stageDir, "audit-anchor.json"));
    layout.anchor = "audit-anchor.json";
  }
  await mkdir(join(input.stageDir, "config"), { recursive: true });
  for (const file of [...new Set(input.configFiles)].sort()) {
    const name = basename(file);
    if (!isBundleableConfig(name)) continue;
    const content = await readFile(file, "utf8");
    const problem = input.acceptContent?.(name, content);
    if (problem) throw new Error(`config file ${name} refused: ${problem}`);
    await writeFile(join(input.stageDir, "config", name), content, { mode: 0o600 });
    layout.config.push(`config/${name}`);
  }
  await writeFile(join(input.stageDir, layout.info), `${JSON.stringify(input.info, null, 2)}\n`, { mode: 0o600 });
  return layout;
}

export async function createTar(stageDir: string, tarPath: string): Promise<void> {
  await run("tar", ["-cf", tarPath, "-C", stageDir, "."]);
  await chmod(tarPath, 0o600);
}

/** Extracts after checking every entry name: no absolute paths, no `..`, no links. */
export async function extractTar(tarPath: string, destDir: string): Promise<string[]> {
  const listed = await run("tar", ["-tf", tarPath], { maxBuffer: 16 * 1024 * 1024 });
  const verbose = await run("tar", ["-tvf", tarPath], { maxBuffer: 16 * 1024 * 1024 });
  if (verbose.stdout.split("\n").some((l) => /^[lh]/.test(l))) throw new Error("archive contains a link");
  const names = listed.stdout.split("\n").filter(Boolean);
  for (const name of names) if (name.startsWith("/") || name.split("/").includes("..")) throw new Error("archive contains an unsafe path");
  await mkdir(destDir, { recursive: true, mode: 0o700 });
  await run("tar", ["-xf", tarPath, "-C", destDir, "--no-same-owner"]);
  return names;
}

/** Best-effort secure removal of a plaintext file (overwrite with zeros once, then unlink). Never throws. */
export async function wipeFile(path: string): Promise<void> {
  try {
    const s = await stat(path);
    if (s.isFile() && s.size > 0 && s.size < 4 * 1024 ** 3) await writeFile(path, Buffer.alloc(Math.min(s.size, 64 * 1024 * 1024)));
  } catch { /* already gone */ }
  await rm(path, { force: true }).catch(() => undefined);
}

export async function wipeDir(dir: string): Promise<void> {
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else await wipeFile(p);
    }
  };
  await walk(dir);
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
