const DEFAULT_MIN_CHARS = 500;
const DEFAULT_VISIBLE_TAIL_RATIO = 0.1;

const CONCLUSION_CUES = [
  { pattern: /^(?:最终结论|结论|最终结果|处理结果|执行结果)(?:如下)?(?:\*\*)?\s*[:：\-—]?\s*/i, score: 100 },
  { pattern: /^(?:总结|总结一下)(?:如下)?(?:\*\*)?\s*[:：\-—]?\s*/i, score: 90 },
  { pattern: /^(?:建议|推荐方案|需要处理|你需要做的)(?:如下)?(?:\*\*)?\s*[:：\-—]?\s*/i, score: 80 },
  { pattern: /^(?:下一步|后续操作)(?:如下)?(?:\*\*)?\s*[:：\-—]?\s*/i, score: 70 },
  { pattern: /^(?:conclusion|final result|summary|recommendation|next steps?)(?:\*\*)?\s*[:：\-—]?\s*/i, score: 75 },
];

function splitOutputForCollapsedDisplay(content, options = {}) {
  const text = String(content || "").trim();
  const chars = Array.from(text);
  const minChars = Number.isFinite(options.minChars) ? options.minChars : DEFAULT_MIN_CHARS;
  const visibleTailRatio = Number.isFinite(options.visibleTailRatio)
    ? Math.max(0.05, Math.min(0.5, options.visibleTailRatio))
    : DEFAULT_VISIBLE_TAIL_RATIO;
  if (chars.length < minChars) {
    return { collapsedContent: "", visibleContent: text, mode: "none" };
  }

  const semanticBoundary = findSemanticConclusionBoundary(text);
  const fallbackBoundary = semanticBoundary >= 0
    ? -1
    : findFallbackBoundary(chars, Math.floor(chars.length * (1 - visibleTailRatio)));
  const collapsedContent = semanticBoundary >= 0
    ? text.slice(0, semanticBoundary).trimEnd()
    : chars.slice(0, fallbackBoundary).join("").trimEnd();
  const visibleContent = semanticBoundary >= 0
    ? text.slice(semanticBoundary).trimStart()
    : chars.slice(fallbackBoundary).join("").trimStart();
  if (!collapsedContent || !visibleContent) {
    return { collapsedContent: "", visibleContent: text, mode: "none" };
  }
  return {
    collapsedContent,
    visibleContent,
    mode: semanticBoundary >= 0 ? "semantic" : "ratio",
  };
}

function findSemanticConclusionBoundary(text) {
  const paragraphStarts = [0];
  const separator = /\n\s*\n/g;
  let match;
  while ((match = separator.exec(text)) !== null) {
    paragraphStarts.push(match.index + match[0].length);
  }

  const minimumStart = Math.floor(text.length * 0.35);
  const candidates = [];
  for (const start of paragraphStarts) {
    if (start < minimumStart) continue;
    const end = text.indexOf("\n\n", start);
    const paragraph = text.slice(start, end >= 0 ? end : undefined)
      .trim()
      .replace(/^(?:(?:#{1,6}|>|[-+*])\s*)+/, "")
      .replace(/^\*\*/, "");
    for (const cue of CONCLUSION_CUES) {
      if (cue.pattern.test(paragraph)) {
        candidates.push({ start, score: cue.score });
        break;
      }
    }
  }
  if (!candidates.length) return -1;
  candidates.sort((left, right) => right.score - left.score || right.start - left.start);
  return candidates[0].start;
}

function findFallbackBoundary(chars, target) {
  const min = Math.max(1, target - Math.floor(chars.length * 0.08));
  const max = Math.min(chars.length - 1, target + Math.floor(chars.length * 0.08));
  const text = chars.join("");
  for (const token of ["\n\n", "\n", "。", "！", "？", ". "]) {
    const after = text.indexOf(token, min);
    const before = text.lastIndexOf(token, target);
    const candidates = [before, after]
      .filter((index) => index >= min && index <= max)
      .map((index) => index + token.length);
    if (candidates.length) {
      return candidates.sort((left, right) => Math.abs(left - target) - Math.abs(right - target))[0];
    }
  }
  return target;
}

module.exports = {
  splitOutputForCollapsedDisplay,
};
