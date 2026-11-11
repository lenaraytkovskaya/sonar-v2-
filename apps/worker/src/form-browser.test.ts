import { createServer, request as httpRequest, type Server } from 'node:http';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { chromium } from 'playwright';
import { sendWebsiteForm, type FormOptions } from './form-browser.js';
import { siteRequestHeaders, type SiteResponse } from './site-http.js';
it('preserves JSON Accept for form requests while enforcing scanner identity headers', () => {
  const settings = {
    maxPages: 1,
    maxBytes: 1000000,
    timeoutMs: 3000,
    userAgent: 'SonarTest/1.0',
  };
  expect(
    siteRequestHeaders(settings, {
      Accept: 'application/json',
      'User-Agent': 'Other',
      'Accept-Encoding': 'gzip',
    }),
  ).toMatchObject({
    accept: 'application/json',
    'user-agent': 'SonarTest/1.0',
    'accept-encoding': 'identity',
  });
});
const home = 'https://forms.example.com';
describe.skipIf(process.env.RUN_BROWSER_TESTS !== '1')(
  'website form browser',
  () => {
    let server: Server, port: number;
    let html = '',
      rules = '',
      responseHtml = '',
      responseStatus = 200,
      responseLocation = '';
    let received: {
      path: string;
      body: string;
      method: string;
      cookie?: string;
    }[] = [];
    const form = (extra = '', action = '/send') =>
      `<form action="${action}" method="post"><label>Name<input name="name"></label><input type="email" name="email" required><input type="tel" name="phone"><textarea name="message" required></textarea>${extra}<button>Send</button></form>`;
    const input = {
      url: `${home}/contact`,
      website: home,
      name: 'Sender',
      email: 'sender@example.com',
      phone: '+380501234567',
      body: 'A unique contact message',
    };
    const settings = {
      maxPages: 1,
      maxBytes: 1000000,
      timeoutMs: 3000,
      userAgent: 'SonarTest/1.0',
    };
    let options: FormOptions;
    beforeAll(async () => {
      server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString();
        received.push({
          path: req.url!,
          body,
          method: req.method!,
          cookie: req.headers.cookie,
        });
        res.setHeader(
          'Content-Type',
          req.url === '/robots.txt' ? 'text/plain' : 'text/html',
        );
        if (req.url === '/robots.txt') res.end(rules);
        else if (req.method === 'POST' || req.url?.startsWith('/send?')) {
          res.statusCode = responseStatus;
          if (responseLocation) res.setHeader('Location', responseLocation);
          res.end(responseHtml);
        } else if (req.url === '/thanks') res.end('<h1>Thank you</h1>');
        else {
          res.setHeader('Set-Cookie', [
            'sonar_session=test-session; Secure; HttpOnly; SameSite=Lax; Path=/',
          ]);
          res.end(html);
        }
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      port = (server.address() as { port: number }).port;
    });
    afterAll(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    beforeEach(() => {
      html = form();
      rules = '';
      responseHtml = '<h1>Thank you, message sent!</h1>';
      responseStatus = 200;
      responseLocation = '';
      received = [];
      options = {
        settings,
        beforeSubmit: vi.fn(async () => {}),
        saveScreenshot: vi.fn(async () => {}),
        launch: () =>
          chromium.launch({
            headless: true,
            proxy: { server: 'http://127.0.0.1:9', bypass: '<-loopback>' },
          }),
        // Only this injected transport can access loopback; Chromium has a dead proxy.
        request: (url, _settings, init = {}) =>
          new Promise<SiteResponse>((resolve, reject) => {
            expect(url.hostname).toBe('forms.example.com');
            const req = httpRequest(
              {
                hostname: '127.0.0.1',
                port,
                path: url.pathname + url.search,
                method: init.method ?? 'GET',
                headers: init.headers,
              },
              (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () =>
                  resolve({
                    url: url.href,
                    status: res.statusCode!,
                    contentType: String(res.headers['content-type']),
                    body: Buffer.concat(chunks),
                    headers: Object.fromEntries(
                      Object.entries(res.headers).filter(
                        (entry): entry is [string, string | string[]] =>
                          entry[1] !== undefined,
                      ),
                    ),
                    location: res.headers.location,
                  }),
                );
              },
            );
            req.on('error', reject);
            req.end(init.body);
          }),
      };
    });
    function posts() {
      return received.filter((entry) => entry.method === 'POST');
    }
    it('fills and submits the contact form once, with durable hook and screenshots', async () => {
      options.beforeSubmit = vi.fn(async () => {
        expect(posts()).toHaveLength(0);
        expect(options.saveScreenshot).toHaveBeenCalledWith(
          'before',
          expect.any(Buffer),
        );
      });
      const result = await sendWebsiteForm(input, options);
      expect(result.status).toBe('sent');
      expect(posts()).toHaveLength(1);
      expect(new URLSearchParams(posts()[0]!.body).get('message')).toBe(
        input.body,
      );
      expect(new URLSearchParams(posts()[0]!.body).get('email')).toBe(
        input.email,
      );
      expect(options.beforeSubmit).toHaveBeenCalledTimes(1);
      expect(options.saveScreenshot).toHaveBeenCalledWith(
        'after',
        expect.any(Buffer),
      );
    });
    it('confirms an AJAX submission through its actual message payload', async () => {
      html =
        form() +
        `<script>document.querySelector('form').onsubmit=async e=>{e.preventDefault(); await fetch('/api/contact',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:e.target.message.value})});};</script>`;
      responseHtml = '{"success":true}';
      expect((await sendWebsiteForm(input, options)).status).toBe('sent');
      expect(posts()[0]!.path).toBe('/api/contact');
    });
    it('does not mistake analytics HTTP 200 for a successful submission', async () => {
      html =
        form() +
        `<script>document.querySelector('form').onsubmit=e=>{e.preventDefault();fetch('/analytics',{method:'POST',body:'click'})};</script>`;
      expect((await sendWebsiteForm(input, options)).reasonCode).toBe(
        'submission_unconfirmed',
      );
      expect(posts()).toHaveLength(0);
    });
    it('uses exact message fields even when the message is a single character', async () => {
      html =
        form() +
        `<script>document.querySelector('form').onsubmit=e=>{e.preventDefault();fetch('/analytics',{method:'POST',body:'analytics'})};</script>`;
      expect(
        (await sendWebsiteForm({ ...input, body: 'a' }, options)).reasonCode,
      ).toBe('submission_unconfirmed');
      expect(posts()).toHaveLength(0);
    });
    it('supports GET contact forms with message fields in the query', async () => {
      html = form().replace('method="post"', 'method="get"');
      expect((await sendWebsiteForm(input, options)).status).toBe('sent');
      expect(
        received.some(
          (entry) => entry.path.startsWith('/send?') && entry.method === 'GET',
        ),
      ).toBe(true);
    });
    it('rejects server validation errors even when the HTTP status is 200', async () => {
      responseHtml = form() + '<p>Please enter a valid email</p>';
      expect((await sendWebsiteForm(input, options)).reasonCode).toBe(
        'validation_error',
      );
    });
    it('rejects JSON validation failure for AJAX', async () => {
      html =
        form() +
        `<script>document.querySelector('form').onsubmit=e=>{e.preventDefault();fetch('/api/contact',{method:'POST',body:JSON.stringify({message:e.target.message.value})})};</script>`;
      responseHtml = '{"success":false}';
      expect((await sendWebsiteForm(input, options)).reasonCode).toBe(
        'validation_error',
      );
    });
    it('requests manual captcha handling without calling the send hook', async () => {
      html = form('<div class="g-recaptcha" data-sitekey="key"></div>');
      expect(await sendWebsiteForm(input, options)).toMatchObject({
        status: 'awaiting_manual',
        reasonUk: 'Потрібна капча',
      });
      expect(options.beforeSubmit).not.toHaveBeenCalled();
      expect(posts()).toHaveLength(0);
      expect(options.saveScreenshot).toHaveBeenCalledTimes(2);
    });
    it('honors scanner captcha hints absent from the current DOM', async () => {
      expect(
        (await sendWebsiteForm({ ...input, captcha: 'recaptcha_v3' }, options))
          .status,
      ).toBe('awaiting_manual');
      expect(posts()).toHaveLength(0);
    });
    it('solves captcha before the durable hook and supplies the token', async () => {
      html = form('<div class="h-captcha" data-sitekey="key"></div>');
      options.solveCaptcha = vi.fn(async () => 'test-token');
      options.beforeSubmit = vi.fn(async () => {
        expect(options.solveCaptcha).toHaveBeenCalledTimes(1);
      });
      expect((await sendWebsiteForm(input, options)).status).toBe('sent');
      expect(
        new URLSearchParams(posts()[0]!.body).get('h-captcha-response'),
      ).toBe('test-token');
    });
    it('blocks another domain in a form action before the send hook', async () => {
      html = form('', 'https://evil.example.net/steal');
      expect((await sendWebsiteForm(input, options)).reasonCode).toBe(
        'unsafe_url',
      );
      expect(options.beforeSubmit).not.toHaveBeenCalled();
      expect(posts()).toHaveLength(0);
    });
    it('honors robots on form actions and never submits', async () => {
      rules = 'User-agent: *\nDisallow: /send';
      expect((await sendWebsiteForm(input, options)).reasonCode).toBe(
        'robots_denied',
      );
      expect(options.beforeSubmit).not.toHaveBeenCalled();
      expect(posts()).toHaveLength(0);
    });
    it('keeps native invalid forms behind the send hook', async () => {
      html = form('<input required name="company-id">');
      expect((await sendWebsiteForm(input, options)).reasonCode).toBe(
        'validation_error',
      );
      expect(options.beforeSubmit).not.toHaveBeenCalled();
      expect(posts()).toHaveLength(0);
    });
    it('does not submit when the durable retry guard rejects', async () => {
      options.beforeSubmit = vi.fn(async () => {
        throw new Error('already sent');
      });
      await expect(sendWebsiteForm(input, options)).rejects.toThrow(
        'already sent',
      );
      expect(posts()).toHaveLength(0);
      expect(options.saveScreenshot).toHaveBeenCalledTimes(2);
    });
    it('preserves session cookies and hidden CSRF while filling a required subject', async () => {
      html = form(
        '<input type="hidden" name="csrf" value="token-123"><input name="title" placeholder="Коротко про звернення" required>',
      );
      expect((await sendWebsiteForm(input, options)).status).toBe('sent');
      const submitted = new URLSearchParams(posts()[0]!.body);
      expect(submitted.get('csrf')).toBe('token-123');
      expect(submitted.get('title')).toBe(input.body);
      expect(posts()[0]!.cookie).toContain('sonar_session=test-session');
    });
    it('waits for a delayed AJAX submit instead of stopping at network idle', async () => {
      html =
        form() +
        `<script>document.querySelector('form').onsubmit=e=>{e.preventDefault();setTimeout(()=>fetch('/api/contact',{method:'POST',body:JSON.stringify({message:e.target.message.value})}),900)};</script>`;
      responseHtml = '{"success":true}';
      expect((await sendWebsiteForm(input, options)).status).toBe('sent');
      expect(posts()).toHaveLength(1);
    });
    it('blocks GET side effects during filling before the durable hook', async () => {
      html = form().replace(
        '<textarea name="message"',
        `<textarea oninput="fetch('/premature?message='+encodeURIComponent(this.value))" name="message"`,
      );
      options.beforeSubmit = vi.fn(async () => {
        expect(received.some((req) => req.path.startsWith('/premature'))).toBe(
          false,
        );
      });
      expect((await sendWebsiteForm(input, options)).status).toBe('sent');
      expect(received.some((req) => req.path.startsWith('/premature'))).toBe(
        false,
      );
    });
    it('checks the submit button action override before the durable hook', async () => {
      html = form().replace(
        '<button>',
        '<button formaction="https://external.example.net/send">',
      );
      expect((await sendWebsiteForm(input, options)).reasonCode).toBe(
        'unsafe_url',
      );
      expect(options.beforeSubmit).not.toHaveBeenCalled();
    });
    it('follows a checked same-site thank-you redirect after submission', async () => {
      responseStatus = 302;
      responseLocation = '/thanks';
      expect((await sendWebsiteForm(input, options)).status).toBe('sent');
      expect(posts()).toHaveLength(1);
    });
    it('rejects a visible field validation error even without a known phrase', async () => {
      responseHtml = form() + '<span class="field-error">Email rejected</span>';
      expect((await sendWebsiteForm(input, options)).reasonCode).toBe(
        'validation_error',
      );
    });
    it('submits a Ukrainian FormData message with hidden CSRF and a required title', async () => {
      html = `<form method="post" action="/feedback"><input type="hidden" name="_token" value="csrf-token"><input type="hidden" name="source" value="app_error"><input type="hidden" name="type" value=""><input name="title" required><input type="email" name="contact_email" required><textarea name="message" required></textarea><button>Send</button></form><p id="notice"></p><script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();try{const r=await fetch(e.target.action,{method:'POST',body:new FormData(e.target),credentials:'same-origin',headers:{Accept:'application/json','X-Requested-With':'XMLHttpRequest'}});if(r.ok){e.target.reset();document.querySelector('#notice').textContent='Дякуємо, звернення надіслано.'}}catch{document.querySelector('#notice').textContent='Немає зв’язку з сервером.'}};</script>`;
      responseHtml = '{"ok":true}';
      expect(
        (
          await sendWebsiteForm(
            { ...input, body: 'Тест Sonar, не відповідайте' },
            options,
          )
        ).status,
      ).toBe('sent');
      expect(posts()).toHaveLength(1);
      expect(posts()[0]!.body).toContain('Тест Sonar, не відповідайте');
      expect(posts()[0]!.body).toContain('name="_token"');
      expect(posts()[0]!.cookie).toContain('sonar_session=test-session');
    });
  },
);
