# AAT local runbook

**Scope:** Person 4 local agent and inspection scaffolding. It is advisory and proposal-only. There is no gateway, frontend, approval authority, checkout tool, authenticated provider discovery, or verified live model result in these checks.

## Local workflow

The root npm workspace builds `@trendie/contracts`, `@trendie/inspection`, `@trendie/agent`, and `@trendie/qatom` in dependency order. The agent accepts narrow discovery and model ports. It validates the trusted task and all configured limits before provider calls, invokes discovery exactly once, bounds and validates the complete listing payload before inspecting fields, and forwards `maxTurns` and `maxToolCalls` to the model port. Listing findings include source spans and item/seller/source references. Proposals are bounded before schema parsing, reject unknown candidate fields, and receive trusted identity, version, platform, and chain only from the core.

`@trendie/agent/openai` is optional and server-only. Construct it with an explicit model name and an asynchronous `authorizeSpend` callback. The callback must return a positive finite numeric allowance; zero, invalid values, callback errors, or an already-aborted signal prevent SDK invocation. This is an authorization gate only. It does not reserve or enforce an exact USD spend; cost depends on model/token usage and requires the caller's cumulative budget policy. Output tokens are capped through the SDK's `modelSettings.maxTokens` (512 by default). The adapter supplies the complete validated listing set in the initial model input, so the one-turn default can produce a proposal without a tool call. The read-only listing tool is optional, and both its calls and SDK turns remain bounded by caller limits. Structured output uses a JSON string for arbitrary provider arguments, which is bounded and parsed through the contracts canonical JSON validator before the core applies its proposal schema. The SDK `Runner` disables tracing so buyer tasks/listings are not automatically sent to the default trace service. Offline tests exercise the actual SDK runner with an injected fake model provider, including one-turn output and a two-turn tool round trip; no live model calls were made.

Inspection scans bounded text for selected instruction patterns and reports source offsets. A missing finding proves nothing. Findings are advisory and must not be treated as a decision or authority. HTML is never executed and URLs are never fetched.

## PDF inspection

Create an isolated Python environment and install the pinned dependencies:

```sh
python3 -m venv .venv-pdf
. .venv-pdf/bin/activate
python -m pip install -r services/pdf-inspection/requirements.txt
npm run test:pdf
```

`npm run test:pdf` fails when the Python environment or dependencies are missing; it does not skip PDF tests. The Node subprocess caps stdout at 1 MB and stderr at 16 KB, kills an oversized or timed out child with `SIGKILL`, hides stderr content from errors, and validates the complete JSON output shape. Python limits source size to 5 MB, pages to 20, extracted text to 100,000 characters, and checks a 3 second cooperative processing budget between pages. That Python limit cannot interrupt a page operation that hangs; the Node hard timeout bounds the whole process. The caller must supply an allowlisted local root; the root is trusted configuration, while the model cannot choose the path. The service rejects traversal and symlink escapes, encrypted/malformed PDFs, and does not execute scripts or fetch remote resources. Text extraction may include visually hidden text but does not detect every visual, metadata, or document attack.

## Integration handoff

For a UI consuming the current server-side fixture runner interface, see [AAT UI fixture integration](aat-ui-integration.md). This documents the public API and unit semantics without implying gateway or live-provider agreement.

**Awais (gateway):** consume validated proposal output as untrusted input; bind authenticated owner and original intent from server state; revalidate all exact fields and policy; inspection must only add advisory evidence. Do not accept agent identity fields or any approval assertion. No authorization signature is defined by this package.

**Nassar (evidence/status UI):** show listing provenance, proposal fields, inspection flags/offsets, source spans, and source (`scripted` vs `model`) separately. Mark findings advisory. Never imply a proposal is approved, purchased, settled, or fulfilled.

## Evidence and remaining gates

Local typecheck, lint, build, Vitest, and Python checks cover synthetic fixtures and mocked child processes only. They do not prove real LLM resistance, authenticated provider discovery, gateway enforcement, PDF sandbox isolation beyond the implemented process limits, numeric spend enforcement by a model provider, or payment behavior. Authentication (`401`), gateway availability, and a nonzero numeric budget remain open integration gates. No live model, provider, gateway, checkout, or payment stage is verified by this runbook. Stages remain pending until owner integration and fresh evidence are reviewed.


## Controlled offline comparison

Build the workspace and run the standalone policy comparison:

```sh
fnm exec --using 22.23.4 npm run build
fnm exec --using 22.23.4 npm run demo:controlled
fnm exec --using 22.23.4 npm run demo:controlled -- --clean
```

The CLI imports the built public `@trendie/agent` package from this checkout. The default fixture changes seller, amount, and recipient and must be rejected with policy reasons; `--clean` uses the trusted seller, listing amount, and authorized recipient and must be approved with `NOT_SETTLED`. Both runs use GOAT to avoid Qatom’s USD-TDN-specific contract requirement. It uses a fixed fixture candidate and an in-process policy that checks trusted seller, item, amount, scale, asset, and recipient. The vulnerable record is simulation-only; no provider dispatch or settlement occurs. Output fields and acceptance cases are documented in [attack evidence](attack-evidence.md).

This does not establish live LLM resistance, gateway enforcement, or execution/settlement outcomes. Gateway/PostgreSQL integration, authenticated provider evidence, and any live-model or payment work remain separately gated and unverified.
