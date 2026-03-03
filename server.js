require('dotenv').config();
const WebSocket = require('ws');
const Groq = require('groq-sdk');

const DEEPGRAM_KEY   = process.env.DEEPGRAM_KEY;
const GROQ_KEY       = process.env.GROQ_KEY;

if (!DEEPGRAM_KEY) console.warn("Warning: DEEPGRAM_KEY is not set.");
if (!GROQ_KEY) console.warn("Warning: GROQ_KEY is not set.");

function nowMs() { return Number(process.hrtime.bigint() / 1000000n); }

function safeJsonSend(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

const groq = new Groq({ apiKey: GROQ_KEY });

// Render uses port 10000 by default, so we prioritize that
const PORT = process.env.PORT || 10000;
const wss = new WebSocket.Server({ port: PORT });
console.log(`Server running on port ${PORT}`);

wss.on('connection', (ws) => {
    console.log("Browser connected");

    let targetLanguage = "Spanish";
    let sourceLanguage = "English";
    let isProcessing   = false;
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

      conn.on('open', () => { 
        console.log(`Deepgram open — listening for ${sourceLanguage} (${langCode})`); 
      });

      conn.on('message', async (message) => {
        let data;
        try { data = JSON.parse(message.toString()); } catch { return; }

        if (data.type !== 'Results') return;

        const transcript = data?.channel?.alternatives?.[0]?.transcript ?? "";
        if (!transcript || !data.is_final || isProcessing) return;

        isProcessing = true;
        console.log(`Heard (${sourceLanguage}):`, transcript);

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
                  `You are a translator. ` +
                  `Translate from ${sourceLanguage} into ${targetLanguage}. ` +
                  `Return ONLY the translated text in ${targetLanguage}. No explanations.`
              },
              { role: "user", content: transcript }
            ]
          });
          
          const translated = groqRes.choices?.[0]?.message?.content?.trim?.() || "";
          const tTranslateEnd = nowMs();
          console.log(`Translated to ${targetLanguage}:`, translated);

          safeJsonSend(ws, {
            type: "subtitle",
            source: transcript,
            translated,
            timing: { translate_ms: Math.max(0, tTranslateEnd - tTranslateStart) }
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
                    const oldSource = sourceLanguage;
                    targetLanguage = msg.targetLang || targetLanguage;
                    sourceLanguage = msg.sourceLang || sourceLanguage;
                    
                    // Restart Deepgram only if the user changed the input language
                    if (sourceLanguage !== oldSource) {
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
