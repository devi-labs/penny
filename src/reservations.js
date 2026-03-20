'use strict';

// ── Parsing ──────────────────────────────────────────────────────

async function parseReservationRequest(anthropic, model, text) {
  const today = new Date().toISOString().slice(0, 10);
  const dayOfWeek = new Date().toLocaleDateString('en-US', { weekday: 'long' });

  const resp = await anthropic.messages.create({
    model,
    max_tokens: 300,
    system:
      'Extract reservation details from the user message. ' +
      `Today is ${dayOfWeek}, ${today}. ` +
      'Return ONLY valid JSON with these fields: ' +
      '{"restaurant": string, "city": string or null, "date": "YYYY-MM-DD", "time": "HH:MM" (24h), "partySize": number, "phone": string or null}. ' +
      'If the user included a phone number, extract it into "phone". ' +
      'If a field is missing, set it to null. Resolve relative dates (tomorrow, Saturday, next Friday, etc.) to actual dates.',
    messages: [{ role: 'user', content: text }],
  });

  let raw = resp.content?.find(c => c.type === 'text')?.text?.trim() || '';
  // Strip markdown code fences if Claude wraps the JSON
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('[reservations] JSON parse failed:', raw.slice(0, 300));
    return null;
  }
}

// ── OpenTable link (no-call fallback) ────────────────────────────

function buildOpenTableUrl({ restaurant, city, date, time, partySize }) {
  const dateTime = `${date}T${time}`;
  const covers = partySize || 2;
  const term = [restaurant, city].filter(Boolean).join(' ');
  return `https://www.opentable.com/s?dateTime=${encodeURIComponent(dateTime)}&covers=${covers}&term=${encodeURIComponent(term)}`;
}

function buildGoogleMapsUrl({ restaurant, city }) {
  const query = [restaurant, city].filter(Boolean).join(', ');
  return `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
}

function formatReservationReply(details, openTableUrl, mapsUrl) {
  const lines = [
    '🍽️ Here\'s your reservation link:',
    '',
    `📍 ${details.restaurant}${details.city ? ` — ${details.city}` : ''}`,
    `📅 ${details.date} at ${details.time}`,
    `👥 Party of ${details.partySize || 2}`,
    '',
    `🔗 Book on OpenTable:\n${openTableUrl}`,
    '',
    `📍 Google Maps:\n${mapsUrl}`,
  ];
  return lines.join('\n');
}

// ── Phone number lookup via Google Places ────────────────────────

async function lookupRestaurantPhone(placesApiKey, restaurant, city) {
  if (!placesApiKey) return null;

  try {
    const query = [restaurant, city, 'restaurant'].filter(Boolean).join(' ');
    const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': placesApiKey,
        'X-Goog-FieldMask': 'places.displayName,places.nationalPhoneNumber,places.formattedAddress',
      },
      body: JSON.stringify({ textQuery: query }),
    });

    if (!resp.ok) return null;
    const data = await resp.json();
    const place = data.places?.[0];
    if (!place?.nationalPhoneNumber) return null;

    return {
      phone: place.nationalPhoneNumber,
      name: place.displayName?.text || restaurant,
      address: place.formattedAddress || '',
    };
  } catch (err) {
    console.error('[reservations] Places lookup error:', err?.message || err);
    return null;
  }
}

// ── Bland.ai phone call ──────────────────────────────────────────

async function makeReservationCall(blandApiKey, { phone, restaurant, date, time, partySize, callerName }) {
  const task =
    `You are calling ${restaurant} to make a dinner reservation. ` +
    `You need a table for ${partySize || 2} on ${date} at ${time}. ` +
    `The reservation is under the name ${callerName || 'OpenClaw'}. ` +
    'Be polite and natural. If the requested time is not available, ask what times are available and accept the closest one. ' +
    'Confirm the final reservation details before hanging up: date, time, party size, and name.';

  const resp = await fetch('https://api.bland.ai/v1/calls', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: blandApiKey,
    },
    body: JSON.stringify({
      phone_number: phone,
      task,
      voice: 'nat',
      wait_for_greeting: true,
      record: true,
      max_duration: 5,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Bland API ${resp.status}: ${body}`);
  }

  const data = await resp.json();
  return data.call_id || data.id;
}

async function checkCallStatus(blandApiKey, callId) {
  const resp = await fetch(`https://api.bland.ai/v1/calls/${callId}`, {
    headers: { Authorization: blandApiKey },
  });

  if (!resp.ok) return { status: 'error', summary: 'Failed to check call status' };
  const data = await resp.json();

  return {
    status: data.status || 'unknown',
    summary: data.summary || '',
    transcript: data.concatenated_transcript || '',
    duration: data.call_length || 0,
  };
}

async function waitForCallCompletion(blandApiKey, callId, { maxWait = 300_000, pollInterval = 10_000, onProgress } = {}) {
  const start = Date.now();
  let checks = 0;

  while (Date.now() - start < maxWait) {
    const result = await checkCallStatus(blandApiKey, callId);

    if (result.status === 'completed' || result.status === 'ended') {
      return result;
    }
    if (result.status === 'error' || result.status === 'failed' || result.status === 'no-answer') {
      return result;
    }

    checks++;
    // Send progress update every 30 seconds (every 3rd check at 10s intervals)
    if (onProgress && checks % 3 === 0) {
      const elapsed = Math.round((Date.now() - start) / 1000);
      onProgress(`📞 Still on the line... (${elapsed}s)`);
    }

    await new Promise(r => setTimeout(r, pollInterval));
  }

  return { status: 'timeout', summary: 'Call did not complete within the time limit' };
}

function formatCallResult(details, result) {
  if (result.status === 'completed' || result.status === 'ended') {
    const lines = [
      '✅ Reservation call completed!',
      '',
      `📍 ${details.restaurant}${details.city ? ` — ${details.city}` : ''}`,
      `📞 Called: ${details.phone}`,
      '',
      '📋 Summary:',
      result.summary || '(no summary available)',
    ];
    if (result.transcript) {
      lines.push('', '💬 Transcript:', result.transcript.slice(0, 2000));
    }
    return lines.join('\n');
  }

  return `❌ Call ${result.status}: ${result.summary || 'The restaurant did not answer or the call failed.'}`;
}

module.exports = {
  parseReservationRequest,
  buildOpenTableUrl,
  buildGoogleMapsUrl,
  formatReservationReply,
  lookupRestaurantPhone,
  makeReservationCall,
  waitForCallCompletion,
  formatCallResult,
};
