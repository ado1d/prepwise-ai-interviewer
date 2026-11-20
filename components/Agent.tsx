"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { cn } from "@/lib/utils";
import { createFeedback } from "@/lib/actions/general.action";

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

// Events received over the OpenAI Realtime data channel (subset we use).
interface RealtimeEvent {
  type: string;
  transcript?: string;
  name?: string;
  arguments?: string;
  call_id?: string;
  item?: {
    type?: string;
    name?: string;
    arguments?: string;
    call_id?: string;
  };
  error?: { message?: string } | string;
}

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

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

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

  // Clean up the WebRTC connection when the component unmounts
  useEffect(() => {
    return () => cleanupConnection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendEvent = (payload: unknown) => {
    if (dcRef.current && dcRef.current.readyState === "open") {
      dcRef.current.send(JSON.stringify(payload));
    }
  };

  const addMessage = (role: SavedMessage["role"], content: string) => {
    const message = { role, content };
    messagesRef.current = [...messagesRef.current, message];
    setMessages(messagesRef.current);
  };

  const cleanupConnection = () => {
    dcRef.current?.close();
    dcRef.current = null;

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    if (pcRef.current) {
      pcRef.current.ontrack = null;
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.close();
      pcRef.current = null;
    }

    if (audioRef.current) {
      audioRef.current.srcObject = null;
      audioRef.current.remove();
      audioRef.current = null;
    }
  };

  // Called when the voice-setup assistant finishes creating an interview
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
    sendEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(result),
      },
    });
    sendEvent({ type: "response.create" });
  };

  const handleServerEvent = (event: RealtimeEvent) => {
    switch (event.type) {
      // Connection established -> make the assistant say its greeting
      case "session.created":
        sendEvent({ type: "response.create" });
        break;

      // The candidate's speech, transcribed (needed for feedback later)
      case "conversation.item.input_audio_transcription.completed":
      case "conversation.item.input_audio_transcription.done":
        if (event.transcript) {
          addMessage("user", event.transcript);
        }
        break;

      // The assistant's speech, transcribed (GA event name + legacy beta name)
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        if (event.transcript) {
          addMessage("assistant", event.transcript);
        }
        break;

      // Speaking indicator
      case "response.created":
        setIsSpeaking(true);
        break;
      case "response.done":
        setIsSpeaking(false);
        if (navigateAfterResponseRef.current) {
          navigateAfterResponseRef.current = false;
          const target = newInterviewIdRef.current;
          if (target) {
            setCallStatus(CallStatus.FINISHED);
            router.push(`/interview/${target}`);
          }
        }
        break;

      // The candidate starts talking (interrupting the assistant)
      case "input_audio_buffer.speech_started":
        setIsSpeaking(false);
        break;

      // Function calls from the voice-setup assistant
      case "response.output_item.done":
        if (event.item?.type === "function_call" && event.item.name) {
          handleCreateInterviewCall(
            event.item.name,
            event.item.arguments || "{}",
            event.item.call_id
          );
        }
        break;
      case "response.function_call_arguments.done":
        if (event.name) {
          handleCreateInterviewCall(
            event.name,
            event.arguments || "{}",
            event.call_id
          );
        }
        break;

      case "error":
        console.error("Realtime error:", event.error);
        break;
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
      // 1. Ask our server for a short-lived Realtime session token.
      //    (The real API key stays on the server.)
      const sessionResponse = await fetch("/api/realtime-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, questions }),
      });

      if (!sessionResponse.ok) {
        const data = await sessionResponse.json().catch(() => ({}));
        throw new Error(data.error || "Failed to start the session");
      }

      const { clientSecret } = await sessionResponse.json();

      // 2. Microphone
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      streamRef.current = stream;

      // 3. Peer connection: send mic audio, receive the assistant's audio
      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      const audioEl = document.createElement("audio");
      audioEl.autoplay = true;
      audioEl.style.display = "none";
      document.body.appendChild(audioEl);
      audioRef.current = audioEl;

      pc.ontrack = (event) => {
        audioEl.srcObject = event.streams[0];
        audioEl.play().catch(() => {});
      };

      stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));

      // 4. Data channel for realtime events (transcripts, function calls)
      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      dc.addEventListener("message", (event) => {
        try {
          handleServerEvent(JSON.parse(event.data as string));
        } catch (error) {
          console.error("Failed to parse realtime event:", error);
        }
      });

      pc.onconnectionstatechange = () => {
        if (
          pc.connectionState === "failed" ||
          pc.connectionState === "closed"
        ) {
          if (callStatusRef.current === CallStatus.ACTIVE) {
            setCallStatus(CallStatus.FINISHED);
            cleanupConnection();
          }
        }
      };

      // 5. WebRTC handshake with the OpenAI Realtime API (GA endpoint;
      //    the model is already bound to the ephemeral token)
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        body: offer.sdp!,
        headers: {
          Authorization: `Bearer ${clientSecret}`,
          "Content-Type": "application/sdp",
        },
      });

      if (!sdpResponse.ok) {
        throw new Error(
          `Realtime connection failed: ${await sdpResponse.text()}`
        );
      }

      const answerSdp = await sdpResponse.text();
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

      setCallStatus(CallStatus.ACTIVE);
    } catch (error) {
      console.error("Failed to start call:", error);
      cleanupConnection();
      setCallStatus(CallStatus.INACTIVE);

      const message =
        error instanceof Error ? error.message : "Unknown error";
      if (message.toLowerCase().includes("permission")) {
        alert(
          "Microphone access was denied. Allow microphone access in your browser and try again."
        );
      } else {
        alert(`Could not start the call.\n\n${message}`);
      }
    }
  };

  const handleDisconnect = () => {
    setCallStatus(CallStatus.FINISHED);
    cleanupConnection();
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
