# Open questions

These questions let local work proceed without treating unknowns as approval or evidence. A
question blocks only work that depends on its answer.

| ID | Question / owner | Current evidence | Status and dependent work |
|---|---|---|---|
| Q001 | Awais, Om: align gateway and adapter contracts before gateway-backed payment execution. | Merged Awais source through `11a66a1` contains Fastify/Postgres gateway work and an HTTP Qatom bridge. Om PR #1/#2/#3 are merged to `develop` at `b576c12`. Published QPE PR #10 (`afc1258`) has the read-only capability collector and proposed authority; published AAT PR #11 (`08016e6`) and draft GOAT PR #12 (`bdcf505`) also target `develop`. Awais was notified on WhatsApp about PR #11/#12 and the dependency. No contract agreement is recorded. See [PR #10](https://github.com/PATELOM925/TrendIE/pull/10), [PR #11](https://github.com/PATELOM925/TrendIE/pull/11), [PR #12](https://github.com/PATELOM925/TrendIE/pull/12), [contract matrix](integration.md) and [review disposition](reviews/2026-11-14-integration.md). | HOLD. None of #10–#12 is merged; the proposed contracts remain unagreed. The newer `develop` source includes an active legacy GOAT client, so do not characterize both bridges as fail-closed. Keep the active bridge disabled pending a complete trusted binding. If the claim may have persisted and the client never received an `executionId`, recovery by owner-scoped approval reference is still needed; the server endpoint is not implemented. The historical `9ffdba5` review cleared only that pinned source for local/test integration; it does not review newer runtime. Awais owns durable storage, atomic claim, authorization and migration design. |
| Q002 | Qatom authentication: what buyer auth method and securely provisioned token/OAuth setup is available? | Unauthenticated read-only `initialize` returned HTTP 401 and a Bearer protected-resource challenge. PR #10 now provides a read-only capability collector, but no authenticated live inventory or tool/schema evidence is recorded. No credential was available or sought. | Open. Authenticated tool inventory is unverified. Provide auth through a secret manager/process environment only; never paste credentials into chat, files or logs. |
| Q003 | What is the numeric ceiling and separate authorization for any paid provider calls? | User said “keep it low,” without a numeric amount. No funded credits or free funds are assumed. | Open; default paid execution is disabled (zero). Checkout remains blocked regardless of test transport until a numeric ceiling and separate authorization are recorded. |
| Q004 | Can Qatom atomically bind the charged price/currency to the approved proposal? | No authenticated tool schema or checkout response schema was available. A quote read is not an atomic price limit. | Open P0. Live checkout blocked until provider capability is verified and an independent review approves the binding. |
| Q005 | Which demo item, seller/merchant and amount are confirmed? | No confirmed demo fixture or merchant was provided. | Open. Use synthetic local fixtures only until the team confirms the demo case. |
| Q006 | What are the exact event submission, demo and pitch requirements? | BuilderBase event page UI displayed on Nov 14: “Live, submissions close tomorrow at 10:00 EST” (implies Nov 15 10:00 EST). Organizer confirmation is still needed. Nov 15 5 PM EST is the event end, not the submission cutoff. | Open pending organizer confirmation and exact pitch/judging details. Stage 5 remains unverified; see [hackathon notes](hackathon.md). |
| Q007 | Om / GOAT AgentKit upstream: what compatible release or tested replacement resolves the nested Zod advisory? | Current registry metadata reports latest `@goatnetwork/agentkit@0.3.0` with `zod ^3.24.2`; the lock resolves nested Zod `3.25.76`. The current advisory's patched version is `4.6.6`, and no Zod 3 patch release or compatible AgentKit release was identified. | Open. Keep the finding visible in the full audit. Do not force Zod 4 into AgentKit's Zod 3 path. Before external use, assess and accept the high transitive risk or wait for an upstream patch / separately tested alternative. See [dependency audit](dependencies.md). |
| Q008 | Awais / Om: which disposable PostgreSQL test database and migration/reset plan will prove durable integration? | Offline unit tests pass on separate heads; no database migration, destructive suite or PostgreSQL race check was run. | Open. Use a dedicated isolated database and guarded TEST_DATABASE_URL; production and shared databases are excluded. Source migrations and reset permissions require review before application. |
| Q009 | Nassar: when will the frontend branch/PR and integration entry point be available? | Answered: frontend exists in `develop` (including the Person 5 implementation recorded in the team handoff). Tirth's `origin/tirth/security-integration` branch also exists in the refreshed source snapshot. | Frontend availability is answered. Remaining owner-scoped history/review controls and provider UI depend on gateway APIs and remain open; preview/live-provider behavior is not established. |
| Q010 | Om / sponsors: are buyer auth, test funds and provider credits actually usable? | Qatom welcome confirms account/plan acceptance and Backboard welcome mentions memory credits; browser tabs did not expose readable account state. | Open. Confirm secure authentication and balances through dashboards; email welcome is not evidence of funded checkout or inference. See testing-setup.md and unsent sponsor questions. |
| Q011 | Awais: which follow-up PR will cover the remaining non-blocking audit operations findings? | Final review on 9ffdba5 found P3-only local follow-ups: chain verification loads the full log; HMAC rejection is not audited and key_id rotation lookup is not implemented; new endpoint success/rejection paths need more mocked route tests; generic 4xx errors are an intentional diagnostic tradeoff. | Open follow-up. These do not block the reviewed local merge, but are not cleared for external/production use. Preserve key secrecy and owner scope while addressing them. |

No Awais or Nassar agreement to proposed contracts is implied by visible source or local fake tests.

## Coordination follow-up (2026-11-15)

Person 5's controlled-comparison route is implemented in commit `c16e091` and uses PR #11's runner server-side with fixed fixture ports. The 133-test root suite, lint, web typecheck/build, and independent route review passed locally. This does not prove Gateway-backed enforcement, payment, or settlement. Om approved fixture integration only, not final adversarial clearance; Awais's contract confirmation is pending. Final `claude-opus-5-5` review remains authorized and unrun. See [AAT UI fixture integration](aat-ui-integration.md).

The fake authority in `packages/integration.test.ts` exercises adapter boundaries with synthetic
data only. The [dependency audit](dependencies.md) records current advisory counts and unresolved
release risk.

The combined local candidate `6397e1710ab7559a908af621ad0bdd24cf55fccf` passed root typecheck,
lint and 135 tests across 25 files on Node 22.23.4. All five library builds and four PDF tests also passed. Both offline comparison modes remained `NOT_SETTLED`. These results are pinned candidate evidence, not checks on the published PR heads or global
integration. No live provider, database or integration checks are established.

## Person 4 / AAT controlled harness

PR #11 adds 35 agent tests across 6 files and 11 comparison cases. Both clean and attack CLI
invocations report `NOT_SETTLED`. The comparison uses a synthetic policy, not the actual gateway,
and does not provide live LLM provider evidence. The parent checked test/lint; this child checked
package build/typecheck and the CLI. These checks are local to their respective heads and do not
settle the comparison or demonstrate live behavior.
