// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  JAZZBOARD_ARTIFACT_FORMAT,
  JAZZBOARD_ARTIFACT_SCHEMA_URL,
  JAZZBOARD_ARTIFACT_VERSION,
} from "@/lib/interchange/types";

import { GET, OPTIONS } from "./route";

function objectsWithRoutingSchema(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const properties = record.properties;
  const current = properties && typeof properties === "object" && "routing" in properties
    ? [record]
    : [];
  return [
    ...current,
    ...Object.values(record).flatMap((entry) => objectsWithRoutingSchema(entry)),
  ];
}

describe("public Jazzboard artifact schema", () => {
  it("serves the stable v1 JSON Schema with public, sniff-safe headers", async () => {
    const response = GET();
    const schema = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/schema+json");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toContain("s-maxage=86400");
    expect(schema).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: JAZZBOARD_ARTIFACT_SCHEMA_URL,
      title: "Jazzboard semantic artifact v1",
    });
    const encoded = JSON.stringify(schema);
    expect(encoded).toContain(JAZZBOARD_ARTIFACT_FORMAT);
    expect(encoded).toContain(String(JAZZBOARD_ARTIFACT_VERSION));
    expect(encoded).toContain('"routing"');
    expect(encoded).toContain('"labelPositionSource"');
    expect(encoded).toContain("private_or_external_source_omitted");
    expect(encoded).not.toContain('"url"');
    expect(encoded).not.toContain("participantId");

    const connectorSchemas = objectsWithRoutingSchema(schema);
    expect(connectorSchemas.length).toBeGreaterThan(0);
    for (const connectorSchema of connectorSchemas) {
      expect(connectorSchema.required ?? []).not.toContain("routing");
    }
  });

  it("allows cross-origin agents to discover only GET and OPTIONS", () => {
    const response = OPTIONS();
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS");
  });
});
