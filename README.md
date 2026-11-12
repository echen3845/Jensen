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

## Next milestones

- Wake-word mode uses the browser's native speech recognition API. Browsers that do not expose that API can still use the mic button recording fallback, but they cannot do local wake-word detection yet.
- Replace browser speech APIs with OpenAI Realtime speech-to-speech
- Add user-approved tools for reminders, files, calendar, and email drafts
- Add encrypted long-term memory
- Add authentication before exposing the app outside your local network
- Wrap the web app with Tauri or Electron for a desktop tray experience
