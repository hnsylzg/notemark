import { describe, expect, it, vi } from "vitest";
import {
  applySourceEnter,
  applySourceTab,
  handleSourceKeydown,
} from "./source-tab";

describe("source editor Tab indentation", () => {
  it("inserts one tab for a collapsed selection", () => {
    expect(applySourceTab("abc", 1, 1, false)).toEqual({
      value: "a\tbc",
      selectionStart: 2,
      selectionEnd: 2,
    });
  });

  it("indents every selected line", () => {
    expect(applySourceTab("alpha\nbeta\nomega", 2, 7, false)).toEqual({
      value: "\talpha\n\tbeta\nomega",
      selectionStart: 3,
      selectionEnd: 9,
    });
  });

  it("does not indent the next line when selection ends at its start", () => {
    expect(applySourceTab("alpha\nbeta", 0, 6, false)).toEqual({
      value: "\talpha\nbeta",
      selectionStart: 1,
      selectionEnd: 7,
    });
  });

  it("outdents tabs and four-space indentation", () => {
    expect(
      applySourceTab("\talpha\n    beta\n  omega", 1, 15, true)
    ).toEqual({
      value: "alpha\nbeta\n  omega",
      selectionStart: 0,
      selectionEnd: 10,
    });
  });

  it("outdents the current line for a collapsed selection", () => {
    expect(applySourceTab("  alpha", 4, 4, true)).toEqual({
      value: "alpha",
      selectionStart: 2,
      selectionEnd: 2,
    });
  });

  it("applies Tab through the shared textarea adapter", () => {
    const textarea = document.createElement("textarea");
    textarea.value = "alpha";
    textarea.setSelectionRange(2, 2);
    const input = vi.fn();
    textarea.addEventListener("input", input);
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });

    expect(handleSourceKeydown(event, textarea)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(textarea.value).toBe("al\tpha");
    expect(textarea.selectionStart).toBe(3);
    expect(input).toHaveBeenCalledOnce();
  });

  it("continues leading tabs and spaces on Enter", () => {
    expect(applySourceEnter("\talpha", 6, 6)).toEqual({
      value: "\talpha\n\t",
      selectionStart: 8,
      selectionEnd: 8,
    });
    expect(applySourceEnter("    beta", 8, 8)).toEqual({
      value: "    beta\n    ",
      selectionStart: 13,
      selectionEnd: 13,
    });
    expect(applySourceEnter("alpha", 2, 2)).toBeNull();
  });

  it("inherits code indentation without treating quote markers as structure", () => {
    expect(applySourceEnter("\tvalue", 6, 6, false)).toEqual({
      value: "\tvalue\n\t",
      selectionStart: 8,
      selectionEnd: 8,
    });
    expect(applySourceEnter("> value", 7, 7, false)).toBeNull();
  });

  it("continues blockquote markers without copying quote indentation", () => {
    expect(applySourceEnter("> \tquoted", 9, 9)).toEqual({
      value: "> \tquoted\n> ",
      selectionStart: 12,
      selectionEnd: 12,
    });
    expect(applySourceEnter(">    quoted", 11, 11)).toEqual({
      value: ">    quoted\n> ",
      selectionStart: 14,
      selectionEnd: 14,
    });
    expect(applySourceEnter("> > \tquoted", 11, 11)).toEqual({
      value: "> > \tquoted\n> > ",
      selectionStart: 16,
      selectionEnd: 16,
    });
    expect(applySourceEnter("> ", 2, 2)).toEqual({
      value: "> \n",
      selectionStart: 3,
      selectionEnd: 3,
    });
  });

  it("does not inherit indentation when replacing a selection", () => {
    expect(applySourceEnter("\talpha", 1, 3)).toBeNull();
  });

  it("applies Enter indentation through the shared textarea adapter", () => {
    const textarea = document.createElement("textarea");
    textarea.value = "\talpha";
    textarea.setSelectionRange(6, 6);
    const input = vi.fn();
    textarea.addEventListener("input", input);
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });

    expect(handleSourceKeydown(event, textarea)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(textarea.value).toBe("\talpha\n\t");
    expect(textarea.selectionStart).toBe(8);
    expect(input).toHaveBeenCalledOnce();
  });

  it("leaves Shift+Enter to native textarea behavior", () => {
    const textarea = document.createElement("textarea");
    textarea.value = "\talpha";
    textarea.setSelectionRange(6, 6);
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });

    expect(handleSourceKeydown(event, textarea)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });
});
