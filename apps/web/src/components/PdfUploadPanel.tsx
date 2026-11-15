'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type { DecisionView, IntentView, ProposalView } from '@/lib/types';

type Finding = { code: string; excerpt: string };
type PdfInspectionView = {
  source: string;
  text: string;
  pageCount: number;
  extractedChars: number;
  truncated: boolean;
  limitations: string[];
};
type VerificationView = {
  decision: DecisionView;
  inspection: {
    source: string;
    findings: Finding[];
    truncated: boolean;
    sourceChars: number;
    caveat: string;
  };
};

export type PdfUploadResult = {
  proposal: ProposalView;
  inspectionText: { source: string; text: string };
  extraction: PdfInspectionView;
  verification: VerificationView;
  verificationTextTruncated: boolean;
};

type PdfUploadPanelProps = {
  intent: IntentView;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onVerified: (result: PdfUploadResult) => void;
};

export function PdfUploadPanel({ intent, disabled = false, onBusyChange, onVerified }: PdfUploadPanelProps) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<PdfUploadResult | null>(null);

  useEffect(() => {
    setFile(null);
    setError('');
    setResult(null);
  }, [intent.id]);

  async function inspectAndVerify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setResult(null);
    if (!file) {
      setError('Choose a PDF invoice first.');
      return;
    }
    setBusy(true);
    onBusyChange?.(true);
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      form.append('intentId', intent.id);
      const uploadResponse = await fetch('/api/pdf', { method: 'POST', body: form, cache: 'no-store' });
      const uploadBody = await uploadResponse.json() as Partial<PdfUploadResult> & { error?: string };
      if (!uploadResponse.ok || !uploadBody.proposal || !uploadBody.inspectionText || !uploadBody.extraction || !uploadBody.verification) {
        throw new Error(uploadBody.error ?? 'PDF extraction and verification failed.');
      }
      const completed = uploadBody as PdfUploadResult;
      setResult(completed);
      onVerified(completed);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'PDF verification is unconfirmed. No payment was attempted.');
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  }

  return (
    <section className="pdf-upload panel" aria-labelledby="pdf-upload-title">
      <div className="pdf-upload-heading">
        <div>
          <h2 id="pdf-upload-title">Check a PDF invoice</h2>
          <p>Finds hidden instructions in the text. The file is deleted right after.</p>
        </div>
      </div>
      <form className="pdf-upload-form" onSubmit={(event) => void inspectAndVerify(event)}>
        <label className="pdf-file-label" htmlFor="invoice-pdf">Choose invoice PDF</label>
        <input
          id="invoice-pdf"
          type="file"
          accept="application/pdf,.pdf"
          disabled={disabled || busy}
          onChange={(event) => { setFile(event.target.files?.[0] ?? null); setError(''); setResult(null); }}
        />
        <p className="form-hint">Up to 5 MB, 20 pages.</p>
        <button className="secondary-btn" type="submit" disabled={disabled || busy || !file}>
          {busy ? 'Checking…' : 'Check PDF'}
        </button>
      </form>
      {error && <p className="error-banner pdf-upload-message" role="alert">{error}</p>}
      {result && (
        <div className="pdf-result" aria-live="polite">
          <div className="pdf-result-meta">
            <strong>{result.extraction.source.replace('uploaded-pdf:', '')}</strong>
            <span>{result.extraction.pageCount} page(s) · {result.extraction.extractedChars.toLocaleString()} extracted characters</span>
            <span>Gateway decision: {result.verification.decision.decision}</span>
          </div>
          {(result.extraction.truncated || result.verificationTextTruncated) && <p className="evidence-foot">The extracted text was truncated to fit the scanner request limits. No invoice amount or recipient was inferred from the PDF.</p>}
          {result.verification.inspection.findings.length > 0 && (
            <ul className="finding-list">{result.verification.inspection.findings.map((finding, index) => <li key={`${finding.code}-${index}`}><code>{finding.code}</code> — {finding.excerpt}</li>)}</ul>
          )}
          <details>
            <summary>Extracted text</summary>
            <pre className="evidence-text">{result.extraction.text || 'No text was found in this PDF.'}</pre>
            <ul className="pdf-limitations">{result.extraction.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>
            <p className="evidence-foot">{result.verification.inspection.caveat}</p>
          </details>
        </div>
      )}
    </section>
  );
}
