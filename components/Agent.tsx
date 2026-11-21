"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { cn } from "@/lib/utils";
import { createFeedback } from "@/lib/actions/general.action";
import {
  DEFAULT_VOICE_PROVIDER,
  createVoiceSession,
  resolveProvider,
} from "@/lib/voice";
import type {
  VoiceProvider,
  VoiceSession,
  VoiceSetupPayload,
} from "@/lib/voice/types";

enum CallStatus {
  INACTIVE = "INACTIVE",
  CONNECTING = "CONNECTING",
  ACTIVE = "ACTIVE",
  FINISHED = "FINISHED",
}

interface SavedMessage {
  role: "user" | "system" | "assistant";
  content: string;
}

const PROVIDER_LABELS: Record<VoiceProvider, string> = {
  openai: "OpenAI Realtime",
  gemini: "Gemini Live",
  groq: "Groq Voice",
};

const Agent = ({
  userName,
  userId,
  interviewId,
  feedbackId,
  type,
  questions,
}: AgentProps) => {
  const router = useRouter();
  const [callStatus, setCallStatus] = useState<CallStatus>(CallStatus.INACTIVE);
  const [messages, setMessages] = useState<SavedMessage[]>([]);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [lastMessage, setLastMessage] = useState<string>("");
  const [provider, setProvider] = useState<VoiceProvider>(DEFAULT_VOICE_PROVIDER);

  const sessionRef = useRef<VoiceSession | null>(null);

  const messagesRef = useRef<SavedMessage[]>([]);
  const callStatusRef = useRef<CallStatus>(CallStatus.INACTIVE);
  const feedbackTriggeredRef = useRef(false);
  const processedCallsRef = useRef<Set<string>>(new Set());
  const newInterviewIdRef = useRef<string | null>(null);
  const navigateAfterResponseRef = useRef(false);

  useEffect(() => {
    callStatusRef.current = callStatus;
  }, [callStatus]);

  useEffect(() => {
    if (messages.length > 0) {
      setLastMessage(messages[messages.length - 1].content);
    }
  }, [messages]);

  // Restore the last-used provider from localStorage (overrides the env default).
  useEffect(() => {
    const saved =
      typeof window !== "undefined"
        ? window.localStorage.getItem("voice-provider")
        : null;
    setProvider(resolveProvider(saved ?? undefined));
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("voice-provider", provider);
    }
  }, [provider]);

  // Clean up the voice session when the component unmounts.
  useEffect(() => {
    return () => {
      sessionRef.current?.disconnect();
      sessionRef.current = null;
    };
  }, []);

  const addMessage = (role: SavedMessage["role"], content: string) => {
    const message = { role, content };
    messagesRef.current = [...messagesRef.current, message];
    setMessages(messagesRef.current);
  };

  // Called when the voice-setup assistant finishes creating an interview.
  const handleCreateInterviewCall = async (
    name: string,
    args: string,
    callId?: string
  ) => {
    const dedupeKey = callId ?? `${name}:${args}`;
    if (processedCallsRef.current.has(dedupeKey)) return;
    processedCallsRef.current.add(dedupeKey);

    if (name !== "createInterview") return;

    let result: { success: boolean; interviewId: string | null } = {
      success: false,
      interviewId: null,
    };

    try {
      const parsed = JSON.parse(args || "{}");

      const response = await fetch("/api/interviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: parsed.role,
          level: parsed.level,
          type: parsed.type,
          techstack: Array.isArray(parsed.techstack)
            ? parsed.techstack.join(", ")
            : parsed.techstack,
          amount: parsed.amount,
        }),
      });

      const data = await response.json();

      if (data.success && data.interviewId) {
        result = { success: true, interviewId: data.interviewId };
        newInterviewIdRef.current = data.interviewId;
        // The assistant will confirm the interview is ready; navigate after
        // that final response finishes playing.
        navigateAfterResponseRef.current = true;
      }
    } catch (error) {
      console.error("createInterview function call failed:", error);
    }

    // Deliver the function result back to the model, then let it respond.
    if (callId) {
      sessionRef.current?.sendToolResult(callId, result);
    }
  };

  const handleCall = async () => {
    if (
      callStatus === CallStatus.CONNECTING ||
      callStatus === CallStatus.ACTIVE
    ) {
      return;
    }

    // Reset state from a previous call (e.g. retake)
    setCallStatus(CallStatus.CONNECTING);
    messagesRef.current = [];
    setMessages([]);
    feedbackTriggeredRef.current = false;
    processedCallsRef.current = new Set();
    newInterviewIdRef.current = null;
    navigateAfterResponseRef.current = false;

    try {
      // 1. Ask our server for the provider-specific setup payload.
      const sessionResponse = await fetch("/api/realtime-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, questions, provider }),
      });

      if (!sessionResponse.ok) {
        const data = await sessionResponse.json().catch(() => ({}));
        throw new Error(data.error || "Failed to start the session");
      }

      const payload = (await sessionResponse.json()) as VoiceSetupPayload;

      // 2. Build the provider session with the callbacks that drive the UI.
      const session = createVoiceSession(provider, payload, {
        onUserMessage: (text) => addMessage("user", text),
        onAssistantMessage: (text) => addMessage("assistant", text),
        onSpeakingStart: () => setIsSpeaking(true),
        onSpeakingEnd: () => {
          setIsSpeaking(false);
          if (navigateAfterResponseRef.current) {
            navigateAfterResponseRef.current = false;
            const target = newInterviewIdRef.current;
            if (target) {
              setCallStatus(CallStatus.FINISHED);
              sessionRef.current?.disconnect();
              router.push(`/interview/${target}`);
            }
          }
        },
        onInterrupted: () => setIsSpeaking(false),
        onFunctionCall: (name, args, callId) =>
          handleCreateInterviewCall(name, args, callId),
        onError: (message) => console.error("Voice error:", message),
      });

      sessionRef.current = session;

      // 3. Establish the connection (WebRTC handshake / WebSocket setup).
      await session.connect();
      setCallStatus(CallStatus.ACTIVE);
    } catch (error) {
      console.error("Failed to start call:", error);
      sessionRef.current?.disconnect();
      sessionRef.current = null;
      setCallStatus(CallStatus.INACTIVE);

      const message =
        error instanceof Error ? error.message : "Unknown error";
      if (message.toLowerCase().includes("permission")) {
        alert(
          "Microphone access was denied. Allow microphone access in your browser and try again."
        );
      } else if (message.includes("NEXT_PUBLIC_GEMINI_API_KEY")) {
        alert(
          `${message}\n\nAdd it to .env.local and restart, or switch back to OpenAI Realtime on the call screen.`
        );
      } else {
        alert(`Could not start the call.\n\n${message}`);
      }
    }
  };

  const handleDisconnect = () => {
    setCallStatus(CallStatus.FINISHED);
    sessionRef.current?.disconnect();
    sessionRef.current = null;
  };

  // When the call ends: save feedback and go to the feedback page
  useEffect(() => {
    if (callStatus !== CallStatus.FINISHED) return;
    if (feedbackTriggeredRef.current) return;
    feedbackTriggeredRef.current = true;

    const handleGenerateFeedback = async () => {
      const { success, feedbackId: id } = await createFeedback({
        interviewId: interviewId!,
        userId: userId!,
        transcript: messagesRef.current,
        feedbackId,
      });

      if (success && id) {
        router.push(`/interview/${interviewId}/feedback`);
      } else {
        console.log("Error saving feedback");
        router.push("/");
      }
    };

    if (type === "generate") {
      // The interview-setup flow navigates itself once the interview is
      // created; only fall back to the dashboard if nothing was created.
      if (!newInterviewIdRef.current) {
        router.push("/");
      }
    } else {
      handleGenerateFeedback();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callStatus]);

  const toggleDisabled =
    callStatus === CallStatus.CONNECTING || callStatus === CallStatus.ACTIVE;

  return (
    <>
      <div className="call-view">
        {/* AI Interviewer Card */}
        <div className="card-interviewer">
          <div className="avatar">
            <Image
              src="/ai-avatar.png"
              alt="profile-image"
              width={65}
              height={54}
              className="object-cover"
            />
            {isSpeaking && <span className="animate-speak" />}
          </div>
          <h3>AI Interviewer</h3>
        </div>

        {/* User Profile Card */}
        <div className="card-border">
          <div className="card-content">
            <Image
              src="/user-avatar.png"
              alt="profile-image"
              width={539}
              height={539}
              className="rounded-full object-cover size-[120px]"
            />
            <h3>{userName}</h3>
          </div>
        </div>
      </div>

      {/* Provider switch */}
      <div className="w-full flex justify-center mt-4">
        <div
          role="group"
          aria-label="Voice provider"
          className="inline-flex items-center rounded-full border border-input bg-dark-200 p-1"
        >
          {(Object.keys(PROVIDER_LABELS) as VoiceProvider[]).map((p) => (
            <button
              key={p}
              type="button"
              disabled={toggleDisabled}
              onClick={() => setProvider(p)}
              className={cn(
                "px-3 py-1.5 text-xs font-medium rounded-full transition-colors cursor-pointer",
                toggleDisabled && "cursor-not-allowed opacity-50",
                provider === p
                  ? "bg-primary-200 text-dark-100"
                  : "text-light-100 hover:text-primary-100"
              )}
            >
              {PROVIDER_LABELS[p]}
            </button>
          ))}
        </div>
      </div>

      {messages.length > 0 && (
        <div className="transcript-border">
          <div className="transcript">
            <p
              key={lastMessage}
              className={cn(
                "transition-opacity duration-500 opacity-0",
                "animate-fadeIn opacity-100"
              )}
            >
              {lastMessage}
            </p>
          </div>
        </div>
      )}

      <div className="w-full flex justify-center">
        {callStatus !== "ACTIVE" ? (
          <button className="relative btn-call" onClick={() => handleCall()}>
            <span
              className={cn(
                "absolute animate-ping rounded-full opacity-75",
                callStatus !== "CONNECTING" && "hidden"
              )}
            />

            <span className="relative">
              {callStatus === "INACTIVE" || callStatus === "FINISHED"
                ? "Call"
                : ". . ."}
            </span>
          </button>
        ) : (
          <button className="btn-disconnect" onClick={() => handleDisconnect()}>
            End
          </button>
        )}
      </div>
    </>
  );
};

export default Agent;
