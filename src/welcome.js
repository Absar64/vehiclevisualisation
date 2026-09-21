/**
 * welcome.js — the greeting on the boot screen.
 *
 * Three sets of lines, chosen by the hour, with one picked at random from the
 * matching set each load.
 *
 * Lines are authored in lower case and sentence-cased on the way out, so a new
 * one can be added without thinking about capitals. The exception is a proper
 * noun: a name is written capitalised here and left that way, because
 * sentence case would otherwise render "good morning absar" with the name in
 * lower case, and a blanket `capitalize` would render "What's The Move".
 */

export const WELCOME_LINES = {
  morning: ['good morning Absar', 'early morning, Absar?'],
  day: ["what's the move, Absar?", 'welcome Absar', 'lets drive'],
  night: ['late night cruising?', "what's the move, Absar?", 'lets roll, Absar'],
};

/**
 * First letter of the line, and of anything after a full stop, upper-cased.
 * Everything else is left exactly as authored.
 *
 * @param {string} line
 * @returns {string}
 */
export function sentenceCase(line) {
  return line.replace(/(^\s*|[.!?]\s+)(\p{Ll})/gu, (_, lead, letter) => lead + letter.toUpperCase());
}

/**
 * Which set applies at a given hour.
 *
 * Night starts at 21:00 as specified and runs until 05:00 — the small hours
 * belong with "late night cruising", not with "good morning".
 */
export function periodFor(hour) {
  if (hour >= 21 || hour < 5) return 'night';
  if (hour < 12) return 'morning';
  return 'day';
}

/**
 * @param {Date} [now]
 * @returns {string} one line, sentence-cased
 */
export function pickWelcome(now = new Date()) {
  const lines = WELCOME_LINES[periodFor(now.getHours())];
  return sentenceCase(lines[Math.floor(Math.random() * lines.length)]);
}
