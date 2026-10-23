import { randomUUID } from "node:crypto";
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  registerClient,
  selectClientAuthMethod,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import { readServers, validateServer, writeServer } from "../mcp.js";
import { setSecret } from "../secrets.js";
import { HttpError } from "./gateway.js";

const MCP_REDIRECT = "http://127.0.0.1:4123/callback";
const LOGIN_TIMEOUT_MS = 10 * 60_000;

type Pending = {
  name: string;
  authorizationServerUrl: string;
  metadata: AuthorizationServerMetadata;
  client: OAuthClientInformationMixed;
  codeVerifier: string;
  resource?: string;
};

const pending = new Map<string, Pending>();

const mcpSecretName = (server: string) =>
  `MCP_${server.toUpperCase().replaceAll("-", "_")}`;

function httpServer(name: string) {
  const config = readServers()[name];
  if (!config) throw new HttpError(404, `no MCP server ${name}`);
  const server = validateServer(name, config);
  if (!("url" in server))
    throw new HttpError(
      400,
      `${name} is a stdio server; only HTTP servers sign in`,
    );
  return server;
}

export async function startMcpLogin(
  name: string,
  given: { clientId?: string; clientSecret?: string },
) {
  const { url } = httpServer(name);
  const info = await discoverOAuthServerInfo(url);
  const metadata = info.authorizationServerMetadata;
  if (!metadata)
    throw new HttpError(400, `${name} does not offer OAuth sign-in`);
  const resource = info.resourceMetadata?.resource;
  const scope = info.resourceMetadata?.scopes_supported?.join(" ");
  let client: OAuthClientInformationMixed;
  if (given.clientId)
    client = { client_id: given.clientId, client_secret: given.clientSecret };
  else if (metadata.registration_endpoint)
    client = await registerClient(info.authorizationServerUrl, {
      metadata,
      scope,
      clientMetadata: {
        client_name: "Nu",
        redirect_uris: [MCP_REDIRECT],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
    });
  else
    throw new HttpError(
      400,
      `${name} does not register clients itself; create an OAuth app with the callback ${MCP_REDIRECT} and pass --client-id`,
    );
  const state = randomUUID();
  const { authorizationUrl, codeVerifier } = await startAuthorization(
    info.authorizationServerUrl,
    {
      metadata,
      clientInformation: client,
      redirectUrl: MCP_REDIRECT,
      scope,
      state,
      resource: resource ? new URL(resource) : undefined,
    },
  );
  pending.set(state, {
    name,
    authorizationServerUrl: info.authorizationServerUrl,
    metadata,
    client,
    codeVerifier,
    resource,
  });
  setTimeout(() => pending.delete(state), LOGIN_TIMEOUT_MS).unref();
  return { url: authorizationUrl.href, redirect: MCP_REDIRECT };
}

export async function finishMcpLogin(callback: string) {
  const params = new URL(callback).searchParams;
  const login = pending.get(params.get("state") ?? "");
  if (!login)
    throw new HttpError(400, "sign-in expired; run nu mcp login again");
  pending.delete(params.get("state") ?? "");
  const code = params.get("code");
  if (!code)
    throw new HttpError(
      400,
      `sign-in failed: ${params.get("error_description") ?? params.get("error") ?? "no code"}`,
    );
  const tokens = await exchangeAuthorization(login.authorizationServerUrl, {
    metadata: login.metadata,
    clientInformation: login.client,
    authorizationCode: code,
    codeVerifier: login.codeVerifier,
    redirectUri: MCP_REDIRECT,
    resource: login.resource ? new URL(login.resource) : undefined,
  });
  const secret = mcpSecretName(login.name);
  setSecret(secret, {
    type: "oauth",
    tokenUrl: login.metadata.token_endpoint,
    clientId: login.client.client_id,
    clientSecret: login.client.client_secret,
    basicAuth:
      selectClientAuthMethod(
        login.client,
        login.metadata.token_endpoint_auth_methods_supported ?? [],
      ) === "client_secret_basic",
    resource: login.resource,
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    expiresAt: tokens.expires_in
      ? Date.now() + tokens.expires_in * 1000
      : undefined,
  });
  const server = httpServer(login.name);
  writeServer(login.name, {
    ...server,
    headers: {
      ...Object.fromEntries(
        Object.entries(server.headers ?? {}).filter(
          ([key]) => key.toLowerCase() !== "authorization",
        ),
      ),
      Authorization: `Bearer \${${secret}}`,
    },
  });
  return `Signed in to MCP server ${login.name}. Its tools are available from the next turn.`;
}
