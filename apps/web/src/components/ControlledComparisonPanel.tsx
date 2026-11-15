'use client';

import { useState } from 'react';
import type { ControlledComparisonResult } from '@/lib/types';
import styles from './ControlledComparisonPanel.module.css';

export type ComparisonScenario = 'attack' | 'clean';

type ControlledComparisonPanelProps = {
  result: ControlledComparisonResult | null;
  scenario: ComparisonScenario | null;
  busy: boolean;
  error: string;
  onRun: (scenario: ComparisonScenario) => void;
};

export function ControlledComparisonPanel({ result, scenario, busy, error, onRun }: ControlledComparisonPanelProps) {
  const [showEvidence, setShowEvidence] = useState(false);

  return (
    <section className={`panel ${styles.panel}`} aria-labelledby="controlled-comparison-title">
      <div className={styles.header}>
        <div>
          <h2 id="controlled-comparison-title">Watch it stop an attack</h2>
          <p>A listing tells the agent to pay someone else. Left: what an unguarded agent would do. Right: what Sentinel does.</p>
        </div>
        <div className={styles.actions}>
          <button type="button" className="primary-btn" onClick={() => onRun('attack')} disabled={busy}>
            {busy && scenario === 'attack' ? 'Running…' : 'Run the attack'}
          </button>
          <button type="button" className="secondary-btn" onClick={() => onRun('clean')} disabled={busy}>
            {busy && scenario === 'clean' ? 'Running…' : 'Run a clean purchase'}
          </button>
        </div>
      </div>

      {error && <p className="error-banner" role="alert">{error}</p>}
      
      {busy && <p className={styles.empty} role="status">Running…</p>}

      {result && (
        <>
          <div className={styles.results}>
            <article className={styles.resultCard}>
              <h3>Unguarded agent would pay</h3>
              <dl>
                <div><dt>Seller / item</dt><dd>{result.proposal.sellerId} / {result.proposal.itemId}</dd></div>
                <div><dt>Recipient</dt><dd>{result.vulnerableSimulation.action.recipient ?? 'Not provided'}</dd></div>
                <div><dt>Amount</dt><dd>{formatScaledAmount(result.vulnerableSimulation.action.amount, result.vulnerableSimulation.action.scale)} {result.vulnerableSimulation.action.asset}</dd></div>
                <div><dt>Proposal</dt><dd><code>{shortHash(result.vulnerableSimulation.action.proposalFingerprint)}</code></dd></div>
              </dl>
              <p className={styles.note}>Simulated. Nothing was sent.</p>
            </article>

            <article className={styles.resultCard}>
              <h3>With Sentinel</h3>
              <p className={styles.decision}>{decisionCopy(result.protectedPolicy.decision)}</p>
              <ul className={styles.reasons}>
                {result.protectedPolicy.reasons.map((reason, index) => <li key={`${reason}-${index}`}>{reason}</li>)}
              </ul>
              <p className={styles.outcome}><strong>Payment outcome:</strong> {result.protectedPolicy.outcome}</p>
              <p className={styles.note}>Demo policy run on test data.</p>
            </article>
          </div>

          <details className={styles.evidence} open={showEvidence} onToggle={(event) => setShowEvidence(event.currentTarget.open)}>
            <summary>Evidence</summary>
            <dl>
              <div><dt>Attempt</dt><dd><code>{result.evidence.attemptId}</code></dd></div>
              <div><dt>Model mode</dt><dd>{result.modelMode}</dd></div>
              <div><dt>Inspection limit</dt><dd>{result.evidence.inspectionMaxChars.toLocaleString()} characters</dd></div>
              <div><dt>Listing content SHA-256</dt><dd><code>{result.evidence.contentSha256}</code></dd></div>
              <div><dt>Proposal fingerprint</dt><dd><code>{result.evidence.canonicalProposalFingerprint}</code></dd></div>
              <div><dt>Source references</dt><dd>{result.evidence.sourceRefs.length ? result.evidence.sourceRefs.map((source) => <code key={source}>{source}</code>) : 'None'}</dd></div>
            </dl>
            <h4>Inspected listing spans</h4>
            
            {result.evidence.inspection.sources.length > 0 ? (
              <ul className={styles.sources}>
                {result.evidence.inspection.sources.map((source, index) => (
                  <li key={`${source.sourceRef ?? source.itemId}-${index}`}>
                    <span>{source.sourceRef ?? source.itemId}</span>
                    <code>characters {source.start}–{source.end}</code>
                  </li>
                ))}
              </ul>
            ) : <p className={styles.note}>No listing source spans were recorded.</p>}
            {result.evidence.inspection.findings.length > 0 && (
              <>
                <h4>Inspection findings</h4>
                <ul className={styles.sources}>
                  {result.evidence.inspection.findings.map((finding, index) => (
                    <li key={`${finding.code}-${finding.start}-${index}`}>
                      <span><strong>{finding.code}</strong> — {finding.excerpt}</span>
                      <code>characters {finding.start}–{finding.end}</code>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </details>
        </>
      )}
    </section>
  );
}

function decisionCopy(decision: ControlledComparisonResult['protectedPolicy']['decision']): string {
  if (decision === 'reject') return 'Blocked';
  if (decision === 'approve') return 'Allowed';
  return 'Held for review';
}

function shortHash(value: string): string {
  return value.length > 20 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}

function formatScaledAmount(amount: string, scale: number): string {
  const digits = amount.padStart(scale + 1, '0');
  if (scale === 0) return digits;
  const whole = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}
