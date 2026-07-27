// Shared types for the research pipeline. All imports of this file across the pipeline
// are `import type { ... }`, which Deno erases at runtime — so this file is only needed
// for type-checking, not execution. Reconstructed from the modules' usage; if it ever
// drifts, runtime is unaffected because the worker is started with `deno run` (no
// type-checking).

export type Collection = "toras_menachem" | "igrot_kodesh";

export type Candidate = {
  collection: Collection;
  source_id: number;
  volume_heading: string;
  item_heading: string;
  chunk_index: number;
  lang: string;
  text: string;
  signals: string[];
  semantic_score?: number;
  keyword_hits?: number;
  // Footnote labels (e.g. ["25", "31"]) in this chunk whose definitions cite the
  // asked-about verse/daf. Present only on citation-route candidates (26 Jul).
  footnotes?: string[];
};

export type QuestionAnalysis = {
  hebrew_query: string;
  alt_queries: string[];
  keyword_terms: string[];
  topic_guidance: string;
};

export type RefutationResult = {
  verdict: "SURVIVES" | "REFUTED";
  justification: string;
};

export type AdversarialVoteResult = {
  verdict: "SURVIVES" | "REFUTED";
  votes: RefutationResult[];
  survives_count: number;
  refuted_count: number;
};

export type Verdict = {
  index: number;
  verdict: "GENUINE" | "TANGENTIAL" | "FALSE_POSITIVE";
  justification: string;
  // The original pass-1 justification, preserved BEFORE the adversarial-refutation
  // rewrite mangles `justification` — the audit trail shows it as "why this passage
  // was considered" (27 Jul rejection-audit feature).
  pass1_justification?: string;
  source?: string;
  collection?: Collection;
  candidate?: Candidate;
  adversarial_check?: AdversarialVoteResult;
};

export type VerificationResult = {
  verdicts: Verdict[];
  citation_recommendation: string;
};
