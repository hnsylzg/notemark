/**
 * Markdown 最小化保存模块（纯函数，无 milkdown/浏览器依赖）。
 *
 * 原理：milkdown 内容变化时会把整棵文档树序列化成 Markdown，而
 * remark-stringify 会强制按内容重排——块间补空行、清行尾空白、按内容重排
 * 表格列宽。直接写回文件会破坏用户未改动区域的排版。
 * mergeMarkdown 以磁盘原文为基底做行级 LCS 合并：未变化的行原样保留
 * （列表符号/分割线/空行/缩进一字不动），只有发生变化的行用序列化结果替换；
 * 表格块内进一步做单元格级合并，编辑单个单元格时只更新该格。
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

/**
 * 清理脚注定义行里「空段落」产生的 `<br />` 占位：`[^1]: <br />` → `[^1]:`
 *
 * 刚插入还没填内容的脚注 = 定义节点 + 一个空段落，而 paragraph 的 toMarkdown
 * 遇到空段落会输出 `<br />`（见 preset-commonmark 的 shouldPreserveEmptyLine），
 * 源码里于是出现 `[^1]: <br />`。这个占位没有任何语义：重新打开时它不会被
 * 还原成"空脚注"，只会变成脚注正文里的一个换行，纯属噪声。
 *
 * 只摘「定义行里只剩这一个占位」的情况。用户在脚注正文中写的 `<br />`
 * （如 `[^1]: 上<br />下`）行内还有其他内容，不会被正则命中。
 * 同理不处理缩进续行里单独的 `<br />`：那可能是用户真实的空行分段。
 */
function cleanFootnoteBrPlaceholder(line: string): string {
  // label 允许非数字（[^note]）；<br /> 的写法有 <br/>、<br>、<br > 等变体
  return line.replace(/^(\s*\[\^[^\]\s]+\]:)[ \t]*<br\s*\/?>[ \t]*$/i, "$1");
}

/**
 * 序列化输出的统一后处理：清掉 `<br />` 占位。
 * 两类来源都在这里处理，保证保存 / 脏检查 / 导出三条路走同一口径：
 *   1. 表格空单元格（GFM 空单元格本就是合法语法）；
 *   2. 空脚注定义（`[^1]:` 后面多出一个 `<br />`）。
 */
export function cleanMarkdownBr(md: string): string {
  return md
    .split("\n")
    .map((line) => cleanFootnoteBrPlaceholder(cleanTableBrPlaceholders(line)))
    .join("\n");
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

/** 解析表格行：拆出行首/行尾空白与单元格数组；非表格行返回 null */
function parseTableRow(line: string): {
  leading: string;
  cells: string[];
  trailing: string;
} | null {
  if (!isTableRow(line)) return null;
  const leading = line.match(/^\s*/)?.[0] ?? "";
  const trailing = line.match(/\s*$/)?.[0] ?? "";
  const core = line.slice(leading.length, line.length - trailing.length);
  return { leading, cells: core.slice(1, -1).split("|"), trailing };
}

/** 单元格内容键：忽略所有空白，用于判断单元格内容是否变化 */
function cellKey(cell: string): string {
  return cell.replace(/\s+/g, "");
}

/** 分隔行单元格（`---` / `:---:` 等，可含对齐冒号） */
function isSeparatorCell(cell: string): boolean {
  return /^:?-+:?$/.test(cell.trim());
}

/** 单元格是否等价：分隔行折叠连续 `-`（`-----` 与 `-` 语义相同）；普通内容忽略空白比较 */
function sameCell(rawCell: string, serCell: string): boolean {
  if (isSeparatorCell(rawCell) && isSeparatorCell(serCell)) {
    return (
      cellKey(rawCell).replace(/-+/g, "-") === cellKey(serCell).replace(/-+/g, "-")
    );
  }
  return cellKey(rawCell) === cellKey(serCell);
}

/**
 * 单元格级行合并：raw/ser 同一行的两个版本。
 * 未变化的单元格保留原文（宽度、对齐一字不动）；变化的单元格替换为
 * 序列化内容，且尽量维持原文单元格的宽度结构——内容变长时只扩展该格
 * （GFM 允许每行列宽不同，不影响渲染）。列结构（单元格数）不同时返回
 * null，表示该行无法单元格级合并，交由调用方整行处理。
 */
function mergeTableRow(rawLine: string, serLine: string): string | null {
  const r = parseTableRow(rawLine);
  const s = parseTableRow(serLine);
  if (!r || !s || r.cells.length !== s.cells.length) return null;
  let changed = false;
  let sameCount = 0;
  const cells = r.cells.map((rc, i) => {
    const sc = s.cells[i];
    if (sameCell(rc, sc)) {
      sameCount++;
      return rc; // 内容未变，保留原文
    }
    changed = true;
    const content = sc.trim();
    const leftPad = rc.match(/^\s*/)?.[0] ?? "";
    const rightPad = rc.match(/\s*$/)?.[0] ?? "";
    if (leftPad.length + content.length + rightPad.length <= rc.length) {
      // 原文宽度足够：保持左右缩进，剩余空间留在右边
      return (
        leftPad + content + " ".repeat(Math.max(1, rc.length - leftPad.length - content.length))
      );
    }
    // 新内容更长：扩展该单元格（左右各留一个空格）
    return " " + content + " ";
  });
  if (!changed) return rawLine;
  if (sameCount === 0) return null; // 与 raw 行无任何相同单元格，视为不同行（整行取 ser）
  return r.leading + "|" + cells.join("|") + "|" + r.trailing;
}

/**
 * 表格块内单元格级合并：以原文块为基底做行级 LCS 配对（定位未变化的行
 * 与增删行），配对的行使 mergeTableRow 逐单元格合并——编辑单个单元格时
 * 只更新该格，其余单元格与整行对齐原样保留；列结构变化（增删列）的行
 * 因单元格数不同而整行取序列化结果。
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
  // 回溯收集匹配行对（按文档顺序）与两侧未匹配行
  const matched: Array<[number, number]> = [];
  const unmatchedRaw: number[] = [];
  const unmatchedSer: number[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (rKeys[i - 1] === sKeys[j - 1]) {
      matched.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[(i - 1) * w + j] >= dp[i * w + j - 1]) {
      unmatchedRaw.push(i - 1);
      i--;
    } else {
      unmatchedSer.push(j - 1);
      j--;
    }
  }
  while (i > 0) unmatchedRaw.push(--i);
  while (j > 0) unmatchedSer.push(--j);
  unmatchedRaw.reverse();
  unmatchedSer.reverse();
  matched.reverse();

  const out: string[] = [];
  let rPrev = -1;
  let sPrev = -1;
  // 合并两个未匹配段：按顺序两两尝试单元格合并（通常是「编辑行」），
  // 失败的 raw 行删除、ser 行插入（增删列/整行重写）
  const mergeSegment = (rStart: number, rEnd: number, sStart: number, sEnd: number) => {
    const rSeg = rEnd >= rStart ? rawBlock.slice(rStart, rEnd + 1) : [];
    const sSeg = sEnd >= sStart ? serBlock.slice(sStart, sEnd + 1) : [];
    const cnt = Math.min(rSeg.length, sSeg.length);
    for (let k = 0; k < cnt; k++) {
      out.push(mergeTableRow(rSeg[k], sSeg[k]) ?? sSeg[k]);
    }
    if (sSeg.length > cnt) out.push(...sSeg.slice(cnt)); // 新增行插入
    // rSeg 多出的行（删除）不输出
  };
  for (const [ri, si] of matched) {
    mergeSegment(rPrev + 1, ri - 1, sPrev + 1, si - 1);
    out.push(mergeTableRow(rawBlock[ri], serBlock[si]) ?? serBlock[si]);
    rPrev = ri;
    sPrev = si;
  }
  mergeSegment(rPrev + 1, n - 1, sPrev + 1, m - 1);
  return out;
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
  // 表格块配对合并：按「行级 key 交集最大」为每个 raw 块找对应的 ser 块，
  // 在块内做单元格级最小修改合并。不用表头 key 配对——表头单元格被编辑后
  // 表头行 key 会变，表头配对会失败导致整块被当成「删除+插入」复制一份。
  // 配对成功后两侧块合并为同一内容，文档级 LCS 自然匹配。
  {
    const rIds = [...rawTables.blocks.keys()];
    const sIds = [...serTables.blocks.keys()];
    const usedS = new Set<string>();
    for (const rid of rIds) {
      const rb = rawTables.blocks.get(rid)!;
      const rSet = new Set(rb.map(tableKey));
      let bestSid: string | undefined;
      let bestScore = -1;
      for (const sid of sIds) {
        if (usedS.has(sid)) continue;
        const sb = serTables.blocks.get(sid)!;
        let score = 0;
        for (const line of sb) if (rSet.has(tableKey(line))) score++;
        if (score > bestScore) {
          bestScore = score;
          bestSid = sid;
        }
      }
      if (bestSid !== undefined) {
        usedS.add(bestSid);
        const merged = mergeTableBlock(rb, serTables.blocks.get(bestSid)!);
        rawTables.blocks.set(rid, merged);
        serTables.blocks.set(bestSid, merged);
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
