'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { browser, loadModules } = require('./harness.cjs');

class FakeElement {
    constructor(tag, elements) {
        this.tagName = tag.toUpperCase();
        this.elements = elements;
        this.children = [];
        this.listeners = Object.create(null);
        this.attributes = Object.create(null);
        this.style = {};
        this.parentElement = null;
        this.textContent = '';
        this.value = '';
        this.checked = false;
        this.disabled = false;
        this.id = '';
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] || null; }
    addEventListener(name, callback) {
        (this.listeners[name] || (this.listeners[name] = [])).push(callback);
    }
    appendChild(child) {
        if (child.parentElement) {
            const oldIndex = child.parentElement.children.indexOf(child);
            if (oldIndex >= 0)
                child.parentElement.children.splice(oldIndex, 1);
        }
        this.children.push(child);
        child.parentElement = this;
        this.register(child);
        return child;
    }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    register(node) {
        if (node.id)
            this.elements.set(node.id, node);
        (node.children || []).forEach(child => this.register(child));
    }
    async click() {
        if (this.disabled)
            return;
        for (const callback of this.listeners.click || [])
            await callback.call(this, { target: this });
    }
    async trigger(name) {
        for (const callback of this.listeners[name] || [])
            await callback.call(this, { target: this });
    }
    insertAdjacentElement(_position, element) {
        this.register(element);
        element.parentElement = this;
        return element;
    }
    remove() {
        if (this.parentElement) {
            const index = this.parentElement.children.indexOf(this);
            if (index >= 0)
                this.parentElement.children.splice(index, 1);
        }
        const unregister = node => {
            if (node.id && this.elements.get(node.id) === node)
                this.elements.delete(node.id);
            (node.children || []).forEach(unregister);
        };
        unregister(this);
        this.parentElement = null;
    }
}

function installDom(context) {
    const elements = new Map();
    context.document.body = new FakeElement('body', elements);
    context.document.createElement = tag => new FakeElement(tag, elements);
    context.document.getElementById = id => elements.get(id) || null;
    return elements;
}

function installTimeline(modules, video = { duration: 20, currentSrc: 'https://cdn.example/video.mp4' }) {
    const sought = [];
    const mutations = [];
    let videos = [video];
    let activeStart = 0, activeEnd = 0;
    modules.config.AUTOCUT.segLen = 50;
    Object.defineProperty(modules.timeline, 'getVideos', { value: () => videos });
    Object.defineProperty(modules.timeline, 'seekTo', { value: async start => { sought.push(start); mutations.push('seek'); return true; } });
    Object.defineProperty(modules.timeline, 'waitEnabled', { value: async () => ({}) });
    Object.defineProperty(modules.timeline, 'createSegmentAt', { value: async start => { mutations.push('create'); activeStart = start; return true; } });
    Object.defineProperty(modules.timeline, 'selectSegmentAt', { value: async start => { mutations.push('select'); activeStart = start; return true; } });
    Object.defineProperty(modules.timeline, 'trimTailTo', { value: async (start, end) => { mutations.push('trim'); activeStart = start; activeEnd = end; return true; } });
    Object.defineProperty(modules.timeline, 'extendByDrag', { value: async () => { mutations.push('extend'); return true; } });
    Object.defineProperty(modules.timeline, 'extendByMerge', { value: async () => { mutations.push('merge'); return 0; } });
    Object.defineProperty(modules.timeline, 'readActiveEpisodeRange', { value: () => ({ start: activeStart, end: activeEnd, text: `${activeStart}–${activeEnd}` }) });
    Object.defineProperty(modules.runtime, 'bgBegin', { value: () => {} });
    Object.defineProperty(modules.runtime, 'bgEnd', { value: () => {} });
    Object.defineProperty(modules.runtime, 'notifyBg', { value: () => {} });
    return {
        sought,
        mutations,
        setVideos(value) { videos = value; }
    };
}

function dispatchManualShortcut(context, key, target = context.document.body) {
    const listener = context.__listeners.find(([type, , capture]) => type === 'keydown' && capture === true);
    assert.ok(listener, 'Q/W shortcut listener is registered');
    let prevented = false;
    let stopped = false;
    listener[1]({
        key,
        code: key.toUpperCase() === 'Q' ? 'KeyQ' : 'KeyW',
        target,
        repeat: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        preventDefault: () => { prevented = true; },
        stopPropagation: () => { stopped = true; }
    });
    return { prevented, stopped };
}

function findByClass(root, className) {
    if (!root)
        return null;
    if (String(root.className || '').split(/\s+/).includes(className))
        return root;
    for (const child of root.children || []) {
        const found = findByClass(child, className);
        if (found)
            return found;
    }
    return null;
}

test('cut suggestions stay on the timeline until cancelled and never mutate segments', () => {
    const context = browser();
    const elements = installDom(context);
    const { modules } = loadModules(context);
    const { sought, mutations } = installTimeline(modules);
    const highlighted = [];
    let clearedHighlights = 0;
    Object.defineProperty(modules.timeline, 'showSuggestionRanges', {
        value: ranges => {
            highlighted.push(ranges.map(range => ({ ...range })));
            return true;
        }
    });
    Object.defineProperty(modules.timeline, 'clearSuggestionRanges', {
        value: () => { clearedHighlights++; return true; }
    });
    const ranges = [
        { start: 1, end: 3, frames: ['discarded-frame-data'] },
        { start: 4, end: 8, frames: ['discarded-frame-data'] }
    ];

    assert.equal(modules.autoCut.runAutoCutFromTimes(ranges, { sourceLabel: 'R2 Handtrack' }), true);
    assert.equal(modules.autoCut.hasActiveSuggestions, true);
    assert.deepEqual(highlighted, [[{ start: 1, end: 3 }, { start: 4, end: 8 }]]);
    assert.equal(modules.autoCut.loadedJsonName, 'R2 Handtrack');
    assert.equal(elements.has('tb-cut-preview'), false);
    assert.deepEqual(mutations, []);

    assert.equal(modules.autoCut.cancelSuggestions(), true);
    assert.equal(modules.autoCut.hasActiveSuggestions, false);
    assert.equal(modules.autoCut.loadedCutTimes.length, 0);
    assert.equal(clearedHighlights, 1);
    assert.deepEqual(sought, []);
    assert.deepEqual(mutations, []);
});

test('Q/W shortcuts show a cancelable suggestion and reject a changed video', async () => {
    const context = browser();
    const elements = installDom(context);
    const { modules } = loadModules(context);
    const video = { duration: 60, currentTime: 12.4, currentSrc: 'https://cdn.example/video.mp4' };
    const { sought, mutations } = installTimeline(modules, video);
    Object.defineProperty(modules.timeline, 'getEpisodeRows', { value: () => [{}] });
    let highlighted = null;
    let highlightCount = 0;
    let cleared = 0;
    Object.defineProperty(modules.timeline, 'showSuggestionRanges', {
        value: ranges => {
            highlightCount++;
            highlighted = Array.from(ranges, range => ({ start: range.start, end: range.end }));
            return true;
        }
    });
    Object.defineProperty(modules.timeline, 'clearSuggestionRanges', {
        value: () => { cleared++; return true; }
    });
    const cutRow = new FakeElement('div', elements);
    cutRow.id = 'tbp-row-cut';
    elements.set(cutRow.id, cutRow);
    Object.defineProperty(modules.panel, 'ensurePanel', { value: () => true });

    modules.r2Bridge.injectR2Btns();
    modules.r2Bridge.init();
    assert.deepEqual(dispatchManualShortcut(context, 'q'), { prevented: true, stopped: true });
    assert.match(elements.get('tb-r2-toast').textContent, /điểm bắt đầu 00:00:12/i);

    video.currentTime = 17.8;
    assert.deepEqual(dispatchManualShortcut(context, 'w'), { prevented: true, stopped: true });
    assert.deepEqual(highlighted, [{ start: 12.4, end: 17.8 }]);
    assert.equal(modules.autoCut.hasActiveSuggestions, true);
    assert.equal(modules.autoCut.loadedJsonName, 'Manual Q/W');
    assert.equal(elements.get('tb-inject-r2-cancel').disabled, false);
    assert.match(elements.get('tb-r2-toast').textContent, /00:00:12–00:00:17/);
    assert.deepEqual(sought, []);
    assert.deepEqual(mutations, []);

    video.currentTime = 25;
    dispatchManualShortcut(context, 'q');
    assert.match(elements.get('tb-r2-toast').textContent, /gợi ý #2/i);
    video.currentTime = 30;
    dispatchManualShortcut(context, 'w');
    assert.deepEqual(highlighted, [{ start: 12.4, end: 17.8 }, { start: 25, end: 30 }]);
    assert.equal(highlightCount, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(modules.autoCut.loadedCutTimes)), [
        { start: 12.4, end: 17.8 },
        { start: 25, end: 30 }
    ]);
    assert.match(elements.get('tb-r2-toast').textContent, /có 2 vùng vàng/i);
    assert.deepEqual(mutations, []);

    await elements.get('tb-inject-r2-cancel').click();
    assert.equal(modules.autoCut.hasActiveSuggestions, false);
    assert.equal(elements.get('tb-inject-r2-cancel').disabled, true);
    assert.equal(cleared, 1);
    assert.deepEqual(mutations, []);

    video.currentTime = 20;
    dispatchManualShortcut(context, 'q');
    video.currentSrc = 'https://cdn.example/other-video.mp4';
    video.currentTime = 24;
    dispatchManualShortcut(context, 'w');
    assert.match(elements.get('tb-r2-toast').textContent, /video, trang hoặc vùng gợi ý đã thay đổi sau khi nhấn Q/i);
    assert.equal(highlightCount, 2);
});

test('Q/W shortcuts work without segments and ignore text inputs and invalid ranges', () => {
    const context = browser();
    const elements = installDom(context);
    const { modules } = loadModules(context);
    const video = { duration: 60, currentTime: 3, currentSrc: 'https://cdn.example/video.mp4' };
    installTimeline(modules, video);
    Object.defineProperty(modules.timeline, 'getEpisodeRows', { value: () => [] });
    Object.defineProperty(modules.timeline, 'showSuggestionRanges', { value: () => true });
    modules.r2Bridge.init();

    dispatchManualShortcut(context, 'w');
    assert.match(elements.get('tb-r2-toast').textContent, /chưa có điểm bắt đầu/i);
    dispatchManualShortcut(context, 'q');
    assert.match(elements.get('tb-r2-toast').textContent, /điểm bắt đầu 00:00:03/i);
    assert.equal(modules.autoCut.hasActiveSuggestions, false);

    const input = new FakeElement('input', elements);
    video.currentTime = 2;
    dispatchManualShortcut(context, 'w');
    assert.match(elements.get('tb-r2-toast').textContent, /điểm W phải nằm sau điểm Q/i);
    assert.equal(modules.autoCut.hasActiveSuggestions, false);

    video.currentTime = 6;
    assert.deepEqual(dispatchManualShortcut(context, 'q', input), { prevented: false, stopped: false });
    dispatchManualShortcut(context, 'w');
    assert.deepEqual(JSON.parse(JSON.stringify(modules.autoCut.loadedCutTimes)), [{ start: 3, end: 6 }]);
    assert.equal(modules.autoCut.hasActiveSuggestions, true);
});

test('timeline suggestion overlay follows the existing timeline scale and cleans up without editing segments', () => {
    const context = browser();
    const elements = installDom(context);
    const { modules } = loadModules(context);
    const { mutations } = installTimeline(modules);
    const host = new FakeElement('div', elements);
    Object.assign(host, { scrollWidth: 1000, clientWidth: 1000, scrollHeight: 30, clientHeight: 30, clientLeft: 0, clientTop: 0 });
    host.getBoundingClientRect = () => ({ left: 100, top: 200, width: 1000, height: 30 });
    const block = new FakeElement('div', elements);
    block.getBoundingClientRect = () => ({ left: 200, top: 205, width: 100, height: 20 });
    const label = new FakeElement('span', elements);
    label.textContent = '#1 · 0:10';
    label.getBoundingClientRect = () => ({ left: 200, top: 205, width: 40, height: 20 });
    block.appendChild(label);
    host.appendChild(block);
    const row = new FakeElement('div', elements);
    row.textContent = 'Episode 1 0:10';
    context.document.querySelectorAll = selector => selector === '[data-testid^="episode-index-row-"]'
        ? [row]
        : selector === 'span, div, p' ? [label] : [];

    assert.equal(modules.timeline.showSuggestionRanges([{ start: 12, end: 15 }]), true);
    const overlay = elements.get('tb-cut-suggestion-overlay');
    assert.ok(overlay);
    assert.equal(overlay.children.length, 1);
    assert.equal(overlay.children[0].style.left, '120px');
    assert.equal(overlay.children[0].style.width, '30px');
    assert.equal(overlay.children[0].style.backgroundColor, 'rgba(250,204,21,.32)');
    assert.equal(overlay.children[0].style.pointerEvents, 'none');
    assert.equal(host.style.position, 'relative');
    assert.equal(modules.timeline.clearSuggestionRanges(), true);
    assert.equal(elements.has('tb-cut-suggestion-overlay'), false);
    assert.equal(host.style.position, '');
    assert.deepEqual(mutations, []);
});

test('auto-cut suggestions use video duration when no segment exists', () => {
    const context = browser();
    const elements = installDom(context);
    const { modules } = loadModules(context);
    const video = { duration: 60, currentSrc: 'https://cdn.example/video.mp4' };
    const { mutations } = installTimeline(modules, video);
    const host = new FakeElement('div', elements);
    Object.assign(host, { scrollWidth: 600, clientWidth: 600, scrollHeight: 400, clientHeight: 400, clientLeft: 0, clientTop: 0 });
    host.getBoundingClientRect = () => ({ left: 100, top: 200, width: 600, height: 400 });
    video.getBoundingClientRect = () => ({ left: 110, top: 210, width: 480, height: 270 });
    host.appendChild(video);
    context.document.querySelectorAll = selector => selector === 'video' ? [video] : [];
    Object.defineProperty(modules.timeline, 'getEpisodeRows', { value: () => [] });

    assert.equal(modules.autoCut.runAutoCutFromTimes([{ start: 15, end: 30 }], { sourceLabel: 'R2 Handtrack' }), true);
    assert.equal(modules.autoCut.hasActiveSuggestions, true);
    assert.equal(modules.autoCut.loadedJsonName, 'R2 Handtrack');
    const overlay = elements.get('tb-cut-suggestion-overlay');
    assert.ok(overlay);
    assert.equal(overlay.children[0].style.left, '130px');
    assert.equal(overlay.children[0].style.width, '120px');
    assert.equal(overlay.children[0].style.top, '272px');
    assert.equal(overlay.children[1].textContent, 'Gợi ý cắt');
    assert.equal(host.style.position, 'relative');
    assert.equal(modules.autoCut.cancelSuggestions(), true);
    assert.equal(modules.autoCut.hasActiveSuggestions, false);
    assert.equal(elements.has('tb-cut-suggestion-overlay'), false);
    assert.equal(host.style.position, '');
    assert.deepEqual(mutations, []);
});

test('R2 paste displays suggestions without requiring a segment', async () => {
    const context = browser();
    let confirmationCount = 0;
    context.confirm = () => { confirmationCount++; return true; };
    const elements = installDom(context);
    const { modules } = loadModules(context);
    installTimeline(modules);
    Object.defineProperty(modules.timeline, 'getEpisodeRows', { value: () => [] });
    Object.defineProperty(modules.timeline, 'showSuggestionRanges', { value: () => true });
    const cutRow = new FakeElement('div', elements);
    cutRow.id = 'tbp-row-cut';
    elements.set(cutRow.id, cutRow);
    Object.defineProperty(modules.panel, 'ensurePanel', { value: () => true });
    let clipboardReads = 0;
    context.navigator.clipboard = {
        readText: async () => {
            clipboardReads++;
            return JSON.stringify({ videoDuration: 20, segments: [{ start: 1, end: 4 }] });
        }
    };

    modules.r2Bridge.injectR2Btns();
    await elements.get('tb-inject-r2-paste').click();

    assert.equal(clipboardReads, 1);
    assert.equal(confirmationCount, 1);
    assert.match(elements.get('tb-r2-toast').textContent, /đã hiển thị 1 vùng gợi ý/i);
    assert.equal(modules.autoCut.hasActiveSuggestions, true);
    assert.equal(elements.get('tb-inject-r2-cancel').disabled, false);
});

test('R2 scans bind to the current video and sensitivity preset', async () => {
    const context = browser();
    let confirmationCount = 0;
    context.confirm = () => { confirmationCount++; return true; };
    const elements = installDom(context);
    const { modules } = loadModules(context);
    const video = { duration: 20, currentTime: 0, currentSrc: 'https://cdn.example/video.mp4' };
    installTimeline(modules, video);
    Object.defineProperty(modules.timeline, 'showSuggestionRanges', { value: () => true });
    const cutRow = new FakeElement('div', elements);
    cutRow.id = 'tbp-row-cut';
    const reviewRow = new FakeElement('div', elements);
    reviewRow.id = 'tbp-row-cut-review';
    elements.set(cutRow.id, cutRow);
    elements.set(reviewRow.id, reviewRow);
    Object.defineProperty(modules.panel, 'ensurePanel', { value: () => true });

    let clipboardText = '';
    context.navigator.clipboard = {
        writeText: async text => { clipboardText = text; },
        readText: async () => clipboardText
    };
    context.window.open = url => ({ url });
    modules.r2Bridge.injectR2Btns();
    const openButton = elements.get('tb-inject-r2-open');
    const pasteButton = elements.get('tb-inject-r2-paste');

    await openButton.click();
    const firstOverrides = JSON.parse(clipboardText.match(/^window\.__R2_OVR = (.*);$/m)[1]);
    assert.equal(firstOverrides.sensitivityPreset, 'balanced');
    assert.equal(firstOverrides.expectedVideoFingerprint, modules.r2Scanner.fingerprintVideoUrl(video.currentSrc));
    const firstScript = clipboardText;

    const sensitivity = elements.get('tb-r2-sensitivity');
    sensitivity.value = 'sensitive';
    await sensitivity.trigger('change');
    await openButton.click();
    const secondOverrides = JSON.parse(clipboardText.match(/^window\.__R2_OVR = (.*);$/m)[1]);
    assert.equal(secondOverrides.sensitivityPreset, 'sensitive');
    assert.equal(secondOverrides.minScore, 0.45);
    assert.equal(secondOverrides.coarseStep, 1);
    assert.equal(secondOverrides.minLen, 15);
    assert.notEqual(secondOverrides.scanId, JSON.parse(firstScript.match(/^window\.__R2_OVR = (.*);$/m)[1]).scanId);
    assert.match(clipboardText, /window\.__TB_R2_FINGERPRINT/);
    assert.match(clipboardText, /expectedVideoFingerprint/);

    const result = scanId => JSON.stringify({
        scanId,
        videoFingerprint: secondOverrides.expectedVideoFingerprint,
        sensitivityPreset: 'sensitive',
        videoDuration: 20,
        segments: [{ start: 1, end: 4 }]
    });
    clipboardText = result(firstOverrides.scanId);
    await pasteButton.click();
    assert.equal(modules.autoCut.hasActiveSuggestions, false);
    assert.match(elements.get('tb-r2-toast').textContent, /lần quét khác|đã cũ/i);

    clipboardText = JSON.stringify({
        scanId: secondOverrides.scanId,
        videoFingerprint: '0000000000000000',
        videoDuration: 20,
        segments: [{ start: 1, end: 4 }]
    });
    await pasteButton.click();
    assert.equal(modules.autoCut.hasActiveSuggestions, false);
    assert.match(elements.get('tb-r2-toast').textContent, /không khớp video/i);

    clipboardText = result(secondOverrides.scanId);
    await pasteButton.click();
    assert.equal(confirmationCount, 0);
    assert.equal(modules.autoCut.hasActiveSuggestions, true);
    assert.match(modules.autoCut.loadedJsonName, /Nhạy hơn/);
});

test('R2 paste rejects results if the current video changes while reading the clipboard', async () => {
    const context = browser();
    context.confirm = () => true;
    const elements = installDom(context);
    const { modules } = loadModules(context);
    const videoA = { duration: 20, currentTime: 0, currentSrc: 'https://cdn.example/video-a.mp4' };
    const videoB = { duration: 20, currentTime: 0, currentSrc: 'https://cdn.example/video-b.mp4' };
    const { mutations, setVideos } = installTimeline(modules, videoA);
    Object.defineProperty(modules.timeline, 'showSuggestionRanges', { value: () => true });
    const cutRow = new FakeElement('div', elements);
    cutRow.id = 'tbp-row-cut';
    elements.set(cutRow.id, cutRow);
    Object.defineProperty(modules.panel, 'ensurePanel', { value: () => true });

    let resolveClipboard;
    context.navigator.clipboard = {
        readText: () => new Promise(resolve => { resolveClipboard = resolve; })
    };
    modules.r2Bridge.injectR2Btns();
    const pastePromise = elements.get('tb-inject-r2-paste').click();
    await Promise.resolve();
    setVideos([videoB]);
    resolveClipboard(JSON.stringify({
        videoFingerprint: modules.r2Scanner.fingerprintVideoUrl(videoA.currentSrc),
        videoDuration: 20,
        segments: [{ start: 1, end: 4 }]
    }));
    await pastePromise;

    assert.equal(modules.autoCut.hasActiveSuggestions, false);
    assert.deepEqual(mutations, []);
    assert.match(elements.get('tb-r2-toast').textContent, /đã đổi trong lúc đọc clipboard/i);
});

test('R2 review list seeks to range edges and loops the selected suggestion', async () => {
    const context = browser();
    const elements = installDom(context);
    const { modules } = loadModules(context);
    const video = {
        duration: 30,
        currentTime: 0,
        currentSrc: 'https://cdn.example/video.mp4',
        paused: true,
        listeners: Object.create(null),
        playCalls: 0,
        addEventListener(name, callback) {
            (this.listeners[name] || (this.listeners[name] = new Set())).add(callback);
        },
        removeEventListener(name, callback) {
            this.listeners[name] && this.listeners[name].delete(callback);
        },
        emit(name) {
            for (const callback of this.listeners[name] || [])
                callback();
        },
        play() {
            this.paused = false;
            this.playCalls++;
            return Promise.resolve();
        },
        pause() {
            this.paused = true;
        }
    };
    installTimeline(modules, video);
    Object.defineProperty(modules.timeline, 'showSuggestionRanges', { value: () => true });
    Object.defineProperty(modules.timeline, 'seekTo', {
        value: async time => {
            video.currentTime = time;
            return true;
        }
    });
    const cutRow = new FakeElement('div', elements);
    cutRow.id = 'tbp-row-cut';
    const reviewRow = new FakeElement('div', elements);
    reviewRow.id = 'tbp-row-cut-review';
    elements.set(cutRow.id, cutRow);
    elements.set(reviewRow.id, reviewRow);
    Object.defineProperty(modules.panel, 'ensurePanel', { value: () => true });

    modules.autoCut.runAutoCutFromTimes([{ start: 12, end: 16 }], { sourceLabel: 'R2 Handtrack' });
    modules.r2Bridge.injectR2Btns();

    let panel = findByClass(reviewRow, 'tbp-r2-review');
    let item = findByClass(panel, 'tbp-r2-review-item');
    let rangeButton = findByClass(item, 'tbp-r2-review-range');
    let endButton = item.children.find(child => child.textContent === 'Cuối');
    let loopButton = item.children.find(child => child.textContent === '▶ Lặp');
    assert.match(rangeButton.textContent, /00:00:12–00:00:16/);
    await rangeButton.click();
    assert.equal(video.currentTime, 12);
    await endButton.click();
    assert.equal(video.currentTime, 16);

    await loopButton.click();
    assert.equal(video.currentTime, 12);
    assert.equal(video.playCalls, 1);
    video.currentTime = 16;
    video.emit('timeupdate');
    assert.equal(video.currentTime, 12);
    assert.equal(video.playCalls, 2);

    panel = findByClass(reviewRow, 'tbp-r2-review');
    item = findByClass(panel, 'tbp-r2-review-item');
    loopButton = item.children.find(child => child.textContent === '⏹ Dừng');
    assert.ok(loopButton);
    await loopButton.click();
    assert.equal(video.paused, true);
    assert.equal(video.listeners.timeupdate.size, 0);
    panel = findByClass(reviewRow, 'tbp-r2-review');
    item = findByClass(panel, 'tbp-r2-review-item');
    loopButton = item.children.find(child => child.textContent === '▶ Lặp');
    assert.ok(loopButton);

    await loopButton.click();
    assert.equal(video.paused, false);
    await elements.get('tb-inject-r2-cancel').click();
    assert.equal(video.paused, true);
    assert.equal(video.listeners.timeupdate.size, 0);
    assert.equal(reviewRow.children.length, 0);
});

test('R2 preview changes no segments until a selected range is explicitly applied', async () => {
    const context = browser();
    let confirmation = '';
    context.confirm = message => { confirmation = message; return true; };
    const elements = installDom(context);
    const { modules } = loadModules(context);
    const video = { duration: 40, currentTime: 0, currentSrc: 'https://cdn.example/video.mp4' };
    const { mutations } = installTimeline(modules, video);
    const created = [];
    let extendedRange = null;
    let activeRange = null;
    let rows = [];
    Object.defineProperty(modules.timeline, 'showSuggestionRanges', { value: () => true });
    Object.defineProperty(modules.timeline, 'getEpisodeRows', { value: () => rows });
    Object.defineProperty(modules.timeline, 'rowStartSec', { value: row => row.start });
    Object.defineProperty(modules.timeline, 'findTimelineBlock', { value: () => null });
    Object.defineProperty(modules.timeline, 'findRowAt', { value: () => ({ number: rows.length }) });
    modules.config.AUTOCUT.segLen = 30;
    Object.defineProperty(modules.timeline, 'seekTo', {
        value: async time => { video.currentTime = time; return true; }
    });
    Object.defineProperty(modules.timeline, 'createSegmentAt', {
        value: async start => { created.push(start); rows.push({ start }); return true; }
    });
    Object.defineProperty(modules.timeline, 'trimTailTo', {
        value: async (start, end) => { activeRange = { start, end }; return true; }
    });
    Object.defineProperty(modules.timeline, 'extendByDrag', {
        value: async (number, duration) => {
            extendedRange = { number, duration };
            return true;
        }
    });
    Object.defineProperty(modules.timeline, 'selectSegmentAt', { value: async () => true });
    Object.defineProperty(modules.timeline, 'readActiveEpisodeRange', { value: () => activeRange });
    const cutRow = new FakeElement('div', elements);
    cutRow.id = 'tbp-row-cut';
    const reviewRow = new FakeElement('div', elements);
    reviewRow.id = 'tbp-row-cut-review';
    elements.set(cutRow.id, cutRow);
    elements.set(reviewRow.id, reviewRow);
    Object.defineProperty(modules.panel, 'ensurePanel', { value: () => true });

    modules.autoCut.runAutoCutFromTimes([{ start: 4, end: 40 }], { sourceLabel: 'R2 Handtrack' });
    modules.r2Bridge.injectR2Btns();
    assert.deepEqual(created, []);
    assert.deepEqual(mutations, []);

    let panel = findByClass(reviewRow, 'tbp-r2-review');
    let checkbox = findByClass(panel, 'tbp-r2-review-select');
    let applyButton = findByClass(panel, 'tbp-r2-review-apply');
    assert.equal(checkbox.checked, false);
    assert.equal(applyButton.disabled, true);
    checkbox.checked = true;
    await checkbox.trigger('change');
    panel = findByClass(reviewRow, 'tbp-r2-review');
    applyButton = findByClass(panel, 'tbp-r2-review-apply');
    assert.equal(applyButton.disabled, false);
    assert.deepEqual(created, []);
    assert.deepEqual(mutations, []);

    await applyButton.click();
    assert.match(confirmation, /Preview hiện tại chưa sửa segment/);
    assert.match(confirmation, /segment mới/);
    assert.deepEqual(created, [4]);
    assert.deepEqual(extendedRange, { number: 1, duration: 36 });
    assert.deepEqual(activeRange, { start: 4, end: 40 });
    assert.equal(modules.autoCut.isAutoCutting, false);
    assert.ok(findByClass(findByClass(reviewRow, 'tbp-r2-review'), 'tbp-r2-review-applied'));
});

test('R2 apply refuses to overlap an existing segment', async () => {
    const context = browser();
    let confirmationCount = 0;
    context.confirm = () => { confirmationCount++; return true; };
    const elements = installDom(context);
    const { modules } = loadModules(context);
    const video = { duration: 40, currentTime: 0, currentSrc: 'https://cdn.example/video.mp4' };
    const { mutations } = installTimeline(modules, video);
    const existingRow = { start: 0 };
    let created = 0;
    Object.defineProperty(modules.timeline, 'showSuggestionRanges', { value: () => true });
    Object.defineProperty(modules.timeline, 'getEpisodeRows', { value: () => [existingRow] });
    Object.defineProperty(modules.timeline, 'rowStartSec', { value: row => row.start });
    Object.defineProperty(modules.timeline, 'findTimelineBlock', { value: () => ({ dur: 10 }) });
    Object.defineProperty(modules.timeline, 'createSegmentAt', { value: async () => { created++; return true; } });
    const cutRow = new FakeElement('div', elements);
    cutRow.id = 'tbp-row-cut';
    const reviewRow = new FakeElement('div', elements);
    reviewRow.id = 'tbp-row-cut-review';
    elements.set(cutRow.id, cutRow);
    elements.set(reviewRow.id, reviewRow);
    Object.defineProperty(modules.panel, 'ensurePanel', { value: () => true });

    modules.autoCut.runAutoCutFromTimes([{ start: 5, end: 8 }], { sourceLabel: 'R2 Handtrack' });
    modules.r2Bridge.injectR2Btns();
    const panel = findByClass(reviewRow, 'tbp-r2-review');
    const checkbox = findByClass(panel, 'tbp-r2-review-select');
    checkbox.checked = true;
    await checkbox.trigger('change');
    await findByClass(findByClass(reviewRow, 'tbp-r2-review'), 'tbp-r2-review-apply').click();

    assert.equal(confirmationCount, 0);
    assert.equal(created, 0);
    assert.deepEqual(mutations, []);
    assert.match(elements.get('tb-r2-toast').textContent, /trùng segment/i);
});

test('R2 apply stops after the current segment operation and marks partial work', async () => {
    const context = browser();
    context.confirm = () => true;
    const elements = installDom(context);
    const { modules } = loadModules(context);
    const video = { duration: 30, currentTime: 0, currentSrc: 'https://cdn.example/video.mp4' };
    installTimeline(modules, video);
    let rows = [];
    let releaseCreate;
    const created = [];
    let trims = 0;
    Object.defineProperty(modules.timeline, 'showSuggestionRanges', { value: () => true });
    Object.defineProperty(modules.timeline, 'getEpisodeRows', { value: () => rows });
    Object.defineProperty(modules.timeline, 'rowStartSec', { value: row => row.start });
    Object.defineProperty(modules.timeline, 'findTimelineBlock', { value: () => null });
    Object.defineProperty(modules.timeline, 'findRowAt', { value: () => ({ number: rows.length }) });
    Object.defineProperty(modules.timeline, 'seekTo', { value: async () => true });
    Object.defineProperty(modules.timeline, 'createSegmentAt', {
        value: async start => {
            created.push(start);
            rows.push({ start });
            await new Promise(resolve => { releaseCreate = () => resolve(true); });
            return true;
        }
    });
    Object.defineProperty(modules.timeline, 'trimTailTo', {
        value: async () => { trims++; return true; }
    });
    const cutRow = new FakeElement('div', elements);
    cutRow.id = 'tbp-row-cut';
    const reviewRow = new FakeElement('div', elements);
    reviewRow.id = 'tbp-row-cut-review';
    elements.set(cutRow.id, cutRow);
    elements.set(reviewRow.id, reviewRow);
    Object.defineProperty(modules.panel, 'ensurePanel', { value: () => true });

    modules.autoCut.runAutoCutFromTimes([
        { start: 4, end: 10 },
        { start: 14, end: 20 }
    ], { sourceLabel: 'R2 Handtrack' });
    modules.r2Bridge.injectR2Btns();
    const panel = findByClass(reviewRow, 'tbp-r2-review');
    const actions = findByClass(panel, 'tbp-r2-review-actions');
    await actions.children.find(button => button.textContent === 'Chọn tất cả').click();
    const applyPromise = findByClass(findByClass(reviewRow, 'tbp-r2-review'), 'tbp-r2-review-apply').click();
    for (let attempt = 0; attempt < 8 && !releaseCreate; attempt++)
        await Promise.resolve();
    assert.equal(typeof releaseCreate, 'function');

    const stopButton = findByClass(findByClass(reviewRow, 'tbp-r2-review'), 'tbp-r2-review-apply');
    assert.equal(stopButton.textContent, '⏹ Dừng áp dụng');
    await stopButton.click();
    releaseCreate();
    await applyPromise;

    assert.deepEqual(created, [4]);
    assert.equal(trims, 0);
    assert.equal(modules.autoCut.isAutoCutting, false);
    assert.match(elements.get('tb-r2-toast').textContent, /dừng áp dụng theo yêu cầu/i);
    assert.ok(findByClass(findByClass(reviewRow, 'tbp-r2-review'), 'tbp-r2-review-partial'));
});

test('R2 apply reports possible partial work when the video changes during segment creation', async () => {
    const context = browser();
    context.confirm = () => true;
    const elements = installDom(context);
    const { modules } = loadModules(context);
    const video = { duration: 30, currentTime: 0, currentSrc: 'https://cdn.example/video.mp4' };
    installTimeline(modules, video);
    modules.config.AUTOCUT.segLen = 30;
    let rows = [];
    let trimCalls = 0;
    const created = [];
    Object.defineProperty(modules.timeline, 'showSuggestionRanges', { value: () => true });
    Object.defineProperty(modules.timeline, 'getEpisodeRows', { value: () => rows });
    Object.defineProperty(modules.timeline, 'rowStartSec', { value: row => row.start });
    Object.defineProperty(modules.timeline, 'findRowAt', { value: () => ({ number: rows.length }) });
    Object.defineProperty(modules.timeline, 'createSegmentAt', {
        value: async (start, isCurrent, onAttempt) => {
            assert.equal(isCurrent(), true);
            onAttempt();
            created.push(start);
            rows.push({ start });
            video.currentSrc = 'https://cdn.example/other-video.mp4';
            assert.equal(isCurrent(), false);
            return false;
        }
    });
    Object.defineProperty(modules.timeline, 'trimTailTo', {
        value: async () => { trimCalls++; return true; }
    });
    const cutRow = new FakeElement('div', elements);
    cutRow.id = 'tbp-row-cut';
    const reviewRow = new FakeElement('div', elements);
    reviewRow.id = 'tbp-row-cut-review';
    elements.set(cutRow.id, cutRow);
    elements.set(reviewRow.id, reviewRow);
    Object.defineProperty(modules.panel, 'ensurePanel', { value: () => true });

    modules.autoCut.runAutoCutFromTimes([{ start: 4, end: 10 }], { sourceLabel: 'R2 Handtrack' });
    modules.r2Bridge.injectR2Btns();
    let panel = findByClass(reviewRow, 'tbp-r2-review');
    const checkbox = findByClass(panel, 'tbp-r2-review-select');
    checkbox.checked = true;
    await checkbox.trigger('change');
    panel = findByClass(reviewRow, 'tbp-r2-review');
    await findByClass(panel, 'tbp-r2-review-apply').click();

    assert.deepEqual(created, [4]);
    assert.equal(trimCalls, 0);
    assert.equal(modules.autoCut.isAutoCutting, false);
    assert.match(elements.get('tb-r2-toast').textContent, /đã áp dụng 0\/1/i);
    assert.match(elements.get('tb-r2-toast').textContent, /có thể đã thay đổi một phần/i);
});

test('timeline segment creation does not click after its context guard changes', async () => {
    const context = browser();
    const { modules } = loadModules(context);
    modules.autoCut.isAutoCutting = true;
    let current = true;
    let clickCount = 0;
    let attemptCount = 0;
    context.document.querySelector = selector => selector === 'button[title^="New"]'
        ? { disabled: false, getAttribute: () => null, click: () => { clickCount++; } }
        : null;

    const createPromise = modules.timeline.createSegmentAt(
        4,
        () => current,
        () => { attemptCount++; }
    );
    current = false;

    assert.equal(await createPromise, false);
    assert.equal(clickCount, 0);
    assert.equal(attemptCount, 0);
});

test('R2 review controls rebuild when the same video or task context changes', async () => {
    const context = browser();
    const elements = installDom(context);
    const { modules } = loadModules(context);
    const video = {
        duration: 30,
        currentTime: 0,
        currentSrc: 'https://cdn.example/video-a.mp4',
        paused: true
    };
    installTimeline(modules, video);
    Object.defineProperty(modules.timeline, 'showSuggestionRanges', { value: () => true });
    Object.defineProperty(modules.timeline, 'seekTo', {
        value: async time => {
            video.currentTime = time;
            return true;
        }
    });
    const cutRow = new FakeElement('div', elements);
    cutRow.id = 'tbp-row-cut';
    const reviewRow = new FakeElement('div', elements);
    reviewRow.id = 'tbp-row-cut-review';
    elements.set(cutRow.id, cutRow);
    elements.set(reviewRow.id, reviewRow);
    Object.defineProperty(modules.panel, 'ensurePanel', { value: () => true });

    const ranges = [{ start: 12, end: 16 }];
    modules.autoCut.runAutoCutFromTimes(ranges, { sourceLabel: 'R2 Handtrack' });
    modules.r2Bridge.injectR2Btns();
    const stalePanel = findByClass(reviewRow, 'tbp-r2-review');
    const staleRangeButton = findByClass(stalePanel, 'tbp-r2-review-range');

    video.currentSrc = 'https://cdn.example/video-b.mp4';
    modules.autoCut.runAutoCutFromTimes(ranges, { sourceLabel: 'R2 Handtrack' });
    modules.r2Bridge.injectR2Btns();
    const freshPanel = findByClass(reviewRow, 'tbp-r2-review');
    assert.ok(freshPanel);
    assert.notEqual(freshPanel, stalePanel);

    await staleRangeButton.click();
    assert.equal(video.currentTime, 0);
    const freshRangeButton = findByClass(freshPanel, 'tbp-r2-review-range');
    await freshRangeButton.click();
    assert.equal(video.currentTime, 12);

    video.currentTime = 0;
    context.location.search = '?task=other-task';
    modules.autoCut.runAutoCutFromTimes(ranges, { sourceLabel: 'R2 Handtrack' });
    modules.r2Bridge.injectR2Btns();
    const taskFreshPanel = findByClass(reviewRow, 'tbp-r2-review');
    assert.ok(taskFreshPanel);
    assert.notEqual(taskFreshPanel, freshPanel);
    await freshRangeButton.click();
    assert.equal(video.currentTime, 0);
    await findByClass(taskFreshPanel, 'tbp-r2-review-range').click();
    assert.equal(video.currentTime, 12);
});

test('R2 paste keeps yellow suggestions visible until the cancel button is used', async () => {
    const context = browser();
    context.confirm = () => true;
    const elements = installDom(context);
    const { modules } = loadModules(context);
    const { sought, mutations } = installTimeline(modules);
    Object.defineProperty(modules.timeline, 'getEpisodeRows', { value: () => [{}] });
    let highlighted = null;
    let cleared = 0;
    Object.defineProperty(modules.timeline, 'showSuggestionRanges', {
        value: ranges => {
            highlighted = Array.from(ranges, range => ({ start: range.start, end: range.end }));
            return true;
        }
    });
    Object.defineProperty(modules.timeline, 'clearSuggestionRanges', {
        value: () => { cleared++; return true; }
    });
    const cutRow = new FakeElement('div', elements);
    cutRow.id = 'tbp-row-cut';
    elements.set(cutRow.id, cutRow);
    Object.defineProperty(modules.panel, 'ensurePanel', { value: () => true });
    context.navigator.clipboard = {
        readText: async () => JSON.stringify({
            videoDuration: 20,
            segments: [{ start: 1, end: 4, frames: ['legacy-image-data'] }, { start: 6, end: 9, frames: [] }]
        })
    };

    modules.r2Bridge.injectR2Btns();
    const cancel = elements.get('tb-inject-r2-cancel');
    assert.equal(cancel.textContent, '✕ Hủy gợi ý');
    assert.equal(cancel.disabled, true);
    await elements.get('tb-inject-r2-paste').click();

    assert.equal(modules.autoCut.hasActiveSuggestions, true);
    assert.equal(elements.has('tb-cut-preview'), false);
    assert.equal(elements.get('tb-inject-r2-paste').textContent, '📋 Dán gợi ý');
    assert.equal(cancel.disabled, false);
    assert.deepEqual(highlighted, [{ start: 1, end: 4 }, { start: 6, end: 9 }]);
    assert.deepEqual(sought, []);
    assert.deepEqual(mutations, []);

    await cancel.click();
    assert.equal(modules.autoCut.hasActiveSuggestions, false);
    assert.equal(cancel.disabled, true);
    assert.equal(cleared, 1);
    assert.deepEqual(sought, []);
    assert.deepEqual(mutations, []);
});

function createUndoFixture(serverLabels) {
    const context = browser();
    const { modules } = loadModules(context);
    const original = {
        environment_l3: 'Kitchen',
        task_description: 'Washing a cup',
        activity_key: 'washing-cup',
        skill_group: 'Household Chores',
        task_difficulty: 'hard'
    };
    const backup = {
        taskId: 'test-task',
        submissionId: 'submission-1',
        episodeKey: 'episode-1',
        artifactId: 'artifact-1',
        start: 0,
        end: 10,
        labels: original,
        changes: [{ field: 'task_difficulty', value: 'easy', feedbackId: 'feedback-1' }],
        runId: 'fix-run-1',
        at: 1000
    };
    const storageKey = 'qc21-backup|submission-1|episode-1|1000';
    let entries = [[storageKey, backup]];
    const deleted = [];
    modules.storage.TBDB.entries = async () => entries;
    modules.storage.TBDB.del = async key => {
        deleted.push(key);
        entries = [];
        return true;
    };
    Object.defineProperty(modules.qcApi, 'getJson', {
        value: async path => {
            if (path === '/api/v1/tasks/test-task')
                return { submission: { id: 'submission-1' } };
            if (path === '/api/v1/submissions/submission-1') {
                return {
                    taskId: 'test-task',
                    artifacts: [{
                        id: 'artifact-1',
                        data: { episodes: [{ episode_key: 'episode-1', start_seconds: 0, end_seconds: 10, labels: { ...serverLabels } }] }
                    }]
                };
            }
            throw new Error('Unexpected QC API path: ' + path);
        }
    });
    Object.defineProperty(modules.qcView, 'render', { value: () => {} });
    Object.defineProperty(modules.runtime, 'bgBegin', { value: () => {} });
    Object.defineProperty(modules.runtime, 'bgEnd', { value: () => {} });
    Object.defineProperty(modules.runtime, 'sleep', { value: async () => {} });
    Object.defineProperty(modules.annotationDom, 'getCurrentSegmentRoot', { value: () => ({}) });
    Object.defineProperty(modules.annotationDom, 'readCurrentSegmentData', {
        value: () => ({
            l3: serverLabels.environment_l3,
            description: serverLabels.task_description,
            activity: serverLabels.activity_key,
            skillGroup: serverLabels.skill_group,
            difficulty: serverLabels.task_difficulty
        })
    });
    Object.defineProperty(modules.annotationDom, 'clickOptionByText', {
        value: label => {
            serverLabels.task_difficulty = label.toLowerCase();
            return true;
        }
    });
    Object.defineProperty(modules.timeline, 'getEpisodeRows', {
        value: () => [{
            getAttribute: name => name === 'data-testid' ? 'episode-index-row-episode-1' : null,
            scrollIntoView() {},
            click() {}
        }]
    });
    Object.defineProperty(modules.timeline, 'readActiveEpisodeRange', { value: () => ({ start: 0, end: 10 }) });
    return { context, modules, backup, deleted, serverLabels };
}

test('Undo FixQC restores the latest batch and consumes its backup after read-back', async () => {
    const serverLabels = {
        environment_l3: 'Kitchen',
        task_description: 'Washing a cup',
        activity_key: 'washing-cup',
        skill_group: 'Household Chores',
        task_difficulty: 'easy'
    };
    const { modules, deleted, serverLabels: current } = createUndoFixture(serverLabels);

    await modules.qcController.onUndoClick();

    assert.equal(current.task_difficulty, 'hard');
    assert.deepEqual(deleted, ['qc21-backup|submission-1|episode-1|1000']);
    assert.equal(modules.qcStore.state.backups.length, 0);
    assert.equal(modules.qcStore.state.workflow, false);
});

test('Undo FixQC refuses to overwrite a field that changed outside the saved FixQC values', async () => {
    const serverLabels = {
        environment_l3: 'Kitchen',
        task_description: 'Washing a cup',
        activity_key: 'different-activity',
        skill_group: 'Household Chores',
        task_difficulty: 'easy'
    };
    const { modules, deleted, serverLabels: current } = createUndoFixture(serverLabels);

    await assert.rejects(modules.qcController.onUndoClick(), /Field activity_key has changed|Field activity_key đã đổi/);

    assert.equal(current.task_difficulty, 'easy');
    assert.deepEqual(deleted, []);
    assert.equal(modules.qcStore.state.workflow, false);
});

test('QC backups survive IndexedDB cache loading until the configured cache age expires', async () => {
    const { modules } = loadModules();
    const freshKey = 'qc21-backup|submission-1|episode-1|1';
    const staleKey = 'qc21-backup|submission-1|episode-2|2';
    const deleted = [];
    modules.storage.TBDB.entries = async () => [
        [freshKey, { at: Date.now() }],
        [staleKey, { at: 0 }]
    ];
    modules.storage.TBDB.del = async key => {
        deleted.push(key);
        return true;
    };

    await modules.storage.loadCaches();

    assert.deepEqual(deleted, [staleKey]);
});

test('clearing AI cache does not delete QC rollback backups', async () => {
    const context = browser();
    const { modules } = loadModules(context);
    const backupKey = 'qc21-backup|submission-1|episode-1|1';
    const cacheKey = 'res|description-hash';
    const passKey = 'pass-example|task-1|submission-1';
    const deleted = [];
    modules.storage.TBDB.entries = async () => [
        [backupKey, { at: Date.now() }],
        [cacheKey, { t: Date.now(), r: {} }],
        [passKey, { t: Date.now(), taskId: 'task-1', submissionId: 'submission-1', episodes: [] }]
    ];
    modules.storage.TBDB.del = async key => {
        deleted.push(key);
        return true;
    };
    modules.storage.init();

    await context.tbClearCache();

    assert.deepEqual(deleted, [cacheKey]);
});
