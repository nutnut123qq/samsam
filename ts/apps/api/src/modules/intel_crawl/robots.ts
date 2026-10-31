import { quote, unquote, urlparse, urlunparse } from '@samsam/core/ops/py-url';
import { isDigit, pyStrip } from '@samsam/core/security/py';

// Port `urllib.robotparser.RobotFileParser` (Python 3.12.7) — phần collector intel dùng: parse,
// can_fetch, crawl_delay, cờ disallow_all/allow_all.

type Rule = { path: string; allowance: boolean };
type Entry = { useragents: string[]; rules: Rule[]; delay: number | null };

function ruleLine(path: string, allowance: boolean): Rule {
  const allow = path === '' && !allowance ? true : allowance; // Disallow rỗng = cho hết
  return { path: quote(urlunparse(urlparse(path))), allowance: allow };
}

function appliesTo(e: Entry, useragent: string): boolean {
  const ua = (useragent.split('/')[0] as string).toLowerCase();
  return e.useragents.some((a) => a === '*' || ua.includes(a.toLowerCase()));
}

function allowance(e: Entry, filename: string): boolean {
  for (const r of e.rules) if (r.path === '*' || filename.startsWith(r.path)) return r.allowance;
  return true;
}

/** Python `int(s)` cho chuỗi đã qua `.strip().isdigit()`. shortcut: chỉ nhận chữ số ASCII — chữ số
 * Unicode khác (Python: số Nd thì nhận, ² thì ValueError làm chết lượt) → null (không dùng delay). */
function decimalInt(s: string): number | null {
  const t = pyStrip(s);
  return /^[0-9]+$/.test(t) ? Number(t) : null;
}

/** Python `str.splitlines()`. */
export function splitlines(s: string): string[] {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: dấu xuống dòng kiểu Python
  const out = s.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

export class RobotFileParser {
  disallowAll = false;
  allowAll = false;
  private entries: Entry[] = [];
  private defaultEntry: Entry | null = null;
  private lastChecked = 0;

  private add(e: Entry): void {
    if (e.useragents.includes('*')) {
      if (this.defaultEntry === null) this.defaultEntry = e;
    } else this.entries.push(e);
  }

  parse(lines: string[]): void {
    let state = 0;
    let entry: Entry = { useragents: [], rules: [], delay: null };
    this.lastChecked = Date.now() / 1000;
    for (let line of lines) {
      if (!line) {
        if (state === 1) {
          entry = { useragents: [], rules: [], delay: null };
          state = 0;
        } else if (state === 2) {
          this.add(entry);
          entry = { useragents: [], rules: [], delay: null };
          state = 0;
        }
      }
      const h = line.indexOf('#');
      if (h >= 0) line = line.slice(0, h);
      line = pyStrip(line);
      if (!line) continue;
      const c = line.indexOf(':');
      if (c < 0) continue;
      const key = pyStrip(line.slice(0, c)).toLowerCase();
      const val = unquote(pyStrip(line.slice(c + 1)));
      if (key === 'user-agent') {
        if (state === 2) {
          this.add(entry);
          entry = { useragents: [], rules: [], delay: null };
        }
        entry.useragents.push(val);
        state = 1;
      } else if (key === 'disallow' || key === 'allow') {
        if (state !== 0) {
          entry.rules.push(ruleLine(val, key === 'allow'));
          state = 2;
        }
      } else if (key === 'crawl-delay') {
        if (state !== 0) {
          const t = pyStrip(val);
          if (t && [...t].every(isDigit)) entry.delay = decimalInt(val);
          state = 2;
        }
      } else if (key === 'request-rate') {
        if (state !== 0) state = 2;
      }
    }
    if (state === 2) this.add(entry);
  }

  canFetch(useragent: string, url: string): boolean {
    if (this.disallowAll) return false;
    if (this.allowAll) return true;
    if (!this.lastChecked) return false;
    const p = urlparse(unquote(url));
    let u = urlunparse({
      scheme: '',
      netloc: '',
      path: p.path,
      params: p.params,
      query: p.query,
      fragment: p.fragment,
    });
    u = quote(u);
    if (!u) u = '/';
    for (const e of this.entries) if (appliesTo(e, useragent)) return allowance(e, u);
    if (this.defaultEntry) return allowance(this.defaultEntry, u);
    return true;
  }

  crawlDelay(useragent: string): number | null {
    if (!this.lastChecked) return null;
    for (const e of this.entries) if (appliesTo(e, useragent)) return e.delay;
    return this.defaultEntry ? this.defaultEntry.delay : null;
  }
}
