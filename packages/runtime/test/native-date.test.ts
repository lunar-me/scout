/**
 * A task's date or time, in the syntax the native input holds it in.
 *
 * The shapes are the ones models were measured writing into native inputs on
 * a fleet Mac, 2026-10-02 ("19:30", "07:30 PM", "1930") plus the forms a task
 * states a date in. An unreadable text must answer `undefined`, because the
 * caller then types what the model wrote rather than a guess.
 */

import { describe, expect, test } from 'bun:test';

import { nativeDateKeys, nativeDateValue } from '../src/native-date';

describe('a time, in any shape a task writes it, is one value', () => {
  test.each([
    ['19:30', '19:30'],
    ['7:30 PM', '19:30'],
    ['07:30 pm', '19:30'],
    ['7:30p.m.', '19:30'],
    ['7 PM', '19:00'],
    ['1930', '19:30'],
    ['12:00 AM', '00:00'],
    ['12:15 PM', '12:15'],
    ['09:05:30', '09:05:30'],
    ['09:05:00', '09:05'],
  ])('%p is %p', (text, value) => {
    expect(nativeDateValue('time', text)).toBe(value);
  });

  test.each(['13:30 PM', '24:00', '7:60', '19', 'half past seven', '0 AM'])('%p is not a time', (text) => {
    expect(nativeDateValue('time', text)).toBeUndefined();
  });
});

describe('a date, in any shape a task writes it, is one value', () => {
  test.each([
    ['2026-10-03', '2026-10-03'],
    ['2026/10/3', '2026-10-03'],
    ['10/03/2026', '2026-10-03'],
    ['25/12/2026', '2026-12-25'],
    ['03.10.2026', '2026-10-03'],
    ['October 3, 2026', '2026-10-03'],
    ['Saturday, Oct 3rd 2026', '2026-10-03'],
    ['3 October 2026', '2026-10-03'],
    ['29 Feb 2028', '2028-02-29'],
  ])('%p is %p', (text, value) => {
    expect(nativeDateValue('date', text)).toBe(value);
  });

  test.each(['2026-02-30', '29 Feb 2026', '13/13/2026', 'Octember 3, 2026', '2026-10'])('%p is not a date', (text) => {
    expect(nativeDateValue('date', text)).toBeUndefined();
  });
});

describe('the other segmented kinds', () => {
  test('a date and a time together, joined any way a task joins them', () => {
    expect(nativeDateValue('datetime-local', '2026-10-03T19:30')).toBe('2026-10-03T19:30');
    expect(nativeDateValue('datetime-local', '2026-10-03 19:30:00')).toBe('2026-10-03T19:30');
    expect(nativeDateValue('datetime-local', 'October 3, 2026 at 7:30 PM')).toBe('2026-10-03T19:30');
    expect(nativeDateValue('datetime-local', '10/03/2026, 7:30 pm')).toBe('2026-10-03T19:30');
    expect(nativeDateValue('datetime-local', '2026-10-03')).toBeUndefined();
  });

  test('a month and a week', () => {
    expect(nativeDateValue('month', '2026-10')).toBe('2026-10');
    expect(nativeDateValue('month', '10/2026')).toBe('2026-10');
    expect(nativeDateValue('month', 'October 2026')).toBe('2026-10');
    expect(nativeDateValue('month', '2026-13')).toBeUndefined();
    expect(nativeDateValue('week', '2026-W40')).toBe('2026-W40');
    expect(nativeDateValue('week', 'Week 40, 2026')).toBe('2026-W40');
    // 2026 has 53 ISO weeks (1 January is a Thursday); 2027 has 52.
    expect(nativeDateValue('week', '2026-W53')).toBe('2026-W53');
    expect(nativeDateValue('week', '2027-W53')).toBeUndefined();
  });

});

describe('what is typed into each segment follows the layout the locale drew', () => {
  const EN = {
    months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
    ampm: ['AM', 'PM'],
  };
  const seg = (field: string, max: number, placeholder = '--') => ({ field, max, placeholder });
  // httpbin's en-US time input, as its shadow tree reads on a fleet Mac 2026-10-02.
  const TWELVE_HOUR = [seg('hour', 12), seg('minute', 59), seg('ampm', 2)];

  test('a 12-hour time: the hour on its own clock, then AM or PM by its first letter', () => {
    expect(nativeDateKeys('time', '19:30', TWELVE_HOUR, EN)).toEqual(['07', '30', 'P']);
    expect(nativeDateKeys('time', '00:05', TWELVE_HOUR, EN)).toEqual(['12', '05', 'A']);
    expect(nativeDateKeys('time', '12:00', TWELVE_HOUR, EN)).toEqual(['12', '00', 'P']);
  });

  test('a 24-hour time with seconds, and an AM/PM segment that comes first', () => {
    expect(nativeDateKeys('time', '09:05:30', [seg('hour', 23), seg('minute', 59), seg('second', 59)], EN)).toEqual(['09', '05', '30']);
    expect(nativeDateKeys('time', '19:30', [seg('ampm', 2), seg('hour', 12), seg('minute', 59)], { ...EN, ampm: ['上午', '下午'] })).toEqual(['下', '07', '30']);
  });

  test('a date in the order its segments are drawn, a symbolic month by name', () => {
    const us = [seg('month', 12, 'mm'), seg('day', 31, 'dd'), seg('year', 275760, 'yyyy')];
    const gb = [seg('day', 31, 'dd'), seg('month', 12, 'mm'), seg('year', 275760, 'yyyy')];
    expect(nativeDateKeys('date', '2026-10-03', us, EN)).toEqual(['10', '03', '2026']);
    expect(nativeDateKeys('date', '2026-10-03', gb, EN)).toEqual(['03', '10', '2026']);
    expect(nativeDateKeys('month', '2026-07', [seg('month', 12, '---------'), seg('year', 275760, '----')], EN)).toEqual(['Jul', '2026']);
  });

  test('a segment the value does not fill, or a clock this plan does not know, plans nothing', () => {
    expect(nativeDateKeys('time', '19:30', [seg('day', 31), seg('hour', 12)], EN)).toBeUndefined();
    expect(nativeDateKeys('time', '19:30', [seg('hour', 99)], EN)).toBeUndefined();
    expect(nativeDateKeys('time', '19:30', TWELVE_HOUR, { months: [], ampm: [] })).toBeUndefined();
  });
});
