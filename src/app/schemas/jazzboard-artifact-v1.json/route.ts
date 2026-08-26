import { z } from "zod";

import { jazzboardArtifactV1Schema } from "@/lib/interchange/schemas";
import { JAZZBOARD_ARTIFACT_SCHEMA_URL } from "@/lib/interchange/types";

export const dynamic = "force-static";

const schema = {
  ...z.toJSONSchema(jazzboardArtifactV1Schema, { target: "draft-2020-12" }),
  $id: JAZZBOARD_ARTIFACT_SCHEMA_URL,
  title: "Jazzboard semantic artifact v1",
  description:
    "Portable, redacted semantic canvas, Diagram, selection, snapshot, and create-only template artifacts.",
};

const publicHeaders = {
  "access-control-allow-origin": "*",
  "cache-control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
  "content-type": "application/schema+json; charset=utf-8",
  "x-content-type-options": "nosniff",
};

export function GET(): Response {
  return new Response(`${JSON.stringify(schema, null, 2)}\n`, { headers: publicHeaders });
}

export function OPTIONS(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...publicHeaders,
      "access-control-allow-methods": "GET, OPTIONS",
    },
  });
}
