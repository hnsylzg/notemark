import { Schema } from "@milkdown/prose/model";
import { EditorState } from "@milkdown/prose/state";
import { EditorView } from "@milkdown/prose/view";
import { describe, expect, it } from "vitest";
import { createAlertNodeView, parseAlertSource } from "./alert";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      parseDOM: [{ tag: "p" }],
      toDOM: () => ["p", 0],
    },
    blockquote: {
      group: "block",
      content: "block+",
      parseDOM: [{ tag: "blockquote" }],
      toDOM: () => ["blockquote", 0],
    },
    alert: {
      group: "block",
      content: "block+",
      defining: true,
      attrs: {
        alertType: { default: "note" },
        title: { default: "" },
      },
      parseDOM: [{ tag: "blockquote[data-alert]" }],
      toDOM: () => ["blockquote", { "data-alert": "note" }, 0],
    },
    text: { group: "inline" },
  },
});

function createAlertView() {
  const alert = schema.nodes.alert.create({ alertType: "note" }, [
    schema.nodes.paragraph.create(null, schema.text("正文")),
  ]);
  const doc = schema.node("doc", null, [alert]);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView(host, {
    state: EditorState.create({ schema, doc }),
    nodeViews: { alert: createAlertNodeView },
  });
  return { view, host };
}

async function startTitleEdit(view: EditorView): Promise<HTMLInputElement> {
  const title = view.dom.querySelector<HTMLElement>(".md-alert-title");
  expect(title).not.toBeNull();
  const down = new MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
    button: 0,
  });
  title!.dispatchEvent(down);
  expect(down.defaultPrevented).toBe(true);
  const input = view.dom.querySelector<HTMLInputElement>(
    ".md-alert-title-input"
  );
  expect(input).not.toBeNull();
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => resolve())
  );
  expect(input!.isConnected).toBe(true);
  expect(document.activeElement).toBe(input);
  expect(input!.selectionStart).toBe("[!NOTE]".length - 1);
  expect(input!.selectionEnd).toBe("[!NOTE]".length - 1);
  title!.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })
  );
  return input!;
}

describe("editable GitHub Alert title", () => {
  it("edits the source marker and updates the alert type without replacing content", async () => {
    const { view, host } = createAlertView();

    try {
      const content = view.dom.querySelector(".md-alert-content");
      expect(content?.textContent).toBe("正文");
      const input = await startTitleEdit(view);
      expect(input.value).toBe("[!NOTE]");

      input.value = "[!warning] 请先备份";
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );

      expect(view.state.doc.firstChild?.attrs.alertType).toBe("warning");
      expect(view.state.doc.firstChild?.attrs.title).toBe("请先备份");
      expect(view.dom.querySelector(".md-alert")?.className).toContain(
        "md-alert-warning"
      );
      expect(view.dom.querySelector(".md-alert-title")?.textContent).toBe(
        "请先备份"
      );
      expect(view.dom.querySelector(".md-alert-content")?.textContent).toBe(
        "正文"
      );
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("keeps the original type when the edited marker is invalid", async () => {
    const { view, host } = createAlertView();

    try {
      const input = await startTitleEdit(view);
      input.value = "[!UNKNOWN]";
      document.body.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0 })
      );

      expect(view.state.doc.firstChild?.attrs.alertType).toBe("note");
      expect(view.dom.querySelector(".md-alert-title")?.textContent).toBe(
        "Note"
      );
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("converts an alert back to a blockquote when its source is deleted", async () => {
    const { view, host } = createAlertView();

    try {
      const input = await startTitleEdit(view);
      input.value = "";
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );

      expect(view.state.doc.firstChild?.type.name).toBe("blockquote");
      expect(view.state.doc.firstChild?.textContent).toBe("正文");
      expect(view.dom.querySelector(".md-alert")).toBeNull();
      expect(view.dom.querySelector("blockquote")?.textContent).toBe("正文");
    } finally {
      view.destroy();
      host.remove();
    }
  });
});

describe("alert source", () => {
  it("parses the type and optional custom title", () => {
    expect(parseAlertSource("[!note]")).toEqual({
      alertType: "note",
      title: "",
    });
    expect(parseAlertSource("[!warning] 发布前检查")).toEqual({
      alertType: "warning",
      title: "发布前检查",
    });
  });
});
