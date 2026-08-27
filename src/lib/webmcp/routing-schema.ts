export const CONNECTOR_ROUTING_INPUT_JSON_SCHEMA = {
  type: "object",
  properties: {
    mode: { enum: ["auto", "straight", "curved", "elbow"] },
    bend: {
      type: "number",
      minimum: -10_000,
      maximum: 10_000,
      anyOf: [{ maximum: -8 }, { minimum: 8 }],
    },
    elbowMidPoint: { type: "number", minimum: 0, maximum: 1 },
    labelPosition: { type: "number", minimum: 0, maximum: 1 },
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
      else: { not: { required: ["elbowMidPoint"] } },
    },
  ],
} as const;
