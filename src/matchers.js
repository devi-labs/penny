'use strict';

// ── Natural language matchers ────────────────────────────────────
// Each function takes a lowercase message string and returns:
//   null  – no match
//   { intent, ...params }  – matched, with extracted parameters

// ── Helpers ──────────────────────────────────────────────────────

const DATE_WORDS = /\b(today|tonight|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this week|next week|this month|next month|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/i;

function extractDate(text) {
  const m = text.match(DATE_WORDS);
  return m ? m[1] : null;
}

// Extract "by Friday", "due tomorrow", "by 03/20" from a string, return { title, due }
function extractDueDate(text) {
  const duePattern = /\s+(?:by|due|due by|before|until)\s+(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)$/i;
  const m = text.match(duePattern);
  if (m) {
    return { title: text.slice(0, m.index).trim(), due: m[1] };
  }
  return { title: text, due: null };
}

// Pull a trailing number like "mark 3 as done"
function extractIndex(text) {
  // "mark 3 as done", "complete #3", "check off 2", "done with 1"
  const m = text.match(/\b#?(\d{1,3})\b/);
  return m ? m[1] : null;
}

// ── Calendar ─────────────────────────────────────────────────────

function matchCalendar(lower) {
  // CREATE patterns — must check first (more specific)
  if (/\b(schedule|set up|create|add|block|put|book)\s+(a |an |my |some )?(meeting|call|event|appointment|time|slot|block|session|standup|sync|check-?in|1[:\-]1|one on one)/i.test(lower)) {
    return { intent: 'cal_create_nl', raw: lower, date: extractDate(lower) };
  }
  if (/\b(block|reserve)\s+(my |some |an? )?(time|calendar|morning|afternoon|evening)/i.test(lower)) {
    return { intent: 'cal_create_nl', raw: lower, date: extractDate(lower) };
  }

  // CALENDARS listing — check before list patterns to avoid "show me my calendars" matching cal_list
  if (/\b(list|show|see|view|which|what)\s+(me )?(my )?(calendars|all calendars)/i.test(lower)) {
    return { intent: 'cal_calendars' };
  }
  if (/\bmy calendars\b/i.test(lower)) {
    return { intent: 'cal_calendars' };
  }

  // LIST / QUERY patterns
  if (/\b(show|check|pull up|open|see|view|display|get)\s+(me )?(my )?(calendar|schedule|agenda|events?|meetings?)/i.test(lower)) {
    return { intent: 'cal_list', date: extractDate(lower) };
  }
  if (/\bwhat('s|s| is| do i have| have i got)\b.*\b(on|going|happening|scheduled|today|tomorrow|this week|next week|coming up|lined up)/i.test(lower) && !/\b(plate|list|to-?do|tasks?)\b/.test(lower)) {
    return { intent: 'cal_list', date: extractDate(lower) };
  }
  if (/\b(am i|are we|are you)\s+(free|busy|available|booked|open)/i.test(lower)) {
    return { intent: 'cal_list', date: extractDate(lower) };
  }
  if (/\b(any|do i have|have i got|got any)\s+(meetings?|events?|calls?|appointments?|things?)/i.test(lower)) {
    return { intent: 'cal_list', date: extractDate(lower) };
  }
  if (/\bwhat do i have (going on|today|tomorrow|this week|next week|on)/i.test(lower)) {
    return { intent: 'cal_list', date: extractDate(lower) };
  }
  if (/\b(my |today'?s |tomorrow'?s )?(schedule|calendar|agenda|events?|meetings?)\b/.test(lower) && !/\b(create|add|schedule a|set up|calendars)\b/.test(lower)) {
    return { intent: 'cal_list', date: extractDate(lower) };
  }
  if (/\bhow('s| does| is) my (day|week|morning|afternoon) look/i.test(lower)) {
    return { intent: 'cal_list', date: extractDate(lower) };
  }
  if (/\bwhat('s| is) (the plan|happening|going on) (today|tomorrow|this week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i.test(lower)) {
    return { intent: 'cal_list', date: extractDate(lower) };
  }
  if (/\b(when'?s|what time is) my (next|first) (meeting|call|event|appointment)/i.test(lower)) {
    return { intent: 'cal_list', date: extractDate(lower) || 'today' };
  }

  return null;
}

// ── Todos ────────────────────────────────────────────────────────

function matchTodo(lower) {
  // ADD patterns
  const remindMe = lower.match(/\bremind me to\s+(.+)/i);
  if (remindMe) { const { title, due } = extractDueDate(remindMe[1].trim()); return { intent: 'todo_add', title, due }; }

  const addToList = lower.match(/\badd\s+(.+?)\s+to\s+(?:my\s+)?(?:list|todos?|tasks?|to-?do(?:\s*list)?|checklist)/i);
  if (addToList) { const { title, due } = extractDueDate(addToList[1].trim()); return { intent: 'todo_add', title, due }; }

  const iNeedTo = lower.match(/\b(?:i need to|i gotta|i have to|i should|don'?t let me forget to|don'?t forget to)\s+(.+)/i);
  if (iNeedTo) {
    const raw = iNeedTo[1].trim();
    // "i need to do" alone is a list query, not an add
    if (!/^(do|get done|finish|complete|handle|tackle)\s*$/.test(raw)) {
      const { title, due } = extractDueDate(raw);
      return { intent: 'todo_add', title, due };
    }
  }

  const addTask = lower.match(/\b(?:add|create|make|new)\s+(?:a\s+)?(?:task|todo|to-?do|reminder)(?:\s*:\s*|\s+(?:for|to|called|named)\s+)(.+)/i);
  if (addTask) { const { title, due } = extractDueDate(addTask[1].trim()); return { intent: 'todo_add', title, due }; }

  const putOnList = lower.match(/\bput\s+(.+?)\s+on\s+(?:my\s+)?(?:list|todos?|tasks?)/i);
  if (putOnList) { const { title, due } = extractDueDate(putOnList[1].trim()); return { intent: 'todo_add', title, due }; }

  // DONE / COMPLETE patterns
  if (/\b(check off|mark|complete|finish|done with|knock out|close out|cross off)\b.*\b#?(\d{1,3})\b/i.test(lower)) {
    return { intent: 'todo_done', index: extractIndex(lower) };
  }
  if (/\b#?(\d{1,3})\s+(is\s+)?(done|finished|complete|completed|checked off)/i.test(lower)) {
    return { intent: 'todo_done', index: extractIndex(lower) };
  }

  // DELETE patterns
  if (/\b(delete|remove|drop|scratch|nix|cancel)\b.*\b(?:task|todo|to-?do|item|#?(\d{1,3}))\b/i.test(lower)) {
    return { intent: 'todo_delete', index: extractIndex(lower) };
  }
  if (/\b(take|remove)\s+(.+?)\s+(off|from)\s+(?:my\s+)?(?:list|todos?|tasks?)/i.test(lower)) {
    return { intent: 'todo_delete', index: extractIndex(lower) };
  }

  // LIST patterns
  if (/\b(show|see|view|check|pull up|display|get|list|give me)\s+(me )?(my )?(todos?|to-?dos?|tasks?|list|checklist|to-?do\s*list)/i.test(lower)) {
    return { intent: 'todo_list' };
  }
  if (/\bwhat('s|s| is| do i have| have i got)\s+(on\s+)?(my\s+)?(plate|list|to-?do|tasks?|agenda)\b/i.test(lower) && !/\b(meeting|call|calendar|schedule|event)\b/.test(lower)) {
    return { intent: 'todo_list' };
  }
  if (/\bwhat\s+(do i|should i|do we)\s+(need to|have to|gotta|need)\s+(do|get done|finish|complete|handle|tackle)\b/i.test(lower)) {
    return { intent: 'todo_list' };
  }
  if (/\b(my|the)\s+(tasks?|todos?|to-?dos?|checklist|to-?do\s*list)\b/i.test(lower) && !/\b(add|create|new|remind|delete|remove|done|complete)\b/.test(lower)) {
    return { intent: 'todo_list' };
  }
  if (/\bwhat('s|s| is)\s+(left|pending|outstanding|remaining|open|undone|incomplete)\b/i.test(lower)) {
    return { intent: 'todo_list' };
  }
  if (/\b(anything|something|stuff|things?)\s+(left\s+)?(to do|to finish|to complete|pending|outstanding)/i.test(lower)) {
    return { intent: 'todo_list' };
  }
  if (/\bhow many (tasks?|todos?|things?|items?) (do i|have i)/i.test(lower)) {
    return { intent: 'todo_list' };
  }

  return null;
}

// ── Email ────────────────────────────────────────────────────────

function matchEmail(lower) {
  // SEND patterns
  if (/\b(send|write|compose|draft|fire off|shoot|reply)\s+(a |an )?(email|message|note|mail|reply)\s+(to|for|back to)\b/i.test(lower)) {
    return { intent: 'email_send_nl', raw: lower };
  }
  if (/\bemail\s+\S+@\S+/i.test(lower)) {
    return { intent: 'email_send_nl', raw: lower };
  }
  if (/\b(message|email|write to|reach out to|get back to|respond to|reply to)\s+\S+@/i.test(lower)) {
    return { intent: 'email_send_nl', raw: lower };
  }

  // SEARCH patterns
  if (/\b(search|find|look for|look up|dig up|locate)\s+(a |an |the |my )?(email|message|mail|thread|conversation)\s*(from|about|regarding|with|mentioning|re:)/i.test(lower)) {
    return { intent: 'email_search_nl', raw: lower };
  }
  if (/\bwhat did\s+\S+\s+(send|email|write|message)\s+(me|us)/i.test(lower)) {
    return { intent: 'email_search_nl', raw: lower };
  }
  if (/\b(emails?|messages?|mail)\s+(from|about|regarding|with)\b/i.test(lower)) {
    return { intent: 'email_search_nl', raw: lower };
  }
  if (/\b(find|search)\s+(my )?(inbox|email|mail)\s+(for)\b/i.test(lower)) {
    return { intent: 'email_search_nl', raw: lower };
  }

  // CHECK / LIST patterns
  if (/\b(check|show|see|view|open|pull up|get|read)\s+(me )?(my )?(email|emails|mail|inbox|messages?)/i.test(lower)) {
    return { intent: 'email_check' };
  }
  if (/\b(any|do i have|have i got|got any)\s+(new\s+)?(emails?|mail|messages?|unread)/i.test(lower)) {
    return { intent: 'email_check' };
  }
  if (/\bwhat('s|s| is)\s+(in\s+)?(my\s+)?(inbox|email|mail)\b/i.test(lower)) {
    return { intent: 'email_check' };
  }
  if (/\bunread\s+(emails?|messages?|mail)\b/i.test(lower)) {
    return { intent: 'email_check' };
  }
  if (/\b(my|the)\s+(inbox|email|mail)\b/i.test(lower) && !/\b(send|write|compose|draft|search|find)\b/.test(lower)) {
    return { intent: 'email_check' };
  }
  if (/\bwho\s+(emailed|messaged|wrote)\s+me\b/i.test(lower)) {
    return { intent: 'email_check' };
  }
  if (/\b(new|recent|latest)\s+(emails?|messages?|mail)\b/i.test(lower)) {
    return { intent: 'email_check' };
  }

  return null;
}

// ── Reservations ─────────────────────────────────────────────────

function matchReservation(lower) {
  // CALL patterns (phone reservation)
  if (/\bcall\b.*\b(reserv|table|dinner|lunch|brunch|book|restaurant)/i.test(lower)) {
    return { intent: 'reserve_call_nl', raw: lower };
  }
  if (/\b(phone|call)\s+(the\s+)?(restaurant|place)/i.test(lower)) {
    return { intent: 'reserve_call_nl', raw: lower };
  }

  // RESERVE / BOOK patterns (OpenTable)
  if (/\b(reserv|book|get)\s+(a |us |me )?(a )?(table|reservation|res|spot|seat)/i.test(lower)) {
    return { intent: 'reserve_nl', raw: lower };
  }
  if (/\b(make|need|want|get)\s+(a |us |me )?(reservation|res|booking|dinner reservation|lunch reservation)/i.test(lower)) {
    return { intent: 'reserve_nl', raw: lower };
  }
  if (/\b(book|reserve)\s+(dinner|lunch|brunch|supper|a meal)/i.test(lower)) {
    return { intent: 'reserve_nl', raw: lower };
  }
  if (/\b(dinner|lunch|brunch|supper)\s+(for\s+\d+\s+)?(at|tonight|tomorrow|on\s+)/i.test(lower)) {
    return { intent: 'reserve_nl', raw: lower };
  }
  if (/\b(find|get)\s+(a |us |me )?(restaurant|place to eat|dinner spot|somewhere to eat)/i.test(lower)) {
    return { intent: 'reserve_nl', raw: lower };
  }
  if (/\b(where should we|where can we|let'?s go|wanna go)\s+(eat|grab|get)\b/i.test(lower)) {
    return { intent: 'reserve_nl', raw: lower };
  }
  if (/\btable for \d+/i.test(lower)) {
    return { intent: 'reserve_nl', raw: lower };
  }
  if (/\b(party of|seating for|seats? for)\s+\d+/i.test(lower) && /\b(restaurant|dinner|lunch|book|reserv)/i.test(lower)) {
    return { intent: 'reserve_nl', raw: lower };
  }

  return null;
}

// ── Roundup ──────────────────────────────────────────────────────

function matchRoundup(lower) {
  if (/\b(give me|send me|show me|get me)\s+(my |the |a )?(briefing|rundown|summary|digest|news|update|roundup|round-?up)/i.test(lower)) {
    if (/\bweekly\b/.test(lower)) return { intent: 'roundup_weekly' };
    return { intent: 'roundup_daily' };
  }
  if (/\b(morning|daily|today'?s)\s+(briefing|digest|update|summary|rundown|news|roundup|round-?up)/i.test(lower)) {
    return { intent: 'roundup_daily' };
  }
  if (/\bweekly\s+(briefing|digest|update|summary|rundown|news|roundup|round-?up)/i.test(lower)) {
    return { intent: 'roundup_weekly' };
  }
  if (/\b(catch me up|catch up|what did i miss|what'?s new|what happened|fill me in|bring me up to speed)/i.test(lower)) {
    return { intent: 'roundup_daily' };
  }
  if (/\bwhat('s|s| is)\s+(the |today'?s )?(news|latest|headlines?)\b/i.test(lower)) {
    return { intent: 'roundup_daily' };
  }
  if (/\b(any|the)\s+(news|updates?|headlines?)\b/i.test(lower)) {
    return { intent: 'roundup_daily' };
  }

  return null;
}

// ── Help ─────────────────────────────────────────────────────────

function matchHelp(lower) {
  if (/\bwhat (can|do) you do\b/i.test(lower)) return { intent: 'help' };
  if (/\bhow (do i|can i|does this|do you)\s+(use|work)/i.test(lower)) return { intent: 'help' };
  if (/\b(show|list|give|tell) (me )?(the |your |all )?(commands|options|features|menu|capabilities|abilities)/i.test(lower)) return { intent: 'help' };
  if (/\bwhat (are|is) (the |your )?(commands|options|features|capabilities)/i.test(lower)) return { intent: 'help' };
  if (/\bwhat('s|s| is) available\b/i.test(lower)) return { intent: 'help' };
  if (/\bi'?m (new|confused|lost|stuck)\b.*\b(help|how|what)\b/i.test(lower)) return { intent: 'help' };
  if (/\b(help me|assist me|guide me)\b/i.test(lower) && lower.length < 40) return { intent: 'help' };
  return null;
}

// ── Repos ────────────────────────────────────────────────────────

function matchRepos(lower) {
  if (/\b(show|list|see|view|get|display|what are)\s+(me )?(my |the |all )?(repos?|repositories|projects|codebases?)\b/i.test(lower)) {
    return { intent: 'repos_list' };
  }
  if (/\bwhat (repos?|repositories|projects|codebases?) (do i have|are there|have i got|are available)/i.test(lower)) {
    return { intent: 'repos_list' };
  }
  if (/\b(my|the)\s+(repos?|repositories|projects)\b/i.test(lower) && lower.length < 50) {
    return { intent: 'repos_list' };
  }
  return null;
}

// ── Brain ────────────────────────────────────────────────────────

function matchBrain(lower) {
  if (/\bwhat do you (remember|know|recall)\s*(about me|about)\b/i.test(lower)) return { intent: 'brain_show' };
  if (/\b(show|check|view|see)\s+(me )?(your |the )?(memory|brain|state)\b/i.test(lower)) return { intent: 'brain_show' };
  if (/\b(clear|reset|wipe|erase|forget|delete)\s+(your |the )?(memory|brain|state|everything)\b/i.test(lower)) return { intent: 'brain_reset' };
  if (/\bforget (about )?(me|everything|all)\b/i.test(lower)) return { intent: 'brain_reset' };
  if (/\b(memory|brain)\s+(status|state|check|info)\b/i.test(lower)) return { intent: 'brain_status' };
  return null;
}

// ── Learn ─────────────────────────────────────────────────────────

function matchLearn(lower) {
  // Exact commands — handled first
  if (/^learn$/.test(lower)) return { intent: 'learn', args: null };
  if (/^learn\s+next$/.test(lower)) return { intent: 'learn', args: 'next' };
  if (/^learn\s+list$/.test(lower)) return { intent: 'learn', args: 'list' };
  if (/^learn\s+help$/.test(lower)) return { intent: 'learn', args: 'help' };
  if (/^learn\s+reset$/.test(lower)) return { intent: 'learn', args: 'reset' };
  if (/^learn\s+syllabus$/.test(lower)) return { intent: 'learn', args: 'syllabus' };
  if (/^learn\s+off$/.test(lower)) return { intent: 'learn', args: 'off' };
  if (/^learn\s+on$/.test(lower)) return { intent: 'learn', args: 'on' };

  // learn language <lang> or "learn in Spanish"
  const langMatch = lower.match(/^learn\s+language\s+(.+)/);
  if (langMatch) return { intent: 'learn', args: `language ${langMatch[1].trim()}` };
  const learnInMatch = lower.match(/^learn\s+in\s+(\w+)$/);
  if (learnInMatch) return { intent: 'learn', args: `language ${learnInMatch[1].trim()}` };

  // learn more about <topic>
  const moreAbout = lower.match(/^learn\s+more\s+about\s+(.+)/);
  if (moreAbout) return { intent: 'learn', args: `more about ${moreAbout[1].trim()}` };

  // learn remove <topic>
  const remove = lower.match(/^learn\s+remove\s+(.+)/);
  if (remove) return { intent: 'learn', args: `remove ${remove[1].trim()}` };

  // Natural language variations
  if (/\b(teach me|start learning|coding lesson|next lesson|continue lesson|my lesson)/i.test(lower)) {
    return { intent: 'learn', args: 'next' };
  }
  if (/\b(how('s| is) my (learning|coding|progress))\b/i.test(lower)) {
    return { intent: 'learn', args: null };
  }
  if (/\b(what('s| am i|should i)\s+(learn|study|code))\b/i.test(lower) && lower.length < 60) {
    return { intent: 'learn', args: null };
  }

  return null;
}

// ── Run all matchers ─────────────────────────────────────────────

function matchIntent(lower) {
  // Order matters: more specific features first to avoid false positives
  return matchHelp(lower)
    || matchBrain(lower)
    || matchLearn(lower)
    || matchRepos(lower)
    || matchRoundup(lower)
    || matchReservation(lower)
    || matchEmail(lower)
    || matchCalendar(lower)
    || matchTodo(lower)
    || null;
}

module.exports = {
  matchCalendar,
  matchTodo,
  matchEmail,
  matchReservation,
  matchRoundup,
  matchHelp,
  matchRepos,
  matchBrain,
  matchLearn,
  matchIntent,
  extractDueDate,
};
