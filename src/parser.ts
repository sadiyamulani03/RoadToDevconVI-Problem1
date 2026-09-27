import { ParsedNoticeSchema, type ParsedNotice } from "./schemas.js";

/**
 * Deterministic parser for messy Indian Railway delay notices.
 *
 * Extracts: train number (5 digits), station code (2-5 uppercase letters),
 * expected arrival time (normalised to 24-hour HH:MM) and an optional reason.
 *
 * The parser is pure: no LLM, no external railway service, no network calls.
 * It either returns a fully validated success result or a controlled failure
 * with the list of fields it could not extract. Partially valid data is never
 * returned as success.
 */

export type ParseResult =
  | { ok: true; data: ParsedNotice }
  | { ok: false; error: string; missing: string[] };

const DEVANAGARI = "\u0900-\u097F";

/** Words that must never be mistaken for a station code by the fallback scan. */
const STATION_STOPLIST = new Set([
  "NOTE", "NOTES", "PLEASE", "KINDLY", "REGRET", "SORRY", "DUE", "FROM", "FOR",
  "AND", "THE", "NOT", "BUT", "MAY", "CAN", "ALL", "ANY", "NEW", "OLD", "WAS",
  "WERE", "WILL", "ITS", "OUR", "OUT", "OFF", "PER", "VIA", "NO", "YES",
  "TRAIN", "TRAINS", "DELAY", "DELAYED", "LATE", "LATER", "TIME", "TIMES",
  "MIN", "MINUTE", "MINUTES", "HRS", "HOUR", "HOURS", "STATION", "STATIONS",
  "CODE", "CODES", "EXPECT", "EXPECTED", "ARRIVAL", "ARRIVE", "ARRIVES",
  "DEPART", "DEPARTURE", "PLATFORM", "ETA", "ETD", "AM", "PM", "INFO",
  "UPDATE", "DATED", "DATE", "SPECIAL", "EXPRESS", "MAIL", "FAST", "SUPER",
  "VANDE", "EMU", "MEMU", "DEMU", "SF", "ICF", "LHB", "PNR", "TTE", "RPF",
  "GRP", "RAIL", "DIVERTED", "CANCELLED", "TERMINATED", "SHORT", "SOURCE",
  "DESTINATION", "RUNNING", "HEAVY", "DENSE", "SIGNAL", "SIGNALS", "FAILURE",
  "FAULT", "POWER", "WATER", "TRACK", "TRACKS", "RAIN", "FOG", "CATTLE",
  "BANDH", "APLOGIES", "INCONVENIENCE", "CAUSED", "IMPORTANT", "ADVISED",
  "DIVERSION", "BETWEEN", "AFTER", "BEFORE", "UPTO", "TILL", "NEXT", "EARLY",
]);

function firstMatch(text: string, re: RegExp): RegExpExecArray | null {
  return re.exec(text);
}

function cleanWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Train number: Indian Railway train numbers are exactly 5 digits
 * (e.g. 12951 Rajdhani, 09019 summer specials).
 */
function extractTrainNumber(text: string): string | undefined {
  // Labeled forms: "Train 12951", "Train No. 12951", "Train Number: 12951",
  // "ट्रेन क्रमांक 22691", "गाड़ी संख्या 12951", "रेलगाडी 12951".
  const labeled = firstMatch(
    text,
    /(?:train|number|no\.|ट्रेन|गाड़ी|गाडी|रेलगाड़ी|रेलगाडी|संख्या|क्रमांक)[^0-9\n]{0,16}?(\d{5})\b/i,
  );
  if (labeled) {
    const candidate = labeled[1]!;
    if (parseInt(candidate, 10) > 0) return candidate;
  }

  // "#12951" style references.
  const hashed = firstMatch(text, /(?:^|[^\d])#(\d{5})\b/);
  if (hashed) return hashed[1];

  // Fallback: first standalone 5-digit number.
  const bare = firstMatch(text, /(?:^|[^\d])(\d{5})(?=[^\d]|$)/);
  if (bare) {
    const candidate = bare[1]!;
    if (parseInt(candidate, 10) > 0) return candidate;
  }
  return undefined;
}

/**
 * Station code: 2-5 uppercase ASCII letters (CSMT, NDLS, PUNE, SBC, ...).
 * Indian Railway notices always write station codes in uppercase, so only
 * uppercase codes are accepted.
 */
function extractStationCode(text: string): string | undefined {
  const candidates: string[] = [];

  // Explicit label: "Station Code: CSMT", "stn code NDLS",
  // "स्टेशन कोड: CSMT", "स्थानक: PUNE".
  const labeled = firstMatch(
    text,
    new RegExp(
      "(?:station|stn|स्टेशन|स्थानक)[^\\nA-Z]{0,12}?([A-Z]{2,5})\\b",
    ),
  );
  if (labeled?.[1]) candidates.push(labeled[1]);

  // Code followed by a station word: "CSMT स्टेशन पर", "NDLS station",
  // "PUNE स्थानकजवळ" (glued Devanagari compounds are allowed).
  const beforeStationWord = firstMatch(
    text,
    new RegExp(`\\b([A-Z]{2,5})\\s+(?:स्टेशन|स्थानक)`),
  );
  if (beforeStationWord?.[1]) candidates.push(beforeStationWord[1]);

  // Code followed by the postposition पर/जवळ: "CSMT पर", "PUNE जवळ".
  const beforePostposition = firstMatch(
    text,
    new RegExp(`\\b([A-Z]{2,5})\\s+(?:पर|जवळ|जवल)(?![${DEVANAGARI}])`),
  );
  if (beforePostposition?.[1]) candidates.push(beforePostposition[1]);

  // Preposition before the code: "delayed at CSMT", "at NDLS", "को SBC".
  const preposition = firstMatch(
    text,
    /\b(?:at|for|to|near|पर|जवळ|जवल|को)\s+([A-Z]{2,5})\b/,
  );
  if (preposition?.[1]) candidates.push(preposition[1]);

  // Fallback: first standalone uppercase token that is not a noise word.
  const globalRe = /\b[A-Z]{2,5}\b/g;
  let m: RegExpExecArray | null;
  while ((m = globalRe.exec(text)) !== null) {
    const candidate = m[0];
    if (!STATION_STOPLIST.has(candidate)) {
      candidates.push(candidate);
      break;
    }
  }

  // Return the first candidate that passes the stoplist and shape checks.
  for (const candidate of candidates) {
    if (!STATION_STOPLIST.has(candidate) && /^[A-Z]{2,5}$/.test(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Convert a parsed clock value to a zero-padded 24-hour "HH:MM" string. */
function to24Hour(hours: number, minutes: number, meridiem?: string): string | undefined {
  let h = hours;
  const m = minutes;
  const mer = meridiem?.toLowerCase();
  if (mer === "am" || mer === "pm") {
    if (h >= 13 && h <= 23) {
      // Messy but human-readable 24-hour time with a meridiem, e.g. "16:45 pm".
      // A reader understands the 24-hour clock value; keep it as-is.
    } else if (h < 1 || h > 12) {
      return undefined;
    } else if (mer === "am") {
      if (h === 12) h = 0;
    } else if (h !== 12) {
      h += 12;
    }
  } else {
    if (h < 0 || h > 23) return undefined;
  }
  if (m < 0 || m > 59) return undefined;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function timeFromMatch(hh: string, mm: string, meridiem?: string): string | undefined {
  return to24Hour(parseInt(hh, 10), parseInt(mm, 10), meridiem);
}

/** Expected arrival time, normalised to 24-hour "HH:MM". */
function extractExpectedTime(text: string): string | undefined {
  // Labeled forms: "expected at 16:45", "Expected arrival: 14:30 hrs",
  // "ETA 17:10", "पोहोचेल 18:15", "पहुँचेगी 17:10 बजे".
  const labeledRe =
    /(?:expected|eta|arrival|arrive|reach|पहुँच|पहुंच|पोहोच|पोहंच)[^0-9\n]{0,24}?(\d{1,2})[:.](\d{2})\s*(am|pm|hrs|hours|बजे|बजत)?/i;
  let m: RegExpExecArray | null;
  let cursor = 0;
  let search = text;
  while ((m = labeledRe.exec(search)) !== null) {
    const time = timeFromMatch(m[1]!, m[2]!, m[3]);
    if (time) return time;
    cursor += m.index + m[0].length + 1;
    search = text.slice(cursor);
  }

  // Fallback: first colon-separated time token ("16:45", "4:45 PM",
  // "14:30 hrs"). Dot-separated times are intentionally not matched here to
  // avoid confusing them with dates like 26.09.2026.
  const fallbackRe = /(?:^|[^\d:.])(\d{1,2}):(\d{2})\s*(am|pm|hrs)?/i;
  m = fallbackRe.exec(text);
  if (m) {
    const time = timeFromMatch(m[1]!, m[2]!, m[3]);
    if (time) return time;
  }
  return undefined;
}

function reasonFromBackwardContext(text: string, keywordIndex: number, keywordLength: number): string | undefined {
  const start = Math.max(0, keywordIndex - 48);
  let slice = text.slice(start, keywordIndex);
  // Stop at sentence/phrase punctuation if present in the window.
  const punctIndex = Math.max(
    slice.lastIndexOf(","),
    slice.lastIndexOf(";"),
    slice.lastIndexOf("."),
    slice.lastIndexOf("!"),
    slice.lastIndexOf("?"),
    slice.lastIndexOf("\n"),
  );
  if (punctIndex !== -1) slice = slice.slice(punctIndex + 1);
  const reason = cleanWhitespace(slice);
  return reason.length >= 2 ? reason : undefined;
}

/** Optional reason, extracted via explicit causal connectors. */
function extractReason(text: string): string | undefined {
  // Hindi/Marathi backward causals: "X के कारण", "X की वजह से", "Xमुळे".
  const backwardRe = new RegExp(`के कारण|की वजह से|मुळे`, "g");
  let m: RegExpExecArray | null;
  while ((m = backwardRe.exec(text)) !== null) {
    const reason = reasonFromBackwardContext(text, m.index, m[0].length);
    if (reason) return reason;
  }

  // Hindi/Marathi labeled reason: "कारण: सिग्नल खराबी", "कारण - देर".
  const labeledDevanagari = firstMatch(text, /कारण\s*[:\-–—]\s*([^\n;]{2,120})/);
  if (labeledDevanagari?.[1]) {
    const reason = cleanWhitespace(labeledDevanagari[1]);
    if (reason.length >= 2) return reason;
  }

  // English causal connectors: "due to X", "because of X", "owing to X".
  const englishRe = /\b(?:due to|because of|owing to)\b\s*:?\s*([^\n.;]{2,120})/i;
  m = englishRe.exec(text);
  if (m?.[1]) {
    const reason = cleanWhitespace(m[1]);
    if (reason.length >= 2) return reason;
  }
  return undefined;
}

/**
 * Parse a railway delay notice.
 *
 * Returns { ok: true, data } only when train number, station code and
 * expected time were all found and the combined result passes the runtime
 * schema. Otherwise returns { ok: false } with a controlled error message.
 */
export function parseNotice(raw: string): ParseResult {
  const text = cleanWhitespace(raw);
  if (!text) {
    return { ok: false, error: "Unable to parse notice: notice is empty", missing: ["notice"] };
  }

  const missing: string[] = [];
  const trainNumber = extractTrainNumber(text);
  if (!trainNumber) missing.push("trainNumber");
  const stationCode = extractStationCode(text);
  if (!stationCode) missing.push("stationCode");
  const expectedTime = extractExpectedTime(text);
  if (!expectedTime) missing.push("expectedTime");

  if (missing.length > 0) {
    return {
      ok: false,
      error: `Unable to parse notice: missing or unreadable ${missing.join(", ")}`,
      missing,
    };
  }

  const reason = extractReason(text);

  const candidate: ParsedNotice = {
    trainNumber: trainNumber!,
    stationCode: stationCode!,
    expectedTime: expectedTime!,
    ...(reason ? { reason } : {}),
  };

  // Validate parser output against the explicit runtime schema before
  // declaring success. A parser bug must surface as a parse failure, never
  // as invalid structured data returned with HTTP 200.
  const validated = ParsedNoticeSchema.safeParse(candidate);
  if (!validated.success) {
    return {
      ok: false,
      error: `Parsed data failed schema validation: ${validated.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
      missing: [],
    };
  }

  return { ok: true, data: validated.data };
}
