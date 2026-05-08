require('dotenv').config();

const express = require('express');
const twilio  = require('twilio');
const { google } = require('googleapis');

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
  GOOGLE_CLIENT_EMAIL,
  GOOGLE_PRIVATE_KEY,
  GOOGLE_CALENDAR_ID,
  PORT = 3000,
} = process.env;

console.log('PUBLIC_BASE_URL =', PUBLIC_BASE_URL);

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ── Google Calendar ─────────────────────────────────────────
function getCalendar() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: GOOGLE_CLIENT_EMAIL,
      private_key: (GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  return google.calendar({ version: 'v3', auth });
}

// Parse "day" (YYYY-MM-DD | today | tomorrow | lundi…) + "time" (HH:MM | HH:MMh | H:MM AM/PM)
function parseDateTime(day, time) {
  const today = new Date();
  let date;

  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    date = new Date(day + 'T00:00:00');
  } else {
    const norm = day.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (norm === 'today' || norm === 'aujourd\'hui' || norm === 'aujourd hui') {
      date = new Date(today);
    } else if (norm === 'tomorrow' || norm === 'demain') {
      date = new Date(today);
      date.setDate(date.getDate() + 1);
    } else {
      const fr = ['dimanche','lundi','mardi','mercredi','jeudi','vendredi','samedi'];
      const en = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
      let idx = fr.indexOf(norm);
      if (idx === -1) idx = en.indexOf(norm);
      if (idx !== -1) {
        date = new Date(today);
        const diff = (idx - date.getDay() + 7) % 7 || 7;
        date.setDate(date.getDate() + diff);
      } else {
        date = new Date(day);           // last resort
      }
    }
  }

  // parse time
  let h = 9, m = 0;
  const t = time.trim();
  const hhmm    = t.match(/^(\d{1,2})[h:](\d{2})$/i);
  const ampm    = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);

  if (hhmm)  { h = +hhmm[1]; m = +hhmm[2]; }
  else if (ampm) {
    h = +ampm[1]; m = +ampm[2];
    if (ampm[3].toUpperCase() === 'PM' && h !== 12) h += 12;
    if (ampm[3].toUpperCase() === 'AM' && h === 12) h = 0;
  }

  date.setHours(h, m, 0, 0);
  return date;
}

// ── Existing Twilio routes ───────────────────────────────────
app.get('/call', async (req, res) => {
  const to = req.query.to;
  if (!to) return res.status(400).json({ success: false, error: 'Missing ?to=+33...' });

  const baseUrl = (PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (!baseUrl) return res.status(500).json({ success: false, error: 'PUBLIC_BASE_URL missing in .env' });

  try {
    const call = await twilioClient.calls.create({
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
    if (Array.isArray(to)) to = to[0];
    if (typeof to === 'string') {
      to = to.trim();
      if (!to.startsWith('+')) to = '+' + to;
    }
    console.log('➡️ Calling cleaned:', to);
    const twiml = new twilio.twiml.VoiceResponse();
    if (!to) { twiml.say('No number provided'); }
    else { const dial = twiml.dial({ callerId: TWILIO_PHONE_NUMBER }); dial.number(to); }
    res.type('text/xml');
    res.send(twiml.toString());
  } catch (err) {
    console.error('🔥 ERROR /voice:', err);
    res.type('text/xml');
    res.send('<Response><Say>Error</Say></Response>');
  }
});

// ── Google Calendar webhook ──────────────────────────────────
app.post('/webhook/schedule', async (req, res) => {
  const { day, time, prospect_name, prospect_phone } = req.body;

  if (!day || !time || !prospect_name || !prospect_phone) {
    return res.status(400).json({
      success: false,
      error: 'Champs requis manquants : day, time, prospect_name, prospect_phone',
    });
  }

  try {
    const start = parseDateTime(day, time);
    const end   = new Date(start.getTime() + 30 * 60 * 1000); // 30 min

    const event = {
      summary:     `RDV – ${prospect_name}`,
      description: `Appel de suivi cold calling\nProspect : ${prospect_name}\nTéléphone : ${prospect_phone}`,
      start: { dateTime: start.toISOString(), timeZone: 'Europe/Paris' },
      end:   { dateTime: end.toISOString(),   timeZone: 'Europe/Paris' },
      reminders: {
        useDefault: false,
        overrides: [{ method: 'popup', minutes: 10 }],
      },
    };

    const calendar  = getCalendar();
    const calId     = GOOGLE_CALENDAR_ID || 'primary';
    const { data }  = await calendar.events.insert({ calendarId: calId, requestBody: event });

    const dateStr = start.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    const timeStr = start.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

    console.log(`📅 RDV créé : ${event.summary} le ${dateStr} à ${timeStr} — ${data.htmlLink}`);

    res.json({
      success:    true,
      event_id:   data.id,
      event_link: data.htmlLink,
      summary:    event.summary,
      start:      start.toISOString(),
      message:    `RDV créé le ${dateStr} à ${timeStr} avec ${prospect_name}`,
    });
  } catch (err) {
    console.error('🔥 ERROR /webhook/schedule:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
