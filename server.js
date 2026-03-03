require('dotenv').config();
const WebSocket = require('ws');
const Groq = require('groq-sdk');

const DEEPGRAM_KEY   = process.env.DEEPGRAM_KEY;
const GROQ_KEY       = process.env.GROQ_KEY;
const ELEVENLABS_KEY = process.env.ELEVENLABS_KEY;

if (!DEEPGRAM_KEY) console.warn("Warning: DEEPGRAM_KEY is not set.");
if (!GROQ_KEY) console.warn("Warning: GROQ_KEY is not set.");
if (!ELEVENLABS_KEY) console.warn("Warning: ELEVENLABS_KEY is not set.");

async function httpFetch(url, options) {
  if (typeof fetch === 'function') {
    return fetch(url, options);
  }
  const { default: fetchPolyfill } = await import('node-fetch');
  return fetchPolyfill(url, options);
}

const VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; 
const ELEVEN_OUTPUT_FORMAT = process.env.ELEVEN_OUTPUT_FORMAT || "mp3_22050_32";
const ELEVEN_OPTIMIZE = Number.isFinite(Number(process.env.ELEVEN_OPTIMIZE_STREAMING_LATENCY))
  ? Number(process.env.ELEVEN_OPTIMIZE_STREAMING_LATENCY)
  : 4; 
const TTS_CACHE_MAX = Number.isFinite(Number(process.env.TTS_CACHE_MAX)) ? Number(process.env.TTS_CACHE_MAX) : 50;

const ttsCache = new Map(); 
function ttsCacheGet(key) { return ttsCache.get(key); }
function ttsCacheSet(key, value) {
  ttsCache.set(key, value);
  if (ttsCache.size <= TTS_CACHE_MAX) return;
  const firstKey = ttsCache.keys().next().value;
  if (firstKey) ttsCache.delete(firstKey);
}

function nowMs() { return Number(process.hrtime.bigint() / 1000000n); }

function safeJsonSend(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

const groq = new Groq({ apiKey: GROQ_KEY });

// --- CLOUD PORT FIX ---
const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });
console.log(`Server running on port ${PORT}`);
// ----------------------

wss.on('connection', (ws) => {
    console.log("Browser connected");

    let targetLanguage = "Spanish";
    let isProcessing   = false;
    let sourceLanguage = "English";
    let dgConnection   = null;

    function langNameToCode(name) {
      switch (name) {
        case "English":   return "en";
        case "Spanish":   return "es";
        case "French":    return "fr";
        case "German":    return "de";
        case "Japanese":  return "ja";
        case "Hindi":     return "hi";
        case "Malayalam": return "ml";
        default:          return "en";
      }
    }

    function openDeepgramStream() {
      if (!DEEPGRAM_KEY) return;

      if (dgConnection && dgConnection.readyState === WebSocket.OPEN) {
        try { dgConnection.close(); } catch (_) {}
      }

      const langCode = langNameToCode(sourceLanguage);

      const dgUrl = new URL("wss://api.deepgram.com/v1/listen");
      dgUrl.searchParams.set("model", "nova-2");
      dgUrl.searchParams.set("language", langCode);
      dgUrl.searchParams.set("smart_format", "true");
      dgUrl.searchParams.set("endpointing", "150"); 
      dgUrl.searchParams.set("keepalive", "true");

      const conn = new WebSocket(dgUrl.toString(), {
        headers: { Authorization: `Token ${DEEPGRAM_KEY}` }
      });

      dgConnection = conn;

      conn.on('open', () => { console.log(`Deepgram open — start speaking (${langCode})`); });

      conn.on('message', async (message) => {
        let data;
        try { data = JSON.parse(message.toString()); } catch { return; }

        if (data.type !== 'Results') return;

        const transcript = data?.channel?.alternatives?.[0]?.transcript ?? "";
        if (!transcript || !data.is_final || isProcessing) return;

        isProcessing = true;
        const t0 = nowMs();
        console.log("Heard:", transcript);

        try {
          const tTranslateStart = nowMs();
          const groqRes = await groq.chat.completions.create({
            model:       "llama-3.1-8b-instant",
            temperature: 0,
            max_tokens:  80,
            messages: [
              {
                role: "system",
                content:
                  `You are a pure translation engine. ` +
                  `Translate the user's message from ${sourceLanguage} into ${targetLanguage}. ` +
                  `Always return ONLY the translated text in ${targetLanguage}, with no extra words, labels, explanations, or quotes. ` +
                  `If the user asks a question, DO NOT answer it; just translate the question itself.`
              },
              { role: "user",   content: transcript }
            ]
          });
          const translated = groqRes.choices?.[0]?.message?.content?.trim?.() || "";
          const tTranslateEnd = nowMs();
          console.log("Translated:", translated);

          safeJsonSend(ws, {
            type: "subtitle",
            source: transcript,
            translated,
            timing: { translate_ms: Math.max(0, tTranslateEnd - tTranslateStart) }
          });

          const tTtsStart = nowMs();
          const ttsText = translated || transcript;
          const cacheKey = `${VOICE_ID}|eleven_turbo_v2_5|${ELEVEN_OUTPUT_FORMAT}|${ELEVEN_OPTIMIZE}|${ttsText}`;
          const cached = ttsCacheGet(cacheKey);
          if (cached) {
            safeJsonSend(ws, { type: "audio_start", mime: "audio/mpeg", cached: true });
            ws.send(cached);
            safeJsonSend(ws, { type: "audio_end" });
          } else {
            const ttsUrl = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream?output_format=${encodeURIComponent(ELEVEN_OUTPUT_FORMAT)}&optimize_streaming_latency=${encodeURIComponent(String(ELEVEN_OPTIMIZE))}`;
            const ttsRes = await httpFetch(ttsUrl, {
                method:  'POST',
                headers: {
                    'xi-api-key':   ELEVENLABS_KEY,
                    'Content-Type': 'application/json',
                    'Accept':       'audio/mpeg'
                },
                body: JSON.stringify({
                    text:           ttsText,
                    model_id:       "eleven_turbo_v2_5",
                    voice_settings: { stability: 0.5, similarity_boost: 0.75, use_speaker_boost: false }
                })
            });

            if (!ttsRes.ok) {
                const errText = await ttsRes.text().catch(() => "");
                console.error("ElevenLabs error:", ttsRes.status, errText);
            } else {
                safeJsonSend(ws, { type: "audio_start", mime: "audio/mpeg", cached: false });

                const chunks = [];
                if (ttsRes.body && typeof ttsRes.body[Symbol.asyncIterator] === 'function') {
                  for await (const chunk of ttsRes.body) {
                    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                    chunks.push(buf);
                    if (ws.readyState === WebSocket.OPEN) ws.send(buf);
                  }
                } else {
                  const buf = Buffer.from(await ttsRes.arrayBuffer());
                  chunks.push(buf);
                  if (ws.readyState === WebSocket.OPEN) ws.send(buf);
                }

                safeJsonSend(ws, { type: "audio_end" });
                const audioAll = Buffer.concat(chunks);
                ttsCacheSet(cacheKey, audioAll);
            }
          }

          const tEnd = nowMs();
          safeJsonSend(ws, {
            type: "timing",
            timing: {
              translate_ms: Math.max(0, tTranslateEnd - tTranslateStart),
              tts_ms: Math.max(0, tEnd - tTtsStart),
              total_ms: Math.max(0, tEnd - t0)
            }
          });
          
        } catch (err) {
          console.error("Error in processing:", err);
        } finally {
          isProcessing = false;
        }
      });

      conn.on('error', (err) => console.error("Deepgram stream error:", err));
      conn.on('close', () => console.log("Deepgram stream closed"));
    }

    openDeepgramStream();

    ws.on('message', (data, isBinary) => {
        if (!isBinary) {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'config') {
                    if (typeof msg.targetLang === "string" && msg.targetLang) {
                      targetLanguage = msg.targetLang;
                    }
                    if (typeof msg.sourceLang === "string" && msg.sourceLang && msg.sourceLang !== sourceLanguage) {
                      sourceLanguage = msg.sourceLang;
                      openDeepgramStream();
                    }
                }
            } catch(_) {}
            return;
        }
        if (dgConnection && dgConnection.readyState === WebSocket.OPEN) {
          dgConnection.send(data);
        }
    });

    ws.on('close', () => {
        console.log("Browser disconnected");
        try { dgConnection.close(); } catch(_) {}
    });
});