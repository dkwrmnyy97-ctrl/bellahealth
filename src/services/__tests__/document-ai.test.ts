/**
 * document-ai.test.ts
 *
 * Tests for parseBiomarkersFromKeyFindings — the structured biomarker
 * extraction function that parses Claude's keyFindings output into
 * a normalized LabBiomarker[] model.
 */

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import { parseBiomarkersFromKeyFindings } from '../document-ai';

describe('parseBiomarkersFromKeyFindings', () => {
  it('returns empty array for empty input', () => {
    expect(parseBiomarkersFromKeyFindings([])).toEqual([]);
  });

  it('parses a standard low finding with numeric reference range', () => {
    const findings = ['Ferritin: 8 ng/mL (ref 12-150) \u2014 LOW'];
    const result = parseBiomarkersFromKeyFindings(findings);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Ferritin');
    expect(result[0].value).toBe(8);
    expect(result[0].unit).toBe('ng/mL');
    expect(result[0].status).toBe('LOW');
    expect(result[0].refLow).toBe(12);
    expect(result[0].refHigh).toBe(150);
  });

  it('parses a NORMAL finding with numeric reference range', () => {
    const findings = ['Total Cholesterol: 182 mg/dL (ref 0-200) \u2014 NORMAL'];
    const result = parseBiomarkersFromKeyFindings(findings);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Total Cholesterol');
    expect(result[0].value).toBe(182);
    expect(result[0].unit).toBe('mg/dL');
    expect(result[0].status).toBe('NORMAL');
  });

  it('parses an OPTIMAL finding with non-numeric reference range (< notation)', () => {
    const findings = ['Hemoglobin A1c: 5.2% (ref <5.7%) \u2014 OPTIMAL'];
    const result = parseBiomarkersFromKeyFindings(findings);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Hemoglobin A1c');
    expect(result[0].value).toBe(5.2);
    expect(result[0].unit).toBe('%');
    expect(result[0].status).toBe('OPTIMAL');
    // Non-numeric range — no refLow/refHigh
    expect(result[0].refLow).toBeUndefined();
    expect(result[0].refHigh).toBeUndefined();
  });

  it('parses a HIGH finding without reference range', () => {
    const findings = ['LDL Cholesterol: 145 mg/dL \u2014 HIGH'];
    const result = parseBiomarkersFromKeyFindings(findings);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('LDL Cholesterol');
    expect(result[0].value).toBe(145);
    expect(result[0].status).toBe('HIGH');
    expect(result[0].refLow).toBeUndefined();
    expect(result[0].refHigh).toBeUndefined();
  });

  it('parses a CRITICAL finding', () => {
    const findings = ['Sodium: 118 mEq/L (ref 135-145) \u2014 CRITICAL'];
    const result = parseBiomarkersFromKeyFindings(findings);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('CRITICAL');
  });

  it('parses multiple findings in one call', () => {
    const findings = [
      'Ferritin: 8 ng/mL (ref 12-150) \u2014 LOW',
      'Vitamin D: 22 ng/mL (ref 30-100) \u2014 LOW',
      'Hemoglobin A1c: 5.2% (ref <5.7%) \u2014 OPTIMAL',
      'Total Cholesterol: 182 mg/dL (ref <200) \u2014 NORMAL',
    ];
    const result = parseBiomarkersFromKeyFindings(findings);
    expect(result).toHaveLength(4);
    expect(result.map((r) => r.name)).toEqual([
      'Ferritin', 'Vitamin D', 'Hemoglobin A1c', 'Total Cholesterol',
    ]);
  });

  it('skips findings that do not match the expected format', () => {
    const findings = [
      'Ferritin: 8 ng/mL (ref 12-150) \u2014 LOW',
      'No numeric value here',
      'Missing status: 5 mg/dL',
      'TSH: 2.4 mIU/L \u2014 NORMAL',
    ];
    const result = parseBiomarkersFromKeyFindings(findings);
    // Only the two well-formed findings should parse
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('Ferritin');
    expect(result[1].name).toBe('TSH');
  });

  it('preserves rawText for each biomarker', () => {
    const raw = 'Ferritin: 8 ng/mL (ref 12-150) \u2014 LOW';
    const result = parseBiomarkersFromKeyFindings([raw]);
    expect(result[0].rawText).toBe(raw);
  });

  it('handles en dash separator variant', () => {
    const findings = ['TSH: 2.4 mIU/L (ref 0.5-4.5) \u2013 NORMAL'];
    const result = parseBiomarkersFromKeyFindings(findings);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('TSH');
    expect(result[0].status).toBe('NORMAL');
  });

  it('is case-insensitive for status', () => {
    const findings = ['Vitamin D: 22 ng/mL (ref 30-100) \u2014 low'];
    const result = parseBiomarkersFromKeyFindings(findings);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('LOW');
  });
});
