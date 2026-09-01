import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const scriptSource = readFileSync(path.join(import.meta.dirname, "capture-baseline-v3.mjs"), "utf8");
const baseSource = readFileSync(path.join(import.meta.dirname, "capture-baseline-v2.mjs"), "utf8");

describe("baseline-v3 production capture wrapper", () => {
  it("pins the exact frozen baseline-v2 capture source", () => {
    expect(createHash("sha256").update(baseSource).digest("hex"))
      .toBe("102ac23118d91d8a8782bf303885065f7afdef7fe208afe22bb6c85baf54b601");
    expect(scriptSource).toContain("argv.length !== 4");
    expect(scriptSource).toContain("--output-dir");
    expect(scriptSource).toContain("--capture-history-log");
  });

  it("injects one draft and exactly one finish without direct fallback", () => {
    expect(scriptSource.match(/callTool\(page, "apply_canvas_transaction"/g)).toHaveLength(1);
    expect(scriptSource.match(/callTool\(page, "finish_canvas_draft"/g)).toHaveLength(1);
    expect(scriptSource).toContain('delivery: { mode: "draft" }');
    expect(scriptSource).toContain("directFallbackUsed: false");
    expect(scriptSource).toContain("progressiveDraftStageCallResult");
    expect(scriptSource).toContain("progressiveDraftFinishCallResult");
    expect(baseSource).toContain('await callTool(page, "read_room_state"');
  });
});
