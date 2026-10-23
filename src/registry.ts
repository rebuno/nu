import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import type { Idempotency } from "rebuno";
import { DATA_DIR } from "./config.js";
import { SECRET_NAME } from "./secrets.js";

export type Manifest = {
  name: string;
  version: number;
  description: string;
  args_schema: Record<string, unknown>;
  idempotency: Idempotency;
  secrets: string[];
  entry: string;
  tests?: string;
};

// hash covers the tool's sources, and bundleHash the bundle built from them.
export type Entry = {
  manifest: Manifest;
  hash: string;
  bundleHash: string;
  package?: string;
};

type Index = Record<
  string,
  { version: number; package?: string; removed?: boolean }
>;

export const SEED_TOOLS = [
  "memory_search",
  "memory_write",
  "skill_write",
  "browser_observe",
  "browser_task",
  "browser_submit",
  "browser_handoff",
  "shell",
  "read",
  "write",
  "edit",
  "message_send",
  "schedule_create",
  "schedule_list",
  "schedule_delete",
  "background_task",
  "secrets_request",
  "package_checkout",
  "package_write",
  "package_search",
  "package_install",
  "package_remove",
  "policy_read",
  "policy_update",
  "delegate",
  "specialist_write",
];

export const RESERVED_NAMESPACES = ["user", "mcp", ...SEED_TOOLS];

const REGISTRY_DIR = join(DATA_DIR, "registry");
const INDEX = join(REGISTRY_DIR, "index.json");
const PACKAGES = join(DATA_DIR, "packages.json");
const SKIPPED = new Set(["node_modules", ".git"]);

export function readIndex(): Index {
  return existsSync(INDEX) ? JSON.parse(readFileSync(INDEX, "utf8")) : {};
}

function writeIndex(index: Index) {
  mkdirSync(REGISTRY_DIR, { recursive: true });
  writeFileSync(INDEX, JSON.stringify(index, null, 2));
}

const versionDir = (name: string, version: number) =>
  join(REGISTRY_DIR, name, String(version));

export const bundlePath = (name: string, version: number) =>
  join(versionDir(name, version), "tool.mjs");

export function readEntry(name: string, version: number): Entry {
  return JSON.parse(
    readFileSync(join(versionDir(name, version), "entry.json"), "utf8"),
  );
}

export function activeTools() {
  return Object.entries(readIndex())
    .filter(([, tool]) => !tool.removed)
    .map(([name, tool]) => readEntry(name, tool.version));
}

export function readFiles(dir: string, root = dir): Record<string, string> {
  const files: Record<string, string> = {};
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED.has(item.name)) continue;
    const path = join(dir, item.name);
    if (item.isDirectory()) Object.assign(files, readFiles(path, root));
    else if (item.isFile())
      files[relative(root, path)] = readFileSync(path, "utf8");
  }
  return files;
}

export function codeHash(files: Record<string, string>) {
  const hash = createHash("sha256");
  for (const path of Object.keys(files).sort())
    hash.update(`${path}\0${files[path]}\0`);
  return hash.digest("hex");
}

export const sha256 = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");

export function dependencies(files: Record<string, string>) {
  const lock = files["package-lock.json"];
  if (!lock) return [];
  const { packages = {} } = JSON.parse(lock) as {
    packages?: Record<string, { version?: string }>;
  };
  return Object.entries(packages)
    .filter(([path]) => path)
    .map(
      ([path, { version }]) =>
        `${path.split("node_modules/").pop()}@${version}`,
    );
}

export const NAMESPACE = /^[a-z][a-z0-9-]*$/;
const NAME = /^[a-z][a-z0-9-]*__[a-z][a-z0-9_]*$/;

export function validateManifest(value: unknown, namespace: string): Manifest {
  const m = value as Partial<Manifest>;
  const fail = (problem: string) => {
    throw new Error(`invalid manifest: ${problem}`);
  };
  if (typeof m?.name !== "string" || !NAME.test(m.name))
    fail("name must be <namespace>__<tool> in lowercase");
  if (!m.name?.startsWith(`${namespace}__`))
    fail(`name must start with ${namespace}__`);
  if (!Number.isInteger(m.version) || (m.version ?? 0) < 1)
    fail("version must be a positive whole number");
  if (typeof m.description !== "string" || !m.description) fail("description");
  if (m.args_schema?.type !== "object")
    fail("args_schema must be an object schema");
  if (m.idempotency !== "safe_to_retry" && m.idempotency !== "at_most_once")
    fail("idempotency must be safe_to_retry or at_most_once");
  for (const name of m.secrets ?? [])
    if (!SECRET_NAME.test(name))
      fail(`secret ${name} must be UPPER_SNAKE_CASE`);
  if (typeof m.entry !== "string" || !m.entry) fail("entry");
  return { ...m, secrets: m.secrets ?? [] } as Manifest;
}

export function activate(entry: Entry, bundle: string) {
  const { name, version } = entry.manifest;
  const current = readIndex()[name];
  if (current && !current.removed && current.version >= version)
    throw new Error(`${name} is already at version ${current.version}`);
  mkdirSync(versionDir(name, version), { recursive: true });
  writeFileSync(bundlePath(name, version), bundle);
  writeFileSync(
    join(versionDir(name, version), "entry.json"),
    JSON.stringify(entry, null, 2),
  );
  writeIndex({
    ...readIndex(),
    [name]: { version, package: entry.package },
  });
}

export function removePackageTools(pkg: string) {
  const index = readIndex();
  for (const tool of Object.values(index))
    if (tool.package === pkg) tool.removed = true;
  writeIndex(index);
}

export type ToolDisplay = {
  icon?: string;
  title?: string;
  body?: string;
  language?: string;
};

export type ClientView = {
  tools?: Record<string, ToolDisplay>;
  commands?: Record<string, { description: string; message: string }>;
};

type InstalledPackage = {
  namespace: string;
  description?: string;
  path: string;
  root?: string;
  skills: string[];
  extensions?: string[];
  secrets?: string[];
  tools: string[];
  client?: ClientView;
};

export function readPackages(): Record<string, InstalledPackage> {
  return existsSync(PACKAGES) ? JSON.parse(readFileSync(PACKAGES, "utf8")) : {};
}

export function writePackages(packages: Record<string, InstalledPackage>) {
  writeFileSync(PACKAGES, JSON.stringify(packages, null, 2));
}
