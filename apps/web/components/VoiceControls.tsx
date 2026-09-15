"use client";

import { useEffect, useRef, useState } from "react";
import { speakText, transcribeAudio } from "../lib/api";

/**
 * Voice controls shared by the dashboard's two chat surfaces (BotChat and
 * HierarchyChat). MicButton turns a MediaRecorder clip into text in the
 * input box — never auto-sends, since a misheard command going straight
 * to a graph with side effects is exactly what the approval model exists
 * to prevent. VoiceReplyToggle speaks each newly completed run's output.
 */

function pickAudioMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const mime of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return undefined;
}

/**
 * Peak amplitude of a recorded clip, or null if the browser can't decode
 * that container. Guards against the classic failure where getUserMedia
 * bound to the wrong source (a monitor line, a dead Bluetooth profile) —
 * the recording "works" but contains silence, and Whisper helpfully
 * hallucinates "Thank you" onto it. Cheaper to catch here than to ship
 * silence to STT and show the user nonsense.
 */
async function peakAmplitude(blob: Blob): Promise<number | null> {
  try {
    const ctx = new AudioContext();
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    let peak = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const data = buf.getChannelData(c);
      const step = Math.max(1, Math.floor(data.length / 20000));
      for (let i = 0; i < data.length; i += step) {
        const a = Math.abs(data[i]);
        if (a > peak) peak = a;
      }
    }
    void ctx.close();
    return peak;
  } catch {
    return null;
  }
}

export function MicButton({
  onTranscript,
  onError,
  disabled,
}: {
  onTranscript: (text: string) => void;
  onError?: (message: string) => void;
  disabled?: boolean;
}) {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const supported =
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof MediaRecorder !== "undefined";

  const stopStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  // If the component unmounts mid-recording, don't leak the mic stream.
  useEffect(() => stopStream, []);

  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;
      const mimeType = pickAudioMime();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stopStream();
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        recorderRef.current = null;
        if (blob.size === 0) return;
        setBusy(true);
        try {
          const peak = await peakAmplitude(blob);
          if (peak !== null && peak < 0.005) {
            onError?.(
              "The recording was silent — the browser is probably listening to the wrong input. Check the mic source in your system settings / browser site permissions.",
            );
            return;
          }
          const text = await transcribeAudio(blob);
          if (text.trim()) onTranscript(text.trim());
        } catch (err) {
          onError?.(err instanceof Error ? err.message : "Transcription failed");
        } finally {
          setBusy(false);
        }
      };
      recorder.start(250);
      setRecording(true);
    } catch (err) {
      stopStream();
      onError?.(err instanceof Error ? err.message : "Microphone access failed");
    }
  };

  const stop = () => {
    setRecording(false);
    recorderRef.current?.stop();
  };

  return (
    <button
      type="button"
      onClick={() => (recording ? stop() : start())}
      disabled={disabled || busy || !supported}
      title={
        !supported
          ? "Voice input isn't supported in this browser"
          : recording
            ? "Stop recording"
            : "Speak your message"
      }
      style={{
        minWidth: 38,
        background: recording ? "var(--danger)" : undefined,
        color: recording ? "var(--accent-text)" : undefined,
      }}
    >
      {busy ? "…" : recording ? "■" : "🎤"}
    </button>
  );
}

/**
 * Speaks `text` once per `speakKey` change — callers pass the latest
 * completed run's id + output, so identical text in two different runs
 * still speaks twice while re-renders of the same run don't. On by
 * default (voice is the point of the Jarvis surface); the button mutes.
 */
export function VoiceReplyToggle({
  speakKey,
  text,
  onError,
}: {
  speakKey: string | null;
  text: string | null;
  onError?: (message: string) => void;
}) {
  // null until the localStorage read — keeps a muted user's stored "0"
  // from racing a speak in the first commit.
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastSpokenRef = useRef<string | null>(null);

  useEffect(() => {
    setEnabled(localStorage.getItem("openbots.voiceReplies") !== "0");
  }, []);

  useEffect(() => {
    if (enabled !== true || !speakKey || !text || lastSpokenRef.current === speakKey) return;
    lastSpokenRef.current = speakKey;
    let cancelled = false;
    speakText(text)
      .then((blob) => {
        if (cancelled) return;
        audioRef.current?.pause();
        const audio = new Audio(URL.createObjectURL(blob));
        audioRef.current = audio;
        audio
          .play()
          .catch(() =>
            onError?.(
              "The browser blocked audio playback — interact with the page once (any click) and it will speak on the next reply.",
            ),
          );
      })
      .catch((err) => onError?.(err instanceof Error ? err.message : "Speech synthesis failed"));
    return () => {
      cancelled = true;
    };
  }, [enabled, speakKey, text, onError]);

  const toggle = () => {
    const next = !enabled;
    setEnabled(next);
    localStorage.setItem("openbots.voiceReplies", next ? "1" : "0");
    if (!next) {
      audioRef.current?.pause();
      audioRef.current = null;
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      title={enabled ? "Mute spoken replies" : "Speak replies aloud"}
      style={{
        background: "transparent",
        color: "var(--text)",
        border: "1px solid var(--border)",
        padding: "4px 8px",
        opacity: enabled ? 1 : 0.55,
      }}
    >
      {enabled ? "🔊" : "🔇"}
    </button>
  );
}
