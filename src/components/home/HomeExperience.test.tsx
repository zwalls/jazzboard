import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { DISPLAY_NAME_KEY } from "@/lib/client/recent-rooms";

import { HomeExperience } from "./HomeExperience";

vi.mock("next/navigation", () => {
  const router = { push: vi.fn() };
  return { useRouter: () => router };
});

beforeEach(() => {
  window.localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

async function renderEntry() {
  await act(async () => { render(<HomeExperience />); });
  return screen.getByRole("textbox", { name: /^Your display name/ });
}

async function finishEntryInitialization() {
  await act(async () => { vi.advanceTimersByTime(0); });
}

it.each(["empty", "denied", "saved"])("keeps typing before display name initialization with %s storage", async (storage) => {
  if (storage === "denied") {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("Storage denied", "SecurityError");
    });
  } else if (storage === "saved") {
    window.localStorage.setItem(DISPLAY_NAME_KEY, "Saved guest");
  }

  const name = await renderEntry();
  fireEvent.change(name, { target: { value: "Current guest" } });
  await finishEntryInitialization();
  expect(name).toHaveValue("Current guest");
});

it("prefills a saved display name when the field is untouched", async () => {
  window.localStorage.setItem(DISPLAY_NAME_KEY, "Saved guest");
  const name = await renderEntry();
  expect(name).toHaveValue("");
  await finishEntryInitialization();
  expect(name).toHaveValue("Saved guest");
});

it("preserves a display name deliberately cleared before initialization", async () => {
  window.localStorage.setItem(DISPLAY_NAME_KEY, "Saved guest");
  const name = await renderEntry();
  fireEvent.change(name, { target: { value: "Current guest" } });
  fireEvent.change(name, { target: { value: "" } });
  await finishEntryInitialization();
  expect(name).toHaveValue("");
  expect(window.localStorage.getItem(DISPLAY_NAME_KEY)).toBe("Saved guest");
});
