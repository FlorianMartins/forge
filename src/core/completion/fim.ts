// Fill-in-the-middle: the prompt shape a code model expects when the cursor is INSIDE a file.
//
// The naive approach — "here is the file, continue from the cursor" — throws away the strongest
// signal available, which is what comes AFTER the cursor. A model that can see the closing brace,
// the next function and the return type writes a completion that fits; one that cannot writes a
// plausible fragment that has to be deleted. Every code model worth using (Qwen-Coder,
// DeepSeek-Coder, CodeLlama, StarCoder, Codestral) has FIM tokens for exactly this.
//
// Two paths exist. Servers that know the model's template (Ollama's `suffix` field, or an
// OpenAI-compatible `/completions` with `suffix`) get the raw halves. Everything else gets the
// tokens written by hand from the table below.

export interface FimTemplate {
  prefix: string;
  suffix: string;
  middle: string;
  stop: string[];
}

// DeepSeek's markers use full-width bars and the SentencePiece underscore; written as escapes so
// the table survives every editor, terminal and patch tool it will pass through.
const DS = { bar: "｜", low: "▁" };

const TEMPLATES: Array<{ match: RegExp; tpl: FimTemplate }> = [
  {
    match: /qwen|codeqwen/i,
    tpl: {
      prefix: "<|fim_prefix|>",
      suffix: "<|fim_suffix|>",
      middle: "<|fim_middle|>",
      stop: ["<|fim_pad|>", "<|endoftext|>", "<|repo_name|>", "<|file_sep|>"],
    },
  },
  {
    match: /deepseek/i,
    tpl: {
      prefix: `<${DS.bar}fim${DS.low}begin${DS.bar}>`,
      suffix: `<${DS.bar}fim${DS.low}hole${DS.bar}>`,
      middle: `<${DS.bar}fim${DS.low}end${DS.bar}>`,
      stop: ["<|EOT|>", `<${DS.bar}end${DS.low}of${DS.low}sentence${DS.bar}>`],
    },
  },
  {
    match: /codellama|code-llama/i,
    tpl: { prefix: "<PRE> ", suffix: " <SUF>", middle: " <MID>", stop: ["<EOT>", "</s>"] },
  },
  {
    match: /starcoder|granite|stable-?code/i,
    tpl: {
      prefix: "<fim_prefix>",
      suffix: "<fim_suffix>",
      middle: "<fim_middle>",
      stop: ["<|endoftext|>", "<file_sep>"],
    },
  },
  {
    match: /codestral|mistral/i,
    tpl: { prefix: "[PREFIX]", suffix: "[SUFFIX]", middle: "", stop: ["</s>"] },
  },
];

export function templateFor(model: string): FimTemplate {
  for (const t of TEMPLATES) if (t.match.test(model)) return t.tpl;
  // Qwen's is the most widely reused convention; it is the least bad default for an unknown model.
  return TEMPLATES[0]!.tpl;
}

/** Universal stop sequences: a code model that starts a new file has left the completion. */
export const COMMON_STOPS = ["\n\n\n", "```", "<|file_sep|>", "<|endoftext|>"];

export function buildFimPrompt(model: string, prefix: string, suffix: string): { prompt: string; stop: string[] } {
  const t = templateFor(model);
  // Codestral inverts the order: suffix first, then prefix, and no middle marker.
  const prompt = t.middle
    ? `${t.prefix}${prefix}${t.suffix}${suffix}${t.middle}`
    : `${t.suffix}${suffix}${t.prefix}${prefix}`;
  return { prompt, stop: [...t.stop, ...COMMON_STOPS] };
}
