/**
 * Markdown 最小化保存模块（纯函数，无 milkdown/浏览器依赖）。
 *
 * 原理：milkdown 内容变化时会把整棵文档树序列化成 Markdown，而
 * remark-stringify 会强制按内容重排——块间补空行、清行尾空白、按内容重排
 * 表格列宽。直接写回文件会破坏用户未改动区域的排版。
 * mergeMarkdown 以磁盘原文为基底做行级 LCS 合并：未变化的行原样保留
 * （列表符号/分割线/空行/缩进一字不动），只有发生变化的行用序列化结果替换。
 */
// ============================================================================
// 行等价判断：合并时「内容相同、仅排版不同」的行视为等价，保留原文行
// ============================================================================

/** 表格行：以 | 开头且以 | 结尾（允许行尾空白） */
function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.length >= 2 && t.startsWith("|") && t.endsWith("|");
}

/**
 * milkdown 用 `<br />` 占位序列化「空段落」（preset-commonmark 默认启用
 * remark-preserve-empty-line 插件，markdown 无法表示空段落，靠它保留文档空行）。
 * 副作用：表格空单元格 = 空段落，也会被填成 `<br />`。GFM 空单元格本就是合法
 * 语法（`|  |`），这里把表格行里「trim 后恰为 `<br />` 变体」的单元格清空
 * （替换为等宽空格，不破坏 remark 已按内容算好的列宽对齐），避免把占位写进文件。
 */
function cleanTableBrPlaceholders(line: string): string {
  if (!isTableRow(line)) return line;
  // 保留行首/行尾空白（含 CRLF 的 \r），只处理中间的单元格内容
  const leading = line.match(/^\s*/)?.[0] ?? "";
  const trailing = line.match(/\s*$/)?.[0] ?? "";
  const core = line.slice(leading.length, line.length - trailing.length);
  const cells = core.slice(1, -1).split("|");
  const cleaned = cells.map((cell) =>
    /^<br\s*\/?>$/i.test(cell.trim()) ? " ".repeat(cell.length) : cell
  );
  return leading + "|" + cleaned.join("|") + "|" + trailing;
}

/** 清理 Markdown 文本里表格空单元格的 `<br />` 占位（序列化输出的统一后处理） */
export function cleanMarkdownTableBr(md: string): string {
  return md.split("\n").map(cleanTableBrPlaceholders).join("\n");
}

/**
 * 表格行的规范化键：忽略所有空白，并把分隔行里连续的 `-` 折叠成一个 `-`
 * （保留 `:` 对齐信息）。
 * 用于让「单元格内容相同、仅列宽对齐不同」的原文行与序列化行互相匹配，
 * 从而保留用户手工对齐的表格排版，不被 remark 按内容重新对齐。
 */
function tableKey(line: string): string {
  return line.replace(/\s+/g, "").replace(/-+/g, "-");
}

/** 序列化行自带行尾空白时的哨兵后缀（内容中不可能出现，用于阻断误匹配） */
const TRAILING_WS_GUARD = "\u0000ws";

/**
 * 原文侧的非表格行键：忽略行尾空白。
 * 原文的「行尾空格 / 空行里的空格或 tab」因此能与被序列化清理掉的版本匹配，
 * 匹配成功时保留原文行，用户的原始排版不被抹掉。
 */
function rawPlainKey(line: string): string {
  if (line.trim() === "") return "";
  return line.replace(/\s+$/, "");
}

/**
 * 序列化侧的非表格行键。
 * 序列化行自带的行尾空白是语义内容（如硬换行的两个空格），必须与原文
 * 「无尾空白」的同内容行区分开，否则用户在编辑器里新增的硬换行会被
 * 原文版本吞掉。故加哨兵使其不与原文行匹配。
 */
function serPlainKey(line: string): string {
  if (line.trim() === "") return "";
  const trimmed = line.replace(/\s+$/, "");
  return /\s+$/.test(line) ? trimmed + TRAILING_WS_GUARD : trimmed;
}

/**
 * 把连续的表格行折叠成一个占位符行，使表格整体参与 diff。
 * 否则 LCS 可能让同一表格「部分行取原文、部分行取序列化」，
 * 导致列宽对齐一半宽一半窄、表格视觉错乱。
 */
function collapseTables(lines: string[], idPrefix: string) {
  const collapsed: string[] = [];
  const blocks = new Map<string, string[]>();
  let i = 0;
  let n = 0;
  while (i < lines.length) {
    if (isTableRow(lines[i])) {
      let j = i;
      while (j < lines.length && isTableRow(lines[j])) j++;
      const id = `\u0000${idPrefix}${n++}`;
      blocks.set(id, lines.slice(i, j));
      collapsed.push(id);
      i = j;
    } else {
      collapsed.push(lines[i]);
      i++;
    }
  }
  return { collapsed, blocks };
}

/** 展开占位符行回原始的多行表格块 */
function expandTables(collapsed: string[], blocks: Map<string, string[]>): string[] {
  const out: string[] = [];
  for (const line of collapsed) {
    const block = blocks.get(line);
    if (block) out.push(...block);
    else out.push(line);
  }
  return out;
}

/**
 * 合并后的行。`fromSer` 标记该行来自序列化（true）还是原文（false）——
 * 只有序列化新增的空行才需要判断是否为「强加的块分隔符」，
 * 原文自带的空行（哪怕是空行里的空格）一律保留。
 */
interface MergedLine {
  text: string;
  fromSer: boolean;
}

/** 取展开后的首行（若首行是表格占位符，取其表格块首行） */
function firstExpandedLine(
  lines: string[],
  blocks: Map<string, string[]>
): string | undefined {
  const first = lines[0];
  if (first === undefined) return undefined;
  const block = blocks.get(first);
  return block ? block[0] : first;
}

/** 取展开后的末行（若末行是表格占位符，取其表格块末行） */
function lastExpandedLine(
  lines: string[],
  blocks: Map<string, string[]>
): string | undefined {
  const last = lines[lines.length - 1];
  if (last === undefined) return undefined;
  const block = blocks.get(last);
  return block ? block[block.length - 1] : last;
}

/** 展开 MergedLine 里的表格占位符，来源标记由整块继承给每一行 */
function expandMergedTables(
  lines: MergedLine[],
  blocks: Map<string, string[]>
): MergedLine[] {
  const out: MergedLine[] = [];
  for (const item of lines) {
    const block = blocks.get(item.text);
    if (block) {
      for (const text of block) out.push({ text, fromSer: item.fromSer });
    } else {
      out.push(item);
    }
  }
  return out;
}

/** 预计算行键（"T:" 表格块 / "P:" 普通行），供 LCS 用键比较，避免重复计算 */
function lineKeys(
  lines: string[],
  blocks: Map<string, string[]>,
  isSerialized: boolean
): string[] {
  return lines.map((line) => {
    const block = blocks.get(line);
    if (block) return "T:" + block.map(tableKey).join("\n");
    return "P:" + (isSerialized ? serPlainKey(line) : rawPlainKey(line));
  });
}

/**
 * 清理序列化强加的块分隔空行。
 * remark-stringify 在每个块（标题、段落等）后都会补一个空行，而 milkdown
 * 的 AST 不保存空行——原文紧凑的 `# h\n- a` 会被序列化成 `# h\n\n- a`，
 * 纯按行 diff 会把多出的空行当成「插入」写进结果，污染未改动区域。
 * 只处理「序列化新增」的空行（fromSer），原文自带的空行（含空行里的空格、
 * tab）一律保留。启发式（偏向保留，宁可多留空行也不误删用户的真实空行）：
 * - 连续空行（≥2）视为真实排版，整段保留；
 * - 孤立空行：两侧至少一侧是修改行（不在原文中）→ 可能是用户排版，保留；
 *   两侧都是原文既有行、但它们在原文中不相邻（中间隔了其他行）→ 说明是
 *   用户插入的空行把原本不相邻的内容隔开，保留；只有「两侧原文相邻的块
 *   之间被强加」的空行才是 milkdown 序列化产物，丢弃；
 * - 首尾没有参照时保守保留。
 * 注意：不能按「是否在中间段的首尾」判断——中间段的首尾其实是文档的中部，
 * 序列化完全可能在那里强加空行，判据只能是行的来源。
 * 仅作用于合并的中间段（公共前缀/后缀是原文原样，不经过此处理）。
 */
function pruneImposedBlankLines(
  mergedMid: MergedLine[],
  rawLines: string[],
  // 中间段的首尾其实是文档的中部，判断其首尾空行时要用前缀/后缀的相邻行
  // 作为参照，否则会误判成「文档首尾」而一律保留。
  contextBefore?: string,
  contextAfter?: string
): MergedLine[] {
  const rawSet = new Set(rawLines);
  // 行 → 首次出现索引，用于判断「空行两侧的行在原文中是否相邻」
  const lineIndex = new Map<string, number>();
  rawLines.forEach((line, i) => {
    if (!lineIndex.has(line)) lineIndex.set(line, i);
  });
  const result: MergedLine[] = [];
  let idx = 0;
  while (idx < mergedMid.length) {
    const item = mergedMid[idx];
    const line = item.text;
    // 非空行、以及原文自带（含原文的空行）一律原样保留
    if (line.trim() !== "" || !item.fromSer) {
      result.push(item);
      idx++;
      continue;
    }
    // 以下是「序列化新增的空行」：统计连续的序列化空行块
    let k = idx;
    while (
      k < mergedMid.length &&
      mergedMid[k].text.trim() === "" &&
      mergedMid[k].fromSer
    )
      k++;
    const blankCount = k - idx;
    if (blankCount >= 2) {
      // 连续空行视为真实排版（如用户插入的空段落），整段保留
      for (let t = idx; t < k; t++) result.push(mergedMid[t]);
    } else {
      // 用相邻内容行判断：prev 可能落在公共前缀里，next 可能落在后缀里
      const prev = result[result.length - 1]?.text ?? contextBefore;
      const next = mergedMid[k]?.text ?? contextAfter;
      const prevExisting = prev != null && rawSet.has(prev);
      const nextExisting = next != null && rawSet.has(next);
      if (prev == null || next == null) {
        // 合并结果的首尾：没有参照，保守保留
        result.push(item);
      } else if (!prevExisting || !nextExisting) {
        // 至少一侧是修改行 → 可能是用户排版，保留
        result.push(item);
      } else {
        // 两侧都是原文既有行：仅当它们在原文中紧邻时才视为序列化强加
        const ip = lineIndex.get(prev);
        const in2 = lineIndex.get(next);
        const adjacent = ip != null && in2 != null && Math.abs(ip - in2) === 1;
        if (!adjacent) result.push(item);
      }
    }
    idx = k;
  }
  return result;
}

/**
 * 行级 LCS diff：以 a（原文中间段）为基底，应用 b（序列化中间段）的变更，
 * 返回合并后的行序列。未变化的行取 a（与 b 相同）；删除的行不输出；
 * 新增/修改的行输出 b 的内容。
 * 规模保护：n*m 超过阈值时退化为整体采用 b（与全量序列化一致，不更差）。
 */
function lcsMergeLines(
  a: string[],
  b: string[],
  aKeys: string[],
  bKeys: string[]
): MergedLine[] {
  const n = a.length;
  const m = b.length;
  if (n * m > 2_000_000) return b.map((text) => ({ text, fromSer: true }));
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = 1; i <= n; i++) {
    const ak = aKeys[i - 1];
    const row = i * w;
    const prev = row - w;
    for (let j = 1; j <= m; j++) {
      if (ak === bKeys[j - 1]) dp[row + j] = dp[prev + j - 1] + 1;
      else dp[row + j] = Math.max(dp[prev + j], dp[row + j - 1]);
    }
  }
  const out: MergedLine[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (aKeys[i - 1] === bKeys[j - 1]) {
      // 键相等：取原文行，保留其原始排版（行尾空格、表格对齐等）
      out.push({ text: a[i - 1], fromSer: false });
      i--;
      j--;
    } else if (dp[(i - 1) * w + j] >= dp[i * w + j - 1]) {
      i--; // 原文该行在序列化中不存在 → 删除（不输出）
    } else {
      out.push({ text: b[j - 1], fromSer: true }); // 序列化新增/修改的行
      j--;
    }
  }
  while (j > 0) {
    out.push({ text: b[j - 1], fromSer: true });
    j--;
  }
  return out.reverse();
}

/**
 * 表格块内行级合并：以原文行为基底，把序列化中变化的行替换进来。
 * 未变化的行（tableKey 相同）取原文，保留用户手工列宽对齐；
 * 变化的行取序列化版本（新内容 + 其对齐）。
 */
function mergeTableBlock(rawBlock: string[], serBlock: string[]): string[] {
  const rKeys = rawBlock.map(tableKey);
  const sKeys = serBlock.map(tableKey);
  const n = rKeys.length;
  const m = sKeys.length;
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = 1; i <= n; i++) {
    const rk = rKeys[i - 1];
    const row = i * w;
    const prev = row - w;
    for (let j = 1; j <= m; j++) {
      if (rk === sKeys[j - 1]) dp[row + j] = dp[prev + j - 1] + 1;
      else dp[row + j] = Math.max(dp[prev + j], dp[row + j - 1]);
    }
  }
  const out: string[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (rKeys[i - 1] === sKeys[j - 1]) {
      out.push(rawBlock[i - 1]);
      i--;
      j--;
    } else if (dp[(i - 1) * w + j] >= dp[i * w + j - 1]) {
      i--;
    } else {
      out.push(serBlock[j - 1]);
      j--;
    }
  }
  while (j > 0) {
    out.push(serBlock[j - 1]);
    j--;
  }
  return out.reverse();
}

/**
 * 把序列化结果合并回磁盘原文，实现「最小化修改保存」。
 * 以原文为基底：未变化的行原样保留（符号/空行/缩进/排版一字不动），
 * 只有序列化中发生变化的行替换原文对应行。行尾符跟随原文（CRLF 保持 CRLF）。
 */
export function mergeMarkdown(raw: string, serialized: string): string {
  if (!raw) return serialized;
  if (!serialized) return raw;
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const rawLines = raw.split(/\r?\n/);
  // 序列化结果理论上只输出 \n，防御性剥掉残留 \r（CRLF 输入直接传给本函数时）。
  // 序列化侧的表格空单元格占位 <br /> 先清掉：原文里若已是空单元格则键匹配
  // （保留原文排版）；原文若残留占位则键不同，表格整体替换为清理后的版本。
  const serLines = serialized
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .map(cleanTableBrPlaceholders);
  // 表格整体参与 diff：连续表格行折叠成一行占位符（见 collapseTables）。
  const rawTables = collapseTables(rawLines, "r");
  const serTables = collapseTables(serLines, "s");
  const rCollapsed = rawTables.collapsed;
  const sCollapsed = serTables.collapsed;
  // 表格块配对合并：表头（首行）规范化键相同的 raw/ser 块，在块内做行级
  // 最小修改合并 —— 未变化的行保留原文（列宽对齐不动），只有变化的行取
  // 序列化结果（编辑表格单元格时其余行不再被整体重排）。合并后两侧块
  // 内容一致，文档级 LCS 自然匹配。
  {
    const rIds = [...rawTables.blocks.keys()];
    const sIds = [...serTables.blocks.keys()];
    const usedS = new Set<string>();
    for (const rid of rIds) {
      const rb = rawTables.blocks.get(rid)!;
      const rHeader = tableKey(rb[0]);
      const sid = sIds.find(
        (id) =>
          !usedS.has(id) &&
          tableKey(serTables.blocks.get(id)![0]) === rHeader
      );
      if (sid !== undefined) {
        usedS.add(sid);
        const merged = mergeTableBlock(rb, serTables.blocks.get(sid)!);
        rawTables.blocks.set(rid, merged);
        serTables.blocks.set(sid, merged);
      }
    }
  }
  const allBlocks = new Map([...rawTables.blocks, ...serTables.blocks]);
  const rKeys = lineKeys(rCollapsed, rawTables.blocks, false);
  const sKeys = lineKeys(sCollapsed, serTables.blocks, true);
  // 公共前缀/后缀裁剪：绝大多数行两侧一致，先排除掉可大幅缩小 diff 规模。
  // 用行键比较（而非逐字符相等），让「仅排版不同」的行也能落进前缀/后缀。
  const minLen = Math.min(rCollapsed.length, sCollapsed.length);
  let prefix = 0;
  while (prefix < minLen && rKeys[prefix] === sKeys[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    rKeys[rCollapsed.length - 1 - suffix] === sKeys[sCollapsed.length - 1 - suffix]
  )
    suffix++;
  const rMid = rCollapsed.slice(prefix, rCollapsed.length - suffix);
  const sMid = sCollapsed.slice(prefix, sCollapsed.length - suffix);
  // keys 必须与切片后的行数组一一对应
  const rMidKeys = rKeys.slice(prefix, rKeys.length - suffix);
  const sMidKeys = sKeys.slice(prefix, sKeys.length - suffix);
  // 纯插入（rMid 空）同样要过 prune：sMid 里的孤立空行可能只是 milkdown
  // 强加的块分隔符（如紧凑标题后补的空行），需要剔除。
  const midLines: MergedLine[] =
    rMid.length === 0
      ? sMid.map((text) => ({ text, fromSer: true })) // 纯插入
      : lcsMergeLines(rMid, sMid, rMidKeys, sMidKeys);
  const mergedMid =
    sMid.length === 0
      ? [] // 纯删除
      : pruneImposedBlankLines(
          expandMergedTables(midLines, allBlocks),
          rawLines,
          lastExpandedLine(rCollapsed.slice(0, prefix), allBlocks),
          firstExpandedLine(rCollapsed.slice(rCollapsed.length - suffix), allBlocks)
        ).map((item) => item.text);
  const merged = [
    ...expandTables(rCollapsed.slice(0, prefix), allBlocks),
    ...mergedMid,
    ...expandTables(rCollapsed.slice(rCollapsed.length - suffix), allBlocks),
  ];
  let out = merged.join(eol);
  // 保持原文的结尾换行形态（原文以换行结尾则补回，反之去掉）
  const rawEndsEol = /(?:\r?\n)$/.test(raw);
  if (rawEndsEol && !out.endsWith("\n")) out += eol;
  else if (!rawEndsEol && out.endsWith("\n")) out = out.replace(/\r?\n$/, "");
  return out;
}
