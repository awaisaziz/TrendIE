export type DemoCurrency = 'USDC' | 'USDT';

export type IntentView = {
  id: string;
  seller: string;
  product: string;
  maxAmount: string;
  currency: DemoCurrency;
  allowedDestinations: string[];
  expiry: string;
  remainingUses: number;
  createdAt: string;
};

export type Decision = 'approve' | 'reject' | 'review';
export type DecisionState = 'blocked' | 'approved' | 'needs_review';

export type DecisionView = {
  id: string;
  proposalHash: string;
  decision: Decision;
  reasonCodes: string[];
  timestamp: string;
};

export type ProposalView = {
  intentId: string;
  seller: string;
  product: string;
  amount: string;
  currency: DemoCurrency;
  destination: string;
  sourceRef: string;
};

export type InspectionTextInput = { source: string; text: string };

export type SessionActivity = {
  id: string;
  kind: 'intent' | 'decision';
  title: string;
  detail: string;
  timestamp: string;
  decision?: Decision;
};

export type SafeAuditEntry = {
  id: string;
  kind: 'intent';
  title: string;
  detail: string;
  timestamp: string;
};

export type ControlledComparisonResult = {
  modelMode: 'fixture';
  proposal: {
    itemId: string;
    sellerId: string;
    amount: string;
    scale: number;
    asset: string;
    recipient: string;
  };
  evidence: {
    version: 1;
    attemptId: string;
    sourceRefs: string[];
    inspectionMaxChars: number;
    contentSha256: string;
    canonicalProposalFingerprint: string;
    inspection: {
      findings: Array<{ code: string; start: number; end: number; excerpt: string }>;
      truncated: boolean;
      sourceChars: number;
      sources: Array<{ itemId: string; sellerId: string; start: number; end: number; sourceRef: string }>;
    };
  };
  vulnerableSimulation: {
    action: { simulation: true; recipient: string; amount: string; scale: number; asset: string; proposalFingerprint: string };
    executed: false;
    providerDispatch: false;
  };
  protectedPolicy: {
    decision: 'approve' | 'reject';
    reasons: string[];
    providerDispatch: false;
    outcome: 'NOT_SETTLED';
  };
};
