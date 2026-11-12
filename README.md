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

The server page supplies public limits to the client at request time. Recording uses short chunks, discards captures that exceed the byte cap, stops slightly before the duration limit to allow a final flush, and releases microphone tracks/timers on stop, error, or disposal. Upload names follow the actual recorded format. The server remains authoritative when browser timers are delayed. Client requests have a timeout covering the body and processing budgets.

In production, set reverse-proxy/platform body caps and timeouts as well: some infrastructure buffers uploads before the route runs or imposes a lower limit. Cancelled requests abort SDK calls and dispose audio readers, but cancellation cannot undo provider work already accepted. These per-request bounds do not replace authentication, distributed concurrency limits, or per-user spend quotas (#2/#21). No quota reservations are introduced here.

## Next milestones

- Wake-word mode uses the browser's native speech recognition API. Browsers that do not expose that API can still use the mic button recording fallback, but they cannot do local wake-word detection yet.
- Replace browser speech APIs with OpenAI Realtime speech-to-speech
- Add user-approved tools for reminders, files, calendar, and email drafts
- Add encrypted long-term memory
- Add authentication before exposing the app outside your local network
- Wrap the web app with Tauri or Electron for a desktop tray experience
