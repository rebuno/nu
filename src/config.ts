import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { env } from "node:process";

export function requiredEnv(name: string) {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export const DATA_DIR = resolve(env.NU_HOME ?? join(homedir(), ".nu"));
export const WORKSPACE_DIR = join(DATA_DIR, "workspace");
export const AGENT_ID = "nu";
export const POLICY_PATH = join(DATA_DIR, "policy.yaml");
export const AUTH_PATH = join(DATA_DIR, "secrets", "auth.json");
export const MODELS_PATH = join(DATA_DIR, "models.json");
export const MCP_PATH = join(DATA_DIR, "mcp.json");
export const SKILLS_DIR = join(DATA_DIR, "skills");
export const PACKAGES_DIR = join(DATA_DIR, "packages");
