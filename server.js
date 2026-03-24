const express = require('express');
const Groq = require('groq-sdk');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
function getTelnyxApiKey() {
  return process.env.TELNYX_API_KEY;
}
const TELNYX_API_BASE = 'https://api.telnyx.com/v2';

// Groq client (lazy init — env vars may not be set at import time locally)
let groq;
function getGroq() {
  if (!groq) {
    groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return groq;
}

// Voice config — AWS Polly Tatyana for Russian
const VOICE = 'female';
const LANGUAGE = 'ru-RU';

const SYSTEM_PROMPT = 'Ты Валентин Музыченко. Ты звонишь Арсену (Сене), который работает в CryptoDep. Представься как Валентин Музыченко. Спроси что Сеня сделал сегодня по CryptoDep и какие топ новости были. Веди диалог вежливо, по-русски. Отвечай коротко, максимум 2-3 предложения. Не используй markdown, списки или специальное форматирование — ты разговариваешь по телефону.';

// In-memory conversation state per call
const conversations = new Map();

// Cleanup old conversations after 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [callId, data] of conversations) {
    if (now - data.lastUpdate > 30 * 60 * 1000) {
      conversations.delete(callId);
    }
  }
}, 5 * 60 * 1000);

// ─── Telnyx API helper ───
async function telnyxCommand(callControlId, action, body = {}) {
  const url = `${TELNYX_API_BASE}/calls/${callControlId}/actions/${action}`;
  console.log(`[${ts()}] → Telnyx ${action} for ${callControlId.slice(0, 20)}...`, JSON.stringify(body).slice(0, 200));

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${getTelnyxApiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }

  if (!res.ok) {
    console.error(`[${ts()}] ✗ Telnyx ${action} failed (${res.status}):`, typeof data === 'string' ? data : JSON.stringify(data));
  } else {
    console.log(`[${ts()}] ✓ Telnyx ${action} OK (${res.status})`);
  }
  return { ok: res.ok, status: res.status, data };
}

function ts() {
  return new Date().toISOString();
}

// ─── Speak text on call ───
async function speak(callControlId, text) {
  return telnyxCommand(callControlId, 'speak', {
    payload: text,
    voice: VOICE,
    language: LANGUAGE,
    command_id: crypto.randomUUID(),
  });
}

// ─── Start transcription (STT) ───
async function startTranscription(callControlId) {
  return telnyxCommand(callControlId, 'transcription_start', {
    language: 'ru',
    command_id: crypto.randomUUID(),
    transcription_engine: 'Google',
    interim_results: false,
  });
}

// ─── Stop transcription ───
async function stopTranscription(callControlId) {
  return telnyxCommand(callControlId, 'transcription_stop', {
    command_id: crypto.randomUUID(),
  });
}

// ─── Answer incoming call ───
async function answerCall(callControlId) {
  return telnyxCommand(callControlId, 'answer', {
    command_id: crypto.randomUUID(),
  });
}

// ─── Get or create conversation ───
function getConv(callControlId) {
  let conv = conversations.get(callControlId);
  if (!conv) {
    conv = {
      messages: [],
      lastUpdate: Date.now(),
      transcriptionStarted: false,
      speaking: false,
      pendingTranscript: null,
    };
    conversations.set(callControlId, conv);
  }
  conv.lastUpdate = Date.now();
  return conv;
}

// ─── Process user speech with Groq LLM ───
async function processWithLLM(callControlId, userText) {
  const conv = getConv(callControlId);

  conv.messages.push({ role: 'user', content: userText });

  // Keep history manageable
  if (conv.messages.length > 20) {
    conv.messages = conv.messages.slice(-20);
  }

  try {
    const response = await getGroq().chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 200,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...conv.messages,
      ],
    });

    const assistantMessage = response.choices[0].message.content;
    console.log(`[${ts()}] Groq response: "${assistantMessage}"`);

    conv.messages.push({ role: 'assistant', content: assistantMessage });
    conv.speaking = true;

    // Stop transcription while speaking to avoid echo
    await stopTranscription(callControlId);
    conv.transcriptionStarted = false;

    // Speak the response
    await speak(callControlId, assistantMessage);
  } catch (error) {
    console.error(`[${ts()}] Groq API error:`, error.message);
    conv.speaking = true;
    await speak(callControlId, 'Произошла ошибка. Попробуй ещё раз.');
  }
}

// ─── Health check ───
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'voice-agent-telnyx', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({ service: 'voice-agent', engine: 'telnyx-call-control', status: 'running' });
});

// ─── Main webhook handler ───
app.post('/webhook', async (req, res) => {
  // Immediately respond 200 to Telnyx
  res.sendStatus(200);

  const event = req.body?.data;
  if (!event) {
    console.log(`[${ts()}] Webhook received with no data`);
    return;
  }

  const eventType = event.event_type;
  const payload = event.payload || {};
  const callControlId = payload.call_control_id;

  console.log(`[${ts()}] ← Webhook: ${eventType} | call_control_id: ${callControlId?.slice(0, 20)}... | direction: ${payload.direction || 'n/a'}`);

  if (!callControlId) {
    console.log(`[${ts()}] No call_control_id in event, skipping`);
    return;
  }

  try {
    switch (eventType) {
      case 'call.initiated': {
        const conv = getConv(callControlId);
        if (payload.direction === 'incoming') {
          // Answer incoming calls
          console.log(`[${ts()}] Incoming call from ${payload.from}, answering...`);
          await answerCall(callControlId);
        } else {
          // Outbound call — wait for answered
          console.log(`[${ts()}] Outbound call to ${payload.to}, waiting for answer...`);
        }
        break;
      }

      case 'call.answered': {
        console.log(`[${ts()}] Call answered, starting greeting...`);
        const conv = getConv(callControlId);
        conv.speaking = true;
        // Greet the user
        await speak(callControlId, 'Алло, добрый день! Это Валентин Музыченко. Сеня, привет!');
        break;
      }

      case 'call.speak.started': {
        console.log(`[${ts()}] Speak started`);
        break;
      }

      case 'call.speak.ended': {
        console.log(`[${ts()}] Speak ended, starting transcription (listening)...`);
        const conv = getConv(callControlId);
        conv.speaking = false;

        // If there was a pending transcript while we were speaking, process it
        if (conv.pendingTranscript) {
          const pending = conv.pendingTranscript;
          conv.pendingTranscript = null;
          console.log(`[${ts()}] Processing pending transcript: "${pending}"`);
          await processWithLLM(callControlId, pending);
        } else {
          // Start listening
          if (!conv.transcriptionStarted) {
            await startTranscription(callControlId);
            conv.transcriptionStarted = true;
          }
        }
        break;
      }

      case 'call.transcription': {
        const transcriptionData = payload.transcription_data;
        if (!transcriptionData) break;

        const transcript = transcriptionData.transcript;
        const isFinal = transcriptionData.is_final;
        const confidence = transcriptionData.confidence;

        console.log(`[${ts()}] Transcription: "${transcript}" (final: ${isFinal}, confidence: ${confidence})`);

        if (isFinal && transcript && transcript.trim().length > 0) {
          const conv = getConv(callControlId);

          if (conv.speaking) {
            // We're currently speaking, queue the transcript
            console.log(`[${ts()}] Currently speaking, queuing transcript`);
            conv.pendingTranscript = transcript.trim();
          } else {
            // Process immediately
            await processWithLLM(callControlId, transcript.trim());
          }
        }
        break;
      }

      case 'call.hangup': {
        console.log(`[${ts()}] Call ended (hangup). Reason: ${payload.hangup_cause || 'unknown'}`);
        conversations.delete(callControlId);
        break;
      }

      // Gather events (fallback if gather_using_speak is used)
      case 'call.gather.ended': {
        const digits = payload.digits;
        console.log(`[${ts()}] Gather ended. Digits: ${digits}`);
        break;
      }

      default:
        console.log(`[${ts()}] Unhandled event: ${eventType}`);
    }
  } catch (err) {
    console.error(`[${ts()}] Error handling ${eventType}:`, err.message);
  }
});

// Also handle POST to root (some Telnyx configs send to /)
app.post('/', async (req, res) => {
  // Forward to webhook handler
  req.url = '/webhook';
  app.handle(req, res);
});

// Status callback (legacy compatibility)
app.post('/status', (req, res) => {
  console.log(`[${ts()}] Status callback:`, JSON.stringify(req.body).slice(0, 200));
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Voice Agent (Telnyx Call Control) running on port ${PORT}`);
  console.log(`TELNYX_API_KEY: ${getTelnyxApiKey() ? 'set (' + getTelnyxApiKey().slice(0, 15) + '...)' : 'NOT SET'}`);
  console.log(`GROQ_API_KEY: ${process.env.GROQ_API_KEY ? 'set (' + process.env.GROQ_API_KEY.slice(0, 10) + '...)' : 'NOT SET'}`);
  console.log(`Webhook URL: POST /webhook`);
});
