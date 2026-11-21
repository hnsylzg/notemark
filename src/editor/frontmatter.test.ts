import { editorViewCtx } from "@milkdown/kit/core";
import { Schema } from "@milkdown/prose/model";
import { EditorState } from "@milkdown/prose/state";
import { EditorView } from "@milkdown/prose/view";
import { GapCursor } from "@milkdown/prose/gapcursor";
import { describe, expect, it } from "vitest";
import {
  createFrontmatterNodeView,
  parseFrontmatterRows,
} from "./frontmatter";
import { createEditor, setMarkdown } from "./index";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "inline*",
      toDOM: () => ["p", 0],
    },
    yaml: {
      group: "block",
      atom: true,
      attrs: { value: { default: "" } },
      toDOM: () => ["div", { class: "mt-frontmatter" }],
    },
    text: { group: "inline" },
  },
});

function createView(value: string) {
  const yaml = schema.nodes.yaml.create({ value });
  const doc = schema.node("doc", null, [yaml]);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView(host, {
    state: EditorState.create({ schema, doc }),
    nodeViews: {
      yaml: createFrontmatterNodeView,
    },
  });
  return { view, host };
}

describe("Front Matter preview", () => {
  it("parses simple YAML properties for display", () => {
    expect(parseFrontmatterRows("title: 文档标题\ntags: test")).toEqual([
      { key: "title", value: "文档标题" },
      { key: "tags", value: "test" },
    ]);
  });

  it("renders committed values and exits source mode on blur", async () => {
    const { view, host } = createView("title: 旧标题");

    try {
      const dom = view.dom.querySelector<HTMLElement>(".mt-frontmatter")!;
      const body = dom.querySelector<HTMLTextAreaElement>(
        ".mt-frontmatter-body"
      )!;
      const source = dom.querySelector<HTMLElement>(".mt-block-source")!;

      dom.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect(source.style.display).toBe("");

      body.value = "title: 新标题\ndate: 2026-11-17";
      body.dispatchEvent(new FocusEvent("blur"));

      expect(view.state.doc.firstChild!.attrs.value).toBe(
        "title: 新标题\ndate: 2026-11-17"
      );
      expect(source.style.display).toBe("none");
      expect(dom.textContent).toContain("新标题");
      expect(dom.textContent).toContain("2026-11-17");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("removes empty Front Matter when editing ends", async () => {
    const { view, host } = createView("");

    try {
      const dom = view.dom.querySelector<HTMLElement>(".mt-frontmatter")!;
      const body = dom.querySelector<HTMLTextAreaElement>(
        ".mt-frontmatter-body"
      )!;

      dom.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      body.dispatchEvent(new FocusEvent("blur"));

      expect(view.state.doc.firstChild!.type.name).toBe("paragraph");
    } finally {
      view.destroy();
      host.remove();
    }
  });

  it("allows the cursor before Front Matter", async () => {
    const root = document.createElement("div");
    root.className = "milkdown";
    document.body.appendChild(root);
    const editor = createEditor(root);

    try {
      await editor.create();
      setMarkdown(
        editor,
        "---\ntitle: Test\n---\n\n正文\n"
      );
      const view = editor.action((ctx) =>
        ctx.get(editorViewCtx)
      );

      view.dispatch(
        view.state.tr.setSelection(
          new GapCursor(view.state.doc.resolve(0))
        )
      );

      expect(view.state.selection).toBeInstanceOf(GapCursor);
      expect(view.state.selection.$from.nodeAfter?.type.name).toBe(
        "yaml"
      );
    } finally {
      await editor.destroy();
      root.remove();
    }
  });
});
