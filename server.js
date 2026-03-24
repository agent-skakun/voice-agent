const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Anthropic client
const anthropic = new Anthropic.default({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

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
  twiml.say({ voice: 'Polly.Joanna', language: 'en-US' },
    'Hello! I am your AI assistant powered by Claude. How can I help you today?'
  );

  const gather = twiml.gather({
    input: 'speech',
    action: '/gather',
    method: 'POST',
    speechTimeout: 'auto',
    language: 'en-US',
  });
  gather.say({ voice: 'Polly.Joanna' }, '');

  // If no input, prompt again
  twiml.say({ voice: 'Polly.Joanna' }, 'I didn\'t hear anything. Please try again.');
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
    // Call Claude
    const response = await anthropic.messages.create({
      model: 'claude-haiku-3-5',
      max_tokens: 300,
      system: 'You are a helpful voice assistant. Keep responses concise and conversational — under 3 sentences. You are speaking on a phone call, so be natural and brief. Do not use markdown, lists, or special formatting.',
      messages: conv.messages,
    });

    const assistantMessage = response.content[0].text;
    console.log(`[${new Date().toISOString()}] Claude response for ${callSid}: "${assistantMessage}"`);

    // Add assistant message to history
    conv.messages.push({ role: 'assistant', content: assistantMessage });

    // Keep conversation history manageable (last 10 exchanges)
    if (conv.messages.length > 20) {
      conv.messages = conv.messages.slice(-20);
    }

    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say({ voice: 'Polly.Joanna', language: 'en-US' }, assistantMessage);

    const gather = twiml.gather({
      input: 'speech',
      action: '/gather',
      method: 'POST',
      speechTimeout: 'auto',
      language: 'en-US',
    });
    gather.say({ voice: 'Polly.Joanna' }, '');

    // If no input after response
    twiml.say({ voice: 'Polly.Joanna' }, 'Are you still there?');
    twiml.redirect('/voice');

    res.type('text/xml');
    res.send(twiml.toString());
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Claude API error:`, error.message);

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
  console.log(`ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? 'set (' + process.env.ANTHROPIC_API_KEY.slice(0, 10) + '...)' : 'NOT SET'}`);
});
