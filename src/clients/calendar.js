'use strict';

const { google } = require('googleapis');

function createCalendarClient({ clientId, clientSecret, refreshToken }) {
  if (!clientId || !clientSecret || !refreshToken) return null;

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });

  const calendar = google.calendar({ version: 'v3', auth: oauth2 });

  function parseDuration(dur) {
    if (!dur) return 60;
    const s = dur.trim().toLowerCase();
    // "1h30m", "2h", "30m"
    const compact = s.match(/^(?:(\d+)\s*h)?(?:(\d+)\s*m)?$/);
    if (compact && (compact[1] || compact[2])) {
      return (parseInt(compact[1] || '0', 10) * 60) + parseInt(compact[2] || '0', 10);
    }
    // "1.5 hours", "2 hours", "1 hour", "90 minutes", "30 min", "1 hr"
    const natural = s.match(/^(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?)$/);
    if (natural) {
      const val = parseFloat(natural[1]);
      const unit = natural[2];
      if (unit.startsWith('h')) return Math.round(val * 60);
      return Math.round(val); // minutes
    }
    // "1 hour 30 minutes" / "1h 30min"
    const combo = s.match(/^(\d+)\s*(?:hours?|hrs?|h)\s+(\d+)\s*(?:minutes?|mins?|m)$/);
    if (combo) return parseInt(combo[1], 10) * 60 + parseInt(combo[2], 10);
    return 60;
  }

  // Extract duration tokens from the front of a string, return { minutes, rest }
  function extractDuration(str) {
    const s = str.trim();
    const patterns = [
      // "1 hour 30 minutes" / "1h 30min"
      /^(\d+\s*(?:hours?|hrs?|h)\s+\d+\s*(?:minutes?|mins?|m))\s*(.*)/i,
      // "1.5 hours", "90 minutes", "1 hour", "30 min", "2 hrs"
      /^(\d+(?:\.\d+)?\s*(?:hours?|hrs?|minutes?|mins?))\s*(.*)/i,
      // "1h30m", "2h", "30m"
      /^(\d+h(?:\d+m)?|\d+m)\s*(.*)/i,
    ];
    for (const pat of patterns) {
      const m = s.match(pat);
      if (m) return { minutes: parseDuration(m[1]), rest: m[2] };
    }
    return { minutes: 60, rest: s };
  }

  function parseTime(timeStr) {
    const s = timeStr.trim().toLowerCase();
    // "14:00", "9:30"
    const mil = s.match(/^(\d{1,2}):(\d{2})$/);
    if (mil) return `${mil[1].padStart(2, '0')}:${mil[2]}`;
    // "2:30pm", "2:30 pm", "11:00am"
    const full = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/);
    if (full) {
      let h = parseInt(full[1], 10);
      if (full[3] === 'pm' && h < 12) h += 12;
      if (full[3] === 'am' && h === 12) h = 0;
      return `${String(h).padStart(2, '0')}:${full[2]}`;
    }
    // "2pm", "2 pm", "12am"
    const bare = s.match(/^(\d{1,2})\s*(am|pm)$/);
    if (bare) {
      let h = parseInt(bare[1], 10);
      if (bare[2] === 'pm' && h < 12) h += 12;
      if (bare[2] === 'am' && h === 12) h = 0;
      return `${String(h).padStart(2, '0')}:00`;
    }
    // Bare hour number like "14" or "9"
    const bareNum = s.match(/^(\d{1,2})$/);
    if (bareNum) {
      return `${bareNum[1].padStart(2, '0')}:00`;
    }
    return timeStr; // pass through as-is
  }

  function resolveDate(dateStr) {
    const lower = dateStr.toLowerCase().trim();
    const now = new Date();
    if (lower === 'today') return now.toISOString().split('T')[0];
    if (lower === 'tomorrow') {
      now.setDate(now.getDate() + 1);
      return now.toISOString().split('T')[0];
    }
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayIdx = days.indexOf(lower);
    if (dayIdx !== -1) {
      const diff = (dayIdx - now.getDay() + 7) % 7 || 7;
      now.setDate(now.getDate() + diff);
      return now.toISOString().split('T')[0];
    }
    // "March 27", "march 27", "March 27 2026", "mar 27"
    const MONTHS = { jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12 };
    const monthDay = lower.match(/^([a-z]+)\s+(\d{1,2})(?:\s+(\d{4}))?$/);
    if (monthDay && MONTHS[monthDay[1]]) {
      const month = String(MONTHS[monthDay[1]]).padStart(2, '0');
      const day = monthDay[2].padStart(2, '0');
      let year = monthDay[3] ? parseInt(monthDay[3], 10) : now.getFullYear();
      if (!monthDay[3]) {
        const candidate = new Date(`${year}-${month}-${day}T00:00:00`);
        if (candidate < new Date(now.getFullYear(), now.getMonth(), now.getDate())) year++;
      }
      return `${year}-${month}-${day}`;
    }
    // "27 March", "27 mar 2026"
    const dayMonth = lower.match(/^(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?$/);
    if (dayMonth && MONTHS[dayMonth[2]]) {
      const month = String(MONTHS[dayMonth[2]]).padStart(2, '0');
      const day = dayMonth[1].padStart(2, '0');
      let year = dayMonth[3] ? parseInt(dayMonth[3], 10) : now.getFullYear();
      if (!dayMonth[3]) {
        const candidate = new Date(`${year}-${month}-${day}T00:00:00`);
        if (candidate < new Date(now.getFullYear(), now.getMonth(), now.getDate())) year++;
      }
      return `${year}-${month}-${day}`;
    }

    // MM/DD/YYYY or MM-DD-YYYY
    const mdyFull = lower.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$/);
    if (mdyFull) {
      return `${mdyFull[3]}-${mdyFull[1].padStart(2, '0')}-${mdyFull[2].padStart(2, '0')}`;
    }
    // MM/DD or MM-DD (assume current year, or next year if date has passed)
    const mdShort = lower.match(/^(\d{1,2})[/\-](\d{1,2})$/);
    if (mdShort) {
      const month = mdShort[1].padStart(2, '0');
      const day = mdShort[2].padStart(2, '0');
      let year = now.getFullYear();
      const candidate = new Date(`${year}-${month}-${day}T00:00:00`);
      if (candidate < new Date(now.getFullYear(), now.getMonth(), now.getDate())) year++;
      return `${year}-${month}-${day}`;
    }
    return dateStr; // assume YYYY-MM-DD
  }

  function formatEvent(ev) {
    const start = ev.start?.dateTime || ev.start?.date || '?';
    const end = ev.end?.dateTime || ev.end?.date || '?';
    const attendees = (ev.attendees || []).map(a => a.email).join(', ');
    return [
      `${ev.summary || '(no title)'}`,
      `  When: ${start} → ${end}`,
      ev.location ? `  Where: ${ev.location}` : null,
      attendees ? `  Who: ${attendees}` : null,
      ev.description ? `  Note: ${ev.description.slice(0, 200)}` : null,
    ].filter(Boolean).join('\n');
  }

  async function listEvents({ timeMin, timeMax, maxResults = 10 } = {}) {
    const now = new Date();
    if (!timeMin) {
      timeMin = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    }
    if (!timeMax) {
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      timeMax = end.toISOString();
    }

    // Fetch all calendars and query events from each
    const calList = await calendar.calendarList.list();
    const allCals = (calList.data.items || []).filter(c => c.accessRole === 'owner' || c.accessRole === 'writer' || c.accessRole === 'reader');

    const allEvents = [];
    for (const cal of allCals) {
      try {
        const res = await calendar.events.list({
          calendarId: cal.id,
          timeMin,
          timeMax,
          maxResults,
          singleEvents: true,
          orderBy: 'startTime',
        });
        for (const ev of (res.data.items || [])) {
          allEvents.push({
            id: ev.id,
            calendarId: cal.id,
            calendarName: cal.summary || '',
            summary: ev.summary || '(no title)',
            start: ev.start?.dateTime || ev.start?.date || '',
            end: ev.end?.dateTime || ev.end?.date || '',
            location: ev.location || '',
            attendees: (ev.attendees || []).map(a => a.email),
            description: ev.description || '',
            formatted: formatEvent(ev),
          });
        }
      } catch (err) {
        // Skip calendars we can't read (e.g. permissions issues)
      }
    }

    // Sort all events by start time
    allEvents.sort((a, b) => new Date(a.start) - new Date(b.start));
    return allEvents;
  }

  async function getEvent(eventId) {
    const res = await calendar.events.get({
      calendarId: 'primary',
      eventId,
    });
    const ev = res.data;
    return {
      id: ev.id,
      summary: ev.summary || '(no title)',
      start: ev.start?.dateTime || ev.start?.date || '',
      end: ev.end?.dateTime || ev.end?.date || '',
      location: ev.location || '',
      attendees: (ev.attendees || []).map(a => a.email),
      description: ev.description || '',
      htmlLink: ev.htmlLink || '',
      formatted: formatEvent(ev),
    };
  }

  async function listCalendars() {
    const res = await calendar.calendarList.list();
    return (res.data.items || []).map(c => ({
      id: c.id,
      summary: c.summary || '(untitled)',
      description: c.description || '',
      primary: !!c.primary,
      accessRole: c.accessRole || '',
    }));
  }

  async function createEvent({ summary, description, date, time, duration, attendees, location, calendarId }) {
    const dateStr = resolveDate(date);
    const minutes = parseDuration(duration || '1h');
    const normalizedTime = parseTime(time);

    const startDt = new Date(`${dateStr}T${normalizedTime}:00`);
    if (isNaN(startDt.getTime())) {
      throw new Error(`Invalid date/time: "${date}" "${time}" resolved to "${dateStr}T${normalizedTime}:00"`);
    }
    const endDt = new Date(startDt.getTime() + minutes * 60 * 1000);

    const event = {
      summary,
      description: description || '',
      start: { dateTime: startDt.toISOString() },
      end: { dateTime: endDt.toISOString() },
    };

    if (location) event.location = location;

    if (attendees && attendees.length) {
      event.attendees = attendees.map(email => ({ email: email.trim() }));
    }

    const res = await calendar.events.insert({
      calendarId: calendarId || 'primary',
      requestBody: event,
      sendUpdates: attendees?.length ? 'all' : 'none',
    });

    return {
      id: res.data.id,
      htmlLink: res.data.htmlLink,
      summary: res.data.summary,
      start: res.data.start?.dateTime || res.data.start?.date,
    };
  }

  async function updateEvent(eventId, updates) {
    // Fetch current event first
    const current = await calendar.events.get({
      calendarId: 'primary',
      eventId,
    });

    const ev = current.data;

    if (updates.summary) ev.summary = updates.summary;
    if (updates.description) ev.description = updates.description;
    if (updates.location) ev.location = updates.location;

    if (updates.time) {
      const currentStart = new Date(ev.start?.dateTime || ev.start?.date);
      const currentEnd = new Date(ev.end?.dateTime || ev.end?.date);
      const durationMs = currentEnd.getTime() - currentStart.getTime();

      const dateStr = currentStart.toISOString().split('T')[0];
      const newStart = new Date(`${dateStr}T${updates.time}:00`);
      const newEnd = new Date(newStart.getTime() + durationMs);

      ev.start = { dateTime: newStart.toISOString() };
      ev.end = { dateTime: newEnd.toISOString() };
    }

    if (updates.date) {
      const resolved = resolveDate(updates.date);
      const currentStart = new Date(ev.start?.dateTime || ev.start?.date);
      const currentEnd = new Date(ev.end?.dateTime || ev.end?.date);
      const durationMs = currentEnd.getTime() - currentStart.getTime();

      const timeStr = currentStart.toISOString().split('T')[1];
      const newStart = new Date(`${resolved}T${timeStr}`);
      const newEnd = new Date(newStart.getTime() + durationMs);

      ev.start = { dateTime: newStart.toISOString() };
      ev.end = { dateTime: newEnd.toISOString() };
    }

    if (updates.duration) {
      const minutes = parseDuration(updates.duration);
      const startDt = new Date(ev.start?.dateTime || ev.start?.date);
      ev.end = { dateTime: new Date(startDt.getTime() + minutes * 60 * 1000).toISOString() };
    }

    if (updates.attendees) {
      ev.attendees = updates.attendees.map(email => ({ email: email.trim() }));
    }

    const hasAttendees = ev.attendees?.length > 0;

    const res = await calendar.events.update({
      calendarId: 'primary',
      eventId,
      requestBody: ev,
      sendUpdates: hasAttendees ? 'all' : 'none',
    });

    return {
      id: res.data.id,
      htmlLink: res.data.htmlLink,
      summary: res.data.summary,
    };
  }

  async function deleteEvent(eventId) {
    await calendar.events.delete({
      calendarId: 'primary',
      eventId,
      sendUpdates: 'all',
    });
  }

  return { listEvents, listCalendars, getEvent, createEvent, updateEvent, deleteEvent, resolveDate, parseDuration, parseTime, extractDuration, enabled: true };
}

module.exports = { createCalendarClient };
