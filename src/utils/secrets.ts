/**
 * Detection and redaction of sensitive material (secrets, credentials, infrastructure, PII).
 *
 * Used as a hard gate so secrets and personal data NEVER enter durable memory, RAG candidates or
 * embeddings - not even chat-scoped. Cross-chat isolation is already deterministic (every retrieval
 * filters by chatId), but on top of that we make sure sensitive content is not ingested at all, and
 * that text sent to the embedding endpoint is redacted first.
 */

// High-confidence secrets / credentials / infrastructure.
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, // PEM private keys
  /\bsk-[A-Za-z0-9]{20,}\b/, // OpenAI-style keys
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{30,}\b/, // Google API key
  /\bAQ\.[A-Za-z0-9._-]{20,}\b/, // Google OAuth / Gemini key
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, // GitHub tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, // Slack tokens
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JWT
  /\b(?:authorization|bearer)\b\s*[:=]?\s*[A-Za-z0-9._-]{16,}/i, // bearer/authorization
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@/i, // scheme://user:pass@host connection strings
  /\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASS(?:WORD)?|PWD|CREDENTIAL|PRIVATE)[A-Z0-9_]*\s*[:=]\s*\S{6,}/i, // KEY=secret
  /\bssh-(?:rsa|ed25519|dss)\s+[A-Za-z0-9+/]{20,}/, // ssh public/authorized keys
  /\b[0-9a-f]{32,}\b/i, // long hex secrets (md5/sha/bootstrap tokens)
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/, // IPv4 (infrastructure)
];

// Personal data (kept from the original memory filter).
const PII_PATTERNS: RegExp[] = [
  /\bpassword\b/i,
  /\bssn\b/i,
  /\bsocial security\b/i,
  /\bcredit card\b/i,
  /\biban\b/i,
  /\bhome address\b/i,
  /\bcodice fiscale\b/i,
  // street address, both "123 via Roma" and "123 Main Street" forms
  /\b\d{1,5}\s+(?:\w+\s+)?(via|viale|piazza|corso|street|st|avenue|ave|road|rd|blvd)\b/i,
  /\b\+?\d[\d\s().-]{7,}\d\b/, // phone-like
];

/** True if the text contains a secret / credential / infrastructure identifier. */
export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

/** True if the text contains a secret OR personal data. Use this to gate memory/RAG ingestion. */
export function containsSensitive(text: string): boolean {
  return containsSecret(text) || PII_PATTERNS.some((re) => re.test(text));
}

// Replacement rules for redaction (mask, not detect). Order matters (connection strings first).
const REDACTIONS: Array<[RegExp, string]> = [
  [/Cookie:\s*\S+/gi, 'Cookie:[redacted]'],
  [/(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----)/g, '[redacted-private-key]'],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):[^\s:@/]+@/gi, '$1:[redacted]@'],
  [/\b(authorization|bearer)(\s*[:=]?\s*)[A-Za-z0-9._-]{16,}/gi, '$1$2[redacted]'],
  [/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASS(?:WORD)?|PWD|CREDENTIAL|PRIVATE)[A-Z0-9_]*)(\s*[:=]\s*)\S{6,}/gi, '$1$2[redacted]'],
  [/\bsk-[A-Za-z0-9]{20,}\b/g, '[redacted]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[redacted]'],
  [/\bAQ\.[A-Za-z0-9._-]{20,}\b/g, '[redacted]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[redacted]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted-jwt]'],
  [/\b[0-9a-f]{32,}\b/gi, '[redacted]'],
];

/** Mask secrets in free text (e.g. before sending it to an embedding endpoint or logging it). */
export function redactSecrets(text: string): string {
  let s = text;
  for (const [re, sub] of REDACTIONS) s = s.replace(re, sub);
  return s;
}
