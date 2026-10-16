import AsyncStorage from '@react-native-async-storage/async-storage';
import { claudeProxyPost } from '@/services/claude-proxy';
export const DOCS_KEY = 'health_documents';

// ─── Normalized lab biomarker model ───────────────────────────────────────────
//
// Shared model for both manually-uploaded labs and future Apple Health
// Clinical Records ingestion (HKClinicalTypeIdentifierLabResultRecord).
//
// When Apple Health Clinical Records support is added:
//   1. Add health-records entitlement to app.json (requires App Review justification)
//   2. Request HKClinicalTypeIdentifier permissions per record type
//   3. Parse FHIR Observation resources into LabBiomarker[]
//   4. Store alongside/instead of document-based biomarkers
//
// NOTE: Clinical Records ingestion is NOT implemented — App Review risk is
// significant and the feature requires a compelling medical-device-level
// privacy justification that this app currently does not make.

export interface LabBiomarker {
  /** Biomarker display name, e.g. "Ferritin", "TSH", "Vitamin D" */
  name: string;
  /** Numeric value as reported */
  value: number;
  /** Unit string, e.g. "ng/mL", "%", "mg/dL", "mIU/L" */
  unit: string;
  /** Interpretation relative to reported reference range */
  status: 'OPTIMAL' | 'NORMAL' | 'LOW' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
  /** Lower bound of reference range, when parseable */
  refLow?: number;
  /** Upper bound of reference range, when parseable */
  refHigh?: number;
  /** Original finding string preserved for display */
  rawText: string;
}

export type StoredDocument = {
  id: string;
  type: string;      // 'Blood Work', 'DEXA Scan', etc.
  name: string;      // display name
  date: string;      // 'Jun 29, 2026'
  accent: string;
  summary: string;
  keyFindings: string[];
  context: string;   // full extracted text surfaced to Claude in chat
  /** Structured biomarkers parsed from keyFindings at save time */
  biomarkers?: LabBiomarker[];
};

// ─── Biomarker extraction ──────────────────────────────────────────────────────

/**
 * Parse structured biomarkers from the keyFindings array produced by Claude.
 *
 * Expected finding format (from extractFromDocumentPhoto prompt):
 *   "Ferritin: 8 ng/mL (ref 12-150) — LOW"
 *   "Vitamin D: 22 ng/mL (ref 30-100) — LOW"
 *   "Hemoglobin A1c: 5.2% (ref <5.7%) — OPTIMAL"
 *   "Total Cholesterol: 182 mg/dL (ref <200) — NORMAL"
 *
 * Findings that don't match the expected pattern are skipped gracefully.
 * Reference ranges using < or > are accepted — refLow/refHigh are left undefined.
 */
export function parseBiomarkersFromKeyFindings(findings: string[]): LabBiomarker[] {
  // Matches: "Name: value unit (optional ref range) — STATUS"
  // The em dash (—) may also appear as en dash (–) or a plain hyphen surrounded by spaces.
  const re = /^(.+?):\s*([\d.]+)\s*(\S+?)(?:\s*\([^)]*\))?\s*[—–]\s*(OPTIMAL|NORMAL|LOW|HIGH|CRITICAL)/i;
  // Separate pattern for "Name: value unit - STATUS" (plain hyphen variant)
  const rePlain = /^(.+?):\s*([\d.]+)\s*(\S+?)(?:\s*\([^)]*\))?\s+-\s+(OPTIMAL|NORMAL|LOW|HIGH|CRITICAL)/i;
  // Numeric reference range e.g. "(ref 12-150)" or "(ref 12–150)"
  const refRangeRe = /\(ref\s*([\d.]+)\s*[-–]\s*([\d.]+)\)/i;

  const results: LabBiomarker[] = [];

  for (const finding of findings) {
    const m = finding.match(re) ?? finding.match(rePlain);
    if (!m) continue;

    const [, rawName, rawVal, unit, rawStatus] = m;
    const value = parseFloat(rawVal);
    if (isNaN(value)) continue;

    const refMatch = finding.match(refRangeRe);
    const status = rawStatus.toUpperCase() as LabBiomarker['status'];
    const validStatuses = new Set(['OPTIMAL', 'NORMAL', 'LOW', 'HIGH', 'CRITICAL']);

    results.push({
      name:    rawName.trim(),
      value,
      unit:    unit.trim(),
      status:  validStatuses.has(status) ? status : 'UNKNOWN',
      refLow:  refMatch ? parseFloat(refMatch[1]) : undefined,
      refHigh: refMatch ? parseFloat(refMatch[2]) : undefined,
      rawText: finding,
    });
  }

  return results;
}

// ─── Storage ──────────────────────────────────────────────────────────────────

export async function loadDocuments(): Promise<StoredDocument[]> {
  const raw = await AsyncStorage.getItem(DOCS_KEY);
  return raw ? JSON.parse(raw) : [];
}

/**
 * Save a document, auto-populating structured biomarkers from keyFindings
 * if not already provided by the caller.
 */
export async function saveDocument(doc: StoredDocument): Promise<void> {
  const enriched: StoredDocument = {
    ...doc,
    biomarkers: doc.biomarkers ?? parseBiomarkersFromKeyFindings(doc.keyFindings),
  };
  const existing = await loadDocuments();
  await AsyncStorage.setItem(DOCS_KEY, JSON.stringify([...existing, enriched]));
}

export async function deleteDocument(id: string): Promise<void> {
  const existing = await loadDocuments();
  await AsyncStorage.setItem(DOCS_KEY, JSON.stringify(existing.filter((d) => d.id !== id)));
}

// ─── Chat bridge ──────────────────────────────────────────────────────────────

/**
 * Build a compact health document context string for injecting into the Chat
 * system prompt. Includes a structured biomarker summary for any concerning
 * values (LOW, HIGH, CRITICAL) so the chat model can reason about them.
 */
export function buildDocumentContext(docs: StoredDocument[]): string {
  if (docs.length === 0) return '';
  return docs
    .map((d) => {
      const header = `[${d.type} — ${d.date}]`;
      const body = `${d.summary}\n${d.keyFindings.join('\n')}`;

      // Highlight structured biomarkers outside reference range for the chat model
      const concerning = (d.biomarkers ?? []).filter(
        (b) => b.status === 'LOW' || b.status === 'HIGH' || b.status === 'CRITICAL',
      );
      const bioSummary = concerning.length > 0
        ? `Biomarkers outside range: ${concerning.map((b) => `${b.name} (${b.status})`).join(', ')}.`
        : '';

      return [header, body, bioSummary].filter(Boolean).join('\n');
    })
    .join('\n\n');
}

// ─── Claude extraction ────────────────────────────────────────────────────────

export type DocumentExtract = {
  summary: string;
  keyFindings: string[];
  context: string;
};

/**
 * Send a base64 photo of a health document to Claude.
 * Claude extracts all visible metrics, flags abnormal values, and returns structured JSON.
 */
/**
 * Send a document (photo or PDF) to Claude and extract health metrics.
 * PDFs use Claude's document content type; images always declare image/jpeg.
 */
export async function extractFromDocumentPhoto(
  base64: string,
  mimeType: string = 'image/jpeg',
  docType: string,
): Promise<DocumentExtract> {
  const isPDF = mimeType === 'application/pdf';

  const contentBlock = isPDF
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image',    source: { type: 'base64', media_type: 'image/jpeg',       data: base64 } };

  const text = await claudeProxyPost(
    {
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: [
            contentBlock,
            {
              type: 'text',
              text: `You are analyzing a ${docType} health document photo.

Extract EVERY visible metric, lab value, hormone level, or health finding.
For each value: include the number, unit, reference range if shown, and flag it as OPTIMAL / NORMAL / LOW / HIGH / CRITICAL.

Reply ONLY with valid JSON (no markdown fences):
{
  "summary": "Brief one-sentence description of this document and its date if visible",
  "keyFindings": [
    "Ferritin: 8 ng/mL (ref 12-150) — LOW",
    "Vitamin D: 22 ng/mL (ref 30-100) — LOW",
    "Hemoglobin A1c: 5.2% (ref <5.7%) — OPTIMAL",
    "Total Cholesterol: 182 mg/dL (ref <200) — NORMAL"
  ],
  "context": "Comprehensive structured summary of all findings for use by a health AI coach — include every value, flag abnormals, and note any clinical relevance"
}`,
            },
          ],
        },
      ],
    },
    isPDF ? 'pdfs-2024-09-25' : undefined,
  );

  // Strip markdown fences if present, then find the JSON object
  const stripped = text.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '');
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) {
    // Response likely truncated — check if it starts with { (partial JSON)
    const trimmed = stripped.trim();
    if (trimmed.startsWith('{')) {
      // Try to recover partial JSON by extracting known fields via regex
      const summaryMatch = trimmed.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (summaryMatch) {
        return {
          summary: summaryMatch[1],
          keyFindings: ['Results were extracted but the full list was truncated — try uploading again.'],
          context: trimmed.slice(0, 2000),
        };
      }
    }
    console.warn('[document-ai] Claude response did not contain parseable JSON');
    const preview = text.slice(0, 120).trim();
    throw new Error(preview
      ? `Could not parse document. Claude said: "${preview}"`
      : 'Could not parse document response. The document may be unreadable or password-protected.');
  }
  try {
    return JSON.parse(match[0]) as DocumentExtract;
  } catch {
    console.warn('[document-ai] JSON parse failed on extracted response block');
    throw new Error('Could not parse document response. Please try a clearer photo or different file.');
  }
}
