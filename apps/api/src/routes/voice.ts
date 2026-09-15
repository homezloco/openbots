import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ProviderId } from "@openbots/graph-schema";
import { requireAuth } from "../auth/middleware.js";
import {
  allEnvConfiguredProviders,
  allUserConfiguredProviders,
  getUserOrEnvCredentials,
} from "../orchestrator/credentials.js";

/**
 * Speech endpoints behind the chat input. Both are thin pass-throughs to
 * whichever audio-capable provider the CALLER has configured — their own
 * account key first, env var second — so a hosted-demo visitor's voice
 * usage bills to their BYOK key, same as graph generation does.
 *
 * Only providers that expose OpenAI-style /audio/* endpoints qualify:
 * openai-compatible (Groq: whisper-large-v3-turbo + playai-tts) and
 * openai (whisper-1 + gpt-4o-mini-tts). Anthropic/xAI/OpenRouter have no
 * audio API to call. VOICE_* env vars override model/voice per deploy.
 */
const VOICE_PROVIDERS = ["openai-compatible", "openai"] as const;
type VoiceProvider = (typeof VOICE_PROVIDERS)[number];

const VOICE_DEFAULTS: Record<
  VoiceProvider,
  { sttModel: string; ttsModel: string; ttsVoice: string; responseFormat: string; baseURL: string }
> = {
  "openai-compatible": {
    sttModel: "whisper-large-v3-turbo",
    // Groq migrated TTS platform-wide from playai-tts (decommissioned
    // 2025-12-31) to Canopy Orpheus. English voices: autumn, diana,
    // hannah, austin, daniel, troy.
    ttsModel: "canopylabs/orpheus-v1-english",
    ttsVoice: "troy",
    // Groq's speech endpoint only emits wav today.
    responseFormat: "wav",
    baseURL: "https://api.groq.com/openai/v1",
  },
  openai: {
    sttModel: "whisper-1",
    ttsModel: "gpt-4o-mini-tts",
    ttsVoice: "alloy",
    responseFormat: "mp3",
    baseURL: "https://api.openai.com/v1",
  },
};

const AUDIO_CONTENT_TYPES = [
  "audio/webm",
  "audio/mp4",
  "audio/ogg",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/m4a",
  "application/octet-stream",
];

const EXTENSION_BY_MIME: Record<string, string> = {
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "application/octet-stream": "webm",
};

const speakBody = z.object({ text: z.string().min(1) });

// Orpheus's spoken replies don't need the full essay — cap ~3900 chars at
// the last sentence boundary so a long reply gets a graceful spoken
// summary instead of a 400.
const SPEAK_CHAR_CAP = 3900;
function truncateForSpeech(text: string): string {
  if (text.length <= SPEAK_CHAR_CAP) return text;
  const slice = text.slice(0, SPEAK_CHAR_CAP);
  const boundary = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf(".\n"), slice.lastIndexOf("! "), slice.lastIndexOf("? "));
  return boundary > SPEAK_CHAR_CAP / 2 ? slice.slice(0, boundary + 1) : slice;
}

async function resolveVoiceConfig(userId: string | null): Promise<{
  provider: VoiceProvider;
  apiKey: string;
  baseURL: string;
  sttModel: string;
  ttsModel: string;
  ttsVoice: string;
  responseFormat: string;
} | null> {
  const configured = new Set<ProviderId>([
    ...(userId ? (await allUserConfiguredProviders(userId)).map((p) => p.provider) : []),
    ...allEnvConfiguredProviders().map((p) => p.provider),
  ]);
  const provider = VOICE_PROVIDERS.find((p) => configured.has(p));
  if (!provider) return null;

  const creds = await getUserOrEnvCredentials(userId, provider);
  if (!creds.apiKey) return null;
  const defaults = VOICE_DEFAULTS[provider];
  return {
    provider,
    apiKey: creds.apiKey,
    baseURL: creds.baseURL ?? defaults.baseURL,
    sttModel: process.env.VOICE_STT_MODEL ?? defaults.sttModel,
    ttsModel: process.env.VOICE_TTS_MODEL ?? defaults.ttsModel,
    ttsVoice: process.env.VOICE_TTS_VOICE ?? defaults.ttsVoice,
    responseFormat: defaults.responseFormat,
  };
}

export async function voiceRoutes(app: FastifyInstance) {
  // Audio uploads arrive as the raw request body (the client POSTs the
  // MediaRecorder blob directly) rather than multipart — avoids pulling in
  // @fastify/multipart for a single-endpoint use. Parsers registered here
  // are scoped to this plugin's routes only.
  for (const type of AUDIO_CONTENT_TYPES) {
    app.addContentTypeParser(type, { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  }

  app.post(
    "/voice/transcribe",
    // ~10MB covers several minutes of opus/webm speech; the JSON default
    // (1MB) would cut off anything past ~90 seconds.
    { preHandler: requireAuth, bodyLimit: 10 * 1024 * 1024 },
    async (req, reply) => {
      if (!req.userId) return reply.code(401).send({ error: "Unauthorized" });
      const audio = req.body as Buffer;
      if (!Buffer.isBuffer(audio) || audio.length === 0) {
        return reply.code(400).send({ error: "Expected an audio request body" });
      }
      const voice = await resolveVoiceConfig(req.userId);
      if (!voice) {
        return reply.code(503).send({
          error: "No voice-capable provider configured (needs an openai-compatible or openai key)",
        });
      }

      const mime = (req.headers["content-type"] ?? "application/octet-stream").split(";")[0].trim();
      const form = new FormData();
      form.append("model", voice.sttModel);
      form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), `audio.${EXTENSION_BY_MIME[mime] ?? "webm"}`);

      const res = await fetch(`${voice.baseURL}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${voice.apiKey}` },
        body: form,
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 500);
        req.log.warn({ provider: voice.provider, status: res.status, detail }, "voice transcribe failed");
        return reply.code(502).send({ error: `Transcription failed (${res.status})` });
      }
      const parsed = (await res.json()) as { text?: string };
      return { text: parsed.text ?? "" };
    },
  );

  app.post("/voice/speak", { preHandler: requireAuth }, async (req, reply) => {
    if (!req.userId) return reply.code(401).send({ error: "Unauthorized" });
    const body = speakBody.parse(req.body);
    const voice = await resolveVoiceConfig(req.userId);
    if (!voice) {
      return reply.code(503).send({
        error: "No voice-capable provider configured (needs an openai-compatible or openai key)",
      });
    }

    const res = await fetch(`${voice.baseURL}/audio/speech`, {
      method: "POST",
      headers: { Authorization: `Bearer ${voice.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: voice.ttsModel,
        voice: voice.ttsVoice,
        input: truncateForSpeech(body.text),
        response_format: voice.responseFormat,
      }),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 500);
      req.log.warn({ provider: voice.provider, status: res.status, detail }, "voice speak failed");
      return reply.code(502).send({ error: `Speech synthesis failed (${res.status})` });
    }
    return reply
      .header("content-type", `audio/${voice.responseFormat}`)
      .send(Buffer.from(await res.arrayBuffer()));
  });
}
