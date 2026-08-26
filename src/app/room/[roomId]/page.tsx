import type { Metadata } from "next";

import { JazzboardRoom } from "@/components/room/JazzboardRoom";

export const metadata: Metadata = {
  title: "Room",
  robots: {
    index: false,
    follow: false,
    noarchive: true,
  },
};

export default async function RoomPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return <JazzboardRoom roomId={roomId} />;
}
