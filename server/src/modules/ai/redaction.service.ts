import { createHash } from 'node:crypto';
import {
  DetectedPII,
  PIICategory,
  PIIDetectedInPromptError
} from './redaction.types.js';

/* ------------------------------------------------------------------ */
/*  Deterministic Opaque Reference Generator (AI-009 Requirement 3)   */
/* ------------------------------------------------------------------ */

export type OpaquePrefix =
  | 'customer_ref'
  | 'merchant_ref'
  | 'order_ref'
  | 'txn_ref'
  | 'case_ref';

/**
 * Generates a stable, collision-resistant 8-character hex opaque reference
 * to preserve relational reasoning without leaking raw PII or database IDs.
 */
export function generateOpaqueReference(prefix: OpaquePrefix, identifier: string | number): string {
  const normalized = String(identifier).trim().toLowerCase();
  const hash = createHash('sha256').update(`paybridge_salt:${prefix}:${normalized}`).digest('hex').slice(0, 8);
  return `${prefix}_${hash}`;
}

/* ------------------------------------------------------------------ */
/*  PII Pattern Definitions (Defense-in-Depth)                        */
/* ------------------------------------------------------------------ */

const PII_PATTERNS: Array<{ category: PIICategory; regex: RegExp; replacement: string }> = [
  // 1. Email Addresses
  {
    category: 'EMAIL',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: '[EMAIL_REDACTED]'
  },
  // 2. Card PANs (13–19 digits with optional delimiters)
  {
    category: 'CARD_PAN',
    regex: /\b(?:\d[ -]*?){13,19}\b/g,
    replacement: '[CARD_REDACTED]'
  },
  // 3. Phone Numbers (Delimited International, US NANP, and Indian Mobile)
  {
    category: 'PHONE',
    regex: /(?:\+\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]+\d{3}[-.\s]+\d{4}\b/g,
    replacement: '[PHONE_REDACTED]'
  },
  {
    category: 'PHONE',
    regex: /\b(?:\+1[-.\s]?)?[2-9]\d{2}[-.]\d{3}[-.]\d{4}\b/g,
    replacement: '[PHONE_REDACTED]'
  },
  {
    category: 'PHONE',
    regex: /(?:\+91[-.\s]?|91[-.\s]?)?[6-9]\d{4}[-.\s]?\d{5}\b/g,
    replacement: '[PHONE_REDACTED]'
  },
  {
    category: 'PHONE',
    regex: /\b[6-9]\d{9}\b/g,
    replacement: '[PHONE_REDACTED]'
  },
  // 4. Card Expiration Dates (MM/YY or MM/YYYY)
  {
    category: 'CARD_EXPIRY',
    regex: /\b(?:exp|expiry|expires)[:=\s]*(0[1-9]|1[0-2])\/([0-9]{2}|[0-9]{4})\b/gi,
    replacement: '[EXPIRY_REDACTED]'
  },
  // 5. Card CVV/CVC
  {
    category: 'CARD_CVV',
    regex: /\b(?:cvv|cvc|security\s*code)[:=\s]*(\d{3,4})\b/gi,
    replacement: '[CVV_REDACTED]'
  },
  // 6. Bank IFSC Code
  {
    category: 'BANK_ACCOUNT_IFSC',
    regex: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g,
    replacement: '[IFSC_REDACTED]'
  },
  // 7. Government Identifiers (SSN, Indian Aadhaar, Indian Tax PAN)
  {
    category: 'GOVERNMENT_ID',
    regex: /\b\d{3}-\d{2}-\d{4}\b/g, // US SSN
    replacement: '[GOVT_ID_REDACTED]'
  },
  {
    category: 'GOVERNMENT_ID',
    regex: /\b\d{4}\s\d{4}\s\d{4}\b/g, // Aadhaar
    replacement: '[GOVT_ID_REDACTED]'
  },
  {
    category: 'GOVERNMENT_ID',
    regex: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g, // Indian PAN
    replacement: '[GOVT_ID_REDACTED]'
  },
  // 8. IP Addresses (IPv4 and IPv6)
  {
    category: 'IP_ADDRESS',
    regex: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g,
    replacement: '[IP_REDACTED]'
  },
  {
    category: 'IP_ADDRESS',
    regex: /\b(?:[a-fA-F0-9]{1,4}:){7}[a-fA-F0-9]{1,4}\b/g,
    replacement: '[IP_REDACTED]'
  }
];

/**
 * Validates whether a numeric sequence passes Luhn algorithm checksum.
 */
function isLuhnValid(digits: string): boolean {
  const clean = digits.replace(/\D/g, '');
  if (clean.length < 13 || clean.length > 19) {
    return false;
  }

  let sum = 0;
  let shouldDouble = false;
  for (let i = clean.length - 1; i >= 0; i--) {
    let digit = parseInt(clean.charAt(i), 10);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

/* ------------------------------------------------------------------ */
/*  Redaction & Sanitization Functions                                */
/* ------------------------------------------------------------------ */

/**
 * Sanitizes arbitrary text by replacing all detected PII patterns with safe tokens.
 */
export function redactString(text: string | null | undefined): string | null {
  if (!text) {
    return text ?? null;
  }

  let sanitized = text;

  // Mask card numbers specifically if Luhn valid or 15-16 consecutive digits
  sanitized = sanitized.replace(/\b(?:\d[ -]*?){13,19}\b/g, (match) => {
    const clean = match.replace(/\D/g, '');
    if (clean.length >= 13 && clean.length <= 19 && isLuhnValid(clean)) {
      return '[CARD_REDACTED]';
    }
    return match;
  });

  for (const { regex, replacement } of PII_PATTERNS) {
    sanitized = sanitized.replace(regex, replacement);
  }

  return sanitized;
}

/**
 * Detects any residual PII in a string for defensive validation.
 */
export function detectPII(text: string): DetectedPII[] {
  if (!text) {
    return [];
  }

  const results: DetectedPII[] = [];

  // 1. Check card numbers
  const cardMatches = text.match(/\b(?:\d[ -]*?){13,19}\b/g);
  if (cardMatches) {
    for (const match of cardMatches) {
      const clean = match.replace(/\D/g, '');
      if (clean.length >= 13 && clean.length <= 19 && isLuhnValid(clean)) {
        results.push({ category: 'CARD_PAN', matchedText: '[CARD_DETECTED]' });
      }
    }
  }

  // 2. Check remaining patterns
  for (const { category, regex } of PII_PATTERNS) {
    if (category === 'CARD_PAN') {
      continue; // checked via Luhn
    }
    // Clone regex with sticky/global flags reset
    const matcher = new RegExp(regex.source, regex.flags);
    const matches = text.match(matcher);
    if (matches) {
      for (const m of matches) {
        results.push({ category, matchedText: m });
      }
    }
  }

  return results;
}

/**
 * Recursively scans an object or string and asserts that zero PII is present.
 * Throws PIIDetectedInPromptError if any PII pattern is found.
 * (AI-009 Requirement 5 & Acceptance Criteria)
 */
export function assertZeroPII(value: unknown, fieldPath = 'root'): void {
  if (value === null || value === undefined) {
    return;
  }

  // Skip system metadata fields (correlationId, timestamps, opaque references)
  if (
    fieldPath.endsWith('correlationId') ||
    fieldPath.endsWith('Reference') ||
    fieldPath.endsWith('Ref') ||
    fieldPath.endsWith('assembledAt') ||
    fieldPath.endsWith('createdAt')
  ) {
    return;
  }

  if (typeof value === 'string') {
    const findings = detectPII(value);
    if (findings.length > 0) {
      const categories = [...new Set(findings.map((f) => f.category))];
      throw new PIIDetectedInPromptError(
        `PII detected in model-bound payload at '${fieldPath}': categories [${categories.join(', ')}]`,
        categories,
        fieldPath
      );
    }
    return;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertZeroPII(value[i], `${fieldPath}[${i}]`);
    }
    return;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const [key, val] of Object.entries(obj)) {
      assertZeroPII(val, `${fieldPath}.${key}`);
    }
  }
}
