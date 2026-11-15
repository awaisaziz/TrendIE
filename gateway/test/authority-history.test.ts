import { afterEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { buildServer } from '../src/server.js';
import { config } from '../src/config.js';
import { pool } from '../src/db/client.js';
import { generateHmacSignature } from '../src/approvals/token.js';

describe('Authority & History Endpoints (Awais Gateway Integration)', () => {
  afterEach(() => vi.restoreAllMocks());

  describe('GET /approvals/:id (Persisted Shared Binding)', () => {
    const validApproval = {
      id: 'apr_test123',
      execution_id: 'exe_test123',
      decision_id: 'dec_test123',
      intent_id: 'int_test123',
      proposal_hash: 'abc123hash',
      key_id: config.APPROVAL_KEY_ID,
      expires_at: new Date(Date.now() + 300_000),
      consumed_at: null,
      consumed_platform: null,
      owner_id: 'owner_alice',
      intent_version: 1,
      bound_platform: 'goat',
      bound_asset: 'BTC',
      bound_chain: 'goat-testnet',
      bound_scale: 18,
      bound_sender: '0x0000000000000000000000000000000000000001',
      bound_destination: '0x000000000000000000000000000000000000dEaD',
      spend_authorization_id: 'auth_1',
      spend_ceiling: 5000000000000000n,
      intent_owner: 'owner_alice',
      intent_intent_version: 1,
      intent_platform: 'goat',
      intent_chain: 'goat-testnet',
      intent_asset: 'BTC',
      intent_scale: 18,
      intent_sender: '0x0000000000000000000000000000000000000001',
      intent_max_amount: '5000000000000000',
    };

    const validHmac = generateHmacSignature({
      approvalId: validApproval.id,
      executionId: validApproval.execution_id,
      proposalHash: validApproval.proposal_hash,
      intentId: validApproval.intent_id,
      expiresAt: validApproval.expires_at.toISOString(),
      ownerId: validApproval.owner_id,
      intentVersion: validApproval.intent_version,
      platform: validApproval.bound_platform,
      chain: validApproval.bound_chain,
      asset: validApproval.bound_asset,
      scale: validApproval.bound_scale,
    });

    it('rejects unauthenticated requests with 401', async () => {
      const app = await buildServer();
      try {
        const res = await app.inject({ method: 'GET', url: '/approvals/apr_test123' });
        expect(res.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it('returns 404 for non-existent approval', async () => {
      vi.spyOn(pool, 'query').mockResolvedValueOnce({ rows: [] } as unknown as pg.QueryResult);
      const app = await buildServer();
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/approvals/apr_missing',
          headers: { 'x-api-key': config.API_KEY_ADAPTER_GOAT },
        });
        expect(res.statusCode).toBe(404);
        expect(res.json().error).toBe('APPROVAL_NOT_FOUND');
      } finally {
        await app.close();
      }
    });

    it('rejects cross-platform adapter requests with 403', async () => {
      vi.spyOn(pool, 'query').mockResolvedValueOnce({
        rows: [{ ...validApproval, bound_platform: 'qatom', hmac_signature: validHmac }],
      } as unknown as pg.QueryResult);

      const app = await buildServer();
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/approvals/apr_test123',
          headers: { 'x-api-key': config.API_KEY_ADAPTER_GOAT },
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().error).toBe('PLATFORM_MISMATCH');
      } finally {
        await app.close();
      }
    });

    it('rejects approvals with invalid HMAC signature with 403', async () => {
      vi.spyOn(pool, 'query').mockResolvedValueOnce({
        rows: [{ ...validApproval, hmac_signature: 'deadbeef'.repeat(8) }],
      } as unknown as pg.QueryResult);

      const app = await buildServer();
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/approvals/apr_test123',
          headers: { 'x-api-key': config.API_KEY_ADAPTER_GOAT },
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().error).toBe('HMAC_INVALID');
      } finally {
        await app.close();
      }
    });

    it('returns full persisted shared binding on valid HMAC', async () => {
      vi.spyOn(pool, 'query').mockResolvedValueOnce({
        rows: [{ ...validApproval, hmac_signature: validHmac }],
      } as unknown as pg.QueryResult);

      const app = await buildServer();
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/approvals/apr_test123',
          headers: { 'x-api-key': config.API_KEY_ADAPTER_GOAT },
        });
        expect(res.statusCode).toBe(200);
        const data = res.json();
        expect(data.id).toBe('apr_test123');
        expect(data.executionId).toBe('exe_test123');
        expect(data.ownerId).toBe('owner_alice');
        expect(data.intentVersion).toBe(1);
        expect(data.boundPlatform).toBe('goat');
        expect(data.boundAsset).toBe('BTC');
        expect(data.boundChain).toBe('goat-testnet');
        expect(data.boundScale).toBe(18);
        expect(data.consumed).toBe(false);
      } finally {
        await app.close();
      }
    });
  });

  describe('Owner-Scoped History Endpoints', () => {
    it('refuses another owner named in the query for /history/decisions', async () => {
      const app = await buildServer();
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/history/decisions?owner=owner_mallory',
          headers: { 'x-api-key': config.API_KEY_DASHBOARD },
        });
        expect(res.statusCode).toBe(403);
        expect(res.json().error).toBe('OWNER_MISMATCH');
      } finally {
        await app.close();
      }
    });

    it('returns owner-scoped decisions with joined proposal and intent', async () => {
      const mockDecisions = [
        {
          id: 'dec_1',
          decision: 'approve',
          reason_codes: ['OK'],
          authorization_ref: 'apr_1',
          created_at: new Date(),
          proposal_id: 'prop_1',
          seller: 'merchant_1',
          product: 'prod_1',
          amount: '1000',
          currency: 'USDC',
          destination: '0x123',
          source_ref: 'ref_1',
          intent_id: 'int_1',
          raw_payload: null,
          intent_owner: 'owner_alice',
          intent_version: 1,
          inspection_source: 'listing:123',
          flags: [],
          evidence: [],
          findings: {},
        },
      ];

      vi.spyOn(pool, 'query')
        .mockResolvedValueOnce({ rows: mockDecisions } as unknown as pg.QueryResult)
        .mockResolvedValueOnce({ rows: [{ count: '1' }] } as unknown as pg.QueryResult);

      const app = await buildServer();
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/history/decisions?owner=owner_alice',
          headers: { 'x-api-key': config.API_KEY_DASHBOARD },
        });
        expect(res.statusCode).toBe(200);
        const data = res.json();
        expect(data.total).toBe(1);
        expect(data.decisions).toHaveLength(1);
        expect(data.decisions[0].intent.owner).toBe('owner_alice');
        expect(data.decisions[0].proposal.seller).toBe('merchant_1');
        expect(data.decisions[0].inspection.source).toBe('listing:123');
      } finally {
        await app.close();
      }
    });

    it('returns owner-scoped executions for /history/executions', async () => {
      const mockExecutions = [
        {
          execution_id: 'exe_1',
          status: 'succeeded',
          platform: 'goat',
          tx_hash_or_checkout_ref: '0xabcdef',
          error: null,
          evidence: { receipt: 'tx_rec' },
          checkpoint_phase: 'broadcast',
          checkpoint_tx_hash: '0xabcdef',
          created_at: new Date(),
          updated_at: new Date(),
          approval_id: 'apr_1',
          intent_id: 'int_1',
          bound_platform: 'goat',
          bound_asset: 'BTC',
          bound_chain: 'goat-testnet',
          bound_scale: 18,
          approval_owner: 'owner_alice',
          expires_at: new Date(),
          consumed_at: new Date(),
          intent_owner: 'owner_alice',
        },
      ];

      vi.spyOn(pool, 'query')
        .mockResolvedValueOnce({ rows: mockExecutions } as unknown as pg.QueryResult)
        .mockResolvedValueOnce({ rows: [{ count: '1' }] } as unknown as pg.QueryResult);

      const app = await buildServer();
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/history/executions?owner=owner_alice',
          headers: { 'x-api-key': config.API_KEY_DASHBOARD },
        });
        expect(res.statusCode).toBe(200);
        const data = res.json();
        expect(data.total).toBe(1);
        expect(data.executions[0].executionId).toBe('exe_1');
        expect(data.executions[0].status).toBe('succeeded');
        expect(data.executions[0].ownerId).toBe('owner_alice');
      } finally {
        await app.close();
      }
    });

    it('returns pending human reviews for /history/review-queue', async () => {
      const mockQueue = [
        {
          id: 'dec_rev_1',
          proposal_hash: 'p_hash_1',
          reason_codes: ['INJECTION_FLAGGED'],
          created_at: new Date(),
          proposal_id: 'prop_rev_1',
          seller: 'suspicious_seller',
          product: 'item_rev',
          amount: '100',
          currency: 'USDC',
          destination: '0xbad',
          source_ref: 'ref_rev',
          raw_payload: null,
          intent_id: 'int_1',
          intent_owner: 'owner_alice',
          intent_version: 1,
          inspection_source: 'listing:suspicious',
          flags: [{ code: 'HIDDEN_PROMPT', severity: 'medium' }],
          evidence: ['instruction found'],
          findings: {},
        },
      ];

      vi.spyOn(pool, 'query').mockResolvedValueOnce({ rows: mockQueue } as unknown as pg.QueryResult);

      const app = await buildServer();
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/history/review-queue?owner=owner_alice',
          headers: { 'x-api-key': config.API_KEY_DASHBOARD },
        });
        expect(res.statusCode).toBe(200);
        const data = res.json();
        expect(data.total).toBe(1);
        expect(data.queue[0].decisionId).toBe('dec_rev_1');
        expect(data.queue[0].reasonCodes).toContain('INJECTION_FLAGGED');
        expect(data.queue[0].intent.owner).toBe('owner_alice');
      } finally {
        await app.close();
      }
    });
  });
  // GOAT authority V1 routes are covered in goat-authority-v1.test.ts.
});
