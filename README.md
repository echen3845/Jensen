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

## Next milestones

- Wake-word mode uses the browser's native speech recognition API. Browsers that do not expose that API can still use the mic button recording fallback, but they cannot do local wake-word detection yet.
- Replace browser speech APIs with OpenAI Realtime speech-to-speech
- Add user-approved tools for reminders, files, calendar, and email drafts
- Add encrypted long-term memory
- Add authentication before exposing the app outside your local network
- Wrap the web app with Tauri or Electron for a desktop tray experience
