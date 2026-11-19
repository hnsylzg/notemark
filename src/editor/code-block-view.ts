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
import {
  CodeMirrorBlock,
  codeBlockConfig,
} from "@milkdown/components/code-block";
import { codeBlockSchema } from "@milkdown/kit/preset/commonmark";
import type { NodeViewConstructor } from "@milkdown/prose/view";
import { $view } from "@milkdown/utils";

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
  private languagePickerTrackingCleanup: (() => void) | null = null;

  constructor(...args: CodeMirrorBlockArgs) {
    super(...args);
    const internals = this as unknown as CodeMirrorBlockInternals;
    internals.scheduleTeardown = () => {};
    // Capture runs before Milkdown's button handler, so the deferred callback
    // lands after Vue renders the menu but before its search field timer runs.
    this.dom.addEventListener(
      "click",
      this.handleLanguagePickerClick,
      true
    );
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
      } else {
        this.stopLanguagePickerTracking();
      }
    }, 0);
  };

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

  private stopLanguagePickerTracking(): void {
    this.languagePickerTrackingCleanup?.();
    this.languagePickerTrackingCleanup = null;
  }

  destroy(): void {
    this.dom.removeEventListener(
      "click",
      this.handleLanguagePickerClick,
      true
    );
    this.stopLanguagePickerTracking();
    super.destroy();
  }
}

class CodeBlockLanguageLoader {
  private readonly map: Record<string, LanguageDescription>;
  private readonly languages: LanguageDescription[];

  constructor(languages: LanguageDescription[]) {
    this.languages = languages;
    this.map = {};
    for (const language of languages) {
      for (const alias of language.alias) {
        this.map[alias] = language;
      }
    }
  }

  getAll(): Array<{ name: string; alias: readonly string[] }> {
    return this.languages.map((language) => ({
      name: language.name,
      alias: language.alias,
    }));
  }

  load(languageName: string): Promise<LanguageSupport | undefined> {
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
