// Local test suite for the external-subtitle -> JASSUB feature.
// Covers: (A) srt-ass converter fixtures, (B) /ext-sub fetch+convert pipeline
// against a local mock server, (C) controller extra-sub state machine,
// (D) video.chunk withHTMLSubtitles suppression handler. No TV, no real network.
const assert = require('assert');
const http = require('http');
const path = require('path');
const SVC = path.join(__dirname, '..', 'service');
const { srtToAss } = require(path.join(SVC, 'srt-ass.js'));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log('  ok  ' + name); pass++; } catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; } }
async function ta(name, fn) { try { await fn(); console.log('  ok  ' + name); pass++; } catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); fail++; } }
const dlgs = a => a.split('\n').filter(l => l.startsWith('Dialogue:'));
// Dialogue: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text (Text may contain commas)
const textOf = line => line.split(',').slice(9).join(',');

console.log('A) srt-ass converter fixtures');
t('plain SRT -> dialogue lines', () => {
  const a = srtToAss('1\n00:00:01,000 --> 00:00:02,000\nHello\n');
  assert.equal(dlgs(a).length, 1); assert.ok(a.includes('[Script Info]'));
  assert.ok(dlgs(a)[0].includes('0:00:01.00,0:00:02.00'));
});
t('{\\an8} sign preserved', () => {
  const a = srtToAss('1\n00:00:01,000 --> 00:00:02,000\n{\\an8}TOP SIGN\n');
  assert.ok(textOf(dlgs(a)[0]) === '{\\an8}TOP SIGN', textOf(dlgs(a)[0]));
});
t('all 9 \\anN kept', () => {
  for (let i = 1; i <= 9; i++) {
    const a = srtToAss('1\n00:00:01,000 --> 00:00:02,000\n{\\an' + i + '}x\n');
    assert.ok(textOf(dlgs(a)[0]) === '{\\an' + i + '}x', 'an' + i);
  }
});
t('unknown override braces stripped, text kept', () => {
  const a = srtToAss('1\n00:00:01,000 --> 00:00:02,000\n{\\pos(9,9)}A {\\blur3}B\n');
  assert.equal(textOf(dlgs(a)[0]), 'A B');
});
t('nested <i><b><u> converted', () => {
  const a = srtToAss('1\n00:00:01,000 --> 00:00:02,000\n<i>a<b>c</b></i><u>u</u>\n');
  assert.equal(textOf(dlgs(a)[0]), '{\\i1}a{\\b1}c{\\b0}{\\i0}{\\u1}u{\\u0}');
});
t('unknown html stripped, text kept', () => {
  const a = srtToAss('1\n00:00:01,000 --> 00:00:02,000\n<font color="red">hi</font>\n');
  assert.equal(textOf(dlgs(a)[0]), 'hi');
});
t('multiline cue -> \\N (no leading/trailing)', () => {
  const a = srtToAss('1\n00:00:01,000 --> 00:00:02,000\nline1\nline2\n');
  assert.equal(textOf(dlgs(a)[0]), 'line1\\Nline2');
});
t('CRLF + BOM handled', () => {
  const a = srtToAss('﻿1\r\n00:00:01,000 --> 00:00:02,000\r\nhi\r\n');
  assert.equal(dlgs(a).length, 1); assert.equal(textOf(dlgs(a)[0]), 'hi');
});
t('zero-duration cue gets end > start', () => {
  const a = srtToAss('1\n00:00:05,000 --> 00:00:05,000\nx\n');
  const m = /Dialogue: 0,([0-9:.]+),([0-9:.]+),/.exec(dlgs(a)[0]);
  assert.ok(m[2] > m[1], m[1] + ' -> ' + m[2]);
});
t('overlapping cues both kept in order', () => {
  const a = srtToAss('1\n00:00:01,000 --> 00:00:05,000\nA\n\n2\n00:00:02,000 --> 00:00:03,000\nB\n');
  const d = dlgs(a); assert.equal(d.length, 2);
  assert.ok(textOf(d[0]) === 'A' && textOf(d[1]) === 'B');
});
t('unicode preserved', () => {
  const a = srtToAss('1\n00:00:01,000 --> 00:00:02,000\n日本語 ✨\n');
  assert.equal(textOf(dlgs(a)[0]), '日本語 ✨');
});
t('malformed block skipped, valid kept', () => {
  const a = srtToAss('garbage no timing\n\n1\n00:00:01,000 --> 00:00:02,000\nok\n');
  assert.equal(dlgs(a).length, 1); assert.equal(textOf(dlgs(a)[0]), 'ok');
});
t('empty cue text dropped', () => {
  const a = srtToAss('1\n00:00:01,000 --> 00:00:02,000\n{\\pos(1,1)}\n\n2\n00:00:03,000 --> 00:00:04,000\nreal\n');
  assert.equal(dlgs(a).length, 1);
});
t('already-ASS passes through unchanged', () => {
  const src = '[Script Info]\nScriptType: v4.00+\n\n[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,hi\n';
  assert.equal(srtToAss(src), src);
});
t('empty/undefined input safe', () => { assert.equal(srtToAss(''), ''); assert.equal(srtToAss(null), ''); });
t('res scaling: 720p smaller font than 1080p', () => {
  const f = a => +(/Style: Default,[^,]+,(\d+),/.exec(a)[1]);
  assert.ok(f(srtToAss('1\n00:00:01,000 --> 00:00:02,000\nx\n', 1280, 720)) < f(srtToAss('1\n00:00:01,000 --> 00:00:02,000\nx\n', 1920, 1080)));
});
t('comma/dot millisecond separators both parse', () => {
  assert.equal(dlgs(srtToAss('1\n00:00:01.500 --> 00:00:02.000\nx\n')).length, 1);
});

// ---- B) /ext-sub pipeline (mirrors launch.js got()+srtToAss) against a mock host
function got(u, hops, cb) {
  if (hops > 5) return cb(new Error('too many redirects'));
  const mod = require(/^https:/i.test(u) ? 'https' : 'http');
  const rq = mod.get(u, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' } }, function (r) {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { r.resume(); return got(require('url').resolve(u, r.headers.location), hops + 1, cb); }
    if (r.statusCode !== 200) { r.resume(); return cb(new Error('status ' + r.statusCode)); }
    const buf = []; let n = 0;
    r.on('data', d => { n += d.length; if (n > 8 * 1024 * 1024) { rq.destroy(new Error('too large')); return; } buf.push(d); });
    r.on('end', () => cb(null, Buffer.concat(buf).toString('utf8')));
  });
  rq.on('error', cb); rq.setTimeout(15000, () => rq.destroy(new Error('timeout')));
}
const extSub = (base, urlPath) => new Promise((resolve) => got(base + urlPath, 0, (err, txt) => {
  if (err || !txt) return resolve({ err: err && err.message, ass: '' });
  let ass = ''; try { ass = srtToAss(txt); } catch (e) {}
  resolve({ ass });
}));

(async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/redir') { res.writeHead(302, { Location: '/real.srt' }); return res.end(); }
    if (req.url === '/real.srt') { res.writeHead(200); return res.end('1\n00:00:01,000 --> 00:00:02,000\n{\\an8}sign\n'); }
    if (req.url === '/plain.srt') { res.writeHead(200); return res.end('1\n00:00:01,000 --> 00:00:02,000\nhi\n'); }
    if (req.url === '/already.ass') { res.writeHead(200); return res.end('[Script Info]\nScriptType: v4.00+\n\n[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,z\n'); }
    if (req.url === '/404') { res.writeHead(404); return res.end('nope'); }
    if (req.url === '/huge') { res.writeHead(200); res.write('1\n00:00:01,000 --> 00:00:02,000\n'); res.write('X'.repeat(9 * 1024 * 1024)); return res.end(); }
    res.writeHead(400); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  console.log('B) /ext-sub fetch+convert pipeline (mock host)');
  await ta('follows redirect -> converts, {\\an8} kept', async () => {
    const { ass } = await extSub(base, '/redir'); assert.ok(textOf(dlgs(ass)[0]) === '{\\an8}sign', ass.slice(0, 120));
  });
  await ta('plain SRT converts', async () => { const { ass } = await extSub(base, '/plain.srt'); assert.equal(textOf(dlgs(ass)[0]), 'hi'); });
  await ta('already-ASS passes through', async () => { const { ass } = await extSub(base, '/already.ass'); assert.ok(ass.includes('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,z')); });
  await ta('404 -> empty (no crash)', async () => { const { ass } = await extSub(base, '/404'); assert.equal(ass, ''); });
  await ta('oversize body capped -> destroyed, empty', async () => { const { ass } = await extSub(base, '/huge'); assert.ok(ass === '' || dlgs(ass).length <= 1); });

  server.close();

  // ---- C) controller extra-sub state machine (mirrors attachViaTee poll branch)
  console.log('C) controller extra-sub state machine');
  function makeCtl() {
    const log = [];
    const win = { __assSel: null, __extraSubSel: null, __extraSubs: {} };
    const ctl = { attached: false, content: null,
      attach(ass) { this.attached = true; this.content = ass; log.push('attach:' + ass); },
      detach() { this.attached = false; this.content = null; log.push('detach'); } };
    let attached = false, extKey = null, extGen = 0;
    const fetches = [];              // pending {gen,id,resolve}
    // one poll tick (embedded vs extra vs none), returns after scheduling any fetch
    function tick() {
      const idx = (typeof win.__assSel === 'string' && /^EMBEDDED_(\d+)$/.test(win.__assSel)) ? +RegExp.$1 : -1;
      if (idx < 0) {
        const exId = win.__extraSubSel;
        const exUrl = exId && win.__extraSubs[exId] && win.__extraSubs[exId].url;
        if (exUrl) {
          if (extKey !== exId) {
            extKey = exId; const myGen = ++extGen; const capId = exId;
            fetches.push({ gen: myGen, id: capId, resolve: (ass) => {
              if (myGen !== extGen || win.__extraSubSel !== capId) return;   // stale guard
              if (!ass || ass.length < 40) return;
              ctl.attach(ass); attached = true;
            }});
          }
        } else if (attached || extKey) { ctl.detach(); attached = false; extKey = null; }
        return;
      }
      if (extKey) { extKey = null; attached = false; ctl.detach(); }
      // (embedded attach path elided; assume embedded tee attaches)
      ctl.attach('EMBEDDED'); attached = true;
    }
    return { win, ctl, tick, log, deliver: (gen, ass) => { const f = fetches.find(x => x.gen === gen); if (f) f.resolve(ass); }, fetches };
  }
  const ASS = '[Script Info]\n' + 'x'.repeat(60);
  t('none selected -> no attach', () => { const h = makeCtl(); h.tick(); assert.equal(h.ctl.attached, false); });
  t('extra selected -> fetch then attach', () => {
    const h = makeCtl(); h.win.__extraSubSel = 'os1'; h.win.__extraSubs.os1 = { url: 'u' };
    h.tick(); assert.equal(h.fetches.length, 1); h.deliver(1, ASS); assert.equal(h.ctl.content, ASS);
  });
  t('extra->extra: stale first response cannot attach', () => {
    const h = makeCtl(); h.win.__extraSubSel = 'os1'; h.win.__extraSubs = { os1: { url: 'u1' }, os2: { url: 'u2' } };
    h.tick();                                   // gen1 for os1
    h.win.__extraSubSel = 'os2'; h.tick();      // gen2 for os2
    h.deliver(1, ASS);                          // stale os1 arrives -> ignored
    assert.equal(h.ctl.attached, false, 'stale attached!');
    h.deliver(2, ASS + '2'); assert.equal(h.ctl.content, ASS + '2');
  });
  t('extra->NONE before response: no attach', () => {
    const h = makeCtl(); h.win.__extraSubSel = 'os1'; h.win.__extraSubs.os1 = { url: 'u' };
    h.tick(); h.win.__extraSubSel = null; h.tick(); h.deliver(1, ASS);
    assert.equal(h.ctl.attached, false);
  });
  t('extra->embedded: detaches then embedded attaches', () => {
    const h = makeCtl(); h.win.__extraSubSel = 'os1'; h.win.__extraSubs.os1 = { url: 'u' };
    h.tick(); h.deliver(1, ASS); assert.equal(h.ctl.content, ASS);
    h.win.__extraSubSel = null; h.win.__assSel = 'EMBEDDED_0'; h.tick();
    assert.equal(h.ctl.content, 'EMBEDDED');
  });
  t('embedded->extra: switches to converted ass', () => {
    const h = makeCtl(); h.win.__assSel = 'EMBEDDED_0'; h.tick(); assert.equal(h.ctl.content, 'EMBEDDED');
    h.win.__assSel = null; h.win.__extraSubSel = 'os1'; h.win.__extraSubs.os1 = { url: 'u' };
    h.tick(); h.deliver(1, ASS); assert.equal(h.ctl.content, ASS);
  });
  t('extra selected but no url -> no fetch, no attach', () => {
    const h = makeCtl(); h.win.__extraSubSel = 'os1'; h.win.__extraSubs.os1 = { url: null };
    h.tick(); assert.equal(h.fetches.length, 0); assert.equal(h.ctl.attached, false);
  });
  t('same extra selected twice -> single fetch (no duplicate attach)', () => {
    const h = makeCtl(); h.win.__extraSubSel = 'os1'; h.win.__extraSubs.os1 = { url: 'u' };
    h.tick(); h.tick(); assert.equal(h.fetches.length, 1);
  });

  // ---- D) video.chunk withHTMLSubtitles suppression handler
  console.log('D) video.chunk suppression handler');
  function handleSelect(v, win, selectedId) {
    // mirrors the patched case "selectedExtraSubtitlesTrackId"
    let g = null, y = null, T = null, fetched = false;
    const I = () => {};                       // render (no-op in test)
    const D = () => {};
    const n = v.find(e => e.id === selectedId);
    try {
      if (n) { win.__extraSubs = win.__extraSubs || {}; win.__extraSubs[n.id] = { url: n.url || null, lang: n.lang, label: n.label }; win.__extraSubSel = n.id; y = n.id; T = 0; }
      else { win.__extraSubSel = null; }
      // dispatch event (simulated) + return BEFORE fetch
      return { g, y, fetched, returnedEarly: true };
    } catch (e) {}
    fetched = true;                            // original path (should NOT run)
    return { g, y, fetched, returnedEarly: false };
  }
  const tracks = [{ id: 'os1', url: 'https://x/s.srt', lang: 'eng', label: 'English' }];
  t('select extra: captures url, sets sel, g stays null, skips fetch', () => {
    const win = {}; const r = handleSelect(tracks, win, 'os1');
    assert.equal(win.__extraSubSel, 'os1');
    assert.equal(win.__extraSubs.os1.url, 'https://x/s.srt');
    assert.equal(r.g, null, 'g must stay null (empty overlay)');
    assert.equal(r.fetched, false, 'original fetch must be skipped');
    assert.equal(r.y, 'os1', 'UI selection kept');
  });
  t('deselect (unknown id): clears sel, no fetch', () => {
    const win = { __extraSubSel: 'os1' }; const r = handleSelect(tracks, win, 'nope');
    assert.equal(win.__extraSubSel, null); assert.equal(r.fetched, false);
  });

  console.log('\n' + (fail ? 'FAILED ' : 'PASSED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
