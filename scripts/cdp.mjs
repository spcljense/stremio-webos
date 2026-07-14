#!/usr/bin/env node
// Minimal CDP client for the webOS app.
//
//   ssh -N -L 9998:127.0.0.1:9998 -i ~/.ssh/tv_key -p 9922 prisoner@192.168.1.9 &
//   node scripts/cdp.mjs targets
//   node scripts/cdp.mjs eval 'document.title'
//
// Read-only by nature: it just evaluates an expression in the page and prints the
// JSON result. Used to observe live player/subtitle state without a rebuild.
import http from 'http';
import { WebSocket } from 'ws';

const PORT = process.env.CDP_PORT || 9998;

function get(path) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: PORT, path }, r => {
      let b = '';
      r.on('data', c => (b += c));
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(new Error('bad json: ' + b.slice(0, 200))); } });
    }).on('error', rej);
  });
}

async function pickTarget() {
  const list = await get('/json');
  const pages = list.filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!pages.length) throw new Error('no inspectable page (is the app running?)');
  // Prefer the Stremio page over about:blank / splash
  return pages.find(p => /stremio|8080|index/i.test(p.url)) || pages[0];
}

async function evaluate(expr) {
  const t = await pickTarget();
  const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  const result = await new Promise((resolve, reject) => {
    const id = 1;
    const timer = setTimeout(() => reject(new Error('CDP timeout')), 15000);
    ws.on('message', m => {
      const msg = JSON.parse(m.toString());
      if (msg.id !== id) return;
      clearTimeout(timer);
      if (msg.error) return reject(new Error(JSON.stringify(msg.error)));
      const r = msg.result?.result;
      resolve(r?.value !== undefined ? r.value : r);
    });
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression: expr, returnByValue: true, awaitPromise: true },
    }));
  });
  ws.close();
  return result;
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'targets') {
    const l = await get('/json');
    console.log(l.map(t => `${t.type}\t${t.title}\t${t.url}`).join('\n'));
  } else if (cmd === 'eval') {
    const out = await evaluate(rest.join(' '));
    console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
  } else {
    console.log('usage: cdp.mjs targets | eval <expr>');
    process.exit(2);
  }
} catch (e) {
  console.error('ERR: ' + e.message);
  process.exit(1);
}
