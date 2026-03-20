'use strict';

const { google } = require('googleapis');

function createGmailClient({ clientId, clientSecret, refreshToken, userEmail }) {
  if (!clientId || !clientSecret || !refreshToken) return null;

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });

  const gmail = google.gmail({ version: 'v1', auth: oauth2 });

  async function listMessages({ query = '', maxResults = 10 } = {}) {
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults,
    });
    const messages = res.data.messages || [];
    const results = [];
    for (const msg of messages.slice(0, maxResults)) {
      const detail = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'Date'],
      });
      const headers = detail.data.payload?.headers || [];
      const get = (name) => headers.find((h) => h.name === name)?.value || '';
      results.push({
        id: msg.id,
        from: get('From'),
        to: get('To'),
        subject: get('Subject'),
        date: get('Date'),
        snippet: detail.data.snippet || '',
      });
    }
    return results;
  }

  async function readMessage(messageId) {
    const res = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });
    const headers = res.data.payload?.headers || [];
    const get = (name) => headers.find((h) => h.name === name)?.value || '';

    let body = '';
    const parts = res.data.payload?.parts || [];
    if (parts.length) {
      const textPart = parts.find((p) => p.mimeType === 'text/plain');
      if (textPart?.body?.data) {
        body = Buffer.from(textPart.body.data, 'base64').toString('utf8');
      }
    } else if (res.data.payload?.body?.data) {
      body = Buffer.from(res.data.payload.body.data, 'base64').toString('utf8');
    }

    return {
      id: messageId,
      from: get('From'),
      to: get('To'),
      subject: get('Subject'),
      date: get('Date'),
      body: body.slice(0, 4000),
    };
  }

  async function sendEmail({ to, subject, body }) {
    if (!to) throw new Error('Missing "to" address');
    if (!subject) throw new Error('Missing subject');

    const raw = [
      `From: ${userEmail}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
    ].join('\r\n');

    const encoded = Buffer.from(raw)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const res = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: encoded },
    });

    if (!res.data?.id) {
      throw new Error(`Gmail send returned no message ID — response: ${JSON.stringify(res.data).slice(0, 200)}`);
    }

    console.log(`[gmail] Email sent to ${to}, messageId: ${res.data.id}`);
    return { id: res.data.id, threadId: res.data.threadId };
  }

  return { listMessages, readMessage, sendEmail, enabled: true };
}

module.exports = { createGmailClient };
