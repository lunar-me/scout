/**
 * How long a JavaScript dialog is read before it is answered.
 *
 * `alert()`, `confirm()`, `prompt()` and `beforeunload` block the renderer's
 * main thread until somebody answers, and with the `Page` domain enabled the
 * browser waits for THIS client to answer rather than answering itself. Every
 * page the worker drives therefore answers its dialogs, after the time a
 * person takes to read one: a floor, a rate per character of the message, and
 * a ceiling, with +-20% so two dialogs never take the same time.
 *
 * The ceiling is not a taste: an agent's freeze command sent while a dialog is
 * open waits behind it and must still be answered inside
 * `FREEZE_REPLY_DEADLINE_MS` (`./agent-deps`), and a scrape pays the wait in
 * its own latency.
 */
const DIALOG_READ_BASE_MS = 700;
const DIALOG_READ_PER_CHAR_MS = 30;
const DIALOG_READ_CAP_MS = 2_500;

export function dialogReadMs(message: string, random: () => number = Math.random): number {
  return Math.round(
    Math.min(DIALOG_READ_CAP_MS, DIALOG_READ_BASE_MS + DIALOG_READ_PER_CHAR_MS * message.length) *
      (0.8 + 0.4 * random()),
  );
}
