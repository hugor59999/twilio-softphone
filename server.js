require('dotenv').config();

const express = require('express');
const twilio = require('twilio');

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  YOUR_PHONE_NUMBER,
  PUBLIC_BASE_URL,
  PORT = 3000,
} = process.env;

console.log('PUBLIC_BASE_URL =', PUBLIC_BASE_URL);

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

app.get('/call', async (req, res) => {
  const to = req.query.to;

  if (!to) {
    return res.status(400).json({ success: false, error: 'Missing ?to=+33...' });
  }

  const baseUrl = (PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');

  if (!baseUrl) {
    return res.status(500).json({
      success: false,
      error: 'PUBLIC_BASE_URL missing in .env',
    });
  }

  try {
    const call = await client.calls.create({
      url: `${baseUrl}/voice?to=${encodeURIComponent(to)}`,
      to: YOUR_PHONE_NUMBER,
      from: TWILIO_PHONE_NUMBER,
      method: 'GET',
    });

    console.log('📞 Appel créé:', call.sid, '-> agent:', YOUR_PHONE_NUMBER, 'client:', to);

    res.json({ success: true, sid: call.sid, to });
  } catch (err) {
    console.error('🔥 ERROR /call:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.all('/voice', (req, res) => {
  try {
    let to = req.query.to || req.body.To;

    if (Array.isArray(to)) {
      to = to[0];
    }

    if (typeof to === 'string') {
      to = to.trim();
      if (!to.startsWith('+')) {
        to = '+' + to;
      }
    }

    console.log('➡️ Calling cleaned:', to);

    const twiml = new twilio.twiml.VoiceResponse();

    if (!to) {
      twiml.say('No number provided');
    } else {
      const dial = twiml.dial({
        callerId: TWILIO_PHONE_NUMBER,
      });
      dial.number(to);
    }

    res.type('text/xml');
    res.send(twiml.toString());
  } catch (err) {
    console.error('🔥 ERROR /voice:', err);
    res.type('text/xml');
    res.send('<Response><Say>Error</Say></Response>');
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});