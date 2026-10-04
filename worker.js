import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { YoutubeTranscript } from "youtube-transcript";
import { z } from "zod";

/*
 * ============================================================
 * CONFIGURATION
 * ============================================================
 */

const TRANSLATION_MODEL = "@cf/meta/m2m100-1.2b";

// Number of translation requests running simultaneously.
// Increase carefully if you want more speed.
const TRANSLATION_CONCURRENCY = 4;

// Approximate words per translation chunk.
const CHUNK_SIZE = 500;

// Common aliases for language names and ISO codes accepted by the model.
const LANGUAGE_ALIASES = {
  auto: "auto",
  english: "en",
  en: "en",
  hindi: "hi",
  hi: "hi",
  spanish: "es",
  es: "es",
  french: "fr",
  fr: "fr",
  german: "de",
  de: "de",
  italian: "it",
  it: "it",
  portuguese: "pt",
  pt: "pt",
  japanese: "ja",
  ja: "ja",
  korean: "ko",
  ko: "ko",
  chinese: "zh",
  zh: "zh",
  arabic: "ar",
  ar: "ar",
  russian: "ru",
  ru: "ru",
  turkish: "tr",
  tr: "tr",
  dutch: "nl",
  nl: "nl",
  polish: "pl",
  pl: "pl",
  ukrainian: "uk",
  uk: "uk",
  swedish: "sv",
  sv: "sv",
  vietnamese: "vi",
  vi: "vi",
  thai: "th",
  th: "th",
  indonesian: "id",
  id: "id",
  hebrew: "he",
  he: "he",
  norwegian: "no",
  no: "no",
  danish: "da",
  da: "da",
  finnish: "fi",
  fi: "fi",
  greek: "el",
  el: "el",
  czech: "cs",
  cs: "cs",
  romanian: "ro",
  ro: "ro",
};

function normalizeLanguageCode(language) {
  if (language == null) {
    return "auto";
  }

  const normalized = String(language).trim().toLowerCase();

  if (!normalized) {
    return "auto";
  }

  return LANGUAGE_ALIASES[normalized] ?? normalized;
}


/*
 * ============================================================
 * YOUTUBE URL → VIDEO ID
 * ============================================================
 */

function extractVideoId(input) {
  try {
    const url = new URL(input);

    // https://youtu.be/VIDEO_ID
    if (url.hostname === "youtu.be") {
      return url.pathname.slice(1).split("/")[0];
    }

    if (
      url.hostname === "youtube.com" ||
      url.hostname === "www.youtube.com" ||
      url.hostname === "m.youtube.com"
    ) {
      // https://www.youtube.com/watch?v=VIDEO_ID
      if (url.pathname === "/watch") {
        return url.searchParams.get("v");
      }

      // https://www.youtube.com/live/VIDEO_ID
      if (url.pathname.startsWith("/live/")) {
        return url.pathname.split("/")[2];
      }

      // https://www.youtube.com/shorts/VIDEO_ID
      if (url.pathname.startsWith("/shorts/")) {
        return url.pathname.split("/")[2];
      }

      // https://www.youtube.com/embed/VIDEO_ID
      if (url.pathname.startsWith("/embed/")) {
        return url.pathname.split("/")[2];
      }
    }

    return null;
  } catch {
    return null;
  }
}


/*
 * ============================================================
 * SPLIT TEXT INTO CHUNKS
 * ============================================================
 */

function splitIntoChunks(text, chunkSize = CHUNK_SIZE) {
  const words = text.split(/\s+/).filter(Boolean);

  const chunks = [];

  for (let i = 0; i < words.length; i += chunkSize) {
    chunks.push(
      words.slice(i, i + chunkSize).join(" ")
    );
  }

  return chunks;
}


/*
 * ============================================================
 * TRANSLATE ONE CHUNK
 * ============================================================
 */

async function translateChunk(env, text, sourceLang = "auto") {
  const sourceLanguage = normalizeLanguageCode(sourceLang);
  const targetLanguage = "en";

  if (sourceLanguage === "auto") {
    throw new Error(
      "A transcript source language is required for translation. " +
      "Pass a language code or let the transcript metadata detect it."
    );
  }

  if (sourceLanguage === targetLanguage) {
    return text;
  }

  const response = await env.AI.run(
    TRANSLATION_MODEL,
    {
      text,
      source_lang: sourceLanguage,
      target_lang: targetLanguage,
    }
  );

  if (!response) {
    throw new Error("Translation model returned no response.");
  }

  if (typeof response.translated_text === "string") {
    return response.translated_text;
  }

  /*
   * Defensive handling in case the response
   * structure changes.
   */

  if (
    response.result &&
    typeof response.result.translated_text === "string"
  ) {
    return response.result.translated_text;
  }

  throw new Error(
    "Translation response did not contain translated_text."
  );
}


/*
 * ============================================================
 * PARALLEL CHUNK TRANSLATION
 * ============================================================
 */

async function translateInParallel(
  env,
  chunks,
  sourceLang = "auto"
) {
  const results = new Array(chunks.length);

  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;

      if (index >= chunks.length) {
        return;
      }

      try {
        results[index] = await translateChunk(
          env,
          chunks[index],
          sourceLang
        );
      } catch (error) {
        results[index] =
          `[Translation failed for chunk ${index + 1}: ${
            error?.message || String(error)
          }]`;
      }
    }
  }

  const workerCount = Math.min(
    TRANSLATION_CONCURRENCY,
    chunks.length
  );

  await Promise.all(
    Array.from(
      { length: workerCount },
      () => worker()
    )
  );

  return results;
}


/*
 * ============================================================
 * GET YOUTUBE TRANSCRIPT
 * ============================================================
 */

async function getYouTubeTranscript(videoId, preferredSourceLanguage = "auto") {
  const normalizedPreferredLanguage = normalizeLanguageCode(preferredSourceLanguage);

  const transcript = await YoutubeTranscript.fetchTranscript(
    videoId,
    normalizedPreferredLanguage !== "auto"
      ? { lang: normalizedPreferredLanguage }
      : undefined
  );

  const detectedLanguage =
    transcript.find((segment) => segment.lang)?.lang ??
    normalizedPreferredLanguage !== "auto"
      ? normalizedPreferredLanguage
      : "en";

  const text = transcript
    .map((segment) => segment.text)
    .join(" ");

  const words = text
    .split(/\s+/)
    .filter(Boolean);

  const paragraphs = [];

  for (let i = 0; i < words.length; i += 100) {
    paragraphs.push(
      words.slice(i, i + 100).join(" ")
    );
  }

  return {
    text,
    paragraphs,
    segments: transcript,
    detectedLanguage,
  };
}


/*
 * ============================================================
 * MCP SERVER
 * ============================================================
 */

function createServer(env) {
  const server = new McpServer({
    name: "youtube-transcript-translator",
    version: "1.0.0",
  });


  /*
   * ----------------------------------------------------------
   * YOUTUBE TRANSCRIPT TOOL
   * ----------------------------------------------------------
   */

  server.tool(
    "youtube_transcript",
    "Get the existing YouTube captions and translate them to English.",
    {
      url: z
        .string()
        .url()
        .describe("YouTube video URL"),

      source_language: z
        .string()
        .optional()
        .default("auto")
        .describe(
          "Source language for translation, e.g. auto, en, hi, es, fr. " +
          "Use auto to detect the caption language from the video transcript."
        ),
    },

    async ({
      url,
      source_language,
    }) => {

      /*
       * Extract video ID
       */

      const videoId =
        extractVideoId(url);

      if (!videoId) {
        return {
          isError: true,

          content: [
            {
              type: "text",

              text: JSON.stringify(
                {
                  error: "INVALID_YOUTUBE_URL",
                  message:
                    "Could not extract a YouTube video ID.",
                  url,
                },
                null,
                2
              ),
            },
          ],
        };
      }


      try {

        /*
         * ----------------------------------------------------
         * STEP 1 — GET EXISTING YOUTUBE CAPTIONS
         * ----------------------------------------------------
         */

        const result =
          await getYouTubeTranscript(
            videoId,
            source_language
          );

        const detectedLanguage =
          normalizeLanguageCode(
            result.detectedLanguage || source_language
          );

        /*
         * ----------------------------------------------------
         * STEP 2 — SPLIT INTO TRANSLATION CHUNKS
         * ----------------------------------------------------
         */

        const chunks =
          splitIntoChunks(result.text);


        /*
         * ----------------------------------------------------
         * STEP 3 — TRANSLATE CHUNKS IN PARALLEL
         * ----------------------------------------------------
         */

        const translatedChunks =
          await translateInParallel(
            env,
            chunks,
            detectedLanguage
          );


        /*
         * ----------------------------------------------------
         * STEP 4 — JOIN TRANSLATED CHUNKS
         * ----------------------------------------------------
         */

        const translatedText =
          translatedChunks.join("\n\n");


        /*
         * ----------------------------------------------------
         * RETURN RESULT
         * ----------------------------------------------------
         */

        return {
          content: [
            {
              type: "text",

              text: JSON.stringify(
                {
                  video_id: videoId,

                  original_transcript:
                    result.text,

                  source_language:
                    detectedLanguage,

                  translated_to:
                    "en",

                  translated_transcript:
                    translatedText,

                  translation_chunks:
                    translatedChunks.length,

                  paragraphs:
                    result.paragraphs,

                  segments:
                    result.segments,
                },
                null,
                2
              ),
            },
          ],
        };

      } catch (error) {

        return {
          isError: true,

          content: [
            {
              type: "text",

              text: JSON.stringify(
                {
                  error:
                    "TRANSCRIPT_OR_TRANSLATION_FAILED",

                  video_id:
                    videoId,

                  message:
                    error?.message ||
                    String(error),
                },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );


  return server;
}


/*
 * ============================================================
 * CLOUDFLARE WORKER
 * ============================================================
 */

export default {
  fetch(request, env, ctx) {

    const url =
      new URL(request.url);

    if (url.pathname === "/mcp") {

      return createMcpHandler(
        createServer(env)
      )(
        request,
        env,
        ctx
      );
    }


    return Response.json({
      service:
        "youtube-transcript-translator",

      status:
        "ok",
    });
  },
};