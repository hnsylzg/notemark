/*
 * Lazy code-block view that keeps a mounted editor alive.
 *
 * Milkdown's stock view initializes CodeMirror when a block approaches the
 * viewport, then destroys it after five seconds off-screen and restores the
 * placeholder. If the mounted and placeholder heights differ at all, a block
 * near the observer boundary can oscillate between those states.
 *
 * This wrapper preserves lazy initialization but disables teardown after the
 * first mount. Code blocks never duplicate across the document, and only blocks
 * the user has actually approached keep an editor instance.
 */
import type { MilkdownPlugin } from "@milkdown/ctx";
import type {
  LanguageDescription,
  LanguageSupport,
} from "@codemirror/language";
import { Compartment, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  CodeMirrorBlock,
  codeBlockConfig,
  type CodeBlockConfig,
} from "@milkdown/components/code-block";
import { codeBlockSchema } from "@milkdown/kit/preset/commonmark";
import type { NodeViewConstructor } from "@milkdown/prose/view";
import { $view } from "@milkdown/utils";
import {
  renderMermaidSvg,
  subscribeMermaidTheme,
} from "./mermaid-renderer";
import {
  diagramLanguage,
  MARKMAP_LANGUAGE,
  MERMAID_LANGUAGE,
  type DiagramLanguage,
} from "./diagram-language";
import {
  renderMarkmapSvg,
  subscribeMarkmapTheme,
} from "./markmap-renderer";
import { preserveMermaidVennTitleInSvg } from "./mermaid-export";
import { applySourceEnter, applySourceTab } from "./source-tab";
import {
  getCodeBlockLineWrap,
  subscribeCodeBlockLineWrap,
} from "./code-block-line-wrap";

type CodeMirrorBlockArgs = ConstructorParameters<typeof CodeMirrorBlock>;
type CodeMirrorBlockInternals = {
  scheduleTeardown(): void;
};

/** Floating-menu breathing room, expressed in root-relative CSS units. */
const LANGUAGE_PICKER_VIEWPORT_INSET_REM = 0.75;

export type FloatingRect = Pick<
  DOMRectReadOnly,
  "top" | "right" | "bottom" | "left"
>;

export type FloatingSize = {
  width: number;
  height: number;
};

export type FloatingCoordinates = {
  left: number;
  top: number;
};

type ApplyPreview = Parameters<CodeBlockConfig["renderPreview"]>[2];

export interface DiagramCodeBlockPreview {
  renderPreview: CodeBlockConfig["renderPreview"];
  destroy(): void;
}

let previewRenderSequence = 0;

function diagramPreviewMarkup(
  kind: DiagramLanguage,
  svg: string
): string {
  return `<div class="diagram ${kind}-preview">${svg}</div>`;
}

function diagramPreviewError(
  kind: DiagramLanguage,
  error: unknown
): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = `diagram ${kind}-preview ${kind}-preview--error`;
  const message = document.createElement("pre");
  message.className = "error";
  message.textContent =
    error instanceof Error ? error.message : String(error);
  wrapper.appendChild(message);
  return wrapper;
}

/**
 * 每个代码块持有独立的渲染序号，避免快速修改语言或源码时，较早的异步
 * Mermaid 结果覆盖较新的预览；同时把渲染注册到主题切换回调中。
 */
export function createDiagramCodeBlockPreview(): DiagramCodeBlockPreview {
  let revision = 0;
  let current: {
    kind: DiagramLanguage;
    source: string;
    apply: ApplyPreview;
  } | null = null;

  const renderCurrent = (): void => {
    const request = current;
    if (!request) return;
    const requestRevision = ++revision;
    const renderId = `code-preview-${++previewRenderSequence}`;
    const render =
      request.kind === "mermaid"
        ? renderMermaidSvg(request.source, renderId, requestRevision)
        : renderMarkmapSvg(request.source);
    void render
      .then((svg) => {
        if (requestRevision !== revision) return;
        const previewSvg =
          request.kind === "mermaid"
            ? preserveMermaidVennTitleInSvg(svg)
            : svg;
        request.apply(diagramPreviewMarkup(request.kind, previewSvg));
      })
      .catch((error) => {
        if (requestRevision !== revision) return;
        request.apply(diagramPreviewError(request.kind, error));
      });
  };

  const unsubscribeMermaidTheme = subscribeMermaidTheme(renderCurrent);
  const unsubscribeMarkmapTheme = subscribeMarkmapTheme(renderCurrent);

  return {
    renderPreview(language, content, apply) {
      revision += 1;
      const kind = diagramLanguage(language);
      if (!kind || !content.trim()) {
        current = null;
        apply(null);
        return null;
      }
      current = { kind, source: content, apply };
      renderCurrent();
      return undefined;
    },
    destroy() {
      revision += 1;
      current = null;
      unsubscribeMermaidTheme();
      unsubscribeMarkmapTheme();
    },
  };
}

export function createMermaidCodeBlockPreview(): DiagramCodeBlockPreview {
  return createDiagramCodeBlockPreview();
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

/**
 * Keep Milkdown's original bottom-start placement whenever it fits. When the
 * preferred position overflows, shift it by the minimum amount and flip above
 * only when the lower side has less space than the upper side.
 */
export function calculateLanguagePickerPosition(
  trigger: FloatingRect,
  boundary: FloatingRect,
  picker: FloatingSize,
  viewportInset: number
): FloatingCoordinates {
  const minimumLeft = boundary.left + viewportInset;
  const maximumLeft = Math.max(
    minimumLeft,
    boundary.right - viewportInset - picker.width
  );
  const minimumTop = boundary.top + viewportInset;
  const maximumTop = Math.max(
    minimumTop,
    boundary.bottom - viewportInset - picker.height
  );

  const spaceBelow = boundary.bottom - viewportInset - trigger.bottom;
  const spaceAbove = trigger.top - boundary.top - viewportInset;
  const preferredTop =
    picker.height <= spaceBelow || spaceBelow >= spaceAbove
      ? trigger.bottom
      : trigger.top - picker.height;

  return {
    left: clamp(trigger.left, minimumLeft, maximumLeft),
    top: clamp(preferredTop, minimumTop, maximumTop),
  };
}

function viewportInset(): number {
  const rootFontSize = Number.parseFloat(
    getComputedStyle(document.documentElement).fontSize
  );
  return (
    (Number.isFinite(rootFontSize) ? rootFontSize : 16) *
    LANGUAGE_PICKER_VIEWPORT_INSET_REM
  );
}

class PersistentCodeMirrorBlock extends CodeMirrorBlock {
  private readonly baseExtensions: Extension[];
  private readonly lineWrapCompartment = new Compartment();
  private readonly unsubscribeLineWrap: () => void;
  private languagePickerTrackingCleanup: (() => void) | null = null;
  private languagePickerListObserver: MutationObserver | null = null;
  private languagePickerActiveIndex = -1;
  private readonly languageTerms = new Map<string, string[]>();
  private diagramSourceOpen = false;
  private readonly diagramPreview = createDiagramCodeBlockPreview();

  constructor(...args: CodeMirrorBlockArgs) {
    super(...args);
    for (const language of this.loader.getAll()) {
      this.languageTerms.set(language.name, [
        language.name,
        ...language.alias,
      ]);
    }
    this.baseExtensions = [...this.config.extensions];
    this.config = {
      ...this.config,
      renderPreview: this.diagramPreview.renderPreview,
      extensions: [
        ...this.baseExtensions,
        this.lineWrapCompartment.of(
          getCodeBlockLineWrap() ? EditorView.lineWrapping : []
        ),
      ],
    };
    this.syncDiagramMode(this.node);
    const internals = this as unknown as CodeMirrorBlockInternals;
    internals.scheduleTeardown = () => {};
    // Capture runs before Milkdown's button handler, so the deferred callback
    // lands after Vue renders the menu but before its search field timer runs.
    this.dom.addEventListener(
      "click",
      this.handleLanguagePickerClick,
      true
    );
    this.dom.addEventListener(
      "keydown",
      this.handleLanguagePickerKeydown,
      true
    );
    this.dom.addEventListener(
      "input",
      this.handleLanguagePickerInput,
      true
    );
    this.dom.addEventListener(
      "click",
      this.handleDiagramPreviewClick,
      true
    );
    this.unsubscribeLineWrap = subscribeCodeBlockLineWrap((enabled) => {
      const extension = enabled ? EditorView.lineWrapping : [];
      if (!this.cm) {
        this.config.extensions = [
          ...this.baseExtensions,
          this.lineWrapCompartment.of(extension),
        ];
        return;
      }
      this.cm.dispatch({
        effects: this.lineWrapCompartment.reconfigure(extension),
      });
    });
  }

  private readonly handleLanguagePickerClick = (event: MouseEvent): void => {
    const target =
      event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>(".language-button")
        : null;
    if (!target || !this.dom.contains(target)) return;

    window.setTimeout(() => {
      if (target.dataset.expanded === "true") {
        this.positionLanguagePicker(target);
        this.trackLanguagePicker(target);
        this.trackLanguagePickerList();
      } else {
        this.stopLanguagePickerTracking();
      }
    }, 0);
  };

  private syncDiagramMode(node: Parameters<CodeMirrorBlock["update"]>[0]): void {
    const kind = diagramLanguage(node.attrs.language);
    this.dom.classList.toggle("diagram-code-block", !!kind);
    this.dom.classList.toggle("mermaid-code-block", kind === "mermaid");
    this.dom.classList.toggle("markmap-code-block", kind === "markmap");
    if (!kind) this.setDiagramSourceOpen(false);
  }

  private readonly handleLanguagePickerKeydown = (
    event: KeyboardEvent
  ): void => {
    if (this.applyCodeMirrorEnter(event)) return;
    if (this.applyCodeMirrorTab(event)) return;
    if (event.key === "Escape" && this.diagramSourceOpen) {
      event.preventDefault();
      event.stopPropagation();
      this.setDiagramSourceOpen(false);
      this.view.focus();
      return;
    }
    const target = event.target;
    if (!(target instanceof Element) || !target.closest(".language-picker")) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.closeLanguagePicker();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      this.moveLanguagePickerActive(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      this.selectActiveLanguage();
    }
  };

  private applyCodeMirrorEnter(event: KeyboardEvent): boolean {
    const target = event.target;
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      !(target instanceof Element) ||
      !target.closest(".cm-content") ||
      !this.view.editable
    ) {
      return false;
    }

    const range = this.cm.state.selection.main;
    const value = this.cm.state.doc.toString();
    const edit = applySourceEnter(
      value,
      range.from,
      range.to,
      false
    );
    const insert = edit
      ? edit.value.slice(range.from, edit.selectionStart)
      : "\n";
    event.preventDefault();
    event.stopPropagation();
    this.cm.dispatch({
      changes: { from: range.from, to: range.to, insert },
      selection: { anchor: range.from + insert.length },
      scrollIntoView: true,
    });
    return true;
  }

  private applyCodeMirrorTab(event: KeyboardEvent): boolean {
    const target = event.target;
    if (
      event.key !== "Tab" ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      !(target instanceof Element) ||
      !target.closest(".cm-content") ||
      !this.view.editable
    ) {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    const range = this.cm.state.selection.main;
    const value = this.cm.state.doc.toString();
    const edit = applySourceTab(
      value,
      range.from,
      range.to,
      event.shiftKey
    );
    if (edit.value !== value) {
      this.cm.dispatch({
        changes: { from: 0, to: value.length, insert: edit.value },
        selection: {
          anchor: edit.selectionStart,
          head: edit.selectionEnd,
        },
        scrollIntoView: true,
      });
    }
    return true;
  }

  private readonly handleLanguagePickerInput = (event: Event): void => {
    const target = event.target;
    if (
      !(target instanceof HTMLInputElement) ||
      !target.matches(".language-picker .search-input")
    ) {
      return;
    }
    window.setTimeout(() => this.syncLanguagePickerItems(), 0);
  };

  private readonly handleDiagramPreviewClick = (
    event: MouseEvent
  ): void => {
    const target = event.target;
    if (
      !(target instanceof Element) ||
      !target.closest(".mermaid-preview, .markmap-preview") ||
      this.diagramSourceOpen
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.setDiagramSourceOpen(true);
  };

  private readonly handleDocumentPointerDown = (
    event: PointerEvent
  ): void => {
    if (!this.diagramSourceOpen) return;
    const target = event.target;
    if (target instanceof Node && this.dom.contains(target)) return;
    this.setDiagramSourceOpen(false);
  };

  private setDiagramSourceOpen(open: boolean): void {
    if (this.diagramSourceOpen === open) return;
    const toggle = this.dom.querySelector<HTMLButtonElement>(
      ".preview-toggle-button"
    );
    if (open && !toggle) return;
    const kind = diagramLanguage(this.node.attrs.language);
    if (open && !kind) return;
    this.diagramSourceOpen = open;
    this.dom.classList.toggle("is-editing-diagram-source", open);
    this.dom.classList.toggle(
      "is-editing-mermaid-source",
      open && kind === "mermaid"
    );
    this.dom.classList.toggle(
      "is-editing-markmap-source",
      open && kind === "markmap"
    );
    toggle?.click();
    if (open) {
      document.addEventListener(
        "pointerdown",
        this.handleDocumentPointerDown,
        true
      );
      requestAnimationFrame(() => {
        if (!this.diagramSourceOpen || this.view.isDestroyed) return;
        const end = this.cm.state.doc.length;
        this.cm.dispatch({ selection: { anchor: end } });
        this.cm.focus();
      });
    } else {
      document.removeEventListener(
        "pointerdown",
        this.handleDocumentPointerDown,
        true
      );
    }
  }

  private positionLanguagePicker(trigger: HTMLButtonElement): void {
    const picker = this.dom.querySelector<HTMLElement>(".language-picker");
    const panel = picker?.querySelector<HTMLElement>(".list-wrapper");
    if (!picker || !panel) return;

    const containingBlock =
      picker.offsetParent instanceof HTMLElement ? picker.offsetParent : this.dom;
    const editor = this.dom.closest<HTMLElement>(".milkdown");
    const triggerRect = trigger.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const containingRect = containingBlock.getBoundingClientRect();
    const boundaryRect = editor?.getBoundingClientRect() ?? {
      top: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
      left: 0,
    };
    const panelMarginTop =
      Number.parseFloat(getComputedStyle(panel).marginTop) || 0;
    const coordinates = calculateLanguagePickerPosition(
      triggerRect,
      boundaryRect,
      {
        width: panelRect.width,
        height: panelRect.height + panelMarginTop,
      },
      viewportInset()
    );

    picker.style.left = `${coordinates.left - containingRect.left}px`;
    picker.style.top = `${
      coordinates.top - containingRect.top - panelMarginTop
    }px`;
  }

  private trackLanguagePicker(trigger: HTMLButtonElement): void {
    this.stopLanguagePickerTracking();

    const updatePosition = () => {
      if (trigger.dataset.expanded !== "true") {
        this.stopLanguagePickerTracking();
        return;
      }
      this.positionLanguagePicker(trigger);
    };
    const observer = new MutationObserver(updatePosition);
    observer.observe(trigger, {
      attributes: true,
      attributeFilter: ["data-expanded"],
    });
    window.addEventListener("resize", updatePosition, { passive: true });
    document.addEventListener("scroll", updatePosition, true);

    this.languagePickerTrackingCleanup = () => {
      observer.disconnect();
      window.removeEventListener("resize", updatePosition);
      document.removeEventListener("scroll", updatePosition, true);
    };
  }

  private trackLanguagePickerList(): void {
    this.languagePickerListObserver?.disconnect();
    const list = this.dom.querySelector<HTMLElement>(
      ".language-picker .language-list"
    );
    if (!list) return;
    this.languagePickerListObserver = new MutationObserver(() => {
      this.syncLanguagePickerItems();
    });
    this.languagePickerListObserver.observe(list, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    this.syncLanguagePickerItems();
  }

  private syncLanguagePickerItems(): void {
    const input = this.dom.querySelector<HTMLInputElement>(
      ".language-picker .search-input"
    );
    const items = Array.from(
      this.dom.querySelectorAll<HTMLElement>(
        ".language-picker .language-list-item[data-language]"
      )
    );
    if (!input || items.length === 0) return;

    const query = input.value.trim().toLowerCase();
    const visible: HTMLElement[] = [];
    for (const item of items) {
      const name = item.dataset.language ?? "";
      const terms = this.languageTerms.get(name) ?? [name];
      const matches =
        !query ||
        terms.some((term) => term.toLowerCase().includes(query));
      item.hidden = !matches;
      item.setAttribute("aria-hidden", String(!matches));
      item.classList.remove("is-keyboard-active");
      if (matches) visible.push(item);
    }

    if (visible.length === 0) {
      this.languagePickerActiveIndex = -1;
      return;
    }
    this.languagePickerActiveIndex = Math.max(
      0,
      Math.min(this.languagePickerActiveIndex, visible.length - 1)
    );
    visible[this.languagePickerActiveIndex].classList.add(
      "is-keyboard-active"
    );
  }

  private visibleLanguageItems(): HTMLElement[] {
    return Array.from(
      this.dom.querySelectorAll<HTMLElement>(
        ".language-picker .language-list-item[data-language]"
      )
    ).filter((item) => !item.hidden);
  }

  private moveLanguagePickerActive(direction: -1 | 1): void {
    this.syncLanguagePickerItems();
    const items = this.visibleLanguageItems();
    if (items.length === 0) return;
    const current = this.languagePickerActiveIndex;
    this.languagePickerActiveIndex =
      current < 0
        ? 0
        : (current + direction + items.length) % items.length;
    for (const item of items) item.classList.remove("is-keyboard-active");
    const active = items[this.languagePickerActiveIndex];
    active.classList.add("is-keyboard-active");
    active.scrollIntoView?.({ block: "nearest" });
  }

  private selectActiveLanguage(): boolean {
    this.syncLanguagePickerItems();
    const items = this.visibleLanguageItems();
    if (items.length === 0) return false;
    const index = Math.max(
      0,
      Math.min(this.languagePickerActiveIndex, items.length - 1)
    );
    items[index].click();
    return true;
  }

  private closeLanguagePicker(): void {
    const trigger = this.dom.querySelector<HTMLButtonElement>(
      ".language-button"
    );
    if (trigger?.dataset.expanded === "true") {
      trigger.click();
    } else {
      this.stopLanguagePickerTracking();
    }
  }

  private stopLanguagePickerTracking(): void {
    this.languagePickerTrackingCleanup?.();
    this.languagePickerTrackingCleanup = null;
    this.languagePickerListObserver?.disconnect();
    this.languagePickerListObserver = null;
    this.languagePickerActiveIndex = -1;
  }

  update(node: Parameters<CodeMirrorBlock["update"]>[0]): boolean {
    const applied = super.update(node);
    this.syncDiagramMode(node);
    return applied;
  }

  destroy(): void {
    this.dom.removeEventListener(
      "click",
      this.handleLanguagePickerClick,
      true
    );
    this.dom.removeEventListener(
      "keydown",
      this.handleLanguagePickerKeydown,
      true
    );
    this.dom.removeEventListener(
      "input",
      this.handleLanguagePickerInput,
      true
    );
    this.dom.removeEventListener(
      "click",
      this.handleDiagramPreviewClick,
      true
    );
    document.removeEventListener(
      "pointerdown",
      this.handleDocumentPointerDown,
      true
    );
    this.unsubscribeLineWrap();
    this.stopLanguagePickerTracking();
    this.diagramPreview.destroy();
    super.destroy();
  }
}

export class CodeBlockLanguageLoader {
  private readonly map: Record<string, LanguageDescription>;
  private readonly languages: LanguageDescription[];

  constructor(languages: LanguageDescription[]) {
    this.languages = languages.filter(
      (language) =>
        !diagramLanguage(language.name) &&
        !language.alias.some((alias) => diagramLanguage(alias))
    );
    this.map = {};
    for (const language of this.languages) {
      for (const alias of language.alias) {
        this.map[alias] = language;
      }
    }
  }

  getAll(): Array<{ name: string; alias: readonly string[] }> {
    const ordered = this.languages.map((language) => ({
      name: language.name,
      alias: language.alias,
    }));
    for (const language of [MARKMAP_LANGUAGE, MERMAID_LANGUAGE]) {
      const insertionIndex = ordered.findIndex(
        (candidate) =>
          candidate.name.localeCompare(language, undefined, {
            sensitivity: "base",
          }) > 0
      );
      ordered.splice(
        insertionIndex < 0 ? ordered.length : insertionIndex,
        0,
        { name: language, alias: [language] }
      );
    }
    return ordered;
  }

  load(languageName: string): Promise<LanguageSupport | undefined> {
    if (diagramLanguage(languageName)) return Promise.resolve(undefined);
    const language = this.map[languageName.toLowerCase()];
    if (!language) return Promise.resolve(undefined);
    if (language.support) return Promise.resolve(language.support);
    return language.load();
  }
}

const persistentCodeBlockView = $view(
  codeBlockSchema.node,
  (ctx): NodeViewConstructor => {
    const config = ctx.get(codeBlockConfig.key);
    const loader = new CodeBlockLanguageLoader(config.languages);
    return (node, view, getPos) =>
      new PersistentCodeMirrorBlock(
        node,
        view,
        getPos,
        loader as unknown as CodeMirrorBlockArgs[3],
        config
      );
  }
);

export const persistentCodeBlockPlugins: MilkdownPlugin[] = [
  persistentCodeBlockView,
  codeBlockConfig,
];
