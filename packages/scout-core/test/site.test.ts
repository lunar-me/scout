import { describe, expect, test } from 'bun:test';

import { siteOf } from '../src/site';

describe('siteOf', () => {
  test('a site is the registrable domain, approximately', () => {
    expect(siteOf('https://en.wikipedia.org/wiki/X')).toBe('wikipedia.org');
    expect(siteOf('https://auth.wikimedia.org/x')).toBe('wikimedia.org');
    expect(siteOf('https://www.bbc.co.uk/news')).toBe('bbc.co.uk');
    expect(siteOf('https://shop.example.co.uk/')).toBe('example.co.uk');
    expect(siteOf('https://a.b.example.com.au/')).toBe('example.com.au');
    expect(siteOf('https://api.x.io/')).toBe('x.io');
    expect(siteOf('http://10.0.0.1:8080/')).toBe('10.0.0.1');
    expect(siteOf('about:blank')).toBeUndefined();
  });
});
