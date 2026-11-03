'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { browser, loadModules } = require('./harness.cjs');

function installGroqKey(context, modules) {
    context.localStorage.setItem(modules.config.TOKEN_STORAGE_KEY, JSON.stringify('gsk-offline-test-key'));
    modules.config.GROQ.baseGapMs = 0;
    modules.gemini.gem.gapMs = 0;
}

test('Groq uses Chat Completions through the userscript transport with JSON mode', async () => {
    const context = browser();
    const { modules } = loadModules(context);
    installGroqKey(context, modules);
    const requests = [];
    context.GM_xmlhttpRequest = options => {
        requests.push(options);
        options.onload({
            status: 200,
            responseText: JSON.stringify({ choices: [{ message: { content: '{"desc":"Washing a cup"}' } }] }),
            responseHeaders: 'content-type: application/json\r\n'
        });
        return { abort() {} };
    };

    const result = await modules.gemini.geminiGenerate({
        parts: [{ text: 'Return a JSON object.' }, { inline_data: { mime_type: 'image/jpeg', data: 'ZmFrZQ==' } }],
        schema: { type: 'OBJECT', properties: { desc: { type: 'STRING' } }, required: ['desc'] }
    });

    assert.equal(result, '{"desc":"Washing a cup"}');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(requests[0].headers.Authorization, 'Bearer gsk-offline-test-key');
    const body = JSON.parse(requests[0].data);
    assert.equal(body.model, 'qwen/qwen3.8-27b');
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.messages[0].role, 'system');
    assert.match(body.messages[0].content, /"properties"/);
    assert.deepEqual(body.messages[1].content[1], {
        type: 'image_url',
        image_url: { url: 'data:image/jpeg;base64,ZmFrZQ==' }
    });
    assert.equal(requests[0].url.includes('gsk-offline-test-key'), false);
    assert.equal(requests[0].data.includes('gsk-offline-test-key'), false);
    assert.equal(context.__requests.length, 0, 'GM_xmlhttpRequest should bypass page fetch/CORS');
});

test('Groq rejects invalid credentials and requests over the vision image cap', async () => {
    const context = browser();
    const { modules } = loadModules(context);
    installGroqKey(context, modules);
    context.GM_xmlhttpRequest = options => {
        options.onload({
            status: 401,
            responseText: JSON.stringify({ error: { message: 'Invalid API Key', code: 'invalid_api_key' } }),
            responseHeaders: 'content-type: application/json\r\n'
        });
        return { abort() {} };
    };

    await assert.rejects(
        modules.gemini.geminiGenerate({ parts: [{ text: 'Return JSON.' }] }),
        error => error instanceof modules.gemini.GroqApiError && /Groq API Key/.test(error.message)
    );

    let requestCount = 0;
    context.GM_xmlhttpRequest = () => { requestCount++; };
    await assert.rejects(
        modules.gemini.geminiGenerate({
            parts: Array.from({ length: 4 }, (_, index) => ({ inline_data: { data: `frame-${index}` } }))
        }),
        /Groq giới hạn 3 ảnh/
    );
    assert.equal(requestCount, 0);
});

test('Groq retry delay reads Retry-After and rate-limit response text', () => {
    const { modules } = loadModules();
    assert.equal(modules.gemini.parseRetryMs('', { get: () => '2.5' }), 2500);
    assert.equal(modules.gemini.parseRetryMs('Rate limited; try again in 3s'), 3000);
});

test('four source frames are encoded into one labeled contact sheet', async () => {
    const context = browser();
    const { modules } = loadModules(context);
    const drawnImages = [];
    const loadedSources = [];
    const canvasContext = {
        fillRect() {},
        fillText() {},
        drawImage(image, ...args) { drawnImages.push({ image, args }); }
    };
    const canvas = {
        width: 0,
        height: 0,
        getContext: () => canvasContext,
        toDataURL: () => 'data:image/jpeg;base64,contact-sheet-base64'
    };
    context.document.createElement = tag => {
        if (tag === 'canvas')
            return canvas;
        if (tag === 'img') {
            return {
                width: 640,
                height: 360,
                naturalWidth: 640,
                naturalHeight: 360,
                set src(value) {
                    loadedSources.push(value);
                    this.onload();
                }
            };
        }
        throw new Error('Unexpected element: ' + tag);
    };

    const result = await modules.media.composeFrameContactSheet(['one', 'two', 'three', 'four']);

    assert.equal(result, 'contact-sheet-base64');
    assert.deepEqual(loadedSources, [
        'data:image/jpeg;base64,one',
        'data:image/jpeg;base64,two',
        'data:image/jpeg;base64,three',
        'data:image/jpeg;base64,four'
    ]);
    assert.equal(drawnImages.length, 4);
    assert.equal(canvas.width, 1304);
    assert.equal(canvas.height, 792);
});
