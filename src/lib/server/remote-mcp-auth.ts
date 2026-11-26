import type { AuthInfo } from "@modelcontextprotocol/server";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";

import { DomainError } from "@/lib/domain/errors";

export const MCP_READ_SCOPE = "room:read";
export const MCP_WRITE_SCOPE = "room:write";
export const MCP_METADATA_PATH = "/.well-known/oauth-protected-resource/api/mcp";
const TOKEN_LIFETIME_SECONDS = 15 * 60;

export const remoteRoomIdSchema = z.string().regex(
  /^room_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
  "Use the exact room ID, not the invite code.",
);

const opaqueIdentifier = z.string().min(1).max(256).refine((value) => !/[\x00-\x20\x7f]/.test(value));
const grantSchema = z.strictObject({
  subject: opaqueIdentifier,
  clientId: opaqueIdentifier,
  roomId: remoteRoomIdSchema,
  participantId: z.string().regex(/^p_[A-Za-z0-9_-]{16,128}$/),
  access: z.enum(["read", "write"]),
});
const grantsSchema = z.array(grantSchema).min(1).max(100);

type Access = z.infer<typeof grantSchema>["access"];

function grantKey(subject: string, clientId: string, roomId: string) {
  return JSON.stringify([subject, clientId, roomId]);
}

function configuredUrl(value: string | undefined, allowLoopback: boolean): URL {
  const url = new URL(value ?? "");
  const isLoopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (
    (url.protocol !== "https:" && !(allowLoopback && isLoopback && url.protocol === "http:"))
    || url.username || url.password || url.search || url.hash
  ) {
    throw new Error("Invalid remote MCP URL");
  }
  return url;
}

export function loadRemoteMcpConfiguration(env: NodeJS.ProcessEnv = process.env) {
  if (env.JAZZBOARD_REMOTE_MCP_ENABLED !== "1") return null;

  try {
    const allowLoopback = !env.VERCEL && !env.VERCEL_ENV;
    const resource = configuredUrl(env.JAZZBOARD_REMOTE_MCP_RESOURCE, allowLoopback);
    const issuerUrl = configuredUrl(env.JAZZBOARD_REMOTE_MCP_ISSUER, allowLoopback);
    const jwks = configuredUrl(env.JAZZBOARD_REMOTE_MCP_JWKS_URL, allowLoopback);
    const issuer = env.JAZZBOARD_REMOTE_MCP_ISSUER;
    if (resource.pathname !== "/api/mcp" || env.JAZZBOARD_REMOTE_MCP_RESOURCE !== resource.href
      || jwks.origin !== issuerUrl.origin) return null;
    if (issuer !== issuerUrl.href && issuer !== issuerUrl.origin) return null;

    const json = env.JAZZBOARD_REMOTE_MCP_ROOM_GRANTS ?? "";
    if (json.length > 65_536) return null;
    const grants = new Map<string, z.infer<typeof grantSchema>>();
    for (const grant of grantsSchema.parse(JSON.parse(json))) {
      const key = grantKey(grant.subject, grant.clientId, grant.roomId);
      if (grants.has(key)) return null;
      grants.set(key, grant);
    }
    return { resource, issuer, jwks, grants };
  } catch {
    // A partial configuration must never expose tools or grant access.
    return null;
  }
}

export type RemoteMcpConfiguration = NonNullable<ReturnType<typeof loadRemoteMcpConfiguration>>;

export function createRemoteMcpVerifier(config: RemoteMcpConfiguration) {
  const keySet = createRemoteJWKSet(config.jwks, { timeoutDuration: 3_000 });
  return async (request: Request, token?: string): Promise<AuthInfo | undefined> => {
    if (!token || token.length > 8192 || !/^Bearer [A-Za-z0-9._-]+$/i.test(request.headers.get("authorization") ?? "")) {
      return undefined;
    }
    try {
      const { payload } = await jwtVerify(token, keySet, {
        issuer: config.issuer,
        audience: config.resource.href,
        algorithms: ["RS256", "ES256"],
        typ: "at+jwt",
        requiredClaims: ["sub", "client_id", "exp", "iat", "jti", "scope"],
        maxTokenAge: TOKEN_LIFETIME_SECONDS,
        clockTolerance: 5,
      });
      const subject = opaqueIdentifier.parse(payload.sub);
      const clientId = opaqueIdentifier.parse(payload.client_id);
      opaqueIdentifier.parse(payload.jti);
      const { exp, iat } = payload;
      if (typeof exp !== "number" || typeof iat !== "number" || exp <= iat || exp - iat > TOKEN_LIFETIME_SECONDS) {
        return undefined;
      }
      if (Array.isArray(payload.aud) && payload.aud.length !== 1) return undefined;
      if (typeof payload.scope !== "string") return undefined;

      return {
        token,
        clientId,
        scopes: payload.scope.split(" ").filter((scope) => scope === MCP_READ_SCOPE || scope === MCP_WRITE_SCOPE),
        expiresAt: exp,
        resource: config.resource,
        resourceMetadataUrl: new URL(MCP_METADATA_PATH, config.resource).href,
        extra: { subject },
      };
    } catch {
      // JWTs, provider error bodies and key details never appear in client errors or logs.
      return undefined;
    }
  };
}

export function requireRemoteMcpGrant(
  config: RemoteMcpConfiguration,
  auth: AuthInfo | undefined,
  roomId: string,
  access: Access,
) {
  const subject = auth?.extra?.subject;
  if (auth && typeof subject === "string"
    && auth.scopes.includes(MCP_READ_SCOPE)
    && (access === "read" || auth.scopes.includes(MCP_WRITE_SCOPE))) {
    const grant = config.grants.get(grantKey(subject, auth.clientId, roomId));
    if (grant && (access === "read" || grant.access === "write")) return grant;
  }
  throw new DomainError("FORBIDDEN", "This connection does not have the requested room access.");
}
