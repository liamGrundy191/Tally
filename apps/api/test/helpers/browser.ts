/** A browser stand-in: keeps cookies and sends the CSRF header, like the web app will. */
export class Browser {
  readonly cookies = new Map<string, string>();
  lastSetCookies: string[] = [];
  constructor(private readonly base: string) {}

  async send(method: string, path: string, body?: unknown, opts: { csrf?: string | false } = {}) {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookies.size) {
      headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    const csrf = opts.csrf ?? this.cookies.get('tally_csrf');
    if (csrf) headers['x-csrf-token'] = csrf;
    const res = await fetch(this.base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.lastSetCookies = res.headers.getSetCookie();
    for (const c of this.lastSetCookies) {
      const pair = c.split(';')[0]!;
      const name = pair.slice(0, pair.indexOf('='));
      const value = pair.slice(pair.indexOf('=') + 1);
      if (!value || /expires=Thu, 01 Jan 1970/i.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  login(email: string, password: string) {
    return this.send('POST', '/api/auth/login', { email, password });
  }
}
