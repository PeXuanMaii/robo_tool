/**
 * r2Bridge
 * Open R2, copy scanner, parse pasted results and show cut suggestions.
 * Dependencies: autoCut, config, logger, panel, qcStore, r2Scanner, timeline.
 * Module state stays in this closure; cross-module mutable bindings use live accessors.
 */
module.exports = function createR2Bridge(modules) {
    'use strict';
    const MANUAL_SUGGESTION_SOURCE = 'Manual Q/W';
    const R2_SENSITIVITY_PRESETS = [
        { value: 'balanced', label: 'Độ nhạy: Cân bằng' },
        { value: 'sensitive', label: 'Độ nhạy: Nhạy hơn' },
        { value: 'conservative', label: 'Độ nhạy: Ít nhiễu' }
    ];
    let manualSuggestionStart = null;
    let manualSuggestionRanges = [];
    let manualSuggestionContext = null;
    let selectedSensitivityPreset = 'balanced';
    let pendingR2Scan = null;
    let applyInProgress = false;
    let applyAbortRequested = false;
    let previewLoop = null;
    let reviewSignature = '';
    let reviewSelectionSignature = '';
    const selectedSuggestionKeys = new Set();
    const appliedSuggestionKeys = new Set();
    const partialSuggestionKeys = new Set();
    let reviewVideo = null;
    let reviewVideoUrl = '';
    let reviewPageKey = '';
    let reviewSuggestionId = null;
    let initialized = false;
    /* ---------- 🔗 Mở video + 📋 Dán kết quả R2 -> xem gợi ý ---------- */
    function parseR2Result(text) {
        let data;
        try {
            data = JSON.parse(text.trim());
        }
        catch (_) {
            throw new Error('Nội dung không phải JSON hợp lệ');
        }
        const list = Array.isArray(data) ? data : (data && data.segments) || [];
        const ranges = list.map(x => Array.isArray(x) ? { start: +x[0], end: +x[1], frames: [] }
            : { start: +(x && x.start), end: +(x && x.end), frames: [] })
            .filter(r => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
            .sort((a, b) => a.start - b.start);
        if (!ranges.length)
            throw new Error('JSON không có đoạn nào');
        const metadata = !Array.isArray(data) && data && typeof data === 'object' ? data : {};
        const fingerprint = typeof metadata.videoFingerprint === 'string'
            && /^[a-f0-9]{16}$/i.test(metadata.videoFingerprint)
            ? metadata.videoFingerprint.toLowerCase()
            : '';
        const scanId = typeof metadata.scanId === 'string' && metadata.scanId.length <= 120
            ? metadata.scanId.trim()
            : '';
        const videoDuration = Number(metadata.videoDuration);
        const preset = R2_SENSITIVITY_PRESETS.some(item => item.value === metadata.sensitivityPreset)
            ? metadata.sensitivityPreset
            : '';
        return {
            ranges,
            videoDuration: Number.isFinite(videoDuration) && videoDuration > 0 ? videoDuration : null,
            scanId,
            videoFingerprint: fingerprint,
            sensitivityPreset: preset
        };
    }
    // Gọi trực tiếp trong click để trình duyệt cho phép đọc clipboard; bị chặn thì hỏi bằng prompt
    async function readR2Text() {
        try {
            const t = await navigator.clipboard.readText();
            if (t && t.trim())
                return t;
        }
        catch (_) { /* không có quyền -> prompt */ }
        return prompt('Dán JSON kết quả từ tab video R2 vào đây:') || '';
    }
    function setR2CancelBtnEnabled(enabled) {
        const cancel = document.getElementById('tb-inject-r2-cancel');
        if (cancel) {
            const canCancel = !!enabled && !applyInProgress;
            cancel.disabled = !canCancel;
            cancel.setAttribute('aria-disabled', canCancel ? 'false' : 'true');
        }
    }
    function resetReviewSelectionState() {
        selectedSuggestionKeys.clear();
        appliedSuggestionKeys.clear();
        partialSuggestionKeys.clear();
        reviewSelectionSignature = '';
    }
    function isEditableTarget(target) {
        if (!target)
            return false;
        const tagName = String(target.tagName || '').toLowerCase();
        return tagName === 'input' || tagName === 'textarea' || tagName === 'select'
            || target.isContentEditable === true
            || (typeof target.closest === 'function' && !!target.closest('[contenteditable]:not([contenteditable="false"])'));
    }
    function formatTimecode(seconds) {
        const totalSeconds = Math.floor(Math.max(0, seconds));
        const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
        const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
        const remainingSeconds = String(totalSeconds % 60).padStart(2, '0');
        return `${hours}:${minutes}:${remainingSeconds}`;
    }
    function getPageKey() {
        return String(location.pathname || '') + String(location.search || '') + String(location.hash || '');
    }
    function isCurrentVideoContext(video, videoUrl, pageKey) {
        const currentVideo = modules.timeline.getVideos()[0];
        return currentVideo === video
            && getPageKey() === pageKey
            && (video.currentSrc || video.src || '') === videoUrl;
    }
    function getSelectedSensitivityPreset() {
        const select = document.getElementById('tb-r2-sensitivity');
        const value = select && select.value;
        return R2_SENSITIVITY_PRESETS.some(item => item.value === value)
            ? value
            : selectedSensitivityPreset;
    }
    function getSensitivitySettings(preset) {
        const ai = modules.config.AI;
        if (preset === 'sensitive') {
            return {
                minScore: 0.45,
                coarseStep: 1,
                fineStep: 0.25,
                mergeGap: 7,
                minLen: 15,
                maxLen: ai.maxLen,
                pad: 1
            };
        }
        if (preset === 'conservative') {
            return {
                minScore: 0.75,
                coarseStep: 1.5,
                fineStep: 0.5,
                mergeGap: 3,
                minLen: 45,
                maxLen: ai.maxLen,
                pad: 0.25
            };
        }
        return {
            minScore: ai.minScore,
            coarseStep: 1.5,
            fineStep: 0.5,
            mergeGap: ai.mergeGap,
            minLen: ai.minLen,
            maxLen: ai.maxLen,
            pad: ai.pad
        };
    }
    function validateR2VideoIdentity(parsed, context) {
        const { video, videoUrl, pageKey } = context;
        if (!isCurrentVideoContext(video, videoUrl, pageKey)) {
            showToast('Task hoặc video đã đổi trong lúc đọc clipboard. Không nhập gợi ý cũ.');
            return false;
        }
        if (pendingR2Scan && !isCurrentVideoContext(
            pendingR2Scan.video, pendingR2Scan.videoUrl, pendingR2Scan.pageKey
        )) {
            showToast('Task hoặc video đã đổi sau khi mở R2. Hãy bấm Mở video lại rồi quét task hiện tại.');
            return false;
        }
        if (pendingR2Scan && parsed.scanId && parsed.scanId !== pendingR2Scan.scanId) {
            showToast('Kết quả thuộc lần quét khác hoặc đã cũ. Hãy dán kết quả mới nhất của video đang mở.');
            return false;
        }
        const currentFingerprint = modules.r2Scanner.fingerprintVideoUrl(videoUrl);
        if (parsed.videoFingerprint && currentFingerprint
            && parsed.videoFingerprint !== currentFingerprint) {
            showToast('Video trong JSON không khớp video của task hiện tại. Không nhập gợi ý để tránh nhầm task.');
            return false;
        }
        const scanMatches = !!(pendingR2Scan && parsed.scanId
            && parsed.scanId === pendingR2Scan.scanId);
        const fingerprintMatches = !!(parsed.videoFingerprint && currentFingerprint
            && parsed.videoFingerprint === currentFingerprint);
        const warnings = [];
        if (!scanMatches && !fingerprintMatches)
            warnings.push('Không xác minh được video từ mã quét hoặc fingerprint.');
        if (parsed.videoDuration && Math.abs(video.duration - parsed.videoDuration) > 3)
            warnings.push(`Độ dài video không khớp (kết quả: ${parsed.videoDuration}s, task: ${Math.round(video.duration)}s).`);
        return !warnings.length || confirm(warnings.join('\n')
            + '\nCó thể đây là video/task khác. Bạn vẫn muốn xem preview?');
    }
    function isActiveSuggestionRange(index, start, end, context) {
        const activeContext = modules.autoCut.activeSuggestionContext;
        const activeRange = modules.autoCut.loadedCutTimes[index];
        return modules.autoCut.hasActiveSuggestions
            && !!activeRange
            && !!activeContext
            && !!context
            && activeContext.id === context.id
            && activeContext.video === context.video
            && activeContext.videoUrl === context.videoUrl
            && activeContext.pageKey === context.pageKey
            && Number(activeRange.start) === start
            && Number(activeRange.end) === end
            && isCurrentVideoContext(context.video, context.videoUrl, context.pageKey);
    }
    function clearStaleSuggestionContext() {
        const context = modules.autoCut.activeSuggestionContext;
        if (!modules.autoCut.hasActiveSuggestions || !context
            || isCurrentVideoContext(context.video, context.videoUrl, context.pageKey))
            return false;
        stopSuggestionLoop(true, false);
        modules.autoCut.cancelSuggestions();
        resetManualSuggestionState();
        setR2CancelBtnEnabled(false);
        reviewSignature = '';
        reviewVideo = null;
        reviewVideoUrl = '';
        reviewPageKey = '';
        reviewSuggestionId = null;
        resetReviewSelectionState();
        showToast('Video hoặc task đã đổi; gợi ý cũ đã được xóa. Hãy dán hoặc tạo gợi ý mới.');
        return true;
    }
    function createReviewButton(text, className, title, onClick) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `tbp-mini tbp-btn ${className}`;
        button.textContent = text;
        button.title = title;
        button.addEventListener('click', onClick);
        return button;
    }
    function suggestionRangeKey(start, end) {
        return `${Number(start)}:${Number(end)}`;
    }
    function readExistingTimelineRanges() {
        const rows = modules.timeline.getEpisodeRows();
        const ranges = [];
        for (let index = 0; index < rows.length; index++) {
            const start = modules.timeline.rowStartSec(rows[index]);
            const block = modules.timeline.findTimelineBlock(index + 1);
            if (!Number.isFinite(start) || !block || !Number.isFinite(block.dur) || block.dur <= 0)
                throw new Error(`Không xác định được vị trí segment #${index + 1}; không thể áp dụng an toàn.`);
            ranges.push({ start, end: start + block.dur, index: index + 1 });
        }
        return ranges;
    }
    function rangesOverlap(first, second) {
        return first.start < second.end && first.end > second.start;
    }
    function isApplyContextCurrent(context) {
        const activeContext = modules.autoCut.activeSuggestionContext;
        return modules.autoCut.hasActiveSuggestions
            && !!activeContext
            && activeContext.id === context.id
            && isCurrentVideoContext(context.video, context.videoUrl, context.pageKey);
    }
    function assertApplyContext(context) {
        if (applyAbortRequested)
            throw new Error('Dừng áp dụng theo yêu cầu.');
        if (!isApplyContextCurrent(context))
            throw new Error('Video, task hoặc danh sách gợi ý đã thay đổi.');
    }
    function requestApplyStop() {
        if (!applyInProgress || applyAbortRequested)
            return;
        applyAbortRequested = true;
        renderSuggestionReview();
        showToast('Đã yêu cầu dừng; userscript sẽ dừng sau thao tác segment hiện tại.');
    }
    async function applySelectedSuggestions() {
        if (applyInProgress) {
            requestApplyStop();
            return;
        }
        if (isQcWorkflowActive()) {
            showToast('Đang chạy QC; hãy dừng QC trước khi áp dụng gợi ý.');
            return;
        }
        if (modules.autoCut.isAutoCutting || modules.autoCut.aiPhase !== 'idle') {
            showToast('Một thao tác Auto-Cut khác đang chạy; hãy đợi thao tác đó kết thúc.');
            return;
        }
        const context = modules.autoCut.activeSuggestionContext;
        if (!context || !isApplyContextCurrent(context)) {
            clearStaleSuggestionContext();
            showToast('Video hoặc task đã đổi. Hãy tạo lại gợi ý trước khi áp dụng.');
            return;
        }
        const selected = modules.autoCut.loadedCutTimes
            .map((range, index) => ({
                index,
                start: Number(range.start),
                end: Number(range.end),
                key: suggestionRangeKey(range.start, range.end)
            }))
            .filter(range => selectedSuggestionKeys.has(range.key)
                && !appliedSuggestionKeys.has(range.key)
                && !partialSuggestionKeys.has(range.key));
        if (!selected.length) {
            showToast('Chọn ít nhất một khoảng chưa áp dụng.');
            return;
        }
        let existingRanges;
        try {
            existingRanges = readExistingTimelineRanges();
        }
        catch (error) {
            showToast(error.message);
            return;
        }
        const conflict = selected.find(range => existingRanges.some(existing => rangesOverlap(range, existing)));
        if (conflict) {
            const overlapping = existingRanges.find(existing => rangesOverlap(conflict, existing));
            showToast(`Khoảng #${conflict.index + 1} trùng segment #${overlapping.index} `
                + `(${formatTimecode(overlapping.start)}–${formatTimecode(overlapping.end)}). Không có thay đổi nào được áp dụng.`);
            return;
        }
        const summary = selected.map(range =>
            `#${range.index + 1} ${formatTimecode(range.start)}–${formatTimecode(range.end)}`
        ).join('\n');
        if (!confirm(`Tạo ${selected.length} segment mới trong các khoảng trống sau?\n${summary}\n`
            + 'Preview hiện tại chưa sửa segment. Các segment đang có sẽ không bị chỉnh sửa. '
            + 'Nếu dừng giữa chừng, các segment đã tạo sẽ được giữ lại; dùng Undo của Tbrain để hoàn tác từng thao tác.'))
            return;

        stopSuggestionLoop(true);
        const wasAutoCutting = modules.autoCut.isAutoCutting;
        let completed = 0;
        let partialKey = null;
        let failureToast = '';
        applyInProgress = true;
        applyAbortRequested = false;
        modules.autoCut.isAutoCutting = true;
        setR2CancelBtnEnabled(modules.autoCut.hasActiveSuggestions);
        renderSuggestionReview();
        try {
            for (const range of selected) {
                assertApplyContext(context);
                const currentSegments = readExistingTimelineRanges();
                if (currentSegments.some(existing => rangesOverlap(range, existing)))
                    throw new Error(`Khoảng #${range.index + 1} vừa trùng với segment hiện có; đã dừng.`);
                const countBefore = modules.timeline.getEpisodeRows().length;
                const positioned = await modules.timeline.seekTo(
                    range.start,
                    () => isApplyContextCurrent(context)
                );
                assertApplyContext(context);
                if (!positioned && Math.abs(context.video.currentTime - range.start) > 0.6)
                    throw new Error(`Không tua được đến ${formatTimecode(range.start)}.`);
                const created = await modules.timeline.createSegmentAt(
                    range.start,
                    () => isApplyContextCurrent(context),
                    () => { partialKey = range.key; }
                );
                if (created)
                    partialKey = range.key;
                else if (isApplyContextCurrent(context)
                    && modules.timeline.getEpisodeRows().length > countBefore)
                    partialKey = range.key;
                assertApplyContext(context);
                if (!created) {
                    throw new Error(`Không tạo được segment #${range.index + 1}.`);
                }
                const countAfter = modules.timeline.getEpisodeRows().length;
                if (countAfter !== countBefore + 1)
                    throw new Error(`Số segment thay đổi ngoài dự kiến sau khoảng #${range.index + 1}.`);
                const segmentRow = modules.timeline.findRowAt(range.start);
                if (!segmentRow)
                    throw new Error(`Không tìm thấy segment mới tại ${formatTimecode(range.start)}.`);
                const desiredDuration = range.end - range.start;
                const defaultDuration = Number(modules.config.AUTOCUT.segLen) || 30;
                if (desiredDuration > defaultDuration + 0.05) {
                    const extended = await modules.timeline.extendByDrag(
                        segmentRow.number,
                        desiredDuration,
                        () => isApplyContextCurrent(context)
                    );
                    assertApplyContext(context);
                    if (!extended)
                        throw new Error(`Không thể kéo dài segment #${range.index + 1} đến đúng khoảng gợi ý.`);
                }
                assertApplyContext(context);
                if (Math.abs(desiredDuration - defaultDuration) > 0.05) {
                    const trimmed = await modules.timeline.trimTailTo(
                        range.start,
                        range.end,
                        () => isApplyContextCurrent(context)
                    );
                    assertApplyContext(context);
                    if (!trimmed)
                        throw new Error(`Không thể chỉnh điểm kết thúc segment #${range.index + 1}.`);
                }
                assertApplyContext(context);
                const selectedRow = await modules.timeline.selectSegmentAt(
                    range.start,
                    () => isApplyContextCurrent(context)
                );
                assertApplyContext(context);
                if (!selectedRow)
                    throw new Error(`Không thể xác minh segment #${range.index + 1}.`);
                const actual = modules.timeline.readActiveEpisodeRange();
                if (!actual || !Number.isFinite(actual.start) || !Number.isFinite(actual.end)
                    || Math.abs(actual.start - range.start) > 1
                    || Math.abs(actual.end - range.end) > 1)
                    throw new Error(`Segment #${range.index + 1} không khớp range dự kiến.`);
                appliedSuggestionKeys.add(range.key);
                selectedSuggestionKeys.delete(range.key);
                partialKey = null;
                completed++;
                renderSuggestionReview();
            }
            showToast(`Đã áp dụng ${completed} khoảng thành segment mới. Dùng Undo của Tbrain để hoàn tác từng thao tác.`);
        }
        catch (error) {
            if (partialKey) {
                partialSuggestionKeys.add(partialKey);
                selectedSuggestionKeys.delete(partialKey);
            }
            const partialMessage = partialKey ? ' Khoảng cuối có thể đã thay đổi một phần; hãy kiểm tra timeline.' : '';
            modules.logger.console.error('❌ [R2 Apply Suggestions]', error);
            failureToast = `Đã áp dụng ${completed}/${selected.length} khoảng; dừng vì: ${error.message}.${partialMessage}`;
        }
        finally {
            modules.autoCut.isAutoCutting = wasAutoCutting;
            applyInProgress = false;
            applyAbortRequested = false;
            setR2CancelBtnEnabled(modules.autoCut.hasActiveSuggestions);
            renderSuggestionReview();
            if (failureToast)
                showToast(failureToast);
        }
    }
    function renderSuggestionReview() {
        clearStaleSuggestionContext();
        const row = document.getElementById('tbp-row-cut-review');
        if (!row)
            return;
        const ranges = modules.autoCut.hasActiveSuggestions && Array.isArray(modules.autoCut.loadedCutTimes)
            ? modules.autoCut.loadedCutTimes
            : [];
        const context = modules.autoCut.activeSuggestionContext;
        if (previewLoop) {
            const activeRange = ranges[previewLoop.index];
            if (!activeRange
                || Number(activeRange.start) !== previewLoop.start
                || Number(activeRange.end) !== previewLoop.end
                || !context
                || context.id !== previewLoop.suggestionId
                || !isCurrentVideoContext(previewLoop.video, previewLoop.videoUrl, previewLoop.pageKey))
                stopSuggestionLoop(true, false);
        }
        const source = ranges.length ? modules.autoCut.loadedJsonName || 'R2' : '';
        const rangePairs = ranges.map(range => [Number(range.start), Number(range.end)]);
        const selectionSignature = JSON.stringify({
            suggestionId: context ? context.id : null,
            source,
            ranges: rangePairs,
            videoUrl: context ? context.videoUrl : '',
            pageKey: context ? context.pageKey : ''
        });
        if (selectionSignature !== reviewSelectionSignature) {
            selectedSuggestionKeys.clear();
            appliedSuggestionKeys.clear();
            partialSuggestionKeys.clear();
            reviewSelectionSignature = selectionSignature;
        }
        const signature = JSON.stringify({
            suggestionId: context ? context.id : null,
            source,
            ranges: rangePairs,
            loop: previewLoop ? `${previewLoop.index}:${previewLoop.starting ? 'starting' : 'playing'}` : '',
            selected: Array.from(selectedSuggestionKeys).sort(),
            applied: Array.from(appliedSuggestionKeys).sort(),
            partial: Array.from(partialSuggestionKeys).sort(),
            applying: applyInProgress,
            stopping: applyAbortRequested
        });
        const hasChildren = !!(row.children && row.children.length);
        const sameContext = context
            ? reviewSuggestionId === context.id && reviewVideo === context.video
                && reviewVideoUrl === context.videoUrl && reviewPageKey === context.pageKey
            : !reviewVideo;
        if (signature === reviewSignature && sameContext && (ranges.length ? hasChildren : !hasChildren))
            return;
        Array.from(row.children || []).forEach(child => child.remove());
        reviewSignature = signature;
        reviewVideo = context ? context.video : null;
        reviewVideoUrl = context ? context.videoUrl : '';
        reviewPageKey = context ? context.pageKey : '';
        reviewSuggestionId = context ? context.id : null;
        if (!ranges.length) {
            setR2CancelBtnEnabled(false);
            return;
        }

        const panel = document.createElement('div');
        panel.className = 'tbp-r2-review';
        panel.setAttribute('role', 'region');
        panel.setAttribute('aria-label', 'R2 suggestion review');
        const header = document.createElement('div');
        header.className = 'tbp-r2-review-head';
        const title = document.createElement('span');
        title.textContent = `🟡 ${source}: ${ranges.length} khoảng`;
        const hint = document.createElement('span');
        hint.className = 'tbp-r2-review-hint';
        hint.textContent = 'Preview chưa sửa segment · bấm thời gian để tua · Cuối để tua cuối · Lặp để phát lại';
        header.appendChild(title);
        header.appendChild(hint);
        panel.appendChild(header);

        const list = document.createElement('div');
        list.className = 'tbp-r2-review-list';
        list.setAttribute('aria-label', 'Danh sách khoảng gợi ý');
        ranges.forEach((range, index) => {
            const start = Number(range && range.start);
            const end = Number(range && range.end);
            if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
                return;
            const item = document.createElement('div');
            item.className = 'tbp-r2-review-item';
            const key = suggestionRangeKey(start, end);
            if (appliedSuggestionKeys.has(key) || partialSuggestionKeys.has(key)) {
                const status = document.createElement('span');
                status.className = appliedSuggestionKeys.has(key)
                    ? 'tbp-r2-review-applied'
                    : 'tbp-r2-review-partial';
                status.textContent = appliedSuggestionKeys.has(key) ? '✓ Đã áp dụng' : '⚠ Kiểm tra';
                status.title = appliedSuggestionKeys.has(key)
                    ? 'Segment mới đã được tạo trên timeline'
                    : 'Thao tác dừng giữa chừng; hãy kiểm tra segment trên timeline';
                item.appendChild(status);
            }
            else {
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.className = 'tbp-r2-review-select';
                checkbox.checked = selectedSuggestionKeys.has(key);
                checkbox.disabled = applyInProgress;
                checkbox.setAttribute('aria-label', `Chọn khoảng ${index + 1} để áp dụng`);
                checkbox.addEventListener('change', () => {
                    if (checkbox.checked)
                        selectedSuggestionKeys.add(key);
                    else
                        selectedSuggestionKeys.delete(key);
                    renderSuggestionReview();
                });
                item.appendChild(checkbox);
            }
            const rangeButton = createReviewButton(
                `#${index + 1} ${formatTimecode(start)}–${formatTimecode(end)}`,
                'tbp-r2-review-range tbp-btn-secondary',
                `Tua đến đầu khoảng ${index + 1} (${formatTimecode(start)})`,
                () => seekSuggestionTime(start, index, start, end, context)
            );
            rangeButton.setAttribute('aria-label', `Tua đến đầu khoảng ${index + 1}, ${formatTimecode(start)} đến ${formatTimecode(end)}`);
            rangeButton.disabled = applyInProgress;
            item.appendChild(rangeButton);
            const endButton = createReviewButton(
                'Cuối',
                'tbp-r2-review-action tbp-btn-neutral',
                `Tua đến cuối khoảng ${index + 1} (${formatTimecode(end)})`,
                () => seekSuggestionTime(end, index, start, end, context)
            );
            endButton.disabled = applyInProgress;
            item.appendChild(endButton);
            const loopActive = previewLoop && previewLoop.index === index;
            const loopButton = createReviewButton(
                loopActive ? previewLoop.starting ? '⏳ Tua...' : '⏹ Dừng' : '▶ Lặp',
                `tbp-r2-review-action ${loopActive ? 'tbp-btn-info tbp-btn-active tbp-r2-review-loop-active' : 'tbp-btn-neutral'}`,
                loopActive ? 'Dừng phát lặp khoảng này' : 'Phát lặp khoảng này',
                () => toggleSuggestionLoop(index, start, end, context)
            );
            loopButton.setAttribute('aria-pressed', loopActive ? 'true' : 'false');
            loopButton.disabled = applyInProgress || !!(loopActive && previewLoop.starting);
            if (loopActive && previewLoop.starting)
                loopButton.title = 'Đang tua tới đầu khoảng...';
            item.appendChild(loopButton);
            list.appendChild(item);
        });
        panel.appendChild(list);
        const actions = document.createElement('div');
        actions.className = 'tbp-r2-review-actions';
        const availableKeys = ranges
            .map(range => suggestionRangeKey(range.start, range.end))
            .filter(key => !appliedSuggestionKeys.has(key) && !partialSuggestionKeys.has(key));
        const allSelected = availableKeys.length > 0
            && availableKeys.every(key => selectedSuggestionKeys.has(key));
        const selectAllButton = createReviewButton(
            allSelected ? 'Bỏ chọn tất cả' : 'Chọn tất cả',
            'tbp-r2-review-action tbp-btn-neutral',
            'Chọn hoặc bỏ chọn các khoảng chưa áp dụng',
            () => {
                if (allSelected)
                    availableKeys.forEach(key => selectedSuggestionKeys.delete(key));
                else
                    availableKeys.forEach(key => selectedSuggestionKeys.add(key));
                renderSuggestionReview();
            }
        );
        selectAllButton.disabled = applyInProgress || !availableKeys.length;
        actions.appendChild(selectAllButton);
        const applyButton = createReviewButton(
            applyInProgress
                ? applyAbortRequested ? '⏳ Đang dừng...' : '⏹ Dừng áp dụng'
                : `Áp dụng đã chọn (${selectedSuggestionKeys.size})`,
            `tbp-r2-review-apply ${applyInProgress ? 'tbp-btn-danger tbp-btn-active' : 'tbp-btn-success'}`,
            applyInProgress
                ? 'Dừng sau khi hoàn tất thao tác segment hiện tại'
                : 'Tạo segment mới cho các khoảng đã chọn; preview không áp dụng tự động',
            () => applyInProgress ? requestApplyStop() : applySelectedSuggestions()
        );
        applyButton.disabled = applyInProgress ? applyAbortRequested : selectedSuggestionKeys.size === 0;
        applyButton.setAttribute('aria-disabled', applyButton.disabled ? 'true' : 'false');
        actions.appendChild(applyButton);
        const note = document.createElement('span');
        note.className = 'tbp-r2-review-note';
        note.textContent = 'Áp dụng chỉ tạo segment ở khoảng trống; segment cũ không bị sửa. Hủy preview không xóa segment đã áp dụng.';
        actions.appendChild(note);
        panel.appendChild(actions);
        row.appendChild(panel);
        setR2CancelBtnEnabled(modules.autoCut.hasActiveSuggestions);
    }
    function stopSuggestionLoop(pauseVideo = false, refresh = true) {
        const state = previewLoop;
        if (!state)
            return false;
        previewLoop = null;
        const video = state.video;
        if (state.onTimeUpdate && video.removeEventListener)
            video.removeEventListener('timeupdate', state.onTimeUpdate);
        if (state.onEnded && video.removeEventListener)
            video.removeEventListener('ended', state.onEnded);
        if (state.onPlay && video.removeEventListener)
            video.removeEventListener('play', state.onPlay);
        if (state.onPause && video.removeEventListener)
            video.removeEventListener('pause', state.onPause);
        if (state.frameId != null && typeof cancelAnimationFrame === 'function')
            cancelAnimationFrame(state.frameId);
        if (pauseVideo && typeof video.pause === 'function')
            video.pause();
        if (refresh)
            renderSuggestionReview();
        return true;
    }
    function reportPreviewLoopError(state, error) {
        if (previewLoop !== state)
            return;
        modules.logger.console.error('❌ [R2 Preview Loop]', error);
        stopSuggestionLoop(false);
        showToast('Không thể phát lặp khoảng gợi ý: ' + (error && error.message || 'lỗi video'));
    }
    function playPreviewLoopVideo(state) {
        try {
            const result = state.video.play();
            if (result && typeof result.catch === 'function')
                result.catch(error => reportPreviewLoopError(state, error));
        }
        catch (error) {
            reportPreviewLoopError(state, error);
        }
    }
    function handlePreviewLoopPosition(state) {
        if (previewLoop !== state)
            return;
        const context = modules.autoCut.activeSuggestionContext;
        if (!context || context.id !== state.suggestionId
            || !isCurrentVideoContext(state.video, state.videoUrl, state.pageKey)) {
            stopSuggestionLoop(true);
            return;
        }
        if (state.video.currentTime < state.end)
            return;
        try {
            state.video.currentTime = state.start;
            playPreviewLoopVideo(state);
        }
        catch (error) {
            reportPreviewLoopError(state, error);
        }
    }
    function schedulePreviewLoopFrame(state) {
        if (previewLoop !== state || state.frameId != null || state.video.paused
            || typeof requestAnimationFrame !== 'function')
            return;
        state.frameId = requestAnimationFrame(() => {
            state.frameId = null;
            if (previewLoop !== state)
                return;
            handlePreviewLoopPosition(state);
            schedulePreviewLoopFrame(state);
        });
    }
    async function seekSuggestionTime(time, index, start, end, context) {
        if (!isActiveSuggestionRange(index, start, end, context)) {
            clearStaleSuggestionContext();
            if (modules.autoCut.hasActiveSuggestions) {
                renderSuggestionReview();
                showToast('Video hoặc task đã đổi. Hãy mở lại gợi ý mới nhất.');
            }
            return;
        }
        const activeContext = context;
        const video = activeContext.video;
        if (!Number.isFinite(video.duration) || time < 0 || time > video.duration) {
            showToast('Video chưa sẵn sàng hoặc thời gian gợi ý không hợp lệ.');
            return;
        }
        stopSuggestionLoop(true);
        const videoUrl = video.currentSrc || video.src || '';
        const pageKey = getPageKey();
        try {
            const positioned = await modules.timeline.seekTo(time);
            if (!isCurrentVideoContext(video, videoUrl, pageKey)) {
                showToast('Video hoặc task đã đổi trong lúc tua. Hãy mở lại gợi ý mới nhất.');
                return;
            }
            if (!positioned && Math.abs(video.currentTime - time) > 0.6)
                showToast(`Không tua được đến ${formatTimecode(time)}.`);
        }
        catch (error) {
            modules.logger.console.error('❌ [R2 Review Seek]', error);
            showToast('Không tua được đến khoảng gợi ý: ' + (error && error.message || 'lỗi video'));
        }
    }
    async function toggleSuggestionLoop(index, start, end, context) {
        if (!isActiveSuggestionRange(index, start, end, context)) {
            stopSuggestionLoop(true);
            clearStaleSuggestionContext();
            if (modules.autoCut.hasActiveSuggestions) {
                renderSuggestionReview();
                showToast('Khoảng gợi ý đã thay đổi. Hãy chọn lại trong danh sách mới nhất.');
            }
            return;
        }
        if (previewLoop && previewLoop.index === index
            && isCurrentVideoContext(previewLoop.video, previewLoop.videoUrl, previewLoop.pageKey)) {
            stopSuggestionLoop(true);
            return;
        }
        stopSuggestionLoop(true);
        const activeContext = context;
        const video = activeContext.video;
        if (!Number.isFinite(video.duration) || start < 0 || end <= start || end > video.duration) {
            showToast('Video chưa sẵn sàng hoặc thời gian gợi ý không hợp lệ.');
            return;
        }
        const state = {
            index,
            start,
            end,
            video,
            suggestionId: activeContext.id,
            videoUrl: activeContext.videoUrl,
            pageKey: activeContext.pageKey,
            starting: true,
            frameId: null,
            onTimeUpdate: null,
            onEnded: null,
            onPlay: null,
            onPause: null
        };
        previewLoop = state;
        renderSuggestionReview();
        try {
            const positioned = await modules.timeline.seekTo(start);
            if (previewLoop !== state)
                return;
            if (!isCurrentVideoContext(video, state.videoUrl, state.pageKey)) {
                stopSuggestionLoop(false);
                showToast('Video hoặc task đã đổi. Hãy mở lại gợi ý mới nhất.');
                return;
            }
            if (!positioned && Math.abs(video.currentTime - start) > 0.6) {
                stopSuggestionLoop(false);
                showToast(`Không tua được đến ${formatTimecode(start)}.`);
                return;
            }
            state.starting = false;
            state.onTimeUpdate = () => {
                if (!video.paused)
                    handlePreviewLoopPosition(state);
            };
            state.onEnded = () => handlePreviewLoopPosition(state);
            state.onPlay = () => schedulePreviewLoopFrame(state);
            state.onPause = () => {
                if (state.frameId != null && typeof cancelAnimationFrame === 'function')
                    cancelAnimationFrame(state.frameId);
                state.frameId = null;
            };
            video.addEventListener('timeupdate', state.onTimeUpdate);
            video.addEventListener('ended', state.onEnded);
            video.addEventListener('play', state.onPlay);
            video.addEventListener('pause', state.onPause);
            playPreviewLoopVideo(state);
            renderSuggestionReview();
            schedulePreviewLoopFrame(state);
        }
        catch (error) {
            reportPreviewLoopError(state, error);
        }
    }
    function resetManualSuggestionState() {
        manualSuggestionStart = null;
        manualSuggestionRanges = [];
        manualSuggestionContext = null;
    }
    function isQcWorkflowActive() {
        return modules.qcStore.state.busy || modules.qcStore.state.workflow;
    }
    function recordManualSuggestionStart() {
        manualSuggestionStart = null;
        if (applyInProgress) {
            showToast('Hãy đợi thao tác áp dụng gợi ý kết thúc trước khi tạo vùng Q/W.');
            return;
        }
        if (isQcWorkflowActive()) {
            showToast('Đang chạy QC; hãy dừng QC trước khi tạo vùng gợi ý.');
            return;
        }
        stopSuggestionLoop(true);
        const video = modules.timeline.getVideos()[0];
        if (!video || !Number.isFinite(video.currentTime) || !Number.isFinite(video.duration) || video.duration <= 0) {
            showToast('Không tìm thấy video đã load. Hãy chờ video sẵn sàng rồi nhấn Q.');
            return;
        }
        const videoUrl = video.currentSrc || video.src || '';
        const pageKey = getPageKey();
        const sameManualContext = manualSuggestionContext
            && manualSuggestionContext.video === video
            && manualSuggestionContext.videoUrl === videoUrl
            && manualSuggestionContext.pageKey === pageKey;
        if (modules.autoCut.loadedJsonName !== MANUAL_SUGGESTION_SOURCE || !sameManualContext)
            manualSuggestionRanges = [];
        manualSuggestionContext = { video, videoUrl, pageKey };
        manualSuggestionStart = {
            time: video.currentTime,
            video,
            videoUrl,
            pageKey,
            sourceLabel: modules.autoCut.loadedJsonName
        };
        const timecode = formatTimecode(video.currentTime);
        modules.logger.console.log(`[Q/W] Đã ghi điểm bắt đầu ${timecode}.`);
        showToast(`Đã ghi điểm bắt đầu ${timecode} cho gợi ý #${manualSuggestionRanges.length + 1}. Phát đến điểm kết thúc rồi nhấn W.`);
    }
    function showManualSuggestionEnd() {
        if (!manualSuggestionStart) {
            showToast('Chưa có điểm bắt đầu. Hãy nhấn Q trước.');
            return;
        }
        if (applyInProgress) {
            showToast('Hãy đợi thao tác áp dụng gợi ý kết thúc trước khi tạo vùng Q/W.');
            return;
        }
        if (isQcWorkflowActive()) {
            showToast('Đang chạy QC; hãy dừng QC trước khi tạo vùng gợi ý.');
            return;
        }
        const video = modules.timeline.getVideos()[0];
        if (!video || !Number.isFinite(video.currentTime) || !Number.isFinite(video.duration) || video.duration <= 0) {
            showToast('Không tìm thấy video đã load. Hãy chờ video sẵn sàng rồi nhấn W.');
            return;
        }
        const videoUrl = video.currentSrc || video.src || '';
        const pageKey = getPageKey();
        if (manualSuggestionStart.video !== video
            || (manualSuggestionStart.videoUrl && videoUrl && manualSuggestionStart.videoUrl !== videoUrl)
            || manualSuggestionStart.pageKey !== pageKey
            || manualSuggestionStart.sourceLabel !== modules.autoCut.loadedJsonName) {
            resetManualSuggestionState();
            showToast('Video, trang hoặc vùng gợi ý đã thay đổi sau khi nhấn Q. Hãy nhấn Q lại.');
            return;
        }
        const start = manualSuggestionStart.time;
        const end = video.currentTime;
        if (!Number.isFinite(start) || end <= start) {
            showToast('Điểm W phải nằm sau điểm Q.');
            return;
        }
        const nextRanges = [...manualSuggestionRanges, { start, end }].sort((a, b) => a.start - b.start);
        let shown;
        try {
            shown = modules.autoCut.runAutoCutFromTimes(nextRanges, { sourceLabel: MANUAL_SUGGESTION_SOURCE });
        }
        catch (err) {
            modules.logger.console.error('❌ [Q/W Suggestions]', err);
            setR2CancelBtnEnabled(modules.autoCut.hasActiveSuggestions);
            showToast('Không thể hiển thị vùng gợi ý Q/W: ' + err.message);
            return;
        }
        setR2CancelBtnEnabled(modules.autoCut.hasActiveSuggestions);
        if (!shown) {
            showToast('Không thể thêm vùng gợi ý. Kiểm tra video và tránh các khoảng chồng lấn.');
            return;
        }
        stopSuggestionLoop(true);
        manualSuggestionRanges = nextRanges;
        manualSuggestionContext = { video, videoUrl, pageKey };
        manualSuggestionStart = null;
        renderSuggestionReview();
        showToast(`Đã thêm gợi ý #${manualSuggestionRanges.length}: ${formatTimecode(start)}–${formatTimecode(end)}. Có ${manualSuggestionRanges.length} vùng vàng; nhấn Q/W để thêm tiếp hoặc "Hủy gợi ý" để xóa.`);
    }
    function handleManualSuggestionShortcut(event) {
        const key = event.code === 'KeyQ' ? 'q'
            : event.code === 'KeyW' ? 'w'
                : String(event.key || '').toLowerCase();
        if ((key !== 'q' && key !== 'w') || event.repeat
            || event.ctrlKey || event.altKey || event.metaKey
            || isEditableTarget(event.target) || isEditableTarget(document.activeElement))
            return;
        event.preventDefault();
        event.stopPropagation();
        if (key === 'q')
            recordManualSuggestionStart();
        else
            showManualSuggestionEnd();
    }
    function cancelR2Suggestions() {
        if (applyInProgress) {
            requestApplyStop();
            return;
        }
        stopSuggestionLoop(true);
        const cancelled = modules.autoCut.cancelSuggestions();
        resetManualSuggestionState();
        resetReviewSelectionState();
        setR2CancelBtnEnabled(modules.autoCut.hasActiveSuggestions);
        renderSuggestionReview();
        if (cancelled)
            modules.logger.console.log('[R2] Đã hủy các vùng gợi ý trên timeline/video.');
    }
    async function runPasteForSuggestions() {
        if (applyInProgress) {
            showToast('Hãy đợi thao tác áp dụng gợi ý kết thúc trước khi dán gợi ý mới.');
            return;
        }
        if (modules.qcStore.state.busy || modules.qcStore.state.workflow) {
            modules.logger.console.warn('[QC] Đang chạy QC; bấm Dừng QC trước.');
            return;
        }
        const video = modules.timeline.getVideos()[0];
        if (!video || !Number.isFinite(video.duration) || video.duration <= 0) {
            alert('Video chưa sẵn sàng hoặc chưa đọc được thời lượng. Hãy đợi video load xong rồi dán lại.');
            return;
        }
        const context = {
            video,
            videoUrl: video.currentSrc || video.src || '',
            pageKey: getPageKey()
        };
        const text = await readR2Text();
        if (!text.trim())
            return;
        let parsed;
        try {
            parsed = parseR2Result(text);
        }
        catch (e) {
            alert('Dán gợi ý R2: ' + e.message);
            return;
        }
        if (!validateR2VideoIdentity(parsed, context))
            return;
        modules.logger.console.log(`📋 [R2] ${parsed.ranges.length} gợi ý:`, parsed.ranges);
        const preset = R2_SENSITIVITY_PRESETS.find(item => item.value === parsed.sensitivityPreset);
        const sourceLabel = preset
            ? `R2 Handtrack · ${preset.label.replace('Độ nhạy: ', '')}`
            : 'R2 Handtrack';
        let shown;
        try {
            shown = modules.autoCut.runAutoCutFromTimes(parsed.ranges, { sourceLabel });
        }
        catch (err) {
            modules.logger.console.error('❌ [R2 Suggestions]', err);
            setR2CancelBtnEnabled(modules.autoCut.hasActiveSuggestions);
            showToast('Không thể hiển thị gợi ý R2: ' + err.message);
            return;
        }
        setR2CancelBtnEnabled(modules.autoCut.hasActiveSuggestions);
        if (!shown) {
            showToast('Không thể hiển thị vùng gợi ý. Kiểm tra video và thời lượng của các ranges.');
            return;
        }
        stopSuggestionLoop(true);
        renderSuggestionReview();
        showToast(`Đã hiển thị ${parsed.ranges.length} vùng gợi ý màu vàng. Không thay đổi segment thật.`);
        if (pendingR2Scan && ((parsed.scanId && parsed.scanId === pendingR2Scan.scanId)
            || (parsed.videoFingerprint && parsed.videoFingerprint === pendingR2Scan.videoFingerprint)))
            pendingR2Scan = null;
        resetManualSuggestionState();
    }
    function showToast(msg, ms = 9000) {
        try {
            const old = document.getElementById('tb-r2-toast');
            if (old)
                old.remove();
            const d = document.createElement('div');
            d.id = 'tb-r2-toast';
            d.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;max-width:520px;'
                + 'padding:10px 14px;border-radius:8px;background:#111827;color:#f9fafb;font:13px/1.45 system-ui,sans-serif;'
                + 'box-shadow:0 8px 24px rgba(0,0,0,.45);white-space:pre-line';
            d.textContent = msg;
            document.body.appendChild(d);
            setTimeout(() => d.remove(), ms);
        }
        catch (_) { }
    }
    // Copy đồng bộ trong sự kiện click: API clipboard, lỗi thì dùng execCommand
    async function copyText(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        }
        catch (_) { }
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;left:-9999px;top:0';
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            const ok = document.execCommand('copy');
            ta.remove();
            return ok;
        }
        catch (_) {
            return false;
        }
    }
    function createR2ScanId() {
        return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    }
    // Script đầy đủ = preset độ nhạy + mã quét, gắn với video/task đang mở.
    function buildR2Script(scanId, expectedVideoFingerprint, sensitivityPreset) {
        const preset = R2_SENSITIVITY_PRESETS.some(item => item.value === sensitivityPreset)
            ? sensitivityPreset
            : getSelectedSensitivityPreset();
        const ovr = Object.assign(getSensitivitySettings(preset), {
            sensitivityPreset: preset,
            scanId: scanId || '',
            expectedVideoFingerprint: expectedVideoFingerprint || '',
            withFrames: false
        });
        return 'window.__R2_OVR = ' + JSON.stringify(ovr) + ';\n'
            + 'window.__TB_R2_FINGERPRINT = ' + modules.r2Scanner.fingerprintVideoUrl.toString() + ';\n'
            + modules.r2Scanner.R2_SCAN_SRC;
    }
    async function openVideoTab() {
        if (applyInProgress) {
            showToast('Hãy đợi thao tác áp dụng gợi ý kết thúc trước khi mở lượt quét mới.');
            return;
        }
        const video = modules.timeline.getVideos()[0];
        const url = video && (video.currentSrc || video.src);
        if (!url) {
            alert('Không tìm thấy video (đợi video load xong rồi bấm lại).');
            return;
        }
        const scanId = createR2ScanId();
        const videoFingerprint = modules.r2Scanner.fingerprintVideoUrl(url);
        const sensitivityPreset = getSelectedSensitivityPreset();
        pendingR2Scan = {
            scanId,
            video,
            videoUrl: url,
            videoFingerprint,
            pageKey: getPageKey(),
            sensitivityPreset
        };
        // R2 gửi video kèm lệnh tải về nên KHÔNG mở thẳng link video.
        // Mở trang gốc của domain R2 (cùng origin => đọc được pixel), gắn link video vào #tbv=...
        let target = url;
        try {
            target = new URL(url).origin + '/#tbv=' + encodeURIComponent(url);
        }
        catch (_) { }
        // Mở tab trước (đồng bộ trong click, tránh bị chặn popup), rồi copy script
        const w = window.open(target, '_blank');
        const ok = await copyText(buildR2Script(scanId, videoFingerprint, sensitivityPreset));
        if (!w)
            showToast('⚠️ Trình duyệt chặn mở tab mới. Hãy cho phép popup cho trang này rồi bấm lại.');
        else if (ok)
            showToast('✅ Đã copy script quét tay.\nQua tab R2 vừa mở: F12 → Console → Ctrl+V → Enter.\n(Lần đầu Console có thể bắt gõ "allow pasting" trước.)');
        else
            showToast('⚠️ Không copy được vào clipboard. Bấm lại nút 🔗 Mở video khi tab Tbrain đang được chọn.');
    }
    function injectSensitivityControl(row) {
        if (document.getElementById('tb-r2-sensitivity'))
            return;
        const select = document.createElement('select');
        select.id = 'tb-r2-sensitivity';
        select.className = 'tbp-r2-sensitivity tbp-control-select';
        select.title = 'Nhạy hơn: quét dày và giữ đoạn ngắn, có thể chậm/nhiều nhiễu. Ít nhiễu: lọc chặt hơn nhưng có thể bỏ sót.';
        select.setAttribute('aria-label', 'Độ nhạy quét R2');
        R2_SENSITIVITY_PRESETS.forEach(preset => {
            const option = document.createElement('option');
            option.value = preset.value;
            option.textContent = preset.label;
            select.appendChild(option);
        });
        select.value = selectedSensitivityPreset;
        select.addEventListener('change', () => {
            if (R2_SENSITIVITY_PRESETS.some(preset => preset.value === select.value))
                selectedSensitivityPreset = select.value;
        });
        row.appendChild(select);
    }
    function injectR2Btns() {
        clearStaleSuggestionContext();
        const row = modules.panel.ensurePanel() && document.getElementById('tbp-row-cut');
        if (!row)
            return;
        const rowClasses = String(row.className || '').split(/\s+/).filter(Boolean);
        if (!rowClasses.includes('tbp-toolbar'))
            row.className = [...rowClasses, 'tbp-toolbar'].join(' ');
        const cls = 'tbp-btn';
        if (!document.getElementById('tb-inject-r2-open')) {
            const btnOpen = document.createElement('button');
            btnOpen.id = 'tb-inject-r2-open';
            btnOpen.type = 'button';
            btnOpen.className = `${cls} tbp-btn-info`;
            btnOpen.textContent = '🔗 Mở video';
            btnOpen.title = 'Mở tab R2 và copy sẵn script quét tay vào clipboard (qua tab R2: F12 → Console → Ctrl+V → Enter)';
            btnOpen.addEventListener('click', openVideoTab);
            row.appendChild(btnOpen);
        }
        injectSensitivityControl(row);
        if (!document.getElementById('tb-inject-r2-paste')) {
            const btnPaste = document.createElement('button');
            btnPaste.id = 'tb-inject-r2-paste';
            btnPaste.type = 'button';
            btnPaste.className = `${cls} tbp-btn-info`;
            btnPaste.textContent = '📋 Dán gợi ý';
            btnPaste.title = 'Phím Q/W: mỗi cặp Q rồi W thêm một vùng vàng; không cần segment. Nút này đọc JSON clipboard → tô vàng ranges trên timeline/video, không sửa segments hoặc annotation';
            btnPaste.addEventListener('click', runPasteForSuggestions);
            row.appendChild(btnPaste);
        }
        if (!document.getElementById('tb-inject-r2-cancel')) {
            const btnCancel = document.createElement('button');
            btnCancel.id = 'tb-inject-r2-cancel';
            btnCancel.type = 'button';
            btnCancel.className = `${cls} tbp-btn-danger`;
            btnCancel.textContent = '✕ Hủy gợi ý';
            btnCancel.title = 'Xóa các vùng vàng gợi ý khỏi timeline/video; không sửa segment thật';
            btnCancel.addEventListener('click', cancelR2Suggestions);
            row.appendChild(btnCancel);
        }
        setR2CancelBtnEnabled(modules.autoCut.hasActiveSuggestions);
        renderSuggestionReview();
    }
    function init() {
        if (initialized)
            return;
        initialized = true;
        document.addEventListener('keydown', handleManualSuggestionShortcut, true);
    }
    return {
        get parseR2Result() { return parseR2Result; },
        get injectR2Btns() { return injectR2Btns; },
        init
    };
};
