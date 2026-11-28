import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { RemoteMcpConnections } from "@/components/room/RemoteMcpConnections";
import { remoteRoomIdSchema } from "@/lib/server/remote-mcp-auth";
import { loadRemoteMcpConfiguration } from "@/lib/server/remote-mcp-config";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "MCP connections",
  robots: { index: false, follow: false, noarchive: true },
};

export default async function ConnectionsPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  if (!loadRemoteMcpConfiguration() || !remoteRoomIdSchema.safeParse(roomId).success) notFound();
  return <RemoteMcpConnections key={roomId} roomId={roomId} />;
}
