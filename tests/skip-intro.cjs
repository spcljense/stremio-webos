// Requires Playwright and its Chromium browser; run: node tests/skip-intro.cjs
// Exercises the shipped Solid player and navigation code, with playback/API state mocked.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = process.env.FRONTEND_ROOT || path.join(__dirname, '..', 'frontend-webos');

async function mount(page, time = 35000, paused = false) {
    await page.goto('about:blank');
    await page.setContent('<html><head></head><body style="background:#171719;color:white"><div id="root"></div></body></html>');
    for (const file of ['main.js', 'player.chunk.js']) {
        let source = fs.readFileSync(path.join(root, file), 'utf8');
        if (file === 'player.chunk.js') {
            assert(source.includes('C = f(),'));
            source = source.replace('C = f(),', 'C = window.testVideo,');
        }
        await page.addScriptTag({ content: source });
    }
    await page.evaluate(({ time, paused }) => {
        const modules = Object.assign({}, ...self.webpackChunkstremio_theater.map(chunk => chunk[1]));
        const cache = {};
        function req(id) {
            if (cache[id]) return cache[id].exports;
            const module = cache[id] = { exports: {} };
            if (!modules[id]) throw new Error('Missing module ' + id);
            modules[id](module, module.exports, req);
            return module.exports;
        }
        req.d = (exports, getters) => Object.keys(getters).forEach(key => Object.defineProperty(exports, key, { enumerable: true, get: getters[key] }));
        req.r = exports => Object.defineProperty(exports, '__esModule', { value: true });
        req.n = module => { const getter = module && module.__esModule ? () => module.default : () => module; req.d(getter, { a: getter }); return getter; };
        req.o = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
        req.g = window;
        req.p = '';
        req.b = 'http://localhost/';
        const stub = (id, exports) => { cache[id] = { exports }; };
        const noop = () => {};
        stub(5585, { B: () => ({ t: key => key }) });
        stub(1088, { g: () => () => ({}), W6: () => ({ size: () => 1, back: noop, navigate: noop }), lq: () => () => ({ data: { hideNavbar: true } }) });
        window.notices = [];
        stub(6193, { Y: () => ({ show: notice => window.notices.push(notice) }) });
        stub(289, { Vj: () => ({ name: 'webos' }), aJ: () => 0 });
        const solid = req(9225), dom = req(9151);
        const [state, setState] = solid.n5({
            manifest: { name: 'WebOsVideo' }, stream: {}, videoParams: null,
            loaded: true, paused, time, duration: 1800000,
            buffering: false, buffered: 1800000, playbackSpeed: 1,
            selectedSubtitlesTrackId: null, selectedExtraSubtitlesTrackId: null,
            selectedAudioTrackId: null, subtitlesTracks: [], extraSubtitlesTracks: [],
            audioTracks: [], extraSubtitlesDelay: 0
        });
        window.commands = [];
        window.publishVideoState = update => setState(s => ({ ...s, ...update }));
        window.deferSeek = false;
        window.testVideo = {
            state, ready: () => true, loaded: () => true, error: () => null, ended: () => false,
            setProp: (key, value) => { window.commands.push([key, value]); if (key === "time" && window.deferSeek) return; setState(s => ({ ...s, [key]: value })); },
            load: noop, unload: noop, addExtraSubtitlesTracks: noop, disableSubtitlesTracks: noop,
            selectAudioTrack: noop, selectSubtitlesTrack: noop, selectExtraSubtitlesTrack: noop
        };
        const playerState = {
            title: 'Skip Intro regression fixture', nextVideo: null, metaItem: null, streamState: null,
            introOutro: { intro: { from: 30000, to: 90000 }, outro: 1700000 }, subtitles: []
        };
        const settings = { bingeWatching: false, seekTimeDuration: 10000, nextVideoNotificationDuration: 30000, audioLanguage: null, secondaryAudioLanguage: null, subtitlesLanguage: null, secondarySubtitlesLanguage: null };
        stub(9132, {
            Pj: () => ({ theme: { animationsClass: () => ({}) } }),
            gK: () => ({
                ctx: { settings: () => settings, updateSettings: noop },
                player: { state: () => playerState, loaded: () => true, load: noop, unload: noop, ended: noop, updatePaused: noop, updateVideoParams: noop, updateSeek: noop, updateTime: noop },
                streamingServer: { state: () => ({}) }
            })
        });
        const nav = req(6870), Player = req(7826).default;
        dom.XX(() => solid.a0(nav.i9, { get children() { return solid.a0(Player, {}); } }), document.getElementById('root'));
    }, { time, paused });
    await page.waitForTimeout(3300); // The shipped controls hide after three seconds.
}

(async () => {
    const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE, args: ['--no-sandbox'] } : {}), ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
    try {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await mount(page);
        await page.evaluate(() => { window.deferSeek = true; });
        await page.keyboard.press('Enter');
        await page.evaluate(() => publishVideoState({ time: 36000 }));
        assert.equal(await page.getByText('PLAYER_SKIP_INTRO', { exact: true }).count(), 0, 'Skip must not remount while the seek is pending');
        assert.equal(await page.locator('[focused]').evaluate(el => !!el.closest('[class*="overlay-"]')), true, 'controls receive focus during a pending seek');
        await page.keyboard.press('Enter');
        assert.equal(await page.evaluate(() => commands.filter(([key]) => key === 'time').length), 1, 'repeat OK must not issue another skip');
        await page.evaluate(() => publishVideoState({ time: 90000 }));
        await page.waitForTimeout(3300);
        assert.equal(await page.getByText('PLAYER_SKIP_INTRO', { exact: true }).count(), 0, 'intro end is outside the skippable range');
        assert.equal(await page.evaluate(() => notices.length), 0);
        console.log('PASS: delayed seek cannot remount Skip or trap repeated OK');
        await mount(page);
        await page.evaluate(() => { window.deferSeek = true; });
        await page.keyboard.press('Enter');
        await page.evaluate(() => publishVideoState({ time: 36000 }));
        await page.waitForTimeout(8200);
        assert.equal(await page.evaluate(() => notices.length), 1, 'failed seek gives feedback');
        assert.equal(await page.locator('[focused]').evaluate(el => !!el.closest('[class*="overlay-"]')), true, 'failed seek restores controls');
        await page.waitForTimeout(3300);
        assert.deepEqual(await page.locator('[focused]').allTextContents(), ['PLAYER_SKIP_INTRO'], 'failed seek remains retryable');
        await page.evaluate(() => { window.deferSeek = false; });
        await page.keyboard.press('Enter');
        assert.equal(await page.evaluate(() => testVideo.state().time), 90000);
        console.log('PASS: failed seek gives feedback and permits a successful retry');
        for (const keyCode of [40, 29461]) {
            await mount(page);
            assert.deepEqual(await page.locator('[focused]').allTextContents(), ['PLAYER_SKIP_INTRO']);
            await page.evaluate(keyCode => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode, bubbles: true, cancelable: true })), keyCode);
            assert.equal(await page.locator('[focused]').evaluate(el => !!el.closest('[class*="overlay-"]')), true, 'Down transfers focus to player controls');
            assert.equal(await page.getByText('PLAYER_SKIP_INTRO', { exact: true }).count(), 0);
            assert.equal(await page.evaluate(() => testVideo.state().paused), false, 'Down must not pause');
            assert.equal(await page.evaluate(() => testVideo.state().time), 35000, 'Down must not skip');
            await page.evaluate(() => testVideo.setProp('time', 36000));
            assert.equal(await page.locator('[focused]').evaluate(el => !!el.closest('[class*="overlay-"]')), true, 'playback update must not steal focus');
            await page.waitForTimeout(3300);
            assert.deepEqual(await page.locator('[focused]').allTextContents(), ['PLAYER_SKIP_INTRO'], 'Skip remains available after controls hide');
            await page.keyboard.press('Enter');
            assert.equal(await page.evaluate(() => testVideo.state().time), 90000);
            console.log('PASS: Down reveals controls without pause/seek, retains focus, and returns to Skip: ' + keyCode);
        }
        await mount(page, 35000, true);
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(3300);
        assert.equal(await page.locator('[focused]').evaluate(el => !!el.closest('[class*="overlay-"]')), true, 'paused controls remain available');
        assert.equal(await page.evaluate(() => testVideo.state().paused), true);
        console.log('PASS: Down preserves pause and controls focus');
        await mount(page, 1710000);
        await page.keyboard.press('ArrowDown');
        assert.equal(await page.locator('[focused]').evaluate(el => !!el.closest('[class*="overlay-"]')), true);
        assert.equal(await page.evaluate(() => testVideo.state().time), 1710000);
        console.log('PASS: Down also escapes Skip Outro without seeking');
        for (const keyCode of [13, 29443, 65376]) {
            await mount(page);
            assert.deepEqual(await page.locator('[focused]').allTextContents(), ['PLAYER_SKIP_INTRO']);
            if (process.env.TEST_SCREENSHOT && keyCode === 13) await page.screenshot({ path: process.env.TEST_SCREENSHOT });
            if (keyCode === 13) await page.keyboard.press('Enter');
            else await page.evaluate(keyCode => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode, bubbles: true, cancelable: true })), keyCode);
            assert.equal(await page.evaluate(() => testVideo.state().time), 90000, 'OK must seek to the intro end');
            assert.equal(await page.evaluate(() => testVideo.state().paused), false, 'skip must preserve playback');
            assert.equal(await page.getByText('PLAYER_SKIP_INTRO', { exact: true }).count(), 0, 'popup closes after skip');
            console.log('PASS: Skip Intro with remote key ' + keyCode);
        }
        await mount(page);
        await page.getByText('PLAYER_SKIP_INTRO', { exact: true }).click();
        assert.equal(await page.evaluate(() => testVideo.state().time), 90000);
        assert.equal(await page.evaluate(() => testVideo.state().paused), false);
        console.log('PASS: Skip Intro with pointer');

        await mount(page, 35000, true);
        await page.keyboard.press('Enter');
        assert.equal(await page.evaluate(() => testVideo.state().time), 90000);
        assert.equal(await page.evaluate(() => testVideo.state().paused), true);
        console.log('PASS: Skip Intro preserves an existing pause');

        await mount(page, 1710000);
        assert.deepEqual(await page.locator('[focused]').allTextContents(), ['PLAYER_SKIP_OUTRO']);
        await page.keyboard.press('Enter');
        assert.equal(await page.evaluate(() => testVideo.state().time), 1800000);
        console.log('PASS: Skip Outro with remote OK');

        await mount(page, 1710000);
        await page.keyboard.press('ArrowLeft');
        assert.deepEqual(await page.locator('[focused]').allTextContents(), ['PLAYER_NEXT_VIDEO_BUTTON_DISMISS']);
        await page.keyboard.press('Enter');
        assert.equal(await page.evaluate(() => testVideo.state().time), 1710000);
        assert.equal(await page.getByText('PLAYER_SKIP_OUTRO', { exact: true }).count(), 0);
        assert.equal(await page.locator('[focused]').evaluate(element => !!element.closest('[class*="overlay-"]')), true, 'normal controls regain focus after dismiss');
        console.log('PASS: Dismiss Outro with remote and restore playback controls');

        await mount(page, 120000);
        await page.keyboard.press('Enter');
        assert.equal(await page.evaluate(() => testVideo.state().paused), true);
        assert.equal(await page.evaluate(() => testVideo.state().time), 120000);
        console.log('PASS: Normal remote playback controls outside a skip segment');
        assert.deepEqual(errors, [], 'no browser exceptions');
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
