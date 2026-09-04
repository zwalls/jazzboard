export const CONNECTOR_ROUTING_INPUT_JSON_SCHEMA = {
  type: "object",
  properties: {
    mode: {
      enum: ["auto", "straight", "curved", "elbow"],
      description: "auto delegates routing.",
    },
    bend: {
      type: "number",
      minimum: -10_000,
      maximum: 10_000,
      anyOf: [{ maximum: -8 }, { minimum: 8 }],
    },
    elbowMidPoint: {
      type: "number",
      minimum: 0,
      maximum: 1,
    },
    labelPosition: {
      type: "number",
      minimum: 0,
      maximum: 1,
    },
    waypoints: {
      type: "array",
      minItems: 1,
      maxItems: 30,
      description:
        "Agent-authored absolute canvas elbow vertices; never generated.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["x", "y"],
        properties: {
          x: { type: "number", minimum: -1_000_000, maximum: 1_000_000 },
          y: { type: "number", minimum: -1_000_000, maximum: 1_000_000 },
        },
      },
    },
  },
  required: ["mode"],
  additionalProperties: false,
  allOf: [
    {
      if: { properties: { mode: { const: "curved" } } },
      then: { required: ["bend"] },
      else: { not: { required: ["bend"] } },
    },
    {
      if: { properties: { mode: { const: "elbow" } } },
      else: { properties: { elbowMidPoint: false, waypoints: false } },
    },
  ],
} as const;
