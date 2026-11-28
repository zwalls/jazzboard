import { createMcpHandler } from "mcp-handler";

import { errorResponse, json, readJsonBody } from "@/lib/server/http";
import { authenticateRemoteMcp } from "@/lib/server/remote-mcp-auth";
import { loadRemoteMcpConfiguration } from "@/lib/server/remote-mcp-config";
import { registerRemoteMcpTools } from "@/lib/server/remote-mcp-tools";

function makeRemoteMcpRoute() {
  const config = loadRemoteMcpConfiguration();
  if (!config) return null;

  const handler = createMcpHandler((server) => registerRemoteMcpTools(server, config), {
    serverInfo: { name: "Jazzboard", version: "1.0.0" },
    maxSubscriptions: 0,
    telemetry: false,
  });
  return { config, handler };
}

let route: ReturnType<typeof makeRemoteMcpRoute> | undefined;

export async function handleRemoteMcp(request: Request): Promise<Response> {
  const current = route ??= makeRemoteMcpRoute();
  if (!current || new URL(request.url).origin !== current.config.resource.origin) {
    return json({ error: "Not found." }, { status: 404 });
  }
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== current.config.resource.origin) {
    return json({ error: "Origin not allowed." }, { status: 403 });
  }

  try {
    const auth = await authenticateRemoteMcp(request, current.config.resource);
    if (!auth) {
      return json({ error: "A valid Jazzboard MCP room connection is required." }, {
        status: 401, headers: { "WWW-Authenticate": 'Bearer realm="Jazzboard MCP"' },
      });
    }

    let bounded = request;
    if (request.method === "POST") {
      if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get("content-type") ?? "")) {
        return json({ error: "Expected application/json." }, { status: 415 });
      }
      const parsed = await readJsonBody(request, { maximumBytes: 256 * 1024 });
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      bounded = new Request(request.url, {
        method: request.method, headers, body: JSON.stringify(parsed), signal: request.signal,
      });
    }
    const response = await current.handler(Object.assign(bounded, { auth }));
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    return errorResponse(error);
  }
}
