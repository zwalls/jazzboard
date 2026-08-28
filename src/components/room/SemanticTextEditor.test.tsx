import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SEMANTIC_TEXT_EDIT_LIMITS } from "@/lib/canvas/semantic-text-edit-session";
import type { ShapeObject, TextObject, Viewport } from "@/lib/domain/types";

import { SemanticTextEditor, type SemanticTextEditorProps } from "./SemanticTextEditor";

const actor = {
  participantId: "participant-1",
  displayName: "Ada",
  color: "#5965e8",
  kind: "human" as const,
};

const textObject: TextObject = {
  id: "text-1",
  kind: "text",
  x: 140,
  y: 90,
  width: 120,
  height: 60,
  rotation: Math.PI / 6,
  zIndex: 7,
  revision: 3,
  groupId: null,
  diagramIds: [],
  createdAt: 1,
  updatedAt: 2,
  createdBy: actor,
  lastEditedBy: actor,
  content: "Hello world",
  color: "black",
  size: "m",
  align: "middle",
};

const shapeObject: ShapeObject = {
  id: "shape-1",
  kind: "shape",
  x: 20,
  y: 30,
  width: 180,
  height: 80,
  rotation: 0,
  zIndex: 2,
  revision: 4,
  groupId: null,
  diagramIds: [],
  createdAt: 1,
  updatedAt: 2,
  createdBy: actor,
  lastEditedBy: actor,
  shape: "rectangle",
  nodeType: "service",
  label: "Room API",
  fill: "light-violet",
  stroke: "blue",
};

const viewport: Viewport = {
  x: 100,
  y: 50,
  width: 400,
  height: 300,
  zoom: 2,
};

const defaultCallbacks = {
  onDraftChange: vi.fn(),
  onCommit: vi.fn(),
  onCancel: vi.fn(),
};

function renderEditor(overrides: Partial<SemanticTextEditorProps> = {}) {
  const props: SemanticTextEditorProps = {
    sessionId: "session-1",
    object: textObject,
    viewport,
    draft: textObject.content,
    ...defaultCallbacks,
    ...overrides,
  };
  return render(<SemanticTextEditor {...props} />);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SemanticTextEditor", () => {
  it("maps page geometry to viewport pixels and rotates around the object center", () => {
    renderEditor();

    const editor = screen.getByRole("textbox", {
      name: "Edit text content for object text-1",
    });
    const frame = editor.closest("[data-semantic-text-editor='true']");

    expect(frame).not.toBeNull();
    expect(frame).toHaveStyle({
      left: "80px",
      top: "80px",
      width: "240px",
      height: "120px",
      transform: `rotate(${Math.PI / 6}rad)`,
      transformOrigin: "center center",
    });
    expect(editor).toHaveStyle({ fontSize: "40px", textAlign: "center" });
    expect(frame).toHaveAttribute("data-object-id", "text-1");
    expect(frame).toHaveAttribute("data-edit-field", "content");
  });

  it("focuses and selects the controlled draft when a session begins", () => {
    renderEditor();

    const editor = screen.getByRole<HTMLTextAreaElement>("textbox");
    expect(editor).toHaveFocus();
    expect(editor.selectionStart).toBe(0);
    expect(editor.selectionEnd).toBe(textObject.content.length);
  });

  it("renders controlled typing frame-immediately, including an empty string", () => {
    const onDraftChange = vi.fn();

    function Harness() {
      const [draft, setDraft] = useState(textObject.content);
      return (
        <SemanticTextEditor
          sessionId="controlled-session"
          object={textObject}
          viewport={viewport}
          draft={draft}
          onDraftChange={(value) => {
            onDraftChange(value);
            setDraft(value);
          }}
          onCommit={vi.fn()}
          onCancel={vi.fn()}
        />
      );
    }

    render(<Harness />);
    const editor = screen.getByRole<HTMLTextAreaElement>("textbox");

    fireEvent.change(editor, { target: { value: "Updated immediately" } });
    expect(onDraftChange).toHaveBeenLastCalledWith("Updated immediately");
    expect(editor).toHaveValue("Updated immediately");

    fireEvent.change(editor, { target: { value: "" } });
    expect(onDraftChange).toHaveBeenLastCalledWith("");
    expect(editor).toHaveValue("");
  });

  it("commits exactly once on blur", () => {
    const onCommit = vi.fn();
    renderEditor({ onCommit });

    const editor = screen.getByRole("textbox");
    fireEvent.blur(editor);
    fireEvent.blur(editor);

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(defaultCallbacks.onCancel).not.toHaveBeenCalled();
  });

  it.each([
    ["Command", { metaKey: true }],
    ["Control", { ctrlKey: true }],
  ])("commits on %s+Enter and prevents the canvas shortcut", (_name, modifier) => {
    const onCommit = vi.fn();
    renderEditor({ onCommit });

    const editor = screen.getByRole("textbox");
    const dispatched = fireEvent.keyDown(editor, { key: "Enter", ...modifier });

    expect(dispatched).toBe(false);
    expect(onCommit).toHaveBeenCalledTimes(1);
    fireEvent.blur(editor);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("uses Escape as a dedicated cancel path and never turns its later blur into a commit", () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    renderEditor({ onCommit, onCancel });

    const editor = screen.getByRole("textbox");
    const dispatched = fireEvent.keyDown(editor, { key: "Escape" });
    fireEvent.blur(editor);

    expect(dispatched).toBe(false);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("keeps ordinary Enter inside the multiline draft instead of committing", () => {
    const onCommit = vi.fn();
    renderEditor({ onCommit });

    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits single-line creation with ordinary Enter when explicitly requested", () => {
    const onCommit = vi.fn();
    renderEditor({ onCommit, commitOnEnter: true });

    const dispatched = fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

    expect(dispatched).toBe(false);
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it("stops pointer, mouse, wheel, focus, and keyboard events from reaching the canvas", () => {
    const canvasHandlers = {
      click: vi.fn(),
      doubleClick: vi.fn(),
      mouseDown: vi.fn(),
      mouseMove: vi.fn(),
      mouseUp: vi.fn(),
      pointerCancel: vi.fn(),
      pointerDown: vi.fn(),
      pointerMove: vi.fn(),
      pointerUp: vi.fn(),
      wheel: vi.fn(),
      focus: vi.fn(),
      keyDown: vi.fn(),
      keyPress: vi.fn(),
      keyUp: vi.fn(),
    };

    render(
      <div
        onClick={canvasHandlers.click}
        onDoubleClick={canvasHandlers.doubleClick}
        onMouseDown={canvasHandlers.mouseDown}
        onMouseMove={canvasHandlers.mouseMove}
        onMouseUp={canvasHandlers.mouseUp}
        onPointerCancel={canvasHandlers.pointerCancel}
        onPointerDown={canvasHandlers.pointerDown}
        onPointerMove={canvasHandlers.pointerMove}
        onPointerUp={canvasHandlers.pointerUp}
        onWheel={canvasHandlers.wheel}
        onFocus={canvasHandlers.focus}
        onKeyDown={canvasHandlers.keyDown}
        onKeyPress={canvasHandlers.keyPress}
        onKeyUp={canvasHandlers.keyUp}
      >
        <SemanticTextEditor
          sessionId="propagation-session"
          object={textObject}
          viewport={viewport}
          draft={textObject.content}
          {...defaultCallbacks}
        />
      </div>,
    );

    const editor = screen.getByRole("textbox");
    fireEvent.click(editor);
    fireEvent.doubleClick(editor);
    fireEvent.mouseDown(editor);
    fireEvent.mouseMove(editor);
    fireEvent.mouseUp(editor);
    fireEvent.pointerDown(editor);
    fireEvent.pointerMove(editor);
    fireEvent.pointerUp(editor);
    fireEvent.pointerCancel(editor);
    fireEvent.wheel(editor);
    fireEvent.keyDown(editor, { key: "a" });
    fireEvent.keyPress(editor, { key: "a", charCode: 97 });
    fireEvent.keyUp(editor, { key: "a" });

    for (const handler of Object.values(canvasHandlers)) {
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it("uses the authoritative field limits for text content and shape labels", () => {
    const onDraftChange = vi.fn();
    const { rerender } = renderEditor({ onDraftChange });
    const editor = screen.getByRole<HTMLTextAreaElement>("textbox");

    expect(editor.maxLength).toBe(SEMANTIC_TEXT_EDIT_LIMITS.content);
    fireEvent.change(editor, {
      target: { value: "x".repeat(SEMANTIC_TEXT_EDIT_LIMITS.content + 1) },
    });
    expect(onDraftChange).toHaveBeenLastCalledWith(
      "x".repeat(SEMANTIC_TEXT_EDIT_LIMITS.content),
    );

    rerender(
      <SemanticTextEditor
        sessionId="shape-session"
        object={shapeObject}
        viewport={{ ...viewport, x: 0, y: 0, zoom: 1 }}
        draft={shapeObject.label}
        onDraftChange={onDraftChange}
        onCommit={defaultCallbacks.onCommit}
        onCancel={defaultCallbacks.onCancel}
      />,
    );

    const shapeEditor = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Edit shape label for object shape-1",
    });
    expect(shapeEditor.maxLength).toBe(SEMANTIC_TEXT_EDIT_LIMITS.label);
    expect(shapeEditor.closest("[data-semantic-text-editor='true']"))
      .toHaveAttribute("data-edit-field", "label");
  });

  it("allows an explicit truthful accessible label for contextual integrations", () => {
    renderEditor({ ariaLabel: "Edit title for Authentication request flow" });

    expect(screen.getByRole("textbox", {
      name: "Edit title for Authentication request flow",
    })).toBeInTheDocument();
  });
});
