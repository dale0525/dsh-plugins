/**
 * The login page served when `auth` is `password`.
 *
 * Self-contained HTML with no external assets: it is served from a listener that
 * may be the only thing reachable, and a stylesheet or font fetched from a CDN
 * would fail on a LAN with no internet — leaving an unstyled page that looks
 * broken rather than protected.
 *
 * The password is never rendered; the only state the page carries is the error
 * text, which is a fixed string chosen by the caller.
 *
 * @module @logictan/dsh-lan-access/login-page
 */

/**
 * Escape text for HTML text and attribute positions.
 *
 * @param value - untrusted text.
 * @returns the escaped text.
 */
export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Render the login page.
 *
 * @param options.error - message to show above the field, when a previous attempt failed.
 * @param options.action - form target, a path on this listener.
 * @returns the complete HTML document.
 */
export function loginPageHtml(options = {}) {
  const action = escapeHtml(options.action ?? '/__dsh-lan-access/login');
  const error = options.error === undefined ? '' : `<p class="error" role="alert">${escapeHtml(options.error)}</p>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>DSH 访问密码</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #f6f7f9;
    color: #1b1d21;
  }
  form {
    width: 100%;
    max-width: 340px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 28px 24px;
    background: #fff;
    border: 1px solid #e3e5e9;
    border-radius: 12px;
    box-shadow: 0 8px 24px rgb(20 24 32 / 8%);
  }
  h1 { margin: 0; font-size: 17px; font-weight: 600; }
  p { margin: 0; font-size: 13px; color: #6b7280; }
  p.error { color: #b42318; }
  input {
    width: 100%;
    padding: 10px 12px;
    font: inherit;
    color: inherit;
    background: #fff;
    border: 1px solid #d5d8de;
    border-radius: 8px;
  }
  input:focus { outline: 2px solid #2563eb; outline-offset: -1px; border-color: transparent; }
  button {
    padding: 10px 12px;
    font: inherit;
    font-weight: 600;
    color: #fff;
    background: #2563eb;
    border: 0;
    border-radius: 8px;
    cursor: pointer;
  }
  button:hover { background: #1d4ed8; }
  @media (prefers-color-scheme: dark) {
    body { background: #16181c; color: #e8eaed; }
    form { background: #1f2126; border-color: #2f3238; box-shadow: none; }
    p { color: #9aa1ab; }
    p.error { color: #f97066; }
    input { background: #16181c; border-color: #3a3e45; }
    button { background: #3b82f6; }
    button:hover { background: #2563eb; }
  }
</style>
</head>
<body>
<form method="post" action="${action}">
  <h1>DSH 访问密码</h1>
  <p>这台 DSH 只对输入了访问密码的浏览器开放。</p>
  ${error}
  <input type="password" name="password" autocomplete="current-password" placeholder="访问密码" autofocus required>
  <button type="submit">进入</button>
</form>
</body>
</html>
`;
}
