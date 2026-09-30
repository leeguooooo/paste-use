// Secret masking for clipboard text. A clipboard history holds whatever was copied, including
// API keys and passwords; an agent that lists it would otherwise pull those into a chat log.
// Heuristic by design: it errs towards masking. `--no-redact` / `get --raw` turn it off.

export interface Redaction {
  text: string;
  /** Number of masked spans. */
  count: number;
  kinds: string[];
}

interface Rule {
  kind: string;
  pattern: RegExp;
  /** Returns the replacement, or null to leave the match alone. */
  replace?: (match: string, ...groups: string[]) => string | null;
}

const mask = (kind: string): string => `[redacted:${kind}]`;

/** Luhn check, so order numbers and timestamps are not taken for card numbers. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const KEYWORDS =
  "pass(?:word|wd|phrase)?|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token|credentials?|authorization|密码|口令|密钥|秘钥";

// Order matters: specific shapes first, so the label says what was found.
const RULES: Rule[] = [
  { kind: "private-key", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})/g },
  { kind: "api-key", pattern: /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "api-key", pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: "slack-token", pattern: /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "aws-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "google-key", pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: "api-key", pattern: /\b(?:glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36}|hf_[A-Za-z0-9]{30,}|dop_v1_[a-f0-9]{64})/g },
  {
    kind: "bearer-token",
    pattern: /\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{16,})/g,
    replace: (_m, scheme) => `${scheme} ${mask("bearer-token")}`,
  },
  {
    kind: "url-password",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s@/]{1,})@/gi,
    replace: (_m, prefix) => `${prefix}:${mask("url-password")}@`,
  },
  {
    // password=… / "api_key": "…" / 密码：…  — the key stays, the value goes.
    kind: "credential",
    pattern: new RegExp(`((?:${KEYWORDS})["']?\\s*[:=：]\\s*)(["']?)([^\\s"',;&]{4,})\\2`, "gi"),
    replace: (_m, lead, quote, value) =>
      value!.startsWith("[redacted:") ? null : `${lead}${quote}${mask("credential")}${quote}`,
  },
  {
    kind: "card-number",
    pattern: /(?<![\d.])(?:\d[ -]?){12,18}\d(?![\d.])/g,
    replace: (m) => {
      const digits = m.replace(/[ -]/g, "");
      return digits.length >= 13 && digits.length <= 19 && luhnValid(digits) ? mask("card-number") : null;
    },
  },
  {
    // Long opaque strings with mixed character classes: session tokens, generated keys.
    // Hex-only strings (git SHAs, checksums) have no upper+lower mix and are left alone.
    kind: "token",
    pattern: /(?<![A-Za-z0-9+_=-])[A-Za-z0-9+_=-]{40,}(?![A-Za-z0-9+_=-])/g,
    replace: (m) => (/[a-z]/.test(m) && /[A-Z]/.test(m) && /\d/.test(m) && entropy(m) >= 4 ? mask("token") : null),
  },
];

/**
 * A clip that is one bare word mixing lower, upper, digit and a symbol, with none of the
 * punctuation code uses: what a password copied out of a password manager looks like.
 */
export function looksLikeBarePassword(text: string): boolean {
  const s = text.trim();
  if (s.length < 8 || s.length > 64) return false;
  if (/[\s()[\]{}<>/\\.:;,"'=]/.test(s)) return false;
  return /[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s) && /[^A-Za-z0-9]/.test(s);
}

export function redact(input: string): Redaction {
  if (looksLikeBarePassword(input)) {
    return { text: mask("possible-password"), count: 1, kinds: ["possible-password"] };
  }
  let text = input;
  let count = 0;
  const kinds = new Set<string>();
  for (const rule of RULES) {
    text = text.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
      // replace() passes (…groups, offset, whole string); keep the groups.
      const groups = rest.slice(0, -2) as string[];
      const out = rule.replace ? rule.replace(match, ...groups) : mask(rule.kind);
      if (out === null) return match;
      count++;
      kinds.add(rule.kind);
      return out;
    });
  }
  return { text, count, kinds: [...kinds] };
}
