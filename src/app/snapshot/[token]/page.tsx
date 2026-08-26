import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { JazzboardSnapshot } from "@/components/snapshot/JazzboardSnapshot";
import { isDomainError } from "@/lib/domain/errors";
import { readPublicSnapshot } from "@/lib/server/snapshot-service";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Shared snapshot",
  description: "A private, frozen, read-only Jazzboard semantic canvas snapshot.",
  robots: {
    index: false,
    follow: false,
    noarchive: true,
    noimageindex: true,
  },
};

async function loadSnapshot(token: string) {
  try {
    return await readPublicSnapshot(token);
  } catch (error) {
    if (isDomainError(error) && error.code === "SNAPSHOT_NOT_FOUND") notFound();
    throw error;
  }
}

export default async function SnapshotPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const snapshot = await loadSnapshot(token);
  return <JazzboardSnapshot snapshot={snapshot} />;
}
