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

class PersistentCodeMirrorBlock extends CodeMirrorBlock {
  constructor(...args: CodeMirrorBlockArgs) {
    super(...args);
    const internals = this as unknown as CodeMirrorBlockInternals;
    internals.scheduleTeardown = () => {};
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
