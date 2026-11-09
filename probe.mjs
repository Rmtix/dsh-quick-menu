// Probe the dsh-quick-menu routes on a running test host.
// Usage: node probe.mjs <baseUrl> <path> [method]
const [, , base, path, method = 'GET', tokenArg] = process.argv;

const token = tokenArg ?? process.env.QM_TOKEN ?? '';
const login = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
const cookie = (login.headers.getSetCookie?.() ?? []).map((line) => line.split(';')[0]).join('; ');
console.log('login', login.status, cookie === '' ? '(no cookie)' : '(cookie)');

const response = await fetch(`${base}${path}`, {
  method,
  headers: {
    accept: 'application/json',
    ...(method === 'POST' ? { 'content-type': 'application/json', 'x-dsh-quick-menu': '1' } : {}),
    ...(cookie === '' ? {} : { cookie }),
  },
  ...(method === 'POST' ? { body: '{}' } : {}),
});
console.log(response.status, await response.text());
