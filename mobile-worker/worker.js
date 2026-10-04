import { YoutubeTranscript } from "youtube-transcript";

// Mobile-friendly, non-MCP Cloudflare Worker
// Endpoint: GET /translate?url=<youtube_url>&source_language=<lang>

const TRANSLATION_MODEL = "@cf/meta/m2m100-1.2b";
const TRANSLATION_CONCURRENCY = 4;
const CHUNK_SIZE = 500;

const LANGUAGE_ALIASES = {
  auto: "auto",
  english: "en",
  en: "en",
  hindi: "hi",
  hi: "hi",
  spanish: "es",
  es: "es",
};

function normalizeLanguageCode(language) {
  if (language == null) return "auto";
  const normalized = String(language).trim().toLowerCase();
  if (!normalized) return "auto";
  return LANGUAGE_ALIASES[normalized] ?? normalized;
}

function extractVideoId(input) {
  try {
    const url = new URL(input);
    if (url.hostname === "youtu.be") return url.pathname.slice(1).split("/")[0];
    if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname)) {
      if (url.pathname === "/watch") return url.searchParams.get("v");
      if (url.pathname.startsWith("/live/")) return url.pathname.split("/")[2];
      if (url.pathname.startsWith("/shorts/")) return url.pathname.split("/")[2];
      if (url.pathname.startsWith("/embed/")) return url.pathname.split("/")[2];
    }
    return null;
  } catch {
    return null;
  }
}

function splitIntoChunks(text, chunkSize = CHUNK_SIZE) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  for (let i = 0; i < words.length; i += chunkSize) {
    chunks.push(words.slice(i, i + chunkSize).join(" "));
  }
  return chunks;
}

async function translateChunk(env, text, sourceLang = "auto") {
  const sourceLanguage = normalizeLanguageCode(sourceLang);
  const targetLanguage = "en";
  if (sourceLanguage === "auto") {
    throw new Error("Source language required for translation (use source_language or let detection run).");
  }
  if (sourceLanguage === targetLanguage) return text;
  const response = await env.AI.run(TRANSLATION_MODEL, {
    text,
    source_lang: sourceLanguage,
    target_lang: targetLanguage,
  });
  if (!response) throw new Error("Translation model returned no response.");
  if (typeof response.translated_text === "string") return response.translated_text;
  if (response.result && typeof response.result.translated_text === "string") return response.result.translated_text;
  throw new Error("Translation response did not contain translated_text.");
}

async function translateInParallel(env, chunks, sourceLang = "auto") {
  const results = new Array(chunks.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= chunks.length) return;
      try {
        results[index] = await translateChunk(env, chunks[index], sourceLang);
      } catch (error) {
        results[index] = `[Translation failed for chunk ${index + 1}: ${error?.message || String(error)}]`;
      }
    }
  }
  const workerCount = Math.min(TRANSLATION_CONCURRENCY, chunks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function getYouTubeTranscript(videoId, preferredSourceLanguage = "auto") {
  const normalizedPreferredLanguage = normalizeLanguageCode(preferredSourceLanguage);
  const transcript = await YoutubeTranscript.fetchTranscript(
    videoId,
    normalizedPreferredLanguage !== "auto" ? { lang: normalizedPreferredLanguage } : undefined
  );
  const detectedLanguage = transcript.find((s) => s.lang)?.lang ?? (normalizedPreferredLanguage !== "auto" ? normalizedPreferredLanguage : "en");
  const text = transcript.map((segment) => segment.text).join(" ");
  return { text, segments: transcript, detectedLanguage };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/translate") {
      const videoUrl = url.searchParams.get("url");
      const source_language = url.searchParams.get("source_language") || "auto";
      if (!videoUrl) return new Response(JSON.stringify({ error: "missing url parameter" }), { status: 400, headers: { "Content-Type": "application/json" } });
      const videoId = extractVideoId(videoUrl);
      if (!videoId) return new Response(JSON.stringify({ error: "invalid_youtube_url" }), { status: 400, headers: { "Content-Type": "application/json" } });

      try {
        const result = await getYouTubeTranscript(videoId, source_language);
        const detectedLanguage = normalizeLanguageCode(result.detectedLanguage || source_language);
        const chunks = splitIntoChunks(result.text);
        const translatedChunks = await translateInParallel(env, chunks, detectedLanguage);
        const translatedText = translatedChunks.join("\n\n");
        return new Response(JSON.stringify({
          video_id: videoId,
          original_transcript: result.text,
          source_language: detectedLanguage,
          translated_to: "en",
          translated_transcript: translatedText,
          translation_chunks: translatedChunks.length,
        }, null, 2), { status: 200, headers: { "Content-Type": "application/json" } });
      } catch (err) {
        return new Response(JSON.stringify({ error: String(err?.message || err) }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    return new Response(JSON.stringify({ service: "youtube-transcript-translator-mobile", status: "ok" }), { headers: { "Content-Type": "application/json" } });
  }
};
