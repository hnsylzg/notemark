import { describe, expect, it } from "vitest";
import { presentContextMenu } from "./context-menu-controller";

describe("context menu focus", () => {
  it("does not steal focus when the menu opens", () => {
    const editor = document.createElement("div");
    editor.tabIndex = 0;
    document.body.appendChild(editor);
    editor.focus();

    const menu = document.createElement("div");
    const item = document.createElement("button");
    item.type = "button";
    item.setAttribute("role", "menuitem");
    menu.appendChild(item);

    const handle = presentContextMenu({
      menu,
      clientX: 10,
      clientY: 10,
    });

    try {
      expect(document.activeElement).toBe(editor);
    } finally {
      handle.close();
      editor.remove();
    }
  });
});
