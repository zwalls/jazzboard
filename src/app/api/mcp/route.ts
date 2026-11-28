import { handleRemoteMcp } from "@/lib/server/remote-mcp-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export { handleRemoteMcp as GET, handleRemoteMcp as POST, handleRemoteMcp as DELETE };
