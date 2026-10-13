/**
 * THE VALUE A NATIVE DATE/TIME INPUT SHOULD HOLD, from what a task says.
 *
 * `<input type=time|date|datetime-local|month|week>` is drawn by Blink as
 * SEGMENTS: one spinbutton per field, in the order the locale writes them.
 * MEASURED on a fleet Mac, 2026-10-02 (Chrome/154, en-US): httpbin's "Preferred
 * delivery time" is three spinbuttons, Hours (1-12), Minutes and AM/PM. A model
 * names a value the way a task does — "19:30", "7:30 PM", "2026-10-03",
 * "October 3, 2026" — and none of those shapes is what any one segment takes.
 *
 * This module is the one place a task's shape is turned into the input's own
 * value syntax (HTML's: `HH:MM[:SS]`, `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM`,
 * `YYYY-MM`, `YYYY-Www`), so that the binding that TYPES the value and the
 * check that READS IT BACK compare the same thing. Pure; no DOM.
 *
 * Unparseable text answers `undefined` and nothing else: the caller then does
 * what it did before this module existed, rather than typing a guess.
 */

/** The `type` of every input Blink draws as segments. */
export type NativeDateKind = 'date' | 'time' | 'datetime-local' | 'month' | 'week';

const KINDS: Readonly<Record<string, NativeDateKind>> = {
  date: 'date',
  time: 'time',
  'datetime-local': 'datetime-local',
  month: 'month',
  week: 'week',
};

/** `kind` as a {@link NativeDateKind}, when an input of that type is segmented. */
export function nativeDateKind(kind: string): NativeDateKind | undefined {
  return KINDS[kind.toLowerCase()];
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;

/** 1-12 for an English month name or its 3+ letter abbreviation ("Sept" too). */
export function monthOfName(word: string): number | undefined {
  const lower = word.toLowerCase().replace(/\.$/u, '');
  if (lower.length < 3) return undefined;
  const index = MONTHS.findIndex((name) => name.startsWith(lower));
  return index < 0 ? undefined : index + 1;
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** A calendar date, validated. Year 1-275760 is Blink's own range for the year field. */
interface Ymd {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function ymd(year: number, month: number, day: number): Ymd | undefined {
  if (!Number.isInteger(year) || year < 1 || year > 275_760) return undefined;
  if (!Number.isInteger(month) || month < 1 || month > 12) return undefined;
  if (!Number.isInteger(day) || day < 1 || day > daysIn(year, month)) return undefined;
  return { year, month, day };
}

const formatYmd = (date: Ymd): string => `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`;

/** A weekday a task may lead with ("Saturday, October 3, 2026"). Dropped, never checked. */
const WEEKDAY = /^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+/iu;

function parseDate(text: string): Ymd | undefined {
  const t = text.trim().replace(WEEKDAY, '');
  // ISO first, and with any of the separators a person uses between its parts.
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/u.exec(t);
  if (m !== null) return ymd(Number(m[1]), Number(m[2]), Number(m[3]));
  // Numeric with the year last. A dot is the European D.M.Y; a slash or dash
  // is read month-first, as the fleet's en-US locale writes it, unless the
  // first number cannot be a month.
  m = /^(\d{1,2})([-/.])(\d{1,2})\2(\d{4})$/u.exec(t);
  if (m !== null) {
    const a = Number(m[1]);
    const b = Number(m[3]);
    const year = Number(m[4]);
    const dayFirst = m[2] === '.' || a > 12;
    return dayFirst ? ymd(year, b, a) : ymd(year, a, b);
  }
  // "October 3, 2026" / "Oct 3rd 2026"
  m = /^([a-z]+\.?)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/iu.exec(t);
  if (m !== null) {
    const month = monthOfName(m[1] ?? '');
    return month === undefined ? undefined : ymd(Number(m[3]), month, Number(m[2]));
  }
  // "3 October 2026" / "3rd of Oct, 2026"
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+\.?),?\s+(\d{4})$/iu.exec(t);
  if (m !== null) {
    const month = monthOfName(m[2] ?? '');
    return month === undefined ? undefined : ymd(Number(m[3]), month, Number(m[1]));
  }
  return undefined;
}

/** A time of day, 24-hour, validated. */
interface Hms {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function hms(hour: number, minute: number, second: number): Hms | undefined {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return undefined;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return undefined;
  if (!Number.isInteger(second) || second < 0 || second > 59) return undefined;
  return { hour, minute, second };
}

/** Seconds only when there are any, which is how Blink serialises a time. */
const formatHms = (time: Hms): string =>
  `${pad(time.hour)}:${pad(time.minute)}${time.second === 0 ? '' : `:${pad(time.second)}`}`;

/** "a.m.", "AM", "pm", "p" — the half of the day, or undefined for none. */
const MERIDIEM = /^([ap])\.?\s*(?:m\.?)?$/iu;

function parseTime(text: string): Hms | undefined {
  const t = text.trim();
  let m = /^(\d{1,2})(?:[:.h](\d{2})(?::(\d{2}))?)?\s*([ap]\.?\s*(?:m\.?)?)?$/iu.exec(t);
  if (m !== null && (m[2] !== undefined || m[4] !== undefined)) {
    const hour = Number(m[1]);
    const minute = m[2] === undefined ? 0 : Number(m[2]);
    const second = m[3] === undefined ? 0 : Number(m[3]);
    const half = m[4] === undefined ? undefined : MERIDIEM.exec(m[4])?.[1]?.toLowerCase();
    if (half === undefined) return hms(hour, minute, second);
    // A 12-hour clock: 12 AM is midnight, 12 PM is noon, and 13 PM is nothing.
    if (hour < 1 || hour > 12) return undefined;
    return hms((hour % 12) + (half === 'p' ? 12 : 0), minute, second);
  }
  // "1930": four digits with no separator are a 24-hour HHMM, as a form wants.
  m = /^(\d{2})(\d{2})$/u.exec(t);
  if (m !== null) return hms(Number(m[1]), Number(m[2]), 0);
  return undefined;
}

/** A trailing time a date-and-time text ends in, and what is left before it. */
const TRAILING_TIME = /(?:^|[\sT,@]+(?:at\s+)?)(\d{1,2}(?:[:.]\d{2}(?::\d{2})?)?\s*(?:[ap]\.?\s*m\.?)?)$/iu;

function parseDateTime(text: string): { readonly date: Ymd; readonly time: Hms } | undefined {
  const t = text.trim();
  const iso = /^(\d{4}-\d{1,2}-\d{1,2})[T\s]+(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?)$/iu.exec(t);
  if (iso !== null) {
    const date = parseDate(iso[1] ?? '');
    const time = parseTime((iso[2] ?? '').replace(/\.\d+$/u, ''));
    return date === undefined || time === undefined ? undefined : { date, time };
  }
  const tail = TRAILING_TIME.exec(t);
  if (tail === null || tail.index === 0) return undefined;
  const time = parseTime(tail[1] ?? '');
  const date = parseDate(t.slice(0, tail.index).replace(/[\s,]+$/u, ''));
  return date === undefined || time === undefined ? undefined : { date, time };
}

function parseMonth(text: string): { readonly year: number; readonly month: number } | undefined {
  const t = text.trim();
  let year: number;
  let month: number | undefined;
  const yearFirst = /^(\d{4})[-/.](\d{1,2})$/u.exec(t);
  const yearLast = /^(\d{1,2})[-/.](\d{4})$/u.exec(t);
  const named = /^([a-z]+\.?),?\s+(\d{4})$/iu.exec(t);
  if (yearFirst !== null) {
    year = Number(yearFirst[1]);
    month = Number(yearFirst[2]);
  } else if (yearLast !== null) {
    year = Number(yearLast[2]);
    month = Number(yearLast[1]);
  } else if (named !== null) {
    year = Number(named[2]);
    month = monthOfName(named[1] ?? '');
  } else {
    return undefined;
  }
  return month === undefined || ymd(year, month, 1) === undefined ? undefined : { year, month };
}

/** ISO weeks in `year`: 53 when 1 January or 31 December is a Thursday. */
function weeksIn(year: number): number {
  const day = (month: number, date: number): number => new Date(Date.UTC(year, month, date)).getUTCDay();
  return day(0, 1) === 4 || day(11, 31) === 4 ? 53 : 52;
}

function parseWeek(text: string): { readonly year: number; readonly week: number } | undefined {
  const t = text.trim();
  const iso = /^(\d{4})-?w(\d{1,2})$/iu.exec(t);
  const spoken = /^(?:week|wk|w)\.?\s*(\d{1,2}),?\s+(?:of\s+)?(\d{4})$/iu.exec(t);
  const year = Number(iso?.[1] ?? spoken?.[2]);
  const week = Number(iso?.[2] ?? spoken?.[1]);
  if (!(year >= 1 && year <= 275_760 && week >= 1 && week <= weeksIn(year))) return undefined;
  return { year, week };
}

/**
 * The value `<input type=kind>` holds once `text` is in it, in HTML's own
 * syntax, or `undefined` when `text` is not a value of that kind in any shape
 * this module reads.
 */
export function nativeDateValue(kind: NativeDateKind, text: string): string | undefined {
  switch (kind) {
    case 'date': {
      const date = parseDate(text);
      return date === undefined ? undefined : formatYmd(date);
    }
    case 'time': {
      const time = parseTime(text);
      return time === undefined ? undefined : formatHms(time);
    }
    case 'datetime-local': {
      const both = parseDateTime(text);
      return both === undefined ? undefined : `${formatYmd(both.date)}T${formatHms(both.time)}`;
    }
    case 'month': {
      const month = parseMonth(text);
      return month === undefined ? undefined : `${pad(month.year, 4)}-${pad(month.month)}`;
    }
    case 'week': {
      const week = parseWeek(text);
      return week === undefined ? undefined : `${pad(week.year, 4)}-W${pad(week.week)}`;
    }
  }
}

/** A value's fields. `hour` is 0-23; a 12-hour layout derives its hour and AM/PM from it. */
interface NativeDateParts {
  readonly year?: number;
  readonly month?: number;
  readonly day?: number;
  readonly week?: number;
  readonly hour?: number;
  readonly minute?: number;
  readonly second?: number;
}

function nativeDateParts(kind: NativeDateKind, value: string): NativeDateParts | undefined {
  const time = (t: string): NativeDateParts | undefined => {
    const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(t);
    return m === null ? undefined : { hour: Number(m[1]), minute: Number(m[2]), second: Number(m[3] ?? 0) };
  };
  const date = (d: string): NativeDateParts | undefined => {
    const m = /^(\d{4,6})-(\d{2})-(\d{2})$/u.exec(d);
    return m === null ? undefined : { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  };
  switch (kind) {
    case 'time':
      return time(value);
    case 'date':
      return date(value);
    case 'datetime-local': {
      const [d = '', t = ''] = value.split('T');
      const left = date(d);
      const right = time(t);
      return left === undefined || right === undefined ? undefined : { ...left, ...right };
    }
    case 'month': {
      const m = /^(\d{4,6})-(\d{2})$/u.exec(value);
      return m === null ? undefined : { year: Number(m[1]), month: Number(m[2]) };
    }
    case 'week': {
      const m = /^(\d{4,6})-W(\d{2})$/u.exec(value);
      return m === null ? undefined : { year: Number(m[1]), week: Number(m[2]) };
    }
  }
}

/**
 * One segment of a native date/time input, as its user-agent shadow tree
 * describes it: `field` is the `<field>` of its `-webkit-datetime-edit-<field>-field`
 * pseudo, `max` its `aria-valuemax`, `placeholder` its `aria-placeholder`.
 */
export interface NativeDateSegment {
  readonly field: string;
  readonly max: number;
  readonly placeholder: string;
}

/** The locale's names for what the symbolic segments show: 12 months, then AM and PM. */
export interface NativeDateSymbols {
  readonly months: readonly string[];
  readonly ampm: readonly string[];
}

/**
 * The shortest start of `names[index]` no other name starts with, which is
 * what Blink's type-ahead needs to choose it in a symbolic segment: "P" for
 * PM, "Ju" is not enough for July, "Jul" is.
 */
function typeAheadFor(names: readonly string[], index: number): string | undefined {
  const name = names[index];
  if (name === undefined || name === '') return undefined;
  for (let length = 1; length <= name.length; length += 1) {
    const start = name.slice(0, length).toLowerCase();
    if (names.every((other, at) => at === index || !other.toLowerCase().startsWith(start))) {
      return name.slice(0, length);
    }
  }
  return name;
}

/**
 * What to type into each segment, in order, for the input to hold `value`;
 * `undefined` when any segment is one this plan does not know how to fill.
 *
 * Each entry is typed into its own segment after focusing it, so nothing here
 * depends on when Blink moves focus on by itself. Numeric segments get their
 * full width (two digits, the year as written), which Blink commits on the
 * last digit. MEASURED on a fleet Mac 2026-10-02 (n=3 each) through trusted key
 * events into httpbin's 12-hour time input: "07", "30", "P" made `19:30`;
 * "07:30 PM" typed as one string did NOT — the space after the minutes left
 * the AM/PM segment empty and `input.value` "", 3/3.
 *
 * The hour follows the segment's own range: 1-12 and 0-11 are a 12-hour
 * clock beside an AM/PM segment, 0-23 and 1-24 a 24-hour one. A month segment
 * whose placeholder is a run of dashes is SYMBOLIC (it shows "October"), and
 * is chosen by name as AM/PM is.
 */
export function nativeDateKeys(
  kind: NativeDateKind,
  value: string,
  segments: readonly NativeDateSegment[],
  symbols: NativeDateSymbols,
): readonly string[] | undefined {
  const parts = nativeDateParts(kind, value);
  if (parts === undefined || segments.length === 0) return undefined;
  const keys: string[] = [];
  for (const segment of segments) {
    let typed: string | undefined;
    switch (segment.field) {
      case 'year':
        typed = parts.year === undefined ? undefined : String(parts.year);
        break;
      case 'month':
        if (parts.month !== undefined) {
          typed = /^-{3,}$/u.test(segment.placeholder)
            ? typeAheadFor(symbols.months, parts.month - 1)
            : pad(parts.month);
        }
        break;
      case 'day':
      case 'week':
      case 'minute':
      case 'second': {
        const part = parts[segment.field];
        typed = part === undefined ? undefined : pad(part);
        break;
      }
      case 'millisecond':
        typed = parts.hour === undefined ? undefined : '000';
        break;
      case 'hour': {
        const hour = parts.hour;
        if (hour === undefined) break;
        const shown =
          segment.max === 12 ? hour % 12 || 12
          : segment.max === 11 ? hour % 12
          : segment.max === 24 ? hour || 24
          : segment.max === 23 ? hour
          : undefined;
        typed = shown === undefined ? undefined : pad(shown);
        break;
      }
      case 'ampm':
        typed = parts.hour === undefined ? undefined : typeAheadFor(symbols.ampm, parts.hour < 12 ? 0 : 1);
        break;
    }
    if (typed === undefined) return undefined;
    keys.push(typed);
  }
  return keys;
}
