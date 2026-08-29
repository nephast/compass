import { describe, expect, it } from "vitest";
import { chunkText, DEFAULT_MAX_CHARS, DEFAULT_MIN_CHARS, type Chunk } from "../../src/chunker.js";

// No Docker, no LocalStack -- this tier runs in CI and on every save.
//
// The strategy under test is a recursive split: try paragraph boundaries; if a
// piece still exceeds maxChars, split it on sentences; if it STILL exceeds
// maxChars, hard-cut it. maxChars is the recursion's stopping rule.
//
// Overlap is deliberately zero. Context that spans a boundary is recovered at
// query time by fetching the neighbouring ordinals (COMPASS-20), which avoids
// near-duplicate chunks competing against each other inside one top-k result.

const words = (count: number, word = "word"): string =>
  new Array<string>(count).fill(word).join(" ");

const contents = (chunks: Chunk[]): string[] => chunks.map((c) => c.content);

describe("chunkText — invariants that must hold for every input", () => {
  const inputs: Record<string, string> = {
    "a single short line": "One short line of text.",
    "several paragraphs": `${words(30)}\n\n${words(40)}\n\n${words(50)}`,
    "one huge paragraph": words(400),
    "a wall of text with no boundaries": "x".repeat(3000),
    "mixed sizes": `Short.\n\n${words(300)}\n\nAlso short.\n\n${words(20)}`,
    "windows line endings": `${words(30)}\r\n\r\n${words(30)}`,
    "trailing and leading whitespace": `\n\n   ${words(30)}   \n\n`,
  };

  for (const [name, text] of Object.entries(inputs)) {
    describe(name, () => {
      const chunks = () => chunkText(text);

      it("numbers ordinals contiguously from 0", () => {
        // chunks is UNIQUE on (document_id, ordinal) and the upsert relies on
        // it: a gap or a repeat makes a re-ingest write to the wrong row.
        expect(chunks().map((c) => c.ordinal)).toEqual(chunks().map((_, i) => i));
      });

      it("never emits an empty or whitespace-only chunk", () => {
        // The embedding providers reject these outright (Titan: minLength 1),
        // so an empty chunk fails the whole document at the vendor.
        for (const chunk of chunks()) {
          expect(chunk.content.trim()).not.toBe("");
        }
      });

      it("never exceeds maxChars", () => {
        // Hard bound, not a target: it is the recursion's stopping rule.
        for (const chunk of chunks()) {
          expect(chunk.content.length).toBeLessThanOrEqual(DEFAULT_MAX_CHARS);
        }
      });

      it("loses no text and duplicates none", () => {
        // Zero overlap means the chunks partition the input: concatenating them
        // must recover the original exactly once. Compared with all whitespace
        // stripped, because splitting legitimately collapses the whitespace it
        // splits on -- and because a hard cut slices mid-token, so a word-level
        // comparison would report a false failure on unbroken text.
        const strip = (value: string) => value.replace(/\s+/g, "");
        expect(strip(contents(chunks()).join(""))).toBe(strip(text));
      });

      it("trims each chunk", () => {
        for (const chunk of chunks()) {
          expect(chunk.content).toBe(chunk.content.trim());
        }
      });
    });
  }
});

describe("chunkText — splitting strategy", () => {
  it("returns a single chunk when the whole text fits", () => {
    const chunks = chunkText("A short document that fits comfortably.");
    expect(contents(chunks)).toEqual(["A short document that fits comfortably."]);
  });

  it("returns nothing for empty or whitespace-only input", () => {
    // Zero chunks, NOT one empty chunk. A document with no extractable text is
    // a failed ingestion, and the caller decides that -- the chunker must not
    // manufacture a row that the embedder will then reject.
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n \t ")).toEqual([]);
  });

  it("prefers paragraph boundaries when the paragraphs fit", () => {
    const text = `${words(10, "alpha")}\n\n${words(10, "beta")}\n\n${words(10, "gamma")}`;
    const chunks = chunkText(text, { maxChars: 100, minChars: 1 });
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.content).toContain("alpha");
    expect(chunks[1]!.content).toContain("beta");
    expect(chunks[2]!.content).toContain("gamma");
    // A paragraph that fits is left whole -- splitting it further would throw
    // away the author's own semantic boundary for no gain.
    expect(chunks[0]!.content).not.toContain("beta");
  });

  it("falls back to sentence boundaries inside an oversized paragraph", () => {
    const paragraph = "Alpha one. Beta two. Gamma three. Delta four.";
    const chunks = chunkText(paragraph, { maxChars: 25, minChars: 1 });
    expect(chunks.length).toBeGreaterThan(1);
    // Cut at sentence ends, so no chunk starts or ends mid-sentence.
    for (const chunk of chunks) {
      expect(chunk.content).toMatch(/\.$/);
    }
  });

  it("hard-cuts text that has no boundaries at all", () => {
    // A minified file, a base64 blob, a language this splitter has no rules
    // for. It must still terminate and still respect maxChars.
    const chunks = chunkText("x".repeat(250), { maxChars: 100, minChars: 1 });
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.content).toHaveLength(100);
    expect(chunks[2]!.content).toHaveLength(50);
  });
});

describe("chunkText — the merge threshold", () => {
  it("merges an orphan fragment into the previous chunk", () => {
    // Without this, a trailing heading or stray line becomes its own chunk:
    // a near-useless row that still costs an embedding call and still competes
    // for a slot in every top-k result.
    const text = `${words(10, "body")}\n\nEnd.`;
    const chunks = chunkText(text, { maxChars: 200, minChars: 20 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toContain("End.");
  });

  it("leaves a small chunk alone rather than exceeding maxChars", () => {
    // maxChars wins when the two rules conflict: it is a hard bound, minChars
    // is a preference. Merging here would produce an over-long chunk, which is
    // the worse failure.
    // words(10, "body") is 49 chars; + "\n\n" + "End." is 55, so maxChars must
    // be below 55 for the merge to be the thing that would break the bound.
    const text = `${words(10, "body")}\n\nEnd.`;
    const chunks = chunkText(text, { maxChars: 54, minChars: 40 });
    expect(chunks).toHaveLength(2);
    expect(chunks[1]!.content).toBe("End.");
  });

  it("never merges its way past maxChars", () => {
    const text = `${words(20, "aa")}\n\nbb\n\ncc\n\ndd`;
    for (const chunk of chunkText(text, { maxChars: 70, minChars: 65 })) {
      expect(chunk.content.length).toBeLessThanOrEqual(70);
    }
  });
});

describe("chunkText — configuration", () => {
  it("defaults to 1000 max and 200 min characters", () => {
    // ~250 tokens: three to five sentences, a coherent unit of meaning. Chosen
    // at the low end of the usual range because neighbour expansion at query
    // time (COMPASS-20) supplies the surrounding context, so a chunk does not
    // have to carry it alone.
    expect(DEFAULT_MAX_CHARS).toBe(1000);
    expect(DEFAULT_MIN_CHARS).toBe(200);
  });

  it("honours a caller-supplied maxChars", () => {
    const chunks = chunkText(words(200), { maxChars: 120 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(120);
    }
  });
});

describe("chunkText — regressions", () => {
  it("pulls the next chunk into a leading orphan", () => {
    // merge() originally only looked backwards, so a chunk with nothing before
    // it could never be rescued. A document opening with a Markdown heading is
    // the common case, not an edge one, and Markdown is in scope for COMPASS-11.
    const chunks = chunkText(`# Introduction\n\n${words(20)}`, { maxChars: 200, minChars: 50 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toContain("# Introduction");
  });

  it("still refuses to merge an orphan past maxChars", () => {
    // The forward merge must not become a way around the hard bound.
    const chunks = chunkText(`# Introduction\n\n${words(60)}`, { maxChars: 200, minChars: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(200);
    }
  });

  it("rejects a maxChars that cannot terminate", () => {
    // maxChars 0 made the hard cut's `start += maxChars` never advance, which
    // exhausted memory rather than failing. NaN -- what Number() gives for an
    // unset or misspelt environment variable -- made every comparison false, so
    // a document silently ingested as zero chunks.
    expect(() => chunkText("hello", { maxChars: 0 })).toThrowError(RangeError);
    expect(() => chunkText("hello", { maxChars: -1 })).toThrowError(RangeError);
    expect(() => chunkText("hello", { maxChars: Number.NaN })).toThrowError(RangeError);
    expect(() => chunkText("hello", { minChars: Number.NaN })).toThrowError(RangeError);
  });

  it("rejects an explicit minChars above maxChars, but adapts the default", () => {
    expect(() => chunkText("hello", { maxChars: 50, minChars: 80 })).toThrowError(/no chunk/);
    // Lowering only maxChars must stay ergonomic: the default minimum clamps
    // rather than contradicting the caller.
    expect(() => chunkText(words(200), { maxChars: 120 })).not.toThrow();
  });

  it("never splits a surrogate pair", () => {
    // hardCut is the only path for scripts written without word spaces, which
    // is exactly where astral characters appear. A cut inside a pair stores two
    // lone surrogates that embed as noise.
    const text = "🙂".repeat(10);
    const chunks = chunkText(text, { maxChars: 5, minChars: 1 });
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (const chunk of chunks) {
      expect(loneSurrogate.test(chunk.content)).toBe(false);
    }
    expect(contents(chunks).join("")).toBe(text);
  });
});
