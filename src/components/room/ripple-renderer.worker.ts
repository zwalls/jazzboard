import { renderAvatarBody, type RippleBody } from "./ripple-renderer";

export type RippleWorkerRequest = { id: number; name: string; size: number };
export type RippleWorkerResponse =
  | { id: number; body: Omit<RippleBody, "data"> & { data: ArrayBuffer } }
  | { id: number; error: string };

const workerScope = self as unknown as {
  addEventListener: (
    type: "message",
    listener: (event: MessageEvent<RippleWorkerRequest>) => void,
  ) => void;
  postMessage: (message: RippleWorkerResponse, transfer?: Transferable[]) => void;
};

workerScope.addEventListener("message", (event) => {
  const { id, name, size } = event.data;
  try {
    const rendered = renderAvatarBody(name, size);
    const data = rendered.data.buffer as ArrayBuffer;
    workerScope.postMessage({ id, body: { ...rendered, data } }, [data]);
  } catch (error) {
    workerScope.postMessage({
      id,
      error: error instanceof Error ? error.message : "Ripple rendering failed",
    });
  }
});
