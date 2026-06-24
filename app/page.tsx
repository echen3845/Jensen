"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

type SpeechRecognitionConstructor = new () => SpeechRecognition;

type SpeechRecognitionEventLike = Event & {
  results: SpeechRecognitionResultList;
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

function createId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>(starterMessages);
  const [input, setInput] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [status, setStatus] = useState("Systems ready");
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const speechSupported = useMemo(() => {
    if (typeof window === "undefined") return false;
    return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  }, []);

  useEffect(() => {
    const savedMessages = window.localStorage.getItem("jensen.messages");
    if (savedMessages) {
      setMessages(JSON.parse(savedMessages) as Message[]);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem("jensen.messages", JSON.stringify(messages));
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!speechSupported) return;

    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) return;

    const recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0]?.transcript)
        .join(" ")
        .trim();

      if (transcript) {
        setInput(transcript);
        void sendMessage(transcript);
      }
    };
    recognition.onend = () => setIsListening(false);
    recognition.onerror = () => {
      setStatus("Voice input paused");
      setIsListening(false);
    };

    recognitionRef.current = recognition;
  }, [speechSupported]);

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
    if (!content || isThinking) return;

    const userMessage: Message = {
      id: createId(),
      role: "user",
      content
    };

    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setInput("");
    setIsThinking(true);
    setStatus("Thinking");

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: nextMessages.map(({ role, content }) => ({ role, content }))
        })
      });

      const data = (await response.json()) as { reply?: string };
      const reply = data.reply || "I could not reach the reasoning core.";
      const assistantMessage: Message = {
        id: createId(),
        role: "assistant",
        content: reply
      };

      setMessages((current) => [...current, assistantMessage]);
      setStatus("Systems ready");
      speak(reply);
    } catch {
      const reply =
        "I could not connect to the local server. Check that the app is running and try again.";
      setMessages((current) => [
        ...current,
        { id: createId(), role: "assistant", content: reply }
      ]);
      setStatus("Connection interrupted");
    } finally {
      setIsThinking(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendMessage();
  }

  function toggleListening() {
    if (!recognitionRef.current) {
      setStatus("Voice input is not supported in this browser");
      return;
    }

    if (isListening) {
      recognitionRef.current.stop();
      setIsListening(false);
      return;
    }

    setIsListening(true);
    setStatus("Listening");
    recognitionRef.current.start();
  }

  function clearConversation() {
    window.speechSynthesis?.cancel();
    setMessages(starterMessages);
    setStatus("Conversation cleared");
  }

  return (
    <main className="shell">
      <section className="workspace" aria-label="Jensen assistant">
        <header className="topbar">
          <div>
            <p className="eyebrow">Personal AI</p>
            <h1>Jensen</h1>
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

        <form className="composer" onSubmit={handleSubmit}>
          <button
            className={isListening ? "iconButton active" : "iconButton"}
            type="button"
            onClick={toggleListening}
            aria-label={isListening ? "Stop listening" : "Start listening"}
            title={speechSupported ? "Voice input" : "Voice input unavailable"}
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
          <button type="button" onClick={clearConversation}>
            Clear
          </button>
        </footer>
      </section>
    </main>
  );
}
