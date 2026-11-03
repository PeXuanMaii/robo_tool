'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { browser, loadModules } = require('./harness.cjs');

function createFillHarness({ descriptions, pauseAfterBatch = false, changeTargetDuringAi = false }) {
    const context = browser();
    const { modules } = loadModules(context);
    const segments = descriptions.map((description, index) => ({
        description: { value: description },
        activity: { value: index === 0 ? 'existing-activity' : '' },
        skill: { value: index === 0 ? 'existing-skill' : '' },
        scene: { value: 'Kitchen' },
        difficulty: index === 0 ? 'Medium' : ''
    }));
    let activeSegment = segments[0];
    let activeRange = { start: 0, end: 30, text: '0:00–0:30' };
    const rows = segments.map((segment, index) => ({
        start: index * 30,
        isConnected: true,
        className: '',
        textContent: `${index + 1} segment ${index * 30}s`,
        getAttribute(name) {
            return name === 'data-testid' ? `episode-index-row-${index + 1}` : null;
        },
        scrollIntoView() {},
        click() {
            activeSegment = segment;
            activeRange = { start: index * 30, end: (index + 1) * 30, text: `${index}:00–${index}:30` };
        }
    }));
    const loopButton = { textContent: '', style: {}, disabled: false };
    const notifications = [];
    const batches = [];
    const cached = new Map();
    const gem = { calls: 0, hits429: 0 };

    context.document.getElementById = id => id === 'tb-inject-fill' ? null : null;
    context.document.querySelector = selector => selector.includes('task-title')
        ? { textContent: 'Kitchen cleanup task' }
        : null;
    context.document.querySelectorAll = selector => selector === '.tb-inject-loop-btn' ? [loopButton] : [];

    modules.annotationDom = {
        getCurrentSegmentRoot: () => activeSegment,
        getDescriptionElement: root => (root || activeSegment).description,
        getActivityElement: root => (root || activeSegment).activity,
        getSkillGroupElement: root => (root || activeSegment).skill,
        getSceneElement: root => (root || activeSegment).scene,
        readCurrentSegmentData: () => ({
            description: activeSegment.description.value,
            activity: activeSegment.activity.value,
            skillGroup: activeSegment.skill.value,
            difficulty: activeSegment.difficulty,
            l3: activeSegment.scene.value
        }),
        setNativeValue: (element, value) => { element.value = value; },
        setComboBoxValue: async (element, value, shouldContinue) => {
            if (shouldContinue && !shouldContinue())
                return false;
            element.value = value;
            return true;
        },
        readDifficulty: root => (root || activeSegment).difficulty,
        clickOptionByText: value => {
            activeSegment.difficulty = value;
            return true;
        }
    };
    modules.timeline = {
        getEpisodeRows: () => rows,
        rowStartSec: row => row.start,
        readActiveEpisodeRange: () => activeRange
    };
    modules.media = {
        isEmptyDesc: value => {
            const text = String(value == null ? '' : value).trim().toLowerCase();
            return !text || text === 'null' || text === 'undefined' || text === 'no description yet' || text === 'no description';
        },
        getMainVideoUrl: () => 'https://video.example/task-video.mp4',
        prepareFrameSource: () => Promise.resolve(true),
        grabSegmentFrames: async () => ['frame1', 'frame2', 'frame3', 'frame4'],
        rowLooksEmpty: () => false
    };
    modules.storage = {
        storageGet: () => null,
        storageSet() {},
        txtKey: value => 'txt:' + String(value),
        imgKey: (start, end) => `img:${start}:${end}`,
        resGet: key => cached.get(key) || null,
        rememberResult: (keys, result) => keys.forEach(key => cached.set(key, result))
    };
    modules.runtime = {
        sleep: async () => {},
        bgBegin() {},
        bgEnd() {},
        notifyBg: (...args) => notifications.push(args)
    };
    modules.gemini = {
        gem,
        GroqApiError: class GroqApiError extends Error {},
        geminiAnalyzeCases: async cases => {
            gem.calls++;
            batches.push(cases);
            if (changeTargetDuringAi) {
                activeSegment = segments[1];
                activeRange = { start: 30, end: 60, text: '0:30–1:00' };
            }
            if (pauseAfterBatch) {
                pauseAfterBatch = false;
                modules.fill.isLoopRunning = false;
            }
            return cases.map((item, index) => ({
                desc: index === 0 ? 'Washing a cup' : 'Folding a towel',
                act: index === 0 ? 'cup-washing' : 'towel-folding',
                skill: modules.config.SKILL_NAMES[0],
                difficulty: 'Easy'
            }));
        }
    };
    return { context, modules, segments, rows, loopButton, notifications, batches, gem };
}

test('Paste All confirms and applies copied non-empty fields to every segment', async () => {
    const { context, modules, segments, notifications } = createFillHarness({
        descriptions: ['Source description', 'Existing description']
    });
    const pasteAllButton = { textContent: '📥 Paste All', style: {}, disabled: false };
    const confirmationMessages = [];
    context.confirm = message => {
        confirmationMessages.push(message);
        return true;
    };
    context.document.getElementById = id => id === 'tb-inject-paste-all' ? pasteAllButton : null;

    modules.fill.runCopySegment();
    await modules.fill.runPasteAllSegments();

    assert.match(confirmationMessages[0], /2 segment/);
    assert.match(confirmationMessages[0], /bị ghi đè/);
    for (const segment of segments) {
        assert.equal(segment.description.value, 'Source description');
        assert.equal(segment.activity.value, 'existing-activity');
        assert.equal(segment.skill.value, 'existing-skill');
        assert.equal(segment.difficulty, 'Medium');
        assert.equal(segment.scene.value, 'Kitchen');
    }
    assert.equal(pasteAllButton.textContent, '📥 Paste All');
    assert.equal(notifications.at(-1)[0], '✅ Paste All xong');
});

test('Paste All cancellation leaves every target unchanged', async () => {
    const { context, modules, segments } = createFillHarness({
        descriptions: ['Source description', 'Existing description']
    });
    context.confirm = () => false;
    modules.fill.runCopySegment();
    await modules.fill.runPasteAllSegments();

    assert.equal(segments[0].description.value, 'Source description');
    assert.equal(segments[1].description.value, 'Existing description');
    assert.equal(segments[1].activity.value, '');
    assert.equal(segments[1].skill.value, '');
});

test('Paste All stops before applying to another segment when stopped by the user', async () => {
    const { context, modules, segments, notifications } = createFillHarness({
        descriptions: ['Source description', 'Existing description']
    });
    context.confirm = () => true;
    context.document.getElementById = id => id === 'tb-inject-paste-all'
        ? { textContent: '📥 Paste All', style: {}, disabled: false }
        : null;
    modules.fill.runCopySegment();
    let stopRequested = false;
    modules.runtime.sleep = async () => {
        if (!stopRequested) {
            stopRequested = true;
            await modules.fill.runPasteAllSegments();
        }
    };

    await modules.fill.runPasteAllSegments();

    assert.equal(segments[1].description.value, 'Existing description');
    assert.equal(segments[1].activity.value, '');
    assert.equal(notifications.at(-1)[0], '⏹ Paste All đã dừng');
});

test('Fill All batches mixed descriptions and resumes after the current AI batch', async () => {
    const { modules, segments, loopButton, batches, gem } = createFillHarness({
        descriptions: ['Rửa cái cốc', 'Folding a towel'],
        pauseAfterBatch: true
    });

    await modules.fill.runLoopAllEpisodes();
    assert.equal(batches.length, 1);
    assert.equal(batches[0].length, 2);
    assert.equal(batches[0][0].text, 'Rửa cái cốc');
    assert.equal(batches[0][1].text, 'Folding a towel');
    assert.equal(batches[0][0].context.taskTitle, 'Kitchen cleanup task');
    assert.equal(segments[0].description.value, 'Rửa cái cốc', 'pause leaves the completed AI batch unapplied');
    assert.match(loopButton.textContent, /Resume/);

    await modules.fill.runLoopAllEpisodes();
    assert.equal(gem.calls, 1, 'resume applies the retained batch without another Groq call');
    assert.equal(segments[0].description.value, 'Washing a cup');
    assert.equal(segments[0].activity.value, 'existing-activity', 'completed labels are preserved');
    assert.equal(segments[0].skill.value, 'existing-skill', 'completed labels are preserved');
    assert.equal(segments[0].difficulty, 'Medium', 'completed labels are preserved');
    assert.equal(segments[1].description.value, 'Folding a towel');
    assert.equal(segments[1].activity.value, 'towel-folding');
    assert.equal(segments[1].difficulty, 'Easy');
    assert.equal(loopButton.textContent, '🔄 Fill All');
});

test('Fill All caps vision cases at three contact sheets per Groq request', async () => {
    const { modules, batches, gem } = createFillHarness({
        descriptions: Array(7).fill('')
    });

    await modules.fill.runLoopAllEpisodes();

    assert.deepEqual(batches.map(batch => batch.length), [3, 3, 1]);
    assert.equal(batches.flat().filter(item => item.frames.length === 4).length, 7);
    assert.equal(gem.calls, 3);
});

test('Fill All keeps text cases in a mixed batch while respecting the Groq image cap', async () => {
    const { modules, batches, gem } = createFillHarness({
        descriptions: ['', '', '', '', 'Text case one', 'Text case two', '', '']
    });

    await modules.fill.runLoopAllEpisodes();

    assert.deepEqual(batches.map(batch => batch.filter(item => item.frames.length).length), [3, 3]);
    assert.deepEqual(batches.map(batch => batch.length), [5, 3]);
    assert.deepEqual(Array.from(batches[0].map(item => item.text).filter(Boolean)), ['Text case one', 'Text case two']);
    assert.equal(gem.calls, 2);
});

test('Fill 1 does not apply a delayed result after the active segment changes', async () => {
    const { modules, context, segments } = createFillHarness({
        descriptions: ['Washing a cup', 'Folding a towel'],
        changeTargetDuringAi: true
    });

    const fillButton = { textContent: '⚡ Fill 1', style: {}, disabled: false };
    context.document.getElementById = id => id === 'tb-inject-fill' ? fillButton : null;
    await modules.fill.runAutoFill();

    assert.equal(segments[0].description.value, 'Washing a cup');
    assert.equal(segments[1].description.value, 'Folding a towel');
    assert.equal(segments[0].activity.value, 'existing-activity');
});
