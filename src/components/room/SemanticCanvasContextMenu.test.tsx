import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SemanticCanvasContextMenu } from "./SemanticCanvasContextMenu";

afterEach(cleanup);

describe("SemanticCanvasContextMenu", () => {
  it("renders semantic actions, focuses the first enabled item, and dispatches by action ID", () => {
    const onAction = vi.fn();
    const onDismiss = vi.fn();
    render(
      <SemanticCanvasContextMenu
        x={120}
        y={80}
        label="Object actions"
        items={[
          { id: "edit", label: "Edit label" },
          { id: "copy", label: "Copy", shortcut: "⌘C" },
          { id: "delete", label: "Delete", danger: true, dividerBefore: true },
        ]}
        onAction={onAction}
        onDismiss={onDismiss}
      />,
    );

    const menu = screen.getByRole("menu", { name: "Object actions" });
    expect(menu).toHaveStyle({ left: "120px", top: "80px" });
    expect(screen.getByRole("menuitem", { name: "Edit label" })).toHaveFocus();

    fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));
    expect(onAction).toHaveBeenCalledExactlyOnceWith("copy");
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("keeps original-image download separate from the board export action", () => {
    const onAction = vi.fn();
    const onDismiss = vi.fn();
    render(
      <SemanticCanvasContextMenu
        x={0}
        y={0}
        label="Object actions"
        items={[{
          id: "download-original",
          label: "Download original",
          href: "/api/rooms/room-1/assets?assetId=image-1",
          download: true,
        }]}
        onAction={onAction}
        onDismiss={onDismiss}
      />,
    );

    const download = screen.getByRole("menuitem", { name: "Download original" });
    expect(download).toHaveAttribute("href", "/api/rooms/room-1/assets?assetId=image-1");
    expect(download).toHaveAttribute("download");
    expect(download).toHaveFocus();
    expect(screen.queryByRole("menuitem", { name: /Export/i })).not.toBeInTheDocument();

    expect(onDismiss).not.toHaveBeenCalled();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("contains context-menu traffic, supports roving focus, and dismisses from the keyboard", () => {
    const onAction = vi.fn();
    const onDismiss = vi.fn();
    const parentPointer = vi.fn();
    const parentContext = vi.fn();
    render(
      <div onPointerDown={parentPointer} onContextMenu={parentContext}>
        <SemanticCanvasContextMenu
          x={0}
          y={0}
          label="Canvas actions"
          items={[
            { id: "paste", label: "Paste" },
            { id: "select-all", label: "Select all" },
            { id: "fit-board", label: "Fit board" },
          ]}
          onAction={onAction}
          onDismiss={onDismiss}
        />
      </div>,
    );

    const menu = screen.getByRole("menu", { name: "Canvas actions" });
    fireEvent.pointerDown(menu);
    fireEvent.contextMenu(menu);
    expect(parentPointer).not.toHaveBeenCalled();
    expect(parentContext).not.toHaveBeenCalled();

    const paste = screen.getByRole("menuitem", { name: "Paste" });
    const selectAll = screen.getByRole("menuitem", { name: "Select all" });
    const fitBoard = screen.getByRole("menuitem", { name: "Fit board" });
    expect(paste).toHaveFocus();
    expect(paste).toHaveAttribute("tabindex", "0");
    expect(selectAll).toHaveAttribute("tabindex", "-1");
    expect(fireEvent.keyDown(menu, { key: "ArrowDown" })).toBe(false);
    expect(selectAll).toHaveFocus();
    expect(paste).toHaveAttribute("tabindex", "-1");
    expect(selectAll).toHaveAttribute("tabindex", "0");
    expect(fireEvent.keyDown(menu, { key: "End" })).toBe(false);
    expect(fitBoard).toHaveFocus();
    expect(fitBoard).toHaveAttribute("tabindex", "0");
    expect(fireEvent.keyDown(menu, { key: "Tab" })).toBe(true);
    expect(onDismiss).toHaveBeenCalledOnce();
    onDismiss.mockClear();
    expect(fireEvent.keyDown(menu, { key: "Escape" })).toBe(false);
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
