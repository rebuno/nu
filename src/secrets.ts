import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { DATA_DIR } from "./config.js";
import { readSettings } from "./settings.js";

const SECRETS_PATH = join(DATA_DIR, "secrets", "secrets.json");
const SANDBOX_ENV_PATH = join(DATA_DIR, "sandbox", "env.json");
export const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;

export type OAuthSecret = {
  type: "oauth";
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  basicAuth?: boolean;
  resource?: string;
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
};

type Secret = string | OAuthSecret;

const readJson = (path: string) =>
  existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};

export const readSecrets = (): Record<string, Secret> => readJson(SECRETS_PATH);

export const hasSecret = (name: string) => name in readSecrets();

export function setSecret(name: string, value: Secret) {
  if (!SECRET_NAME.test(name))
    throw new Error("secret names are UPPER_SNAKE_CASE");
  mkdirSync(dirname(SECRETS_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(
    SECRETS_PATH,
    JSON.stringify({ ...readSecrets(), [name]: value }, null, 2),
    { mode: 0o600 },
  );
  chmodSync(SECRETS_PATH, 0o600);
}

export function syncSandboxEnv() {
  const secrets = readSecrets();
  const env = Object.fromEntries(
    (readSettings().sandboxSecrets ?? []).flatMap((name) => {
      const value = secrets[name];
      return typeof value === "string" ? [[name, value]] : [];
    }),
  );
  mkdirSync(dirname(SANDBOX_ENV_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(SANDBOX_ENV_PATH, JSON.stringify(env), { mode: 0o600 });
  chmodSync(SANDBOX_ENV_PATH, 0o600);
}

export function readSandboxEnv(
  path = SANDBOX_ENV_PATH,
): Record<string, string> {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}
