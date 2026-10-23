import { type OAuthSecret, readSecrets, setSecret } from "../secrets.js";

const REFRESH_EARLY_MS = 60_000;
const REFRESH_TIMEOUT_MS = 30_000;

const refreshing = new Map<string, Promise<string>>();

async function refresh(name: string, secret: OAuthSecret) {
  if (!secret.refreshToken)
    throw new Error(
      `secret ${name} expired and cannot be refreshed; the user needs to sign in again`,
    );
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: secret.refreshToken,
    ...(secret.resource && { resource: secret.resource }),
  });
  const headers: Record<string, string> = { accept: "application/json" };
  if (secret.basicAuth)
    headers.authorization = `Basic ${btoa(`${encodeURIComponent(secret.clientId)}:${encodeURIComponent(secret.clientSecret ?? "")}`)}`;
  else {
    body.set("client_id", secret.clientId);
    if (secret.clientSecret) body.set("client_secret", secret.clientSecret);
  }
  const response = await fetch(secret.tokenUrl, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  });
  const tokens = await response.json().catch(() => ({}));
  if (!response.ok || typeof tokens.access_token !== "string")
    throw new Error(
      `refreshing secret ${name} failed (${tokens.error_description ?? tokens.error ?? response.status}); the user needs to sign in again`,
    );
  const current = readSecrets()[name];
  setSecret(name, {
    ...(typeof current === "object" ? current : secret),
    refreshToken: tokens.refresh_token ?? secret.refreshToken,
    accessToken: tokens.access_token,
    expiresAt:
      typeof tokens.expires_in === "number"
        ? Date.now() + tokens.expires_in * 1000
        : undefined,
  });
  return tokens.access_token as string;
}

function accessToken(name: string, secret: OAuthSecret) {
  if (
    secret.accessToken &&
    (secret.expiresAt ?? Infinity) - REFRESH_EARLY_MS > Date.now()
  )
    return Promise.resolve(secret.accessToken);
  let pending = refreshing.get(name);
  if (!pending) {
    pending = refresh(name, secret).finally(() => refreshing.delete(name));
    refreshing.set(name, pending);
  }
  return pending;
}

export async function resolveSecrets(names: string[]) {
  const secrets = readSecrets();
  const missing = names.filter((name) => !(name in secrets));
  if (missing.length)
    throw new Error(
      `missing secret ${missing.join(", ")}; ask the user with secrets_request`,
    );
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => {
        const secret = secrets[name];
        return [
          name,
          typeof secret === "string" ? secret : await accessToken(name, secret),
        ] as const;
      }),
    ),
  );
}
