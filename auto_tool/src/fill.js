/**
 * fill
 * Fill one/all, L3 workflows and annotation copy/paste.
 * Dependencies: annotationDom, config, gemini (Groq provider), logger, media, qcStore, runtime, storage, timeline.
 * Module state stays in this closure; cross-module mutable bindings use live accessors.
 */
module.exports = function createFill(modules) {
    'use strict';
    let segmentClipboard = modules.storage.storageGet(modules.config.CLIPBOARD_KEY);
    let isLoopRunning = false;
    let isLoopWorkerActive = false;
    let resumeRequested = false;
    let isL3LoopRunning = false;
    let isPasteAllRunning = false;
    let isFillSingleRunning = false;
    let fillSession = null;
    const FILL_TARGET_CHANGED = 'Segment hoặc nội dung đã thay đổi; không ghi kết quả';
    const FILL_SESSION_STALE = 'Danh sách segment đã thay đổi; hãy chạy lại Fill All';
    const FILL_TASK_CHANGED = 'Task hoặc video đã thay đổi; phiên Fill All đã dừng';
    const PASTE_ALL_TARGET_CHANGED = 'Task hoặc segment đã thay đổi; Paste All đã dừng';
    const BUTTON_TONE_BY_COLOR = {
        '#d97706': 'warning',
        '#0f766e': 'info',
        '#10b981': 'success',
        '#dc2626': 'danger',
        '#059669': 'success',
        '#4338ca': 'primary',
        '#0284c7': 'info',
        '#4f46e5': 'primary',
        '#6366f1': 'secondary'
    };

    function setButtonPresentation(button, color, state) {
        if (!button)
            return;
        const tone = BUTTON_TONE_BY_COLOR[color] || 'secondary';
        const classes = String(button.className || '')
            .split(/\s+/)
            .filter(name => name && !name.startsWith('tbp-btn'));
        classes.push('tbp-btn', `tbp-btn-${tone}`);
        if (state)
            classes.push(`tbp-btn-${state}`);
        button.className = classes.join(' ');
    }

    function readTaskMetadata() {
        const read = (selectors, limit) => {
            const element = document.querySelector(selectors);
            const value = element && ('value' in element ? element.value : element.textContent);
            return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
        };
        return {
            taskTitle: read('[data-testid="task-title"], [data-testid="task-name"], main h1, header h1', 240),
            taskInstructions: read('[data-testid="task-instructions"], [data-testid="task-description"]', 600)
        };
    }

    function readContext(root, data) {
        const inputEl = document.getElementById('tb-l3-custom-input');
        const sceneEl = modules.annotationDom.getSceneElement(root || modules.annotationDom.getCurrentSegmentRoot());
        const l3 = (inputEl && String(inputEl.value || '').trim())
            || (data && String(data.l3 || '').trim())
            || (sceneEl && 'value' in sceneEl && String(sceneEl.value || '').trim())
            || '';
        return Object.assign({ l3 }, readTaskMetadata());
    }

    function taskIdentity() {
        return {
            pageKey: String(location.pathname || '') + String(location.search || '') + String(location.hash || ''),
            videoUrl: modules.media.getMainVideoUrl()
        };
    }

    function isSameTask(identity) {
        if (!identity || identity.pageKey !== String(location.pathname || '') + String(location.search || '') + String(location.hash || ''))
            return false;
        return !identity.videoUrl || identity.videoUrl === modules.media.getMainVideoUrl();
    }

    function discardStaleFillSession() {
        if (fillSession && !isLoopWorkerActive && !isSameTask(fillSession.identity)) {
            modules.logger.console.warn('[Fill All] Task/video đã đổi; bỏ phiên cũ để tránh điền nhầm.');
            fillSession = null;
            resumeRequested = false;
        }
    }

    function rowIdentity(row) {
        if (!row)
            return '';
        for (const attr of ['data-episode-key', 'data-episode-id', 'data-testid']) {
            const value = row.getAttribute(attr);
            if (value)
                return value;
        }
        const start = modules.timeline.rowStartSec(row);
        return Number.isFinite(start) ? `start:${start}` : '';
    }

    function findRowForRange(range) {
        if (!range)
            return null;
        const rows = modules.timeline.getEpisodeRows();
        const matches = rows.filter(row => Math.abs(modules.timeline.rowStartSec(row) - range.start) <= 1.01);
        const selected = matches.find(row => {
            const cls = row.className && row.className.toString();
            return row.getAttribute('aria-selected') === 'true'
                || row.getAttribute('data-state') === 'selected'
                || /(^|[\s_-])(active|selected)([\s_-]|$)/i.test(cls || '');
        });
        return selected || matches[0] || null;
    }

    function descriptionFingerprint(value) {
        return modules.media.isEmptyDesc(value) ? '' : String(value || '').trim().replace(/\s+/g, ' ');
    }

    function contextFingerprint(context) {
        return JSON.stringify({
            l3: String((context && context.l3) || '').trim(),
            taskTitle: String((context && context.taskTitle) || '').trim(),
            taskInstructions: String((context && context.taskInstructions) || '').trim()
        });
    }

    function captureTarget(row) {
        const range = modules.timeline.readActiveEpisodeRange();
        if (!range)
            throw new Error('Không đọc được khoảng thời gian của segment đang chọn');
        const rowStart = row ? modules.timeline.rowStartSec(row) : NaN;
        if (row && !Number.isFinite(rowStart))
            throw new Error('Không đọc được thời gian bắt đầu của segment; dừng để tránh điền nhầm');
        if (row && Number.isFinite(rowStart) && Math.abs(rowStart - range.start) > 1.01)
            throw new Error('Không xác nhận được segment vừa chọn; dừng để tránh điền nhầm');
        const root = modules.annotationDom.getCurrentSegmentRoot();
        const data = modules.annotationDom.readCurrentSegmentData();
        const context = readContext(root, data);
        const target = {
            row,
            rowIdentity: rowIdentity(row),
            range: { start: range.start, end: range.end, text: range.text },
            snapshot: data,
            context,
            mode: modules.media.isEmptyDesc(data.description) ? 'image' : 'text',
            job: null,
            status: 'pending',
            applyStarted: false
        };
        target.cacheKey = target.mode === 'text'
            ? modules.storage.txtKey('fill-v2|' + JSON.stringify({
                text: String(data.description || '').trim(),
                context
            }))
            : modules.storage.imgKey(range.start, range.end)
                + '|context|' + modules.storage.txtKey(contextFingerprint(context));
        return target;
    }

    function targetIdentityMatches(target, identity) {
        if (!isSameTask(identity))
            return false;
        if (target.row) {
            if (!target.row.isConnected && target.row.isConnected !== undefined)
                return false;
            if (!modules.timeline.getEpisodeRows().includes(target.row) || rowIdentity(target.row) !== target.rowIdentity)
                return false;
        }
        const range = modules.timeline.readActiveEpisodeRange();
        return !!range
            && Math.abs(range.start - target.range.start) <= 1.01
            && Math.abs(range.end - target.range.end) <= 1.01;
    }

    function targetInputsMatch(target) {
        const data = modules.annotationDom.readCurrentSegmentData();
        return descriptionFingerprint(data.description) === descriptionFingerprint(target.snapshot.description)
            && contextFingerprint(readContext(modules.annotationDom.getCurrentSegmentRoot(), data)) === contextFingerprint(target.context);
    }

    async function waitForTargetSelection(target, identity) {
        const deadline = Date.now() + 1500;
        for (;;) {
            if (!isLoopRunning)
                return false;
            if (!isSameTask(identity))
                throw new Error(FILL_TASK_CHANGED);
            if (target.row && (!target.row.isConnected && target.row.isConnected !== undefined
                || !modules.timeline.getEpisodeRows().includes(target.row)
                || rowIdentity(target.row) !== target.rowIdentity))
                throw new Error(FILL_SESSION_STALE);
            if (targetIdentityMatches(target, identity))
                return true;
            if (Date.now() >= deadline)
                throw new Error(FILL_SESSION_STALE);
            await modules.runtime.sleep(50);
        }
    }

    async function waitForRowSelection(row, identity) {
        const rowStart = modules.timeline.rowStartSec(row);
        if (!Number.isFinite(rowStart))
            throw new Error(FILL_SESSION_STALE);
        const deadline = Date.now() + 1500;
        for (;;) {
            if (!isLoopRunning)
                return false;
            if (!isSameTask(identity))
                throw new Error(FILL_TASK_CHANGED);
            if (row.isConnected === false || !modules.timeline.getEpisodeRows().includes(row))
                throw new Error(FILL_SESSION_STALE);
            const range = modules.timeline.readActiveEpisodeRange();
            if (range && Math.abs(range.start - rowStart) <= 1.01)
                return true;
            if (Date.now() >= deadline)
                throw new Error(FILL_SESSION_STALE);
            await modules.runtime.sleep(50);
        }
    }

    async function selectTarget(target, identity) {
        if (!isSameTask(identity))
            throw new Error(FILL_TASK_CHANGED);
        if (!target.row)
            return waitForTargetSelection(target, identity);
        if (!target.row.isConnected && target.row.isConnected !== undefined)
            throw new Error(FILL_SESSION_STALE);
        if (!modules.timeline.getEpisodeRows().includes(target.row) || rowIdentity(target.row) !== target.rowIdentity)
            throw new Error(FILL_SESSION_STALE);
        target.row.scrollIntoView({ block: 'nearest' });
        target.row.click();
        await modules.runtime.sleep(modules.config.CONFIG.delayBetweenEpisodes);
        return waitForTargetSelection(target, identity);
    }

    async function fillFieldsFromResult(result, root, options = {}) {
        const preserveExisting = options.preserveExisting !== false;
        const shouldContinue = options.shouldContinue || (() => true);
        const resolveRoot = options.getRoot || (() => root);
        const assertCurrent = () => {
            if (!shouldContinue())
                throw new Error(FILL_TARGET_CHANGED);
        };
        const isBlank = value => modules.media.isEmptyDesc(value);
        const description = String((result && result.desc) || '').trim();
        let currentRoot = resolveRoot();
        let descEl = modules.annotationDom.getDescriptionElement(currentRoot);
        if (descEl && description && String(descEl.value || '').trim() !== description) {
            assertCurrent();
            modules.annotationDom.setNativeValue(descEl, description);
        }

        assertCurrent();
        currentRoot = resolveRoot();
        const activityEl = modules.annotationDom.getActivityElement(currentRoot);
        if (activityEl && result.act && (!preserveExisting || isBlank(activityEl.value))) {
            modules.annotationDom.setNativeValue(activityEl, result.act);
        }

        assertCurrent();
        currentRoot = resolveRoot();
        const skillName = typeof result.skill === 'object' ? result.skill.name : result.skill;
        const skillEl = modules.annotationDom.getSkillGroupElement(currentRoot);
        if (skillName) {
            if (skillEl && (!preserveExisting || isBlank(skillEl.value))) {
                if (!await modules.annotationDom.setComboBoxValue(skillEl, skillName, shouldContinue))
                    assertCurrent();
            }
            else if (!skillEl && (!preserveExisting || isBlank(modules.annotationDom.readCurrentSegmentData().skillGroup))) {
                assertCurrent();
                modules.annotationDom.clickOptionByText(skillName);
            }
        }

        assertCurrent();
        currentRoot = resolveRoot();
        const diffName = typeof result.difficulty === 'object' ? result.difficulty.name : result.difficulty;
        if (diffName && (!preserveExisting || !modules.annotationDom.readDifficulty(currentRoot)))
            modules.annotationDom.clickOptionByText(diffName);

        assertCurrent();
        currentRoot = resolveRoot();
        const inputEl = document.getElementById('tb-l3-custom-input');
        const customVal = inputEl ? String(inputEl.value || '').trim() : '';
        const sceneEl = modules.annotationDom.getSceneElement(currentRoot);
        if (customVal && sceneEl && (!preserveExisting || isBlank(sceneEl.value))) {
            if (!await modules.annotationDom.setComboBoxValue(sceneEl, customVal, shouldContinue))
                assertCurrent();
        }
    }

    async function resolveSingleTarget(target, onStatus, shouldAbort, sourceReady) {
        const hit = modules.storage.resGet(target.cacheKey);
        if (hit)
            return { result: hit, cached: true };
        let frames = [];
        if (target.mode === 'image') {
            onStatus && onStatus('🖼️ Frames...');
            if (!await sourceReady)
                throw new Error('Không thể chuẩn bị nguồn video để lấy frame');
            frames = await modules.media.grabSegmentFrames(target.range.start, target.range.end, onStatus);
        }
        onStatus && onStatus('🤖 Analyzing...');
        const results = await modules.gemini.geminiAnalyzeCases([{
            text: target.mode === 'text' ? target.snapshot.description : '',
            frames,
            durSec: target.range.end - target.range.start,
            context: target.context
        }], shouldAbort, onStatus);
        const result = results && results[0];
        if (!result)
            throw new Error('Groq không trả kết quả cho segment');
        modules.storage.rememberResult([target.cacheKey], result);
        return { result, cached: false };
    }

    async function runAutoFill() {
        discardStaleFillSession();
        if (isLoopWorkerActive || isLoopRunning || isL3LoopRunning || isPasteAllRunning || fillSession) {
            modules.logger.console.warn('[Fill 1] Một luồng Fill khác đang chạy; hãy dừng luồng đó trước.');
            return;
        }
        if (modules.qcStore.state.busy || modules.qcStore.state.workflow) {
            modules.logger.console.warn('[QC] Đang chạy QC; bấm Dừng QC trước.');
            return;
        }
        if (isFillSingleRunning)
            return;
        const fillSingleBtn = document.getElementById('tb-inject-fill') || document.querySelector('.tb-inject-fill-btn');
        const setBtn = (text, color) => {
            if (fillSingleBtn) {
                fillSingleBtn.textContent = text;
                setButtonPresentation(fillSingleBtn, color,
                    color === '#d97706' || color === '#0f766e' ? 'loading' : '');
            }
        };
        const descEl = modules.annotationDom.getDescriptionElement();
        if (!descEl)
            return false;
        let target;
        try {
            target = captureTarget(findRowForRange(modules.timeline.readActiveEpisodeRange()));
        }
        catch (error) {
            modules.logger.console.warn('[Fill 1] Không thể xác định segment:', error.message);
            modules.runtime.notifyBg('❌ Fill 1 lỗi', error.message);
            alert('Fill 1: ' + error.message);
            return false;
        }
        const cached = modules.storage.resGet(target.cacheKey);
        const sourceReady = modules.media.prepareFrameSource(target.mode === 'image' && !cached);
        const identity = taskIdentity();
        isFillSingleRunning = true;
        if (fillSingleBtn)
            fillSingleBtn.disabled = true;
        setBtn('⏳ Analyzing...', '#d97706');
        modules.runtime.bgBegin();
        try {
            const { result, cached: fromCache } = await resolveSingleTarget(
                target,
                status => setBtn(status, '#0f766e'),
                null,
                sourceReady
            );
            if (!targetIdentityMatches(target, identity))
                throw new Error(FILL_TARGET_CHANGED);
            let applyStarted = false;
            const shouldContinue = () => {
                if (!targetIdentityMatches(target, identity))
                    return false;
                if (!applyStarted) {
                    if (!targetInputsMatch(target))
                        return false;
                    applyStarted = true;
                    target.applyStarted = true;
                    return true;
                }
                const current = modules.annotationDom.readCurrentSegmentData();
                const descriptionMatches = descriptionFingerprint(current.description) === descriptionFingerprint(target.snapshot.description)
                    || descriptionFingerprint(current.description) === descriptionFingerprint(result.desc);
                return descriptionMatches
                    && contextFingerprint(readContext(modules.annotationDom.getCurrentSegmentRoot(), current)) === contextFingerprint(target.context);
            };
            await fillFieldsFromResult(result, modules.annotationDom.getCurrentSegmentRoot(), {
                preserveExisting: true,
                shouldContinue,
                getRoot: () => modules.annotationDom.getCurrentSegmentRoot()
            });
            if (targetIdentityMatches(target, identity)) {
                segmentClipboard = modules.annotationDom.readCurrentSegmentData();
                modules.storage.storageSet(modules.config.CLIPBOARD_KEY, segmentClipboard);
            }
            modules.logger.console.log(`⚡ [Fill 1] ${fromCache ? '(cache) ' : ''}${target.mode === 'image' ? '(ảnh) ' : ''}${result.act} | ${result.skill} | ${result.difficulty}`);
            setBtn(fromCache ? '✅ Done (cache)' : '✅ Done!', '#10b981');
            modules.runtime.notifyBg('✅ Fill 1 xong', result.act || '');
            setTimeout(() => fillSingleBtn && resetFillBtn(fillSingleBtn), 1200);
            return true;
        }
        catch (error) {
            modules.logger.console.error('Lỗi khi chạy AutoFill:', error.message || error);
            setBtn('❌ Error', '#dc2626');
            modules.runtime.notifyBg('❌ Fill 1 lỗi', error.message);
            if (error instanceof modules.gemini.GroqApiError || /CORS|chia sẻ tab|khoảng|segment/i.test(error.message))
                alert('Fill 1: ' + error.message);
            setTimeout(() => fillSingleBtn && resetFillBtn(fillSingleBtn), 1500);
            return false;
        }
        finally {
            isFillSingleRunning = false;
            modules.runtime.bgEnd();
        }
    }

    function resetFillBtn(btn) {
        btn.textContent = '⚡ Fill 1';
        setButtonPresentation(btn, '#4f46e5');
        btn.disabled = false;
    }

    function runCopySegment() {
        if (isPasteAllRunning) {
            modules.logger.console.warn('[Paste All] Đang dán; hãy chờ hoàn tất hoặc dừng trước khi copy.');
            return;
        }
        segmentClipboard = modules.annotationDom.readCurrentSegmentData();
        modules.storage.storageSet(modules.config.CLIPBOARD_KEY, segmentClipboard);
        const btnCopy = document.getElementById('tb-inject-copy');
        if (btnCopy) {
            const originalText = btnCopy.innerHTML;
            btnCopy.innerHTML = '✅ Copied!';
            setButtonPresentation(btnCopy, '#059669');
            setTimeout(() => {
                btnCopy.innerHTML = originalText;
                setButtonPresentation(btnCopy, '#6366f1');
            }, 1000);
        }
        modules.logger.console.log('[TBRAIN] Đã copy thông tin segment:', segmentClipboard);
    }

    async function pasteSegmentData(data, getRoot, shouldContinue = () => true) {
        const assertCurrent = () => {
            if (!shouldContinue())
                throw new Error(PASTE_ALL_TARGET_CHANGED);
        };
        if (data.description) {
            assertCurrent();
            const el = modules.annotationDom.getDescriptionElement(getRoot());
            if (el)
                modules.annotationDom.setNativeValue(el, data.description);
        }
        if (data.activity) {
            assertCurrent();
            const el = modules.annotationDom.getActivityElement(getRoot());
            if (el)
                modules.annotationDom.setNativeValue(el, data.activity);
        }
        if (data.skillGroup) {
            assertCurrent();
            const el = modules.annotationDom.getSkillGroupElement(getRoot());
            if (el && !await modules.annotationDom.setComboBoxValue(el, data.skillGroup, shouldContinue))
                assertCurrent();
        }
        if (data.difficulty) {
            assertCurrent();
            modules.annotationDom.clickOptionByText(data.difficulty, getRoot());
        }
        if (data.l3) {
            assertCurrent();
            const el = modules.annotationDom.getSceneElement(getRoot());
            if (el && !await modules.annotationDom.setComboBoxValue(el, data.l3, shouldContinue))
                assertCurrent();
        }
        assertCurrent();
    }

    async function runPasteSegment() {
        if (modules.qcStore.state.busy || modules.qcStore.state.workflow) {
            modules.logger.console.warn('[QC] Đang chạy QC; bấm Dừng QC trước.');
            return;
        }
        if (isPasteAllRunning) {
            modules.logger.console.warn('[Paste All] Đang dán; hãy chờ hoàn tất hoặc dừng trước.');
            return;
        }
        if (!segmentClipboard) {
            alert('Chưa có dữ liệu nào được lưu.');
            return;
        }
        const root = modules.annotationDom.getCurrentSegmentRoot();
        const data = segmentClipboard;
        try {
            await pasteSegmentData(data, () => root);
        }
        catch (error) {
            modules.logger.console.error('Lỗi khi paste:', error);
        }
    }

    function setPasteAllButton(text, color) {
        const button = document.getElementById('tb-inject-paste-all');
        if (!button)
            return;
        button.textContent = text;
        const state = text.startsWith('⏳') ? 'loading'
            : text.includes('Stop') ? 'active'
                : /^📥 Paste \d/.test(text) ? 'loading' : '';
        setButtonPresentation(button, color, state);
        button.disabled = false;
    }

    function pasteAllRowIsCurrent(entry) {
        return !!entry.row
            && entry.row.isConnected !== false
            && modules.timeline.getEpisodeRows().includes(entry.row)
            && rowIdentity(entry.row) === entry.identity;
    }

    function pasteAllTargetIsCurrent(entry, identity) {
        if (!isPasteAllRunning || !isSameTask(identity) || !pasteAllRowIsCurrent(entry))
            return false;
        const range = modules.timeline.readActiveEpisodeRange();
        return !!range && Math.abs(range.start - entry.start) <= 1.01;
    }

    async function waitForPasteAllRowSelection(entry, identity) {
        const deadline = Date.now() + 1500;
        for (;;) {
            if (!isPasteAllRunning)
                return false;
            if (!isSameTask(identity) || !pasteAllRowIsCurrent(entry))
                throw new Error(PASTE_ALL_TARGET_CHANGED);
            const range = modules.timeline.readActiveEpisodeRange();
            if (range && Math.abs(range.start - entry.start) <= 1.01)
                return true;
            if (Date.now() >= deadline)
                throw new Error(PASTE_ALL_TARGET_CHANGED);
            await modules.runtime.sleep(50);
        }
    }

    async function runPasteAllSegments() {
        if (isPasteAllRunning) {
            isPasteAllRunning = false;
            setPasteAllButton('⏳ Stopping Paste All...', '#d97706');
            return false;
        }
        discardStaleFillSession();
        if (isLoopWorkerActive || isLoopRunning || isL3LoopRunning || isFillSingleRunning || fillSession) {
            modules.logger.console.warn('[Paste All] Một luồng Fill/Paste khác đang chạy; hãy dừng luồng đó trước.');
            return false;
        }
        if (modules.qcStore.state.busy || modules.qcStore.state.workflow) {
            modules.logger.console.warn('[QC] Đang chạy QC; bấm Dừng QC trước.');
            return false;
        }
        if (!segmentClipboard) {
            alert('Chưa có dữ liệu nào được lưu.');
            return false;
        }
        const data = Object.assign({}, segmentClipboard);
        const fieldNames = [
            ['description', 'Description'],
            ['activity', 'Activity'],
            ['skillGroup', 'Skill Group'],
            ['difficulty', 'Difficulty'],
            ['l3', 'L3']
        ];
        const fields = fieldNames
            .filter(([key]) => data[key] != null && String(data[key]).trim())
            .map(([, label]) => label);
        if (!fields.length) {
            alert('Dữ liệu đã copy không có annotation để dán.');
            return false;
        }
        const rows = modules.timeline.getEpisodeRows();
        if (!rows.length) {
            alert('Không tìm thấy danh sách segment.');
            return false;
        }
        const identity = taskIdentity();
        const entries = rows.map(row => ({
            row,
            identity: rowIdentity(row),
            start: modules.timeline.rowStartSec(row)
        }));
        if (entries.some(entry => !entry.identity || !Number.isFinite(entry.start))) {
            modules.logger.console.warn('[Paste All] Không xác định được danh tính hoặc thời gian của mọi segment; không có thay đổi nào được thực hiện.');
            return false;
        }
        const confirmation = `Dán ${fields.join(', ')} vào tất cả ${entries.length} segment? Các trường có dữ liệu trong clipboard sẽ bị ghi đè trên mọi segment.`;
        if (!confirm(confirmation))
            return false;
        if (!isSameTask(identity)) {
            modules.logger.console.warn('[Paste All] Task hoặc video đã đổi trong lúc xác nhận; không dán dữ liệu.');
            return false;
        }

        isPasteAllRunning = true;
        let completed = 0;
        modules.runtime.bgBegin();
        setPasteAllButton('⏹ Stop Paste All', '#dc2626');
        try {
            for (const entry of entries) {
                if (!isPasteAllRunning)
                    break;
                if (!isSameTask(identity) || !pasteAllRowIsCurrent(entry))
                    throw new Error(PASTE_ALL_TARGET_CHANGED);
                entry.row.scrollIntoView({ block: 'nearest' });
                entry.row.click();
                await modules.runtime.sleep(modules.config.CONFIG.delayBetweenEpisodes);
                if (!isPasteAllRunning)
                    break;
                if (!await waitForPasteAllRowSelection(entry, identity))
                    break;
                const shouldContinue = () => pasteAllTargetIsCurrent(entry, identity);
                if (!shouldContinue())
                    throw new Error(PASTE_ALL_TARGET_CHANGED);
                setPasteAllButton(`📥 Paste ${completed + 1}/${entries.length}`, '#0284c7');
                await pasteSegmentData(data, () => modules.annotationDom.getCurrentSegmentRoot(), shouldContinue);
                completed++;
            }
            if (!isPasteAllRunning) {
                modules.runtime.notifyBg('⏹ Paste All đã dừng', `Đã dán ${completed}/${entries.length} segment.`);
            }
            else {
                const message = `Đã dán annotation vào ${completed}/${entries.length} segment.`;
                modules.logger.console.log('[Paste All] ' + message);
                modules.runtime.notifyBg('✅ Paste All xong', message);
            }
        }
        catch (error) {
            if (error.message === PASTE_ALL_TARGET_CHANGED && !isPasteAllRunning) {
                modules.runtime.notifyBg('⏹ Paste All đã dừng', `Đã dán ${completed}/${entries.length} segment.`);
            }
            else {
                isPasteAllRunning = false;
                modules.logger.console.error('[Paste All]', error.message || error);
                modules.runtime.notifyBg('❌ Paste All dừng', `${completed}/${entries.length} segment: ${error.message || error}`);
            }
        }
        finally {
            isPasteAllRunning = false;
            modules.runtime.bgEnd();
            setPasteAllButton('📥 Paste All', '#0284c7');
        }
        return completed === entries.length;
    }

    async function runLoopFillL3() {
        discardStaleFillSession();
        if (isLoopWorkerActive || isFillSingleRunning || isPasteAllRunning || fillSession) {
            modules.logger.console.warn('[Fill L3 All] Một luồng Fill khác đang chạy; hãy dừng luồng đó trước.');
            return;
        }
        if (modules.qcStore.state.busy || modules.qcStore.state.workflow) {
            modules.logger.console.warn('[QC] Đang chạy QC; bấm Dừng QC trước.');
            return;
        }
        if (isL3LoopRunning) {
            isL3LoopRunning = false;
            return;
        }
        const inputEl = document.getElementById('tb-l3-custom-input');
        const customVal = inputEl ? inputEl.value.trim() : '';
        if (!customVal) {
            alert('Vui lòng nhập giá trị L3 vào ô text box trước!');
            return;
        }
        const episodeButtons = Array.from(document.querySelectorAll('[data-testid^="episode-index-row-"]'));
        if (!episodeButtons.length) {
            modules.logger.console.warn('[Fill L3 All] Không tìm thấy danh sách segment.');
            return;
        }
        isL3LoopRunning = true;
        document.querySelectorAll('.tb-inject-fill-l3-loop-btn').forEach(button => {
            button.textContent = '⏹ Stop Fill L3 All';
            setButtonPresentation(button, '#dc2626', 'active');
        });
        for (let idx = 0; idx < episodeButtons.length; idx++) {
            if (!isL3LoopRunning)
                break;
            const btn = episodeButtons[idx];
            btn.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            btn.click();
            await modules.runtime.sleep(modules.config.CONFIG.delayBetweenEpisodes);
            if (!isL3LoopRunning)
                break;
            const sceneEl = modules.annotationDom.getSceneElement();
            if (sceneEl)
                await modules.annotationDom.setComboBoxValue(sceneEl, customVal);
            await modules.runtime.sleep(300);
        }
        isL3LoopRunning = false;
        document.querySelectorAll('.tb-inject-fill-l3-loop-btn').forEach(button => {
            button.textContent = '🔄 Fill L3 All';
            setButtonPresentation(button, '#059669');
        });
    }

    function setLoopButtons(text, color) {
        document.querySelectorAll('.tb-inject-loop-btn').forEach(button => {
            button.textContent = text;
            const state = color === '#d97706' ? 'loading'
                : color === '#dc2626' || text.startsWith('▶ Resume') ? 'active' : '';
            setButtonPresentation(button, color, state);
            button.disabled = false;
        });
    }

    function createFillSession(rows, identity, frameSourceReady, needsFrames) {
        return {
            identity,
            rows,
            total: rows.length,
            collectIndex: 0,
            jobs: [],
            jobMap: new Map(),
            cachedTargets: [],
            cacheCursor: 0,
            aiJobs: [],
            activeBatch: null,
            runId: 0,
            frameSourceReady,
            frameSourceRequestedForImage: needsFrames,
            stats: { filled: 0, fromImage: 0, fromCache: 0, skipped: 0 },
            callsAtStart: modules.gemini.gem.calls,
            hits429AtStart: modules.gemini.gem.hits429,
            error: null
        };
    }

    async function ensureFrameSource(session) {
        if (!session.frameSourceRequestedForImage || !session.frameSourceReady) {
            session.frameSourceReady = modules.media.prepareFrameSource(true);
            session.frameSourceRequestedForImage = true;
        }
        const ready = await session.frameSourceReady;
        if (!ready) {
            session.frameSourceReady = null;
            session.frameSourceRequestedForImage = false;
            throw new Error('Không thể chuẩn bị nguồn video để lấy frame');
        }
    }

    async function addTargetToSession(session, target) {
        let job = session.jobMap.get(target.cacheKey);
        if (!job) {
            const hit = modules.storage.resGet(target.cacheKey);
            let frames = [];
            if (!hit && target.mode === 'image') {
                await ensureFrameSource(session);
                frames = await modules.media.grabSegmentFrames(target.range.start, target.range.end, status => {
                    setLoopButtons(`🖼️ ${session.collectIndex + 1}/${session.total} ${status}`, '#d97706');
                });
            }
            job = {
                cacheKey: target.cacheKey,
                mode: target.mode,
                result: hit || null,
                cached: !!hit,
                status: hit ? 'cached' : 'pending',
                retryRunId: 0,
                targets: [],
                input: {
                    text: target.mode === 'text' ? target.snapshot.description : '',
                    frames,
                    durSec: target.range.end - target.range.start,
                    context: target.context
                }
            };
            session.jobMap.set(target.cacheKey, job);
            session.jobs.push(job);
            if (!hit)
                session.aiJobs.push(job);
        }
        job.targets.push(target);
        target.job = job;
        if (job.cached)
            session.cachedTargets.push(target);
    }

    function targetApplyGuard(session, target) {
        return () => {
            if (!targetIdentityMatches(target, session.identity))
                return false;
            const current = modules.annotationDom.readCurrentSegmentData();
            const currentDescription = descriptionFingerprint(current.description);
            if (!target.applyStarted) {
                if (!targetInputsMatch(target))
                    return false;
                target.applyStarted = true;
                return true;
            }
            const descriptionMatches = currentDescription === descriptionFingerprint(target.snapshot.description)
                || currentDescription === descriptionFingerprint(target.job.result && target.job.result.desc);
            return descriptionMatches
                && contextFingerprint(readContext(modules.annotationDom.getCurrentSegmentRoot(), current)) === contextFingerprint(target.context);
        };
    }

    async function applyTarget(session, target, fromCache, setLoop) {
        if (!isLoopRunning)
            return 'paused';
        if (target.status === 'done' || target.status === 'skipped')
            return 'done';
        if (!isSameTask(session.identity))
            throw new Error(FILL_TASK_CHANGED);
        await selectTarget(target, session.identity);
        if (!isLoopRunning)
            return 'paused';
        const targetGuard = targetApplyGuard(session, target);
        const shouldContinue = () => isLoopRunning && targetGuard();
        if (!shouldContinue()) {
            target.status = 'skipped';
            session.stats.skipped++;
            modules.logger.console.warn(`[Fill All] Bỏ qua segment ${target.range.text}: dữ liệu hoặc ngữ cảnh đã thay đổi`);
            return 'done';
        }
        if (setLoop)
            setLoop(`⚡ Fill ${session.stats.filled + session.stats.skipped + 1}/${session.total}`, '#d97706');
        try {
            await fillFieldsFromResult(target.job.result, modules.annotationDom.getCurrentSegmentRoot(), {
                preserveExisting: true,
                shouldContinue,
                getRoot: () => modules.annotationDom.getCurrentSegmentRoot()
            });
        }
        catch (error) {
            if (!isLoopRunning && error.message === FILL_TARGET_CHANGED)
                return 'paused';
            if (!isSameTask(session.identity))
                throw new Error(FILL_TASK_CHANGED);
            if (!targetIdentityMatches(target, session.identity))
                throw new Error(FILL_SESSION_STALE);
            if (!targetApplyGuard(session, target)()) {
                target.status = 'skipped';
                session.stats.skipped++;
                modules.logger.console.warn(`[Fill All] Bỏ qua segment ${target.range.text}: dữ liệu đã đổi trong lúc điền`);
                return 'done';
            }
            throw error;
        }
        target.status = 'done';
        session.stats.filled++;
        if (fromCache)
            session.stats.fromCache++;
        else if (target.mode === 'image')
            session.stats.fromImage++;
        return 'done';
    }

    async function collectSessionTargets(session, setLoop) {
        while (session.collectIndex < session.total && isLoopRunning) {
            if (!isSameTask(session.identity))
                throw new Error(FILL_TASK_CHANGED);
            const row = session.rows[session.collectIndex];
            if (!row || (row.isConnected === false) || !modules.timeline.getEpisodeRows().includes(row))
                throw new Error(FILL_SESSION_STALE);
            row.scrollIntoView({ block: 'nearest' });
            row.click();
            await modules.runtime.sleep(modules.config.CONFIG.delayBetweenEpisodes);
            if (!isLoopRunning)
                break;
            if (!await waitForRowSelection(row, session.identity))
                break;
            const target = captureTarget(row);
            await addTargetToSession(session, target);
            session.collectIndex++;
            setLoop(`📋 Scan ${session.collectIndex}/${session.total}`, '#d97706');
        }
    }

    async function applyCachedTargets(session, setLoop) {
        while (session.cacheCursor < session.cachedTargets.length && isLoopRunning) {
            const target = session.cachedTargets[session.cacheCursor];
            const outcome = await applyTarget(session, target, true, setLoop);
            if (outcome === 'paused')
                return;
            session.cacheCursor++;
        }
    }

    function pendingAiJobs(session) {
        return session.aiJobs.filter(job => job.status === 'pending'
            || (job.status === 'failed' && job.retryRunId < session.runId));
    }
    function selectAiBatch(pending) {
        const caseLimit = Math.max(1, Number(modules.config.GROQ.batchSize) || 1);
        const imageLimit = Math.max(0, Number(modules.config.GROQ.maxImagesPerRequest) || 0);
        const selected = [];
        let imageCount = 0;
        for (const job of pending) {
            const hasImage = Array.isArray(job.input.frames) && job.input.frames.length > 0;
            if (hasImage && imageCount >= imageLimit)
                continue;
            selected.push(job);
            if (hasImage)
                imageCount++;
            if (selected.length >= caseLimit)
                break;
        }
        return selected;
    }

    async function beginAiBatch(session, jobs, setLoop) {
        jobs.forEach(job => {
            job.status = 'inflight';
            job.retryRunId = session.runId;
        });
        const targetCount = jobs.reduce((sum, job) => sum + job.targets.length, 0);
        setLoop(`🤖 AI batch ${jobs.length} case / ${targetCount} segment`, '#d97706');
        let results;
        try {
            results = await modules.gemini.geminiAnalyzeCases(
                jobs.map(job => job.input),
                () => !isLoopRunning,
                status => setLoop(`🤖 ${status}`, '#d97706')
            );
        }
        catch (error) {
            jobs.forEach(job => {
                if (job.status === 'inflight')
                    job.status = 'pending';
            });
            throw error;
        }
        jobs.forEach((job, index) => {
            const result = results && results[index];
            if (result) {
                job.result = result;
                job.status = 'ready';
                modules.storage.rememberResult([job.cacheKey], result);
            }
            else {
                job.status = 'failed';
            }
        });
        const targets = jobs.filter(job => job.result)
            .flatMap(job => job.targets.filter(target => target.status === 'pending'));
        session.activeBatch = { jobs, targets, cursor: 0 };
    }

    async function applyActiveBatch(session, setLoop) {
        const active = session.activeBatch;
        if (!active)
            return;
        while (active.cursor < active.targets.length && isLoopRunning) {
            const target = active.targets[active.cursor];
            const outcome = await applyTarget(session, target, false, setLoop);
            if (outcome === 'paused')
                return;
            active.cursor++;
        }
        if (active.cursor >= active.targets.length) {
            active.jobs.forEach(job => {
                if (job.result)
                    job.status = 'done';
            });
            session.activeBatch = null;
        }
    }

    async function runLoopAllEpisodes() {
        if (isLoopWorkerActive) {
            if (isLoopRunning) {
                isLoopRunning = false;
                resumeRequested = false;
                setLoopButtons('⏸ Pausing Fill All...', '#d97706');
            }
            else if (resumeRequested) {
                resumeRequested = false;
                setLoopButtons('▶ Resume Fill All', '#059669');
            }
            else {
                resumeRequested = true;
                setLoopButtons('⏳ Resume queued...', '#d97706');
            }
            return;
        }
        if (isFillSingleRunning || isL3LoopRunning || isPasteAllRunning) {
            modules.logger.console.warn('[Fill All] Một luồng Fill khác đang chạy; hãy dừng luồng đó trước.');
            return;
        }
        if (modules.qcStore.state.busy || modules.qcStore.state.workflow) {
            modules.logger.console.warn('[QC] Đang chạy QC; bấm Dừng QC trước.');
            return;
        }
        discardStaleFillSession();
        if (!fillSession) {
            const rows = modules.timeline.getEpisodeRows();
            if (!rows.length) {
                alert('Không tìm thấy danh sách episode.');
                return;
            }
            const identity = taskIdentity();
            const needsFrames = rows.some(row => modules.media.rowLooksEmpty(row));
            const sourceReady = modules.media.prepareFrameSource(needsFrames);
            fillSession = createFillSession(rows, identity, sourceReady, needsFrames);
        }
        else if (fillSession.rows.some(row => modules.media.rowLooksEmpty(row))
            && !fillSession.frameSourceRequestedForImage) {
            fillSession.frameSourceReady = modules.media.prepareFrameSource(true);
            fillSession.frameSourceRequestedForImage = true;
        }

        const session = fillSession;
        session.runId++;
        session.error = null;
        isLoopRunning = true;
        isLoopWorkerActive = true;
        modules.runtime.bgBegin();
        const setLoop = (text, color) => setLoopButtons(text, color);
        try {
            setLoop('⏹ Stop Fill All', '#dc2626');
            await collectSessionTargets(session, setLoop);
            if (isLoopRunning)
                await applyCachedTargets(session, setLoop);
            while (isLoopRunning) {
                if (session.activeBatch) {
                    await applyActiveBatch(session, setLoop);
                    if (!isLoopRunning)
                        break;
                }
                const pending = pendingAiJobs(session);
                if (!pending.length)
                    break;
                const chunk = selectAiBatch(pending);
                if (!chunk.length)
                    throw new Error('Không tạo được batch Fill All; hãy kiểm tra giới hạn batch/image của Groq.');
                await beginAiBatch(session, chunk, setLoop);
                if (isLoopRunning)
                    await applyActiveBatch(session, setLoop);
            }
            if (!isLoopRunning) {
                session.error = 'Paused';
                return;
            }
            const unresolved = session.aiJobs.filter(job => job.status === 'failed' || job.status === 'pending').length;
            const collectionComplete = session.collectIndex >= session.total;
            const cacheComplete = session.cacheCursor >= session.cachedTargets.length;
            if (collectionComplete && cacheComplete && !session.activeBatch && !unresolved) {
                const message = `Đã điền ${session.stats.filled}/${session.total} segment (từ ảnh: ${session.stats.fromImage}, cache: ${session.stats.fromCache}, bỏ qua: ${session.stats.skipped}) · Groq: ${modules.gemini.gem.calls - session.callsAtStart} lần gọi, 429: ${modules.gemini.gem.hits429 - session.hits429AtStart}`;
                modules.logger.console.log('✅ [Fill All] ' + message);
                modules.runtime.notifyBg('✅ Fill All xong', message);
                fillSession = null;
            }
            else if (collectionComplete && cacheComplete && !session.activeBatch) {
                const failedSegments = session.aiJobs
                    .filter(job => job.status === 'failed')
                    .reduce((sum, job) => sum + job.targets.filter(target => target.status === 'pending').length, 0);
                session.error = `${failedSegments} segment chưa có kết quả AI`;
                modules.logger.console.warn('[Fill All] ' + session.error + '; bấm lại để thử lại các case lỗi.');
                modules.runtime.notifyBg('⚠️ Fill All cần thử lại', session.error);
            }
        }
        catch (error) {
            if (error.message === FILL_TASK_CHANGED || error.message === FILL_SESSION_STALE) {
                modules.logger.console.warn('[Fill All] Phiên đã dừng vì task/segment không còn khớp; hãy chạy lại từ đầu.');
                modules.runtime.notifyBg('⏹ Fill All dừng', error.message);
                fillSession = null;
            }
            else if (error.message === 'ABORTED') {
                session.error = 'Paused';
            }
            else {
                session.error = error.message || String(error);
                modules.logger.console.error('❌ [Fill All]', session.error);
                if (error instanceof modules.gemini.GroqApiError)
                    alert('Fill All: ' + error.message);
                modules.runtime.notifyBg('❌ Fill All lỗi', session.error);
            }
        }
        finally {
            isLoopRunning = false;
            isLoopWorkerActive = false;
            modules.runtime.bgEnd();
            const resume = resumeRequested && !!fillSession && isSameTask(fillSession.identity);
            if (resumeRequested && fillSession && !resume) {
                fillSession = null;
                modules.runtime.notifyBg('⏹ Fill All dừng', FILL_TASK_CHANGED);
            }
            resumeRequested = false;
            if (resume) {
                setLoopButtons('⏳ Resuming Fill All...', '#d97706');
                runLoopAllEpisodes();
            }
            else if (fillSession)
                setLoopButtons('▶ Resume Fill All', '#059669');
            else
                resetLoopButtons();
        }
    }

    function resetLoopButtons() {
        isLoopRunning = false;
        setLoopButtons('🔄 Fill All', '#4338ca');
    }

    return {
        get runAutoFill() { return runAutoFill; },
        get runLoopAllEpisodes() { return runLoopAllEpisodes; },
        get runLoopFillL3() { return runLoopFillL3; },
        get runCopySegment() { return runCopySegment; },
        get runPasteSegment() { return runPasteSegment; },
        get runPasteAllSegments() { return runPasteAllSegments; },
        get fillFieldsFromResult() { return fillFieldsFromResult; },
        get isLoopRunning() { return isLoopRunning; },
        set isLoopRunning(value) { isLoopRunning = value; },
        get isL3LoopRunning() { return isL3LoopRunning; },
        set isL3LoopRunning(value) { isL3LoopRunning = value; },
        get isFillSingleRunning() { return isFillSingleRunning; },
        set isFillSingleRunning(value) { isFillSingleRunning = value; },
        get readContext() { return readContext; }
    };
};
