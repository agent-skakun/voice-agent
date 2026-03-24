const express = require('express');
const Groq = require('groq-sdk');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Groq client
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// In-memory conversation history per call
const conversations = new Map();

// Cleanup old conversations after 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [callSid, data] of conversations) {
    if (now - data.lastUpdate > 30 * 60 * 1000) {
      conversations.delete(callSid);
    }
  }
}, 5 * 60 * 1000);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'voice-agent', timestamp: new Date().toISOString() });
});

// Root
app.get('/', (req, res) => {
  res.json({ service: 'voice-agent', status: 'running' });
});

// Twilio webhook — incoming call
app.post('/voice', (req, res) => {
  const callSid = req.body.CallSid;
  console.log(`[${new Date().toISOString()}] Incoming call: ${callSid} from ${req.body.From}`);

  // Initialize conversation
  conversations.set(callSid, {
    messages: [],
    lastUpdate: Date.now(),
  });

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: 'Polly.Tatyana', language: 'ru-RU' },
    'Привет! Это BigBoss. Слушаю тебя.'
  );

  const gather = twiml.gather({
    input: 'speech',
    action: '/gather',
    method: 'POST',
    speechTimeout: 'auto',
    language: 'ru-RU',
  });
  gather.say({ voice: 'Polly.Tatyana' }, '');

  // If no input, prompt again
  twiml.say({ voice: 'Polly.Tatyana' }, 'Не слышу тебя. Попробуй ещё раз.');
  twiml.redirect('/voice');

  res.type('text/xml');
  res.send(twiml.toString());
});

// Gather callback — process speech
app.post('/gather', async (req, res) => {
  const callSid = req.body.CallSid;
  const speechResult = req.body.SpeechResult;
  const confidence = req.body.Confidence;

  console.log(`[${new Date().toISOString()}] Speech from ${callSid}: "${speechResult}" (confidence: ${confidence})`);

  if (!speechResult) {
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say({ voice: 'Polly.Joanna' }, 'I couldn\'t understand that. Could you please repeat?');
    twiml.redirect('/voice');
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // Get or create conversation
  let conv = conversations.get(callSid);
  if (!conv) {
    conv = { messages: [], lastUpdate: Date.now() };
    conversations.set(callSid, conv);
  }

  // Add user message
  conv.messages.push({ role: 'user', content: speechResult });
  conv.lastUpdate = Date.now();

  try {
    // Call Groq (LLaMA)
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 200,
      messages: [
        { role: 'system', content: 'Ты BigBoss — голосовой AI ассистент SKAKUN. Отвечай коротко, максимум 2-3 предложения. Ты разговариваешь по телефону — будь естественным и лаконичным. Отвечай на русском языке. Не используй markdown, списки или специальное форматирование.' },
        ...conv.messages,
      ],
    });

    const assistantMessage = response.choices[0].message.content;
    console.log(`[${new Date().toISOString()}] Groq response for ${callSid}: "${assistantMessage}"`);

    // Add assistant message to history
    conv.messages.push({ role: 'assistant', content: assistantMessage });

    // Keep conversation history manageable (last 10 exchanges)
    if (conv.messages.length > 20) {
      conv.messages = conv.messages.slice(-20);
    }

    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say({ voice: 'Polly.Tatyana', language: 'ru-RU' }, assistantMessage);

    const gather = twiml.gather({
      input: 'speech',
      action: '/gather',
      method: 'POST',
      speechTimeout: 'auto',
      language: 'ru-RU',
    });
    gather.say({ voice: 'Polly.Tatyana' }, '');

    // If no input after response
    twiml.say({ voice: 'Polly.Tatyana' }, 'Ты ещё здесь?');
    twiml.redirect('/voice');

    res.type('text/xml');
    res.send(twiml.toString());
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Groq API error:`, error.message);

    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say({ voice: 'Polly.Joanna' },
      'I\'m sorry, I encountered an error processing your request. Let me try again.'
    );
    twiml.redirect('/voice');
    res.type('text/xml');
    res.send(twiml.toString());
  }
});

// Call status callback
app.post('/status', (req, res) => {
  const callSid = req.body.CallSid;
  const status = req.body.CallStatus;
  console.log(`[${new Date().toISOString()}] Call ${callSid} status: ${status}`);

  if (status === 'completed' || status === 'failed' || status === 'canceled') {
    conversations.delete(callSid);
  }
  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Voice Agent server running on port ${PORT}`);
  console.log(`GROQ_API_KEY: ${process.env.GROQ_API_KEY ? 'set (' + process.env.GROQ_API_KEY.slice(0, 10) + '...)' : 'NOT SET'}`);
});
