"use client";

import { useCallback, useEffect, useState } from "react";

import { apiRequest } from "@/lib/client/api";
import type { RoomActivitySummary, RoomState } from "@/lib/domain/types";

type ActivityListResponse = {
  ok: true;
  activities: RoomActivitySummary[];
  hasMore: boolean;
  nextBeforeRoomRevision: number | null;
};

type ActivityRevertResponse = {
  ok: true;
  room: RoomState;
  activity: RoomActivitySummary;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Jazzboard could not load room activity.";
}

export function revertBodyFor(activity: RoomActivitySummary) {
  return {
    objectExpectations: Object.entries(activity.objectGuards).map(([objectId, guard]) =>
      guard.state === "present"
        ? { objectId, state: "present" as const, expectedRevision: guard.revision }
        : { objectId, state: "absent" as const },
    ),
    diagramExpectations: Object.entries(activity.diagramGuards).map(([diagramId, guard]) =>
      guard.state === "present"
        ? { diagramId, state: "present" as const, expectedRevision: guard.revision }
        : { diagramId, state: "absent" as const },
    ),
    metadata: {
      intent: `Revert activity ${activity.id}`,
      summary: `Compensating revert for: ${activity.label}`,
    },
  };
}

export function useRoomActivity({
  roomId,
  enabled,
  acceptRoom,
}: {
  roomId: string;
  enabled: boolean;
  acceptRoom(room: RoomState): void;
}) {
  const [activities, setActivities] = useState<RoomActivitySummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revertingActivityId, setRevertingActivityId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    try {
      const response = await apiRequest<ActivityListResponse>(
        `/api/rooms/${roomId}/activity?limit=60`,
      );
      setActivities(response.activities);
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setLoading(false);
    }
  }, [enabled, roomId]);

  useEffect(() => {
    if (!enabled) return;
    const initial = window.setTimeout(() => void refresh(), 0);
    const interval = window.setInterval(() => void refresh(), 4_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [enabled, refresh]);

  const revert = useCallback(async (activity: RoomActivitySummary) => {
    setRevertingActivityId(activity.id);
    setError(null);
    try {
      const response = await apiRequest<ActivityRevertResponse>(
        `/api/rooms/${roomId}/activity/${encodeURIComponent(activity.id)}/revert`,
        { method: "POST", body: JSON.stringify(revertBodyFor(activity)) },
      );
      acceptRoom(response.room);
      setActivities((current) => [response.activity, ...current]);
      return response;
    } catch (nextError) {
      setError(errorMessage(nextError));
      throw nextError;
    } finally {
      setRevertingActivityId(null);
    }
  }, [acceptRoom, roomId]);

  return {
    activities,
    error,
    loading,
    revertingActivityId,
    refresh,
    revert,
  };
}
