// Barebones live-list page (Task 1.3 tracer bullet — Phase 5 replaces this with
// the real ui/dist bundle). Inline HTML with the token injected server-side.
// SSE is consumed via fetch + a ReadableStream reader (NOT native EventSource,
// which can't send the auth header). Ugly on purpose.

import { TOKEN_HEADER } from '../shared/index.js';

/** Render the inline HTML page with the server token injected. */
export function renderPage(token: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>agent-lens (tracer bullet)</title>
</head>
<body>
  <h1>agent-lens — live events</h1>
  <ul id="events"></ul>
  <script>
    const TOKEN = ${JSON.stringify(token)};
    const HEADER = ${JSON.stringify(TOKEN_HEADER)};
    const list = document.getElementById('events');

    function render(e) {
      const li = document.createElement('li');
      li.textContent = e.seq + ' ' + e.source + ' ' + (e.hook_name || '') + ' ' + e.event_id;
      list.appendChild(li);
    }

    async function hydrate() {
      const res = await fetch('/api/events', { headers: { [HEADER]: TOKEN } });
      const events = await res.json();
      for (const e of events) render(e);
    }

    async function stream() {
      const res = await fetch('/api/stream', { headers: { [HEADER]: TOKEN } });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\\n\\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = frame.split('\\n').find((l) => l.startsWith('data:'));
          if (!dataLine) continue;
          try { render(JSON.parse(dataLine.slice(5).trim())); } catch {}
        }
      }
    }

    hydrate().then(stream);
  </script>
</body>
</html>`;
}
