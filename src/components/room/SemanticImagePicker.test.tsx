import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  uploadJazzboardRoomImage,
  type JazzboardRoomImageUpload,
} from "@/lib/client/assets";

import {
  SemanticImagePicker,
  type SemanticImagePickerHandle,
  type SemanticImagePickerProps,
} from "./SemanticImagePicker";

vi.mock("@/lib/client/assets", () => ({
  uploadJazzboardRoomImage: vi.fn(),
}));

const uploadMock = vi.mocked(uploadJazzboardRoomImage);
const createObjectURL = vi.fn<(file: File) => string>();
const revokeObjectURL = vi.fn<(url: string) => void>();
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

let decodedWidth = 1_600;
let decodedHeight = 900;
let decodeFailure = false;
let decodePending = false;
let completePendingDecode: (() => void) | null = null;

class MockImage {
  naturalWidth = decodedWidth;
  naturalHeight = decodedHeight;
  decoding = "auto";
  onload: ((event: Event) => unknown) | null = null;
  onerror: ((event: Event | string) => unknown) | null = null;

  set src(_value: string) {
    if (decodePending) {
      completePendingDecode = () => this.onload?.(new Event("load"));
      return;
    }
    queueMicrotask(() => {
      if (decodeFailure) this.onerror?.(new Event("error"));
      else this.onload?.(new Event("load"));
    });
  }
}

const asset: JazzboardRoomImageUpload = Object.freeze({
  url: "/api/rooms/room-1/assets?assetId=asset-1",
  assetId: "asset-1",
  mimeType: "image/png",
  sourceUrl: null,
  storage: "local-memory",
  pathname: null,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function renderPicker(overrides: Partial<SemanticImagePickerProps> = {}) {
  const ref = createRef<SemanticImagePickerHandle>();
  const onReady = vi.fn();
  const onError = vi.fn();
  const result = render(
    <SemanticImagePicker
      ref={ref}
      roomId="room-1"
      onReady={onReady}
      onError={onError}
      {...overrides}
    />,
  );
  const input = result.container.querySelector<HTMLInputElement>("[data-semantic-image-input='true']");
  if (!input) throw new Error("Missing semantic image input.");
  return { ...result, ref, input, onReady, onError };
}

async function chooseFile(input: HTMLInputElement, file: File): Promise<void> {
  fireEvent.change(input, { target: { files: [file] } });
  await screen.findByRole("textbox", { name: "Image description" });
}

function confirmAlt(): void {
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "I confirm this description truthfully identifies the image.",
    }),
  );
}

beforeEach(() => {
  decodedWidth = 1_600;
  decodedHeight = 900;
  decodeFailure = false;
  decodePending = false;
  completePendingDecode = null;
  createObjectURL.mockReset().mockReturnValue("blob:selected-image");
  revokeObjectURL.mockReset();
  uploadMock.mockReset();
  vi.stubGlobal("Image", MockImage);
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: createObjectURL,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: revokeObjectURL,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (originalCreateObjectURL) {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: originalCreateObjectURL,
    });
  } else {
    Reflect.deleteProperty(URL, "createObjectURL");
  }
  if (originalRevokeObjectURL) {
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: originalRevokeObjectURL,
    });
  } else {
    Reflect.deleteProperty(URL, "revokeObjectURL");
  }
  vi.clearAllMocks();
});

describe("SemanticImagePicker", () => {
  it("opens imperatively and returns the exact finalized asset with confirmed alt and capped dimensions", async () => {
    decodedWidth = 2_400;
    decodedHeight = 1_200;
    uploadMock.mockImplementation(async (_roomId, _file, options) => {
      options?.onProgress?.(43.4);
      options?.onProgress?.(100);
      return asset;
    });
    const { ref, input, onReady, onError } = renderPicker();
    const click = vi.spyOn(input, "click");

    act(() => ref.current?.open());
    expect(click).toHaveBeenCalledTimes(1);

    await chooseFile(input, new File(["png"], "system_architecture-final.PNG", { type: "image/png" }));
    expect(screen.getByRole("textbox", { name: "Image description" })).toHaveValue(
      "system architecture final",
    );
    expect(screen.getByText("720 × 360 canvas units")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add to canvas" })).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox", { name: "Image description" }), {
      target: { value: "Web client connected to the room API" },
    });
    confirmAlt();
    fireEvent.click(screen.getByRole("button", { name: "Add to canvas" }));

    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    expect(uploadMock).toHaveBeenCalledWith(
      "room-1",
      expect.any(File),
      expect.objectContaining({ signal: expect.any(AbortSignal), onProgress: expect.any(Function) }),
    );
    const ready = onReady.mock.calls[0]?.[0];
    expect(ready).toEqual({
      asset,
      width: 720,
      height: 360,
      alt: "Web client connected to the room API",
    });
    expect(ready.asset).toBe(asset);
    expect(onError).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:selected-image");
  });

  it("offers pasted or dropped images through the same reviewed flow and declines unsupported files", async () => {
    const { ref, onError } = renderPicker();
    const supported = new File(["png"], "pasted-diagram.png", { type: "image/png" });
    const unsupported = new File(["svg"], "unsafe.svg", { type: "image/svg+xml" });

    expect(ref.current?.offerFile(unsupported)).toBe(false);
    expect(onError).not.toHaveBeenCalled();
    expect(ref.current?.offerFile(supported)).toBe(true);
    expect(await screen.findByRole("textbox", { name: "Image description" })).toHaveValue("pasted diagram");
    expect(createObjectURL).toHaveBeenCalledWith(supported);
  });

  it("rejects unsupported files before decoding or uploading", async () => {
    const { input, onReady, onError } = renderPicker();

    fireEvent.change(input, {
      target: { files: [new File(["svg"], "diagram.svg", { type: "image/svg+xml" })] },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Jazzboard accepts JPEG, PNG, WebP, and GIF images only.",
    );
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("JPEG") }));
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
  });

  it("aborts an in-flight upload on cancel and ignores its late completion", async () => {
    const pending = deferred<JazzboardRoomImageUpload>();
    let signal: AbortSignal | undefined;
    uploadMock.mockImplementation((_roomId, _file, options) => {
      signal = options?.signal;
      options?.onProgress?.(28);
      return pending.promise;
    });
    const { input, onReady, onError } = renderPicker();

    await chooseFile(input, new File(["png"], "diagram.png", { type: "image/png" }));
    confirmAlt();
    fireEvent.click(screen.getByRole("button", { name: "Add to canvas" }));
    expect(await screen.findByRole("progressbar", { name: "Image upload progress" })).toHaveValue(28);

    fireEvent.click(screen.getByRole("button", { name: "Cancel upload" }));
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await act(async () => pending.resolve(asset));
    expect(onReady).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports an upload failure and preserves the reviewed candidate for retry", async () => {
    uploadMock.mockRejectedValueOnce(new Error("Private storage is unavailable."));
    const { input, onReady, onError } = renderPicker();

    await chooseFile(input, new File(["png"], "diagram.png", { type: "image/png" }));
    confirmAlt();
    fireEvent.click(screen.getByRole("button", { name: "Add to canvas" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Private storage is unavailable.");
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Private storage is unavailable." }),
    );
    expect(onReady).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Add to canvas" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "Image description" })).toHaveValue("diagram");
  });

  it("aborts on unmount and fences a late upload result from every callback", async () => {
    const pending = deferred<JazzboardRoomImageUpload>();
    let signal: AbortSignal | undefined;
    uploadMock.mockImplementation((_roomId, _file, options) => {
      signal = options?.signal;
      return pending.promise;
    });
    const { input, onReady, onError, unmount } = renderPicker();

    await chooseFile(input, new File(["png"], "diagram.png", { type: "image/png" }));
    confirmAlt();
    fireEvent.click(screen.getByRole("button", { name: "Add to canvas" }));
    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));

    unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve(asset));

    expect(onReady).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:selected-image");
  });

  it("requires confirmation again whenever the prefilled alt text is edited", async () => {
    uploadMock.mockResolvedValue(asset);
    const { input } = renderPicker();
    await chooseFile(input, new File(["png"], "auth-request_flow.png", { type: "image/png" }));

    const description = screen.getByRole("textbox", { name: "Image description" });
    const confirmation = screen.getByRole("checkbox", {
      name: "I confirm this description truthfully identifies the image.",
    });
    const submit = screen.getByRole("button", { name: "Add to canvas" });

    expect(description).toHaveValue("auth request flow");
    expect(confirmation).not.toBeChecked();
    fireEvent.click(confirmation);
    expect(submit).toBeEnabled();

    fireEvent.change(description, { target: { value: "Authentication request flow" } });
    expect(confirmation).not.toBeChecked();
    expect(submit).toBeDisabled();
  });

  it("preserves small natural dimensions and rejects undecodable images", async () => {
    decodedWidth = 320;
    decodedHeight = 180;
    const { input, onError } = renderPicker();
    await chooseFile(input, new File(["png"], "small.png", { type: "image/png" }));
    expect(screen.getByText("320 × 180 canvas units")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    decodeFailure = true;
    fireEvent.change(input, {
      target: { files: [new File(["broken"], "broken.png", { type: "image/png" })] },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The browser could not decode the selected image.",
    );
    expect(onError).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: "The browser could not decode the selected image." }),
    );
  });

  it("cancels pending local decoding without calling host callbacks", async () => {
    decodePending = true;
    const { input, onReady, onError } = renderPicker();
    fireEvent.change(input, {
      target: { files: [new File(["png"], "slow.png", { type: "image/png" })] },
    });

    expect(await screen.findByText("Reading image dimensions")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel image selection" }));
    completePendingDecode?.();

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onReady).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:selected-image");
  });
});
