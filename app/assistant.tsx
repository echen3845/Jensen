"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import type { ClientLimits } from "../lib/resource-limits";
import { startBoundedRecording } from "../lib/recording";
import { buildChatRequest } from "../lib/client-chat";
import { failureMessage } from "../lib/api-contract";
import { useRouter } from "next/navigation";
import type { Identity } from "../lib/auth";
import { useHistory } from "../lib/use-history";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

type ChatMode = "standard" | "unhinged" | "flirty" | "therapist";

type SpeechRecognitionConstructor = new () => SpeechRecognition;

type SpeechRecognitionEventLike = Event & {
  results: SpeechRecognitionResultList;
  resultIndex: number;
};

type SpeechRecognition = EventTarget & {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
};

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

type RecognitionMode = "manual" | "hands-free";

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

function stripWakeWord(transcript: string) {
  return transcript.replace(/^.*?\bjensen\b[,.!?\s-]*/i, "").trim();
}

function includesWakeWord(transcript: string) {
  return /\bjensen\b/i.test(transcript);
}

function includesDismissal(transcript: string) {
  return /\b(dismiss|stand down|go to sleep|that's all|that'?ll be all|that is all|that will be all|stop listening|thank you jensen)\b/i.test(
    transcript
  );
}

function stripAfterDismissal(transcript: string) {
  return transcript
    .split(
      /\b(?:dismiss|stand down|go to sleep|that's all|that'?ll be all|that is all|that will be all|stop listening|thank you jensen)\b/i
    )[0]
    .trim();
}

function getFinalTranscript(event: SpeechRecognitionEventLike) {
  const transcripts: string[] = [];

  for (let index = event.resultIndex; index < event.results.length; index += 1) {
    const result = event.results[index];
    if (result.isFinal) {
      transcripts.push(result[0]?.transcript || "");
    }
  }

  return transcripts.join(" ").trim();
}

export default function Assistant({ limits,identity }: { limits: ClientLimits;identity:Identity|null }) {
  const router=useRouter();
  const history=useHistory(identity?.id||null,starterMessages);
  const {messages,setMessages}=history;
  const [input, setInput] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [voiceInputAvailable] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }

    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recorderSupported =
      typeof navigator.mediaDevices?.getUserMedia === "function" &&
      typeof window.MediaRecorder !== "undefined";

    return Boolean(Recognition) || recorderSupported;
  });
  const [handsFreeEnabled, setHandsFreeEnabled] = useState(false);
  const [assistantAwake, setAssistantAwake] = useState(false);
  const [chatMode, setChatMode] = useState<ChatMode>("standard");
  const [status, setStatus] = useState("Systems ready");
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const recognitionModeRef = useRef<RecognitionMode>("manual");
  const handsFreeEnabledRef = useRef(false);
  const assistantAwakeRef = useRef(false);
  const isThinkingRef = useRef(false);
  const messagesRef = useRef<Message[]>(messages);
  const recordingRef = useRef<ReturnType<typeof startBoundedRecording> | null>(null);
  const recordingGenerationRef = useRef({ value: 0 });
  const recordingActiveRef = useRef(false);
  const restartRecognitionTimeoutRef = useRef<number | null>(null);
  const handleVoiceTranscriptRef = useRef<(transcript: string) => Promise<void>>(async () => {});
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    messagesRef.current = messages;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    handsFreeEnabledRef.current = handsFreeEnabled;
  }, [handsFreeEnabled]);

  useEffect(() => {
    assistantAwakeRef.current = assistantAwake;
  }, [assistantAwake]);

  useEffect(() => {
    isThinkingRef.current = isThinking;
  }, [isThinking]);

  useEffect(() => {
    const recordingGeneration = recordingGenerationRef.current;
    return () => {
      if (restartRecognitionTimeoutRef.current !== null) {
        window.clearTimeout(restartRecognitionTimeoutRef.current);
      }

      recognitionRef.current?.stop();

      recordingGeneration.value++;
      recordingActiveRef.current = false;
      recordingRef.current?.dispose();
    };
  }, []);

  useEffect(() => {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) return;

    const recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      const transcript = getFinalTranscript(event);

      if (transcript) {
        void handleVoiceTranscriptRef.current(transcript);
      }
    };
    recognition.onend = () => {
      setIsListening(false);

      if (handsFreeEnabledRef.current) {
        if (restartRecognitionTimeoutRef.current !== null) {
          window.clearTimeout(restartRecognitionTimeoutRef.current);
        }

        restartRecognitionTimeoutRef.current = window.setTimeout(() => {
          restartRecognitionTimeoutRef.current = null;
          startNativeRecognition("hands-free");
        }, 350);
      }
    };
    recognition.onerror = () => {
      setStatus("Voice input paused");
      setIsListening(false);
    };

    recognitionRef.current = recognition;
  }, []);

  function speak(text: string) {
    if (!voiceEnabled || typeof window === "undefined" || !window.speechSynthesis) {
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1;
    utterance.pitch = 0.95;
    utterance.volume = 0.9;
    window.speechSynthesis.speak(utterance);
  }

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

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json",
          ...(history.conversationId ? {"x-conversation-id":history.conversationId,"x-client-message-id":userMessage.id} : {}) },
        body: request.body,
        signal: AbortSignal.timeout(limits.requestTimeoutMs)
      });

      const data = (await response.json()) as { reply?: string; error?: string; code?: string };
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
      setStatus(handsFreeEnabledRef.current ? "Jensen awake" : "Systems ready");
      speak(reply);
    } catch (error) {
      setStatus(failureMessage(error));
    } finally {
      setIsThinking(false);
      isThinkingRef.current = false;
    }
  }

  async function handleVoiceTranscript(rawTranscript: string) {
    const transcript = rawTranscript.trim();
    if (!transcript) return;

    if (recognitionModeRef.current !== "hands-free") {
      setInput(transcript);
      await sendMessage(transcript);
      return;
    }

    if (!assistantAwakeRef.current) {
      if (!includesWakeWord(transcript)) {
        setStatus("Awaiting wake word");
        return;
      }

      setAssistantAwake(true);
      assistantAwakeRef.current = true;
      setStatus("Jensen awake");

      const command = stripWakeWord(transcript);
      if (command) {
        setInput(command);
        await sendMessage(command);
      } else {
        speak("I'm listening.");
      }
      return;
    }

    if (includesDismissal(transcript)) {
      const commandBeforeDismissal = stripAfterDismissal(transcript);

      if (commandBeforeDismissal) {
        setInput(commandBeforeDismissal);
        await sendMessage(commandBeforeDismissal);
      }

      setAssistantAwake(false);
      assistantAwakeRef.current = false;
      setStatus("Awaiting wake word");
      speak("Standing by.");
      return;
    }

    setInput(transcript);
    await sendMessage(transcript);
  }

  handleVoiceTranscriptRef.current = handleVoiceTranscript;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendMessage();
  }

  async function transcribeRecording(audio: Blob) {
    setStatus("Transcribing");

    try {
      const formData = new FormData();
      const extension = audio.type.startsWith("audio/mp4") ? "m4a" : "webm";
      formData.append("audio", audio, `jensen-voice.${extension}`);

      const response = await fetch("/api/transcribe", {
        method: "POST",
        body: formData,
        signal: AbortSignal.timeout(limits.requestTimeoutMs)
      });
      const data = (await response.json()) as { text?: string; error?: string };
      const transcript = data.text?.trim();

      if (!transcript) {
        setStatus(data.error || "No speech detected");
        return;
      }

      setInput(transcript);
      await sendMessage(transcript);
    } catch {
      setStatus("Voice transcription failed");
    }
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

  function startNativeRecognition(mode: RecognitionMode) {
    if (!recognitionRef.current) return false;

    try {
      recognitionModeRef.current = mode;
      recognitionRef.current.continuous = mode === "hands-free";
      recognitionRef.current.start();
      setIsListening(true);
      setStatus(
        mode === "hands-free"
          ? assistantAwakeRef.current
            ? "Jensen awake"
            : "Awaiting wake word"
          : "Listening"
      );
      return true;
    } catch {
      return false;
    }
  }

  async function toggleListening() {
    if (isListening) {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
      recordingRef.current?.stop();
      setIsListening(false);
      return;
    }

    if (!recognitionRef.current) {
      await startRecordingFallback();
      return;
    }

    startNativeRecognition("manual");
  }

  async function toggleHandsFree() {
    if (handsFreeEnabledRef.current) {
      handsFreeEnabledRef.current = false;
      setHandsFreeEnabled(false);
      setAssistantAwake(false);
      assistantAwakeRef.current = false;
      recognitionRef.current?.stop();
      setIsListening(false);
      setStatus("Hands-free off");
      return;
    }

    if (!recognitionRef.current) {
      setStatus("Wake word needs browser speech recognition");
      return;
    }

    handsFreeEnabledRef.current = true;
    setHandsFreeEnabled(true);
    setAssistantAwake(false);
    assistantAwakeRef.current = false;
    startNativeRecognition("hands-free");
  }

  function clearConversation() {
    window.speechSynthesis?.cancel();
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
              const response=await fetch("/api/auth/signout",{method:"POST"});
              if(response.ok){setMessages(starterMessages);router.refresh();}
              else setStatus("Sign-out failed. Please try again.");
            }}>Sign out</button>:null}
            {identity ? <select aria-label="Conversation" value={history.conversationId||""} onChange={e=>void history.select(e.target.value)}>
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
            aria-label={isListening ? "Stop listening" : "Start listening"}
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

        <footer className="controls">
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
              checked={handsFreeEnabled}
              onChange={() => void toggleHandsFree()}
            />
            Wake word
          </label>
          <button type="button" onClick={clearConversation}>
            New conversation
          </button>
        </footer>
      </section>
    </main>
  );
}
