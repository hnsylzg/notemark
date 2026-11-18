import { describe, expect, it } from "vitest";
import { checkBoxCheckedIcon, syncTaskCheckboxA11y } from "./list-item";

describe("task checkbox rendering", () => {
  it("keeps SVG colors themeable", () => {
    expect(checkBoxCheckedIcon).toContain('fill="currentColor"');
    expect(checkBoxCheckedIcon).toContain('stroke="currentColor"');
    expect(checkBoxCheckedIcon).toContain(
      'stroke="var(--mt-task-check-fg, #fff)"'
    );
  });

  it("adds checkbox semantics and removes them when the item stops being a task", () => {
    const root = document.createElement("div");
    root.innerHTML = `<div class="milkdown-list-item-block"><div class="label-wrapper"><span class="label checked">${checkBoxCheckedIcon}</span></div></div>`;
    const wrapper = root.querySelector<HTMLElement>(".label-wrapper")!;

    syncTaskCheckboxA11y(root);
    expect(wrapper.dataset.taskCheckbox).toBe("true");
    expect(wrapper.getAttribute("role")).toBe("checkbox");
    expect(wrapper.getAttribute("aria-checked")).toBe("true");
    expect(wrapper.tabIndex).toBe(0);

    const label = wrapper.querySelector<HTMLElement>(".label")!;
    label.className = "label bullet";
    syncTaskCheckboxA11y(root);
    expect(wrapper.dataset.taskCheckbox).toBeUndefined();
    expect(wrapper.hasAttribute("role")).toBe(false);
    expect(wrapper.hasAttribute("aria-checked")).toBe(false);
    expect(wrapper.hasAttribute("tabindex")).toBe(false);
  });
});
