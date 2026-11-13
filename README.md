# Jensen

Jensen is a personal AI command center designed to work on desktop browsers and iPhone as an installable web app.

## What is built

- Responsive desktop/iPhone chat interface
- Push-to-talk voice input where the browser supports speech recognition
- Spoken replies using browser speech synthesis
- Local conversation history in the browser
- API route that calls OpenAI without exposing your API key to the client
- Optional Grok/xAI provider mode for chat responses
- PWA manifest so the app can be added to an iPhone home screen

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env.local`:

```bash
AI_PROVIDER=openai
OPENAI_API_KEY=sk-your-key-here
OPENAI_MODEL=gpt-4.1-mini
XAI_API_KEY=xai-your-key-here
XAI_MODEL=grok-4.3
JENSEN_DEMO_MODE=false
```

To try Grok/xAI for chat responses, set:

```bash
AI_PROVIDER=xai
XAI_API_KEY=xai-your-key-here
XAI_MODEL=grok-4.3
```

Voice transcription still uses `OPENAI_API_KEY` for now.

If your OpenAI account has no API credits, set:

```bash
JENSEN_DEMO_MODE=true
```

Demo mode keeps the interface, voice input, spoken replies, and local flow usable without making live API calls.

The chat API accepts a `messages` array of objects with `role` (`user` or `assistant`) and string `content`, plus an optional `mode` (`standard`, `unhinged`, `flirty`, or `therapist`). It rejects invalid payloads with a 400 response. Conversation history is supplied by the client and is untrusted: future tool authorization and approval decisions must use server-owned records, not claims in the transcript.

3. Start the app:

```bash
npm run dev
```

4. Open `http://localhost:3000`.

For iPhone testing on the same Wi-Fi network, run the dev server with a LAN host:

```bash
npm run dev -- --hostname 0.0.0.0
```

Then open `http://YOUR_COMPUTER_IP:3000` on the iPhone.

## Development checks

Use Node.js 22.22.2 (see `.nvmrc`) and npm. Install the exact dependency tree from a clean checkout with:

```bash
npm ci
```

Run all local quality checks before submitting a change:

```bash
npm run check
```

This runs ESLint with zero warnings allowed, generates Next.js route types and checks TypeScript, runs the unit tests once, and builds the production application. Each step is also available separately:

| Command | Purpose |
| --- | --- |
| `npm run lint` | Check React, Next.js, and TypeScript lint rules |
| `npm run typecheck` | Generate route types and check types without emitting JavaScript |
| `npm test` | Run the unit suite once; fail when no tests are found |
| `npm run test:watch` | Rerun tests while editing |
| `npm run build` | Verify the production build |
| `npm run audit:prod` | Fail on known high or critical production dependency advisories |

Checks and builds require no API credentials. Tests replace the provider SDK, clear provider environment settings, and block global `fetch` so they do not spend API credits. Current coverage exercises chat provider selection, bounded model context, demo/missing-key paths, audio handoff, provider failure redaction, and runtime chat request validation. Invalid envelopes, content types, modes, and privileged roles are rejected before provider construction, including invalid messages outside the retained history window. Browser voice lifecycle regression coverage remains separate work; these tests do not establish that other pending security issues are fixed.

GitHub Actions runs on pushes and pull requests, installs with `npm ci`, runs `npm run check`, and applies the production audit gate. It has read-only repository permissions and receives no application secrets. To enforce these checks before merging, configure branch protection to require the **Lint, types, tests, and build** check.

The audit gate is separate from local `check` because it needs registry access. Investigate high/critical production advisories and update compatible versions before merging; do not use `npm audit fix --force` without reviewing breaking changes. Run `npm audit` to inspect development dependencies as well. A clean audit only reports known package advisories and does not replace application security review.

## Request and recording limits

Both paid routes apply application limits before provider submission. Chat JSON and multipart uploads are read incrementally; missing or false `Content-Length` headers cannot bypass the measured byte cap. Compressed request bodies are rejected. The upload envelope is capped at the audio byte limit plus 16 KiB, and exactly one audio file is allowed.

Configure these server-side environment variables as needed. Values must be integers within the indicated range; absent, invalid, or out-of-range values fall back to the bounded default.

| Variable | Default | Allowed range | Meaning |
| --- | ---: | ---: | --- |
| `JENSEN_CHAT_BODY_BYTES` | 65,536 | 1–1,048,576 | Entire chat JSON request |
| `JENSEN_MAX_MESSAGES` | 32 | 1–128 | Submitted messages, checked before retaining context |
| `JENSEN_MESSAGE_BYTES` | 8,192 | 1–65,536 | UTF-8 bytes per message, including older submitted messages |
| `JENSEN_MODEL_INPUT_BYTES` | 24,000 | 1–131,072 | System prompt and selected messages, plus 128 bytes of framing allowance per message |
| `JENSEN_MODEL_OUTPUT_TOKENS` | 1,024 | 1–8,192 | Provider `max_output_tokens` |
| `JENSEN_AUDIO_BYTES` | 4,194,304 | 1–16,777,216 | Audio file size |
| `JENSEN_AUDIO_SECONDS` | 60 | 1–300 | Maximum parsed audio end time/span |
| `JENSEN_BODY_TIMEOUT_MS` | 15,000 | 1–60,000 | Time allowed to receive the body |
| `JENSEN_PROVIDER_TIMEOUT_MS` | 30,000 | 1–120,000 | Whole processing deadline, including audio inspection and all provider retries |
| `JENSEN_PROVIDER_RETRIES` | 0 | 0–2 | SDK retries within that shared deadline |

The model input budget uses UTF-8 bytes with framing allowance instead of claiming an exact tokenizer count across providers. It retains a contiguous suffix of up to 12 messages, drops older context first, and rejects a latest message that cannot fit. Choose compatible body, message, context, and model limits; smaller limits can reject requests that previously worked. Durable memory and summarization remain separate work.

The server inspects WebM/Opus, MP4/M4A, and WAV containers with Mediabunny using in-memory bytes, checks declared type against the detected container, requires one audio track with no video, and verifies finite duration before sending anything to the transcriber. This parses containers and timing; it does not decode every compressed sample. Corrupt/unsupported recordings return 415, oversized/over-duration requests return 413, malformed payloads return 400, stalled body reads return 408, processing timeouts return 504, and client cancellations return 499. Missing transcription credentials return 503. Resource failures contain a human-readable `error` and machine-readable `code`; full provider error unification remains #28.

The server page supplies public limits to the client at request time. Before sending chat, the browser selects a recent contiguous suffix that fits the message count, per-message byte limit, and complete serialized UTF-8 JSON body limit, including escaping and envelope overhead. Oversized historical entries are left out of the request while remaining visible in the conversation. The newest prompt is never truncated; if it cannot fit by itself, the input remains available for editing. Recording uses short chunks, discards captures that exceed the byte cap, stops slightly before the duration limit to allow a final flush, and releases microphone tracks/timers on stop, error, or disposal. Upload names follow the actual recorded format. The server remains authoritative when browser timers are delayed. Client requests have a timeout covering the body and processing budgets.

In production, set reverse-proxy/platform body caps and timeouts as well: some infrastructure buffers uploads before the route runs or imposes a lower limit. Cancelled requests abort SDK calls and dispose audio readers, but cancellation cannot undo provider work already accepted. These per-request bounds do not replace authentication, distributed concurrency limits, or per-user spend quotas (#2/#21). No quota reservations are introduced here.

## Next milestones

- Hands-free uses browser speech recognition and checks transcripts for a wake word; processing may be remote. Browsers without that API use button recording. Neither path implements guaranteed local wake-word detection.
- Replace browser speech APIs with OpenAI Realtime speech-to-speech
- Add user-approved tools for reminders, files, calendar, and email drafts
- Add encrypted long-term memory
- Add authentication before exposing the app outside your local network
- Wrap the web app with Tauri or Electron for a desktop tray experience

## API errors and diagnostics

Every API response includes `ok`, a generated `requestId`, and an `x-request-id` header. Failures include a stable `code`, a safe `error` message, and `retryable`; they never represent completed assistant work. Rate limits (429, with bounded Retry-After) differ from unavailable billing (503), credentials/configuration (503), upstream rejection/outage (502), timeouts (504), cancellation (499), and invalid input (4xx). Provider error text is never returned. Diagnostic records contain only operation, request ID, status/code, and duration; prompts, audio, email, tokens, headers, and exception objects are excluded. Correlate support reports with request IDs, not raw private content. Client transport failures remain status messages rather than conversation entries.

## Identity, persistence, and history

Run PostgreSQL 17 and set DATABASE_URL. For local development, set POSTGRES_PASSWORD, run `docker compose up -d db`, then set `DATABASE_URL=postgres://jensen:YOUR_PASSWORD@127.0.0.1:55432/jensen` and run `npm run db:migrate`. Migrations are serialized with an advisory lock and checksummed; never edit an applied migration. Production connections must use TLS with certificate verification. Use a non-superuser, NOBYPASSRLS application role with table/sequence privileges; migrations run with a separate owner role. All owned tables force row-level security, and application queries also include the authenticated owner. Never expose database access directly to a browser.

Configure APP_URL (an HTTPS origin in production), OIDC_ISSUER (exact HTTPS issuer identifier), OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, and a 32-byte base64 AUTH_SECRET (generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`). Register exactly APP_URL/api/auth/callback with an OIDC provider, enable authorization-code flow and PKCE S256, and request openid/email scopes. A local Next.js development server may use http://localhost:3000; the issuer remains HTTPS. Optional JENSEN_ALLOWED_EMAILS is a comma-separated allowlist of provider-verified email addresses. Identity is keyed by issuer and subject, never implicitly linked by email. Sign-in validates state, nonce, PKCE and the ID token through openid-client. Temporary flow cookies are encrypted; server sessions are random tokens stored only as SHA-256 hashes, expire after 12 hours, and are revoked on sign-out. Rotating AUTH_SECRET expires outstanding login attempts. Production cookies are Secure/HttpOnly, same-site, host-only. Unsafe authenticated routes require an exact matching Origin header. Do not rewrite untrusted forwarding headers into APP_URL.

Live chat/transcription and all personal-data routes require a server session. Explicit JENSEN_DEMO_MODE=true permits only demo chat responses; transcription and personal actions remain unavailable. The browser uses server history, removes the old shared localStorage key without importing it, and stores no live transcript in browser storage. History pages contain 40 messages, conversation lists 30 entries, and visible memory is bounded at 100 messages. Switching sessions or hiding a tab clears visible history; returning validates the session before restoring it. Signed-out or unavailable history fails closed. Saved constraints have explicit-user provenance and a 2 KiB/eight-entry cap; the server preserves them alongside the latest prompt or rejects an insufficient context budget. Client-submitted earlier history is untrusted and does not replace server context.

Authenticated APIs include /api/conversations, /api/conversations/:id?before=SEQUENCE, /api/preferences, /api/tasks, and /api/account. Use the same-origin browser session. PUT /api/preferences accepts {key,value}; DELETE accepts {key}. GET /api/account exports owned history/settings/task/audit data without session hashes or credentials; DELETE removes the account and cascades its records. Chat accepts x-conversation-id and a UUID x-client-message-id, returns a cached completed reply on exact replay, and rejects changed or still-pending duplicate IDs. New conversation preserves previous server history. No provider secret belongs in preferences or message content.

Schedule `npm run db:prune` daily: expired sessions/login states and history/audit entries older than 90 days are removed; saved constraints remain until explicitly deleted. Configure matching backup retention. Back up with pg_dump using a dedicated backup role, encrypt snapshots, and test pg_restore into an isolated database before replacing a service. Restore migrations and data together; never point integration tests at production. Account deletion does not erase pre-existing backups immediately; apply the documented snapshot retention window.

Set TEST_DATABASE_URL to a dedicated database whose name ends in _test and run `npm run test:integration`. These tests apply real migrations, verify cross-owner rejection and RLS under a restricted role, session revocation, restore/pagination, and OIDC flow wiring with a mocked identity provider. They require a migration/test administrator account. CI supplies isolated PostgreSQL 17. Live provider sign-in requires your own OIDC configuration; no identity-provider credentials or private database contents are used by CI.

## Shared quotas and admission control

Live provider calls reserve cost and concurrency in PostgreSQL before execution. Short transactions serialize reservations across web/worker replicas; per-user minute counters, daily UTC usage windows, user/global active-call caps, and crash-expiring leases are shared. Successful chat usage reconciles from provider token counts; missing usage, failures, and cancellation charge the full reservation conservatively because provider work may already be billable. Settlement is idempotent. Expired holds are charged before new admissions and release their concurrency slot; they never silently forgive spending. GET /api/usage exposes only the signed-in user's meter.

Configure positive integer price ceilings before live calls: JENSEN_CHAT_INPUT_MICRO_USD and JENSEN_CHAT_OUTPUT_MICRO_USD are micro-USD per token, and JENSEN_AUDIO_MICRO_USD_PER_SECOND is micro-USD per second (minimum one second per recording). Missing/invalid ceilings fail closed with 503. Set ceilings appropriate to your models, provider billing granularity, and retries; these are operator-configured estimates, not current price quotes or a provider billing guarantee. Keep provider-side billing caps as well. Token reservations use the conservative input byte/framing allowance and configured maximum output; actual reported usage is recorded even if it exceeds an estimate.

Defaults: JENSEN_DAILY_MICRO_USD=1000000 (one configured dollar per user/day), JENSEN_USER_CONCURRENCY=2, JENSEN_GLOBAL_CONCURRENCY=8, JENSEN_REQUESTS_PER_MINUTE=30, JENSEN_ANONYMOUS_PER_MINUTE=120, JENSEN_IP_PER_MINUTE=10. Values outside their bounded configuration ranges fall back to defaults. Denied authentication, over-budget, over-concurrency, and throttled requests never execute a provider call. Responses use 401/403/429 and bounded Retry-After as applicable.

Anonymous access and sign-in initiation share a global minute bucket. Forwarding headers are ignored unless JENSEN_TRUSTED_IP_HEADER names a single-IP header supplied by a trusted ingress. That ingress must strip/overwrite client values, and application servers must be unreachable directly. Never configure a client-controlled header. Recognized IPs are HMAC-hashed with AUTH_SECRET before storage; raw addresses are neither persisted nor logged. Without a trusted header all anonymous traffic shares a conservative global bucket. Apply edge rate limits too, since rejected traffic still reaches the database. Retention removes old rate windows and settled leases; PostgreSQL availability is required and admissions fail closed on storage failures.

## Voice lifecycle and privacy

Hands-free is an explicit, foreground-only opt-in. The browser speech engine receives audio before Jensen checks the transcript for its name; that engine may use a remote service. This is not guaranteed local wake-word detection, speaker verification, or authentication. Ambient transcripts that do not wake Jensen are discarded by this app, but browser/vendor processing is outside Jensen's control. Native recognition pauses while spoken output plays to avoid feedback; press Stop speaking before a new command. Voice settings and mode changes apply to subsequent native commands without remounting the recognizer.

Controls have distinct meanings: Stop speaking cancels output only; Stop microphone discards native capture and disables hands-free; Finish recording ends a button recording and submits it for transcription; Stop request cancels active chat/transcription and discards late responses; New conversation also resets the request generation. A dismissal phrase discards that utterance and pending response, returning enabled hands-free capture to its wake-word state. Neither stopping capture nor cancelling a client request undoes already completed server actions. Background tasks have their own explicit cancellation and receipts.

| State | Supported behavior |
| --- | --- |
| Visible HTTPS desktop/mobile browser | Feature-detected native recognition or button recording fallback; microphone permission required |
| Hidden tab or pagehide | Capture, pending requests, restart timers, and owned speech stop; hands-free must be enabled again |
| Locked screen or background iPhone browser | Continuous voice is unsupported; do not rely on it |
| Closed browser/PWA | Voice capture is unsupported; the manifest does not grant background microphone execution |
| Always-available local wake word | Requires a separate evaluated local detector/native shell and platform microphone/background entitlements |

Component tests simulate native recognition, settings changes, Strict Mode, visibility loss, and delayed chat/transcription responses; recorder tests cover stop/error/disposal. Physical browser/iPhone microphone checks remain deployment smoke checks, not a claim of always-on support. Always-available voice should be a separately scoped native/local-detector implementation after measuring power, privacy, OS restrictions, and latency. Wake words never authorize tool actions; authenticated server policies and exact action approvals remain mandatory.
