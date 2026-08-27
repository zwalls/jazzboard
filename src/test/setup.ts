import "@testing-library/jest-dom/vitest";
import { beforeEach } from "vitest";

import { resetLocalMutationReceiptStateForTests } from "@/lib/server/idempotency";

beforeEach(() => {
  resetLocalMutationReceiptStateForTests();
});
