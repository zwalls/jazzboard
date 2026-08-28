import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SemanticCanvasContextMenu } from "./SemanticCanvasContextMenu";

afterEach(cleanup);

describe("SemanticCanvasContextMenu", () => {
  it("exposes only the original image download, separate from board export", () => {
    const onDismiss = vi.fn();
    render(
      <SemanticCanvasContextMenu
        x={120}
        y={80}
        downloadUrl="/api/rooms/room-1/assets?assetId=image-1"
        onDismiss={onDismiss}
      />,
    );

    const menu = screen.getByRole("menu", { name: "Image actions" });
    expect(menu).toHaveStyle({ left: "120px", top: "80px" });
    const download = screen.getByRole("menuitem", { name: "Download original" });
    expect(download).toHaveAttribute("href", "/api/rooms/room-1/assets?assetId=image-1");
    expect(download).toHaveAttribute("download");
    expect(download).toHaveFocus();
    expect(screen.queryByRole("menuitem", { name: /Export/i })).not.toBeInTheDocument();

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("contains context-menu traffic and dismisses from the keyboard", () => {
    const onDismiss = vi.fn();
    const parentPointer = vi.fn();
    const parentContext = vi.fn();
    render(
      <div onPointerDown={parentPointer} onContextMenu={parentContext}>
        <SemanticCanvasContextMenu
          x={0}
          y={0}
          downloadUrl="/asset.png"
          onDismiss={onDismiss}
        />
      </div>,
    );

    const menu = screen.getByRole("menu", { name: "Image actions" });
    fireEvent.pointerDown(menu);
    fireEvent.contextMenu(menu);
    expect(parentPointer).not.toHaveBeenCalled();
    expect(parentContext).not.toHaveBeenCalled();

    expect(fireEvent.keyDown(menu, { key: "Escape" })).toBe(false);
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
