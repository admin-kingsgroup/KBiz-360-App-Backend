// WhatsApp-style message formatting — pure parsing + composer helpers, no UI imports.
// Copied VERBATIM between Frontend/src/logic and Web/src/logic (keep in sync by hand, like mentions.ts).
//
// Markup, exactly WhatsApp's:
//   *bold*   _italic_   ~strikethrough~   `mono`   ```mono```
//     — an inline marker OPENS after a word boundary when it hugs a non-space, and CLOSES when it
//       hugs a non-space on the left and a boundary follows, so "5*3*2", "snake_case_name" and
//       "* not bold *" all stay literal, and a marker with no valid partner is left alone.
//   - item / * item → bullet      1. item → numbered      > text → quote
//   ``` … ``` across lines → code block

export interface InlineStyle { bold: boolean; italic: boolean; strike: boolean; mono: boolean }
export interface InlineRun { text: string; style: InlineStyle }
export type Block =
  | { kind: 'line'; runs: InlineRun[] }
  | { kind: 'bullet'; runs: InlineRun[] }
  | { kind: 'number'; n: number; runs: InlineRun[] }
  | { kind: 'quote'; runs: InlineRun[] }
  | { kind: 'code'; text: string };

export const PLAIN: InlineStyle = { bold: false, italic: false, strike: false, mono: false };
export const isPlain = (s: InlineStyle): boolean => !s.bold && !s.italic && !s.strike && !s.mono;

// Cheap gate so the common unformatted message never pays for the parser.
export function hasFormatting(text: string): boolean {
  return /[*_~`]/.test(text) || /(^|\n)[ \t]*(?:[-*] |\d{1,3}\. |> )/.test(text);
}

const MARK: Record<string, 'bold' | 'italic' | 'strike'> = { '*': 'bold', '_': 'italic', '~': 'strike' };
// "Word" characters for the boundary rule — Latin (+ accents), Cyrillic, Arabic and Devanagari LETTERS
// (combining marks left out on purpose: a marker never sits between a letter and its vowel sign).
const WORD = /[A-Za-z0-9\u00C0-\u024F\u0400-\u0481\u048A-\u04FF\u0620-\u064A\u0904-\u0939\u0958-\u0961\u0966-\u096F]/;
const isWs = (c: string | undefined): boolean => c === undefined || /\s/.test(c);
const isWord = (c: string | undefined): boolean => c !== undefined && WORD.test(c);
const canOpen = (s: string, i: number): boolean => !isWord(s[i - 1]) && !isWs(s[i + 1]) && s[i + 1] !== s[i];
const canClose = (s: string, i: number): boolean => !isWs(s[i - 1]) && s[i - 1] !== s[i] && !isWord(s[i + 1]);
function hasClose(s: string, from: number, ch: string): boolean {
  for (let j = from; j < s.length; j++) if (s[j] === ch && canClose(s, j)) return true;
  return false;
}

/** One line → styled runs. Concatenating the runs' text gives the line with its markers removed. */
export function inlineRuns(line: string): InlineRun[] {
  const runs: InlineRun[] = [];
  let style: InlineStyle = { ...PLAIN };
  let buf = '';
  const flush = (): void => { if (buf) { runs.push({ text: buf, style: { ...style } }); buf = ''; } };
  for (let i = 0; i < line.length;) {
    const ch = line[i];
    if (ch === '`') {
      // Monospace takes everything up to the matching fence literally — no nesting inside it.
      const fence = line.startsWith('```', i) ? '```' : '`';
      const close = line.indexOf(fence, i + fence.length);
      if (close > i + fence.length) {
        flush();
        runs.push({ text: line.slice(i + fence.length, close), style: { ...style, mono: true } });
        i = close + fence.length;
        continue;
      }
    } else {
      const key = MARK[ch];
      if (key && (style[key] ? canClose(line, i) : canOpen(line, i) && hasClose(line, i + 1, ch))) {
        flush();
        style = { ...style };
        style[key] = !style[key];
        i++;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return runs;
}

const BULLET_RE = /^[ \t]*[-*] (.*)$/;
const NUMBER_RE = /^[ \t]*(\d{1,3})\. (.*)$/;
const QUOTE_RE = /^[ \t]*> (.*)$/;
function lineBlock(line: string): Block {
  let m = BULLET_RE.exec(line);
  if (m) return { kind: 'bullet', runs: inlineRuns(m[1]) };
  m = NUMBER_RE.exec(line);
  if (m) return { kind: 'number', n: Number(m[1]), runs: inlineRuns(m[2]) };
  m = QUOTE_RE.exec(line);
  if (m) return { kind: 'quote', runs: inlineRuns(m[1]) };
  return { kind: 'line', runs: inlineRuns(line) };
}

/** Whole message → blocks, one per line (a multi-line ``` fence folds into one code block). */
export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const open = line.indexOf('```');
    if (open >= 0 && line.indexOf('```', open + 3) < 0) {
      let closeLine = -1;
      for (let j = i + 1; j < lines.length; j++) if (lines[j].includes('```')) { closeLine = j; break; }
      if (closeLine >= 0) {
        const closeAt = lines[closeLine].indexOf('```');
        const before = line.slice(0, open);
        const after = lines[closeLine].slice(closeAt + 3);
        const body = [line.slice(open + 3), ...lines.slice(i + 1, closeLine), lines[closeLine].slice(0, closeAt)]
          .join('\n').replace(/^\n/, '').replace(/\n$/, '');
        if (before.trim()) out.push(lineBlock(before));
        out.push({ kind: 'code', text: body });
        if (after.trim()) out.push(lineBlock(after));
        i = closeLine;
        continue;
      }
    }
    out.push(lineBlock(line));
  }
  return out;
}

const runsText = (runs: InlineRun[]): string => runs.map((r) => r.text).join('');

/** Plain rendering with the markers removed — chat-list previews, reply quotes, notifications. */
export function stripFormatting(text: string): string {
  if (!hasFormatting(text)) return text;
  return parseBlocks(text).map((b) => {
    switch (b.kind) {
      case 'code': return b.text;
      case 'bullet': return `• ${runsText(b.runs)}`;
      case 'number': return `${b.n}. ${runsText(b.runs)}`;
      default: return runsText(b.runs);
    }
  }).join('\n');
}

// ── Composer helpers: what the formatting toolbar (or a Ctrl/⌘ shortcut) does to the draft ──

export type FormatAction = 'bold' | 'italic' | 'strike' | 'mono' | 'bullet' | 'number' | 'quote';
export interface Range { start: number; end: number }
export interface FormatEdit { text: string; selection: Range }

const INLINE: Record<string, string> = { bold: '*', italic: '_', strike: '~', mono: '`' };

/** Apply `action` to the selection; the returned selection keeps the styled text selected. */
export function applyFormat(text: string, sel: Range, action: FormatAction): FormatEdit {
  const start = Math.max(0, Math.min(sel.start, sel.end, text.length));
  const end = Math.min(text.length, Math.max(sel.start, sel.end, 0));
  const mark = INLINE[action];
  return mark ? wrapInline(text, start, end, mark) : prefixLines(text, start, end, action as 'bullet' | 'number' | 'quote');
}

function wrapInline(text: string, start: number, end: number, mark: string): FormatEdit {
  if (start === end) {
    // Nothing selected: drop the pair and put the caret between the markers.
    const at = start + mark.length;
    return { text: text.slice(0, start) + mark + mark + text.slice(end), selection: { start: at, end: at } };
  }
  // Markers must hug non-space text, so whitespace at the selection's edges stays outside them.
  const raw = text.slice(start, end);
  const lead = raw.length - raw.trimStart().length;
  const trail = raw.length - raw.trimEnd().length;
  const inner = raw.trim();
  if (!inner) return { text, selection: { start, end } };
  const s = start + lead;
  const e = end - trail;
  const fence = mark === '`' && inner.includes('\n') ? '```' : mark;
  // Toggle OFF when the selection is already wrapped — markers just outside it, or inside it.
  if (s >= fence.length && text.startsWith(fence, s - fence.length) && text.startsWith(fence, e)) {
    const from = s - fence.length;
    return { text: text.slice(0, from) + inner + text.slice(e + fence.length), selection: { start: from, end: from + inner.length } };
  }
  if (inner.length > fence.length * 2 && inner.startsWith(fence) && inner.endsWith(fence)) {
    const bare = inner.slice(fence.length, -fence.length);
    return { text: text.slice(0, s) + bare + text.slice(e), selection: { start: s, end: s + bare.length } };
  }
  return { text: text.slice(0, s) + fence + inner + fence + text.slice(e), selection: { start: s, end: s + inner.length + fence.length * 2 } };
}

const ANY_PREFIX = /^[ \t]*(?:[-*] |\d{1,3}\. |> )/;
function prefixLines(text: string, start: number, end: number, kind: 'bullet' | 'number' | 'quote'): FormatEdit {
  // Every line the selection touches (a selection ending right after a newline does not touch the next line).
  const from = text.lastIndexOf('\n', start - 1) + 1;
  const lastEnd = end > start && text[end - 1] === '\n' ? end - 1 : end;
  const nl = text.indexOf('\n', lastEnd);
  const to = nl < 0 ? text.length : nl;
  const lines = text.slice(from, to).split('\n');
  const re = kind === 'bullet' ? /^[ \t]*[-*] / : kind === 'number' ? /^[ \t]*\d{1,3}\. / : /^[ \t]*> /;
  const allOn = lines.every((l) => re.test(l));
  const next = lines.map((l, i) => {
    if (allOn) return l.replace(re, ''); // toggle off
    const bare = l.replace(ANY_PREFIX, ''); // switching kinds swaps the prefix instead of stacking
    return kind === 'bullet' ? `- ${bare}` : kind === 'number' ? `${i + 1}. ${bare}` : `> ${bare}`;
  }).join('\n');
  return { text: text.slice(0, from) + next + text.slice(to), selection: { start: from, end: from + next.length } };
}
