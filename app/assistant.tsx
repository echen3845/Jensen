"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import type { ClientLimits } from "../lib/resource-limits";
import { startBoundedRecording } from "../lib/recording";
import { buildChatRequest } from "../lib/client-chat";
import { failureMessage } from "../lib/api-contract";
import { useRouter } from "next/navigation";
import type { Identity } from "../lib/auth";
import { useHistory } from "../lib/use-history";
import { useVoice } from "../lib/use-voice";
import { ConversationScope } from "../lib/conversation-scope";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

type ChatMode = "standard" | "unhinged" | "flirty" | "therapist";

const starterMessages: Message[] = [
  {
    id: "welcome",
    role: "assistant",
    content:
      "Good evening. Jensen is standing by. Ask me to plan, draft, summarize, reason through something, or remember a note."
  }
];

const suggestions = [
  "Help me plan tomorrow",
  "Summarize this idea",
  "Remember that I prefer concise answers",
  "Draft a text message"
];

const chatModes: { id: ChatMode; label: string }[] = [
  { id: "standard", label: "Standard" },
  { id: "unhinged", label: "Unhinged" },
  { id: "flirty", label: "Flirty" },
  { id: "therapist", label: "Therapist" }
];

function createId() {
  return crypto.randomUUID();
}

export default function Assistant({ limits,identity }: { limits: ClientLimits;identity:Identity|null }) {
  const router=useRouter();
  const history=useHistory(identity?.id||null,starterMessages);
  const {messages,setMessages}=history;
  const [input, setInput] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [chatMode, setChatMode] = useState<ChatMode>("standard");
  const [status, setStatus] = useState("Systems ready");
  const isThinkingRef = useRef(false);
  const messagesRef = useRef<Message[]>(messages);
  const recordingRef = useRef<ReturnType<typeof startBoundedRecording> | null>(null);
  const recordingGenerationRef = useRef({ value: 0 });
  const recordingActiveRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const scope=useRef(new ConversationScope());
  const voice=useVoice({spoken:voiceEnabled,onCapture:setIsListening,onStatus:setStatus,
    onCommand:async text=>{setInput(text);await sendMessage(text);},
    onDismiss:reason=>cancelActive(reason==="unmount")});
  const voiceInputAvailable=voice.mode!=="none";
  const speak=voice.speak;
  function cancelActive(unmount=false){
    scope.current.cancel();recordingRef.current?.dispose();
    recordingRef.current=null;recordingActiveRef.current=false;recordingGenerationRef.current.value++;
    if(!unmount){setIsThinking(false);isThinkingRef.current=false;}
  }

  useEffect(() => {
    messagesRef.current = messages;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function sendMessage(rawContent = input) {
    const content = rawContent.trim();
    if (!content || isThinkingRef.current || !history.ready) return;

    const userMessage: Message = {
      id: createId(),
      role: "user",
      content
    };

    const nextMessages = [...messagesRef.current, userMessage];
    const request = buildChatRequest(nextMessages, chatMode, limits);
    if (!request.ok) {
      setStatus(request.error);
      return;
    }
    messagesRef.current = nextMessages;
    setMessages(nextMessages);
    setInput("");
    setIsThinking(true);
    isThinkingRef.current = true;
    setStatus("Thinking");

    const operation=scope.current.begin(limits.requestTimeoutMs);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json",
          ...(history.conversationId ? {"x-conversation-id":history.conversationId,"x-client-message-id":userMessage.id} : {}) },
        body: request.body,
        signal: operation.signal
      });

      if(!operation.usable())return;
      const data = (await response.json()) as { reply?: string; error?: string; code?: string };
      if(!operation.usable())return;
      if (!response.ok) {
        if(data.code==="authentication_required"||response.status===404)history.clearScope();
        setStatus(data.error || "Request failed. Please try again.");
        return;
      }
      const reply = data.reply || "I could not reach the reasoning core.";
      const assistantMessage: Message = {
        id: createId(),
        role: "assistant",
        content: reply
      };

      setMessages((current) => {
        const updated = [...current, assistantMessage];
        messagesRef.current = updated;
        return updated;
      });
      setStatus(voice.isHandsFree() ? "Jensen awake" : "Systems ready");
      speak(reply);
    } catch (error) {
      if(!operation.current())return;
      setStatus(failureMessage(error));
    } finally {
      const current=operation.current();operation.finish();
      if(!current)return;
      setIsThinking(false);
      isThinkingRef.current = false;
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendMessage();
  }

  async function transcribeRecording(audio: Blob) {
    setStatus("Transcribing");
    const operation=scope.current.begin(limits.requestTimeoutMs);

    try {
      const formData = new FormData();
      const extension = audio.type.startsWith("audio/mp4") ? "m4a" : "webm";
      formData.append("audio", audio, `jensen-voice.${extension}`);

      const response = await fetch("/api/transcribe", {
        method: "POST",
        body: formData,
        signal: operation.signal
      });
      const data = (await response.json()) as { text?: string; error?: string };
      if(!operation.usable())return;
      const transcript = data.text?.trim();

      if (!transcript) {
        setStatus(data.error || "No speech detected");
        return;
      }

      setInput(transcript);
      await sendMessage(transcript);
    } catch {
      if(operation.current())setStatus("Voice transcription failed");
    } finally {operation.finish();}
  }

  function getRecorderOptions() {
    if (MediaRecorder.isTypeSupported("audio/webm")) {
      return { mimeType: "audio/webm" };
    }

    if (MediaRecorder.isTypeSupported("audio/mp4")) {
      return { mimeType: "audio/mp4" };
    }

    return null;
  }

  async function startRecordingFallback() {
    if (recordingActiveRef.current) return;
    if (
      typeof navigator.mediaDevices?.getUserMedia !== "function" ||
      typeof window.MediaRecorder === "undefined"
    ) {
      setStatus("Voice input is not supported in this browser");
      return;
    }

    try {
      const options = getRecorderOptions();
      if (!options) {
        setStatus("This browser cannot record a supported audio format.");
        return;
      }
      const generation = recordingGenerationRef.current.value;
      recordingActiveRef.current = true;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (generation !== recordingGenerationRef.current.value) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      recordingRef.current = startBoundedRecording(stream, options, limits, (audio) => {
        recordingActiveRef.current = false;
        recordingRef.current = null;
        setIsListening(false);
        void transcribeRecording(audio);
      }, (message) => {
        recordingActiveRef.current = false;
        setIsListening(false);
        setStatus(message);
      });
      setIsListening(true);
      setStatus("Recording");
    } catch {
      recordingActiveRef.current = false;
      setStatus("Microphone permission is needed");
      setIsListening(false);
    }
  }

  async function toggleListening(){
    if(isListening){if(recordingRef.current)recordingRef.current.stop();else voice.stopListening();return;}
    if(voice.mode==="native")voice.startManual();else await startRecordingFallback();
  }

  function clearConversation() {
    voice.stopListening();voice.stopSpeaking();cancelActive();
    setMessages(starterMessages);
    messagesRef.current = starterMessages;
    void history.create().catch(()=>setStatus("Unable to create conversation."));
    setStatus("Conversation cleared");
  }

  return (
    <main className="shell">
      <section className="workspace" aria-label="Jensen assistant">
        <header className="topbar">
          <div>
            <p className="eyebrow">Personal AI</p>
            <h1>Jensen</h1>
            <p>{identity?.email|| (identity?"Signed in":"Demo: no live actions")}</p>
            {identity ? <button type="button" onClick={async()=>{
              voice.stopListening();voice.stopSpeaking();cancelActive();
              const response=await fetch("/api/auth/signout",{method:"POST"});
              if(response.ok){setMessages(starterMessages);router.refresh();}
              else setStatus("Sign-out failed. Please try again.");
            }}>Sign out</button>:null}
            {identity ? <select aria-label="Conversation" value={history.conversationId||""} onChange={e=>void (voice.stopListening(),voice.stopSpeaking(),cancelActive(),history.select(e.target.value))}>
              {history.items.map(item=><option key={item.id} value={item.id}>{item.title}</option>)}
            </select>:null}
            {history.error?<p role="alert">{history.error}</p>:null}
          </div>
          <div className="status" aria-live="polite">
            <span className={isThinking || isListening ? "pulse active" : "pulse"} />
            {status}
          </div>
        </header>

        <section className="console" aria-label="Conversation">
          <div className="orb-wrap" aria-hidden="true">
            <div className={isListening ? "core listening" : "core"}>
              <span />
            </div>
          </div>

          {identity?<div>
            <button type="button" disabled={!history.hasMore} onClick={()=>void history.older().catch(()=>setStatus("Unable to load earlier messages."))}>Earlier messages</button>
            <button type="button" onClick={()=>void history.latest().catch(()=>setStatus("Unable to restore latest messages."))}>Latest messages</button>
          </div>:null}
          <div className="messages">
            {messages.map((message) => (
              <article className={`message ${message.role}`} key={message.id}>
                <span>{message.role === "assistant" ? "Jensen" : "You"}</span>
                <p>{message.content}</p>
              </article>
            ))}
            {isThinking ? (
              <article className="message assistant">
                <span>Jensen</span>
                <p>Processing request...</p>
              </article>
            ) : null}
            <div ref={bottomRef} />
          </div>
        </section>

        <div className="suggestions" aria-label="Suggested requests">
          {suggestions.map((suggestion) => (
            <button
              type="button"
              key={suggestion}
              onClick={() => void sendMessage(suggestion)}
              disabled={isThinking}
            >
              {suggestion}
            </button>
          ))}
        </div>

        <div className="modeBar" aria-label="Jensen modes">
          {chatModes.map((mode) => (
            <button
              type="button"
              key={mode.id}
              className={chatMode === mode.id ? "selected" : ""}
              onClick={() => setChatMode(mode.id)}
              aria-pressed={chatMode === mode.id}
            >
              {mode.label}
            </button>
          ))}
        </div>

        <form className="composer" onSubmit={handleSubmit}>
          <button
            className={isListening ? "iconButton active" : "iconButton"}
            type="button"
            onClick={() => void toggleListening()}
            aria-label={isListening ? (voice.mode==="recording" ? "Finish recording" : "Stop microphone") : "Start listening"}
            title={voiceInputAvailable ? "Voice input" : "Voice input unavailable"}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Z" />
              <path d="M19 11a7 7 0 0 1-14 0" />
              <path d="M12 18v4" />
              <path d="M8 22h8" />
            </svg>
          </button>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            maxLength={limits.messageBytes}
            placeholder="Ask Jensen anything..."
            aria-label="Message Jensen"
          />
          <button className="send" type="submit" disabled={isThinking || !input.trim()}>
            Send
          </button>
        </form>

        <p>Hands-free recognition may send audio to your browser speech service before the wake word is detected. It is not local wake-word detection or identity verification.</p>
        <footer className="controls">
          <button type="button" onClick={()=>voice.stopSpeaking()}>Stop speaking</button>
          <button type="button" onClick={()=>{voice.stopListening();voice.stopSpeaking();cancelActive();setStatus("Request stopped. Already completed server work remains.");}}>Stop request</button>
          <label>
            <input
              type="checkbox"
              checked={voiceEnabled}
              onChange={(event) => setVoiceEnabled(event.target.checked)}
            />
            Spoken replies
          </label>
          <label>
            <input
              type="checkbox"
              checked={voice.handsFreeEnabled}
              onChange={() => voice.toggleHandsFree()}
            />
            Hands-free (foreground only)
          </label>
          <button type="button" onClick={clearConversation}>
            New conversation
          </button>
        </footer>
      </section>
    </main>
  );
}
