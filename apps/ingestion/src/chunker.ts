// Recursive character splitting: paragraphs, then sentences, then words, then
// a hard cut. Each level only runs on a piece the level above could not get
// under maxChars, so the author's own boundaries are preferred and the hard
// cut -- the only one that can slice a token in half -- is the last resort.
//
// Overlap is deliberately zero: neighbouring ordinals are fetched at query
// time (COMPASS-20) instead, so chunks stay a partition of the document and
// near-duplicates never compete for a slot in one top-k result.

// ~250 tokens. Low end of the usual range on purpose -- neighbour expansion
// supplies surrounding context, so a chunk does not have to carry it alone.
export const DEFAULT_MAX_CHARS = 1000;
export const DEFAULT_MIN_CHARS = 200;

export interface Chunk {
  ordinal: number;
  content: string;
}

export interface ChunkOptions {
  /** Hard upper bound on chunk length. Never exceeded. */
  maxChars?: number;
  /** Preferred lower bound. Yields to maxChars when the two conflict. */
  minChars?: number;
}

// A leaf piece plus the separator that stood between it and the piece before
// it. Carrying the separator is what lets the packing and merging passes do
// their length arithmetic without guessing, and what keeps a hard cut from
// being silently glued back together across a space that was never there.
interface Fragment {
  text: string;
  sep: string;
}

const PARAGRAPH_BREAK = /\n\s*\n/;
// Split after terminal punctuation, keeping the punctuation on the sentence.
// Knowingly naive: it also splits "Dr. Smith", "e.g. this" and "3.14 metres".
// Left as is because the consequence is benign -- a slightly shorter chunk, not
// a wrong one -- and the alternatives (an abbreviation list, or Intl.Segmenter
// with its own locale caveats) cost more than the defect. Revisit if retrieval
// quality ever traces back to sentence boundaries.
const SENTENCE_BREAK = /(?<=[.!?])\s+/;
const WHITESPACE = /\s+/;

export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  // Clamped rather than fixed: a caller lowering only maxChars would otherwise
  // inherit a default minimum above their own maximum, and a perfectly
  // reasonable call would throw. An explicit contradiction still errors below.
  const minChars = options.minChars ?? Math.min(DEFAULT_MIN_CHARS, maxChars);

  // Both failure modes here are silent and neither is theoretical once these
  // become configurable: maxChars of 0 makes the hard cut's `start += maxChars`
  // never advance, and NaN -- what `Number(process.env.X)` yields for an unset
  // or misspelt variable -- makes every comparison false, so a document
  // ingests as zero chunks with nothing raised.
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new RangeError(`maxChars must be a positive integer, got ${String(maxChars)}`);
  }
  if (!Number.isInteger(minChars) || minChars < 0) {
    throw new RangeError(`minChars must be a non-negative integer, got ${String(minChars)}`);
  }
  if (options.minChars !== undefined && options.minChars > maxChars) {
    throw new RangeError(
      `minChars (${options.minChars}) cannot exceed maxChars (${maxChars}) — ` +
        `no chunk could satisfy both`,
    );
  }

  const paragraphs = text
    .replace(/\r\n/g, "\n")
    .split(PARAGRAPH_BREAK)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  // No extractable text is a failed ingestion, and that is the caller's call
  // to make -- do not manufacture a row the embedder will reject.
  if (paragraphs.length === 0) return [];

  const chunks: Fragment[] = [];
  for (const [index, paragraph] of paragraphs.entries()) {
    const packed = pack(split(paragraph, maxChars), maxChars);
    // Paragraphs are packed independently: a paragraph that fits is left
    // whole rather than glued to its neighbour, because the break is the
    // author's own semantic boundary. Undersized ones are rescued below.
    for (const [position, piece] of packed.entries()) {
      chunks.push({
        text: piece.text,
        sep: position === 0 ? (index === 0 ? "" : "\n\n") : piece.sep,
      });
    }
  }

  return merge(chunks, maxChars, minChars).map((chunk, ordinal) => ({
    ordinal,
    content: chunk.text,
  }));
}

// One level of the recursion: return leaf fragments that are each within
// maxChars, descending only into the units that are still too long.
function split(text: string, maxChars: number): Fragment[] {
  if (text.length <= maxChars) return [{ text, sep: "" }];

  const sentences = text.split(SENTENCE_BREAK);
  if (sentences.length > 1) return descend(sentences, maxChars);

  const words = text.split(WHITESPACE);
  if (words.length > 1) return descend(words, maxChars);

  // A minified file, a base64 blob, a script this splitter has no rules for.
  // Nothing left to respect, so cut on the bound itself -- this is the case
  // that guarantees termination.
  return hardCut(text, maxChars);
}

function descend(units: string[], maxChars: number): Fragment[] {
  const fragments: Fragment[] = [];
  for (const [index, unit] of units.entries()) {
    for (const [position, fragment] of split(unit, maxChars).entries()) {
      fragments.push({
        text: fragment.text,
        // Whitespace between units was collapsed by the split, so a single
        // space rejoins them; within a unit the fragment keeps its own
        // separator, which is empty for hard-cut pieces.
        sep: position === 0 ? (index === 0 ? "" : " ") : fragment.sep,
      });
    }
  }
  return fragments;
}

function hardCut(text: string, maxChars: number): Fragment[] {
  const fragments: Fragment[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    // slice() counts UTF-16 code units, so a cut can land between the halves of
    // a surrogate pair and store two lone surrogates -- corrupt text that then
    // embeds as noise. This is not exotic: hardCut is the ONLY path for scripts
    // written without word spaces, which is exactly where astral characters
    // turn up. Back off one unit so the pair starts the next fragment instead.
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) {
      // Unless backing off would empty the fragment (maxChars of 1 against
      // astral text). A surrogate pair is indivisible, so the only options are
      // corrupting it or exceeding the bound by one unit; take the bound.
      end = end - 1 > start ? end - 1 : end + 1;
    }
    fragments.push({ text: text.slice(start, end), sep: "" });
    start = end;
  }
  return fragments;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

// Greedily refill: fragments were produced by descending past a boundary, so
// several of them usually fit back into one chunk. Without this, a paragraph
// one character over maxChars would come back as one big and one tiny chunk.
function pack(fragments: Fragment[], maxChars: number): Fragment[] {
  const chunks: Fragment[] = [];
  for (const fragment of fragments) {
    const current = chunks[chunks.length - 1];
    if (current && current.text.length + fragment.sep.length + fragment.text.length <= maxChars) {
      current.text += fragment.sep + fragment.text;
    } else {
      chunks.push({ ...fragment });
    }
  }
  return chunks;
}

// Absorb an orphan -- a trailing heading, a stray line -- into its neighbour.
// On its own it is a near-useless row that still costs an embedding call and
// still competes for a slot in every top-k result.
function merge(chunks: Fragment[], maxChars: number, minChars: number): Fragment[] {
  const merged: Fragment[] = [];
  for (const chunk of chunks) {
    const previous = merged[merged.length - 1];
    if (previous) {
      const joined = previous.text.length + chunk.sep.length + chunk.text.length;
      // Undersized on EITHER side. Looking only backwards leaves a leading
      // orphan stranded forever, because it has nothing before it to fold
      // into -- and a document opening with a Markdown heading is the common
      // case, not an edge one. So an undersized chunk also pulls the next one
      // forward.
      const undersized = chunk.text.length < minChars || previous.text.length < minChars;
      // maxChars is a hard bound and minChars only a preference, so when the
      // two rules conflict the small chunk simply stays small.
      if (undersized && joined <= maxChars) {
        previous.text += chunk.sep + chunk.text;
        continue;
      }
    }
    merged.push({ ...chunk });
  }
  return merged;
}
