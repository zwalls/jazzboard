export type RemoteMcpConfiguration = { resource: URL };

export function loadRemoteMcpConfiguration(env: NodeJS.ProcessEnv = process.env): RemoteMcpConfiguration | null {
  if (env.JAZZBOARD_REMOTE_MCP_ENABLED !== "1") return null;
  try {
    const resource = new URL(env.JAZZBOARD_REMOTE_MCP_RESOURCE ?? "");
    const local = !env.VERCEL && !env.VERCEL_ENV && resource.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(resource.hostname);
    const productionResource = "https://www.jazzboard.xyz/api/mcp";
    if ((!local && resource.protocol !== "https:") || resource.username || resource.password ||
      resource.search || resource.hash || resource.pathname !== "/api/mcp" ||
      env.JAZZBOARD_REMOTE_MCP_RESOURCE !== resource.href ||
      (env.VERCEL_ENV === "production" && resource.href !== productionResource)) return null;
    return { resource };
  } catch {
    return null;
  }
}
