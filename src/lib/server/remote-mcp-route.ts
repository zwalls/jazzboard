import { createMcpHandler, generateProtectedResourceMetadata, withMcpAuth } from "mcp-handler";

import { errorResponse, json, readJsonBody } from "@/lib/server/http";
import {
  createRemoteMcpVerifier,
  loadRemoteMcpConfiguration,
  MCP_METADATA_PATH,
  MCP_READ_SCOPE,
  MCP_WRITE_SCOPE,
} from "@/lib/server/remote-mcp-auth";
import { registerRemoteMcpTools } from "@/lib/server/remote-mcp-tools";

function makeRemoteMcpRoute() {
  const config = loadRemoteMcpConfiguration();
  if (!config) return null;

  const handler = createMcpHandler((server) => registerRemoteMcpTools(server, config), {
    serverInfo: { name: "Jazzboard", version: "1.0.0" },
    maxSubscriptions: 0,
    telemetry: false,
  });

  const authorized = withMcpAuth(async (request) => {
    if (request.method !== "POST") return handler(request);
    if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get("content-type") ?? "")) {
      return json({ error: "Expected application/json." }, { status: 415 });
    }

    // Authenticate before parsing, cap the original input, and pass the verified context to the transport.
    let parsed: unknown;
    try {
      parsed = await readJsonBody(request, { maximumBytes: 256 * 1024 });
    } catch (error) {
      return errorResponse(error);
    }
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    const bounded = new Request(request.url, {
      method: request.method,
      headers,
      body: JSON.stringify(parsed),
      signal: request.signal,
    });
    bounded.auth = request.auth;
    return handler(bounded);
  }, createRemoteMcpVerifier(config), {
    required: true,
    requiredScopes: [MCP_READ_SCOPE],
    resourceMetadataPath: MCP_METADATA_PATH,
    resourceUrl: config.resource.origin,
  });

  const metadata = generateProtectedResourceMetadata({
    authServerUrls: [config.issuer],
    resourceUrl: config.resource.href,
    additionalMetadata: { scopes_supported: [MCP_READ_SCOPE, MCP_WRITE_SCOPE], bearer_methods_supported: ["header"] },
  });

  return { config, authorized, metadata };
}

let route: ReturnType<typeof makeRemoteMcpRoute> | undefined;

function currentRoute() {
  return route ??= makeRemoteMcpRoute();
}

function unavailable() {
  return json({ error: "Not found." }, { status: 404 });
}

export async function handleRemoteMcp(request: Request): Promise<Response> {
  const current = currentRoute();
  if (!current || new URL(request.url).origin !== current.config.resource.origin) return unavailable();
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== current.config.resource.origin) {
    return json({ error: "Origin not allowed." }, { status: 403 });
  }

  const response = await current.authorized(request);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}

export function remoteMcpMetadata(request: Request): Response {
  const current = currentRoute();
  if (!current || new URL(request.url).origin !== current.config.resource.origin) return unavailable();
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Cache-Control": "no-store",
      },
    });
  }
  return Response.json(current.metadata, {
    headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
  });
}
