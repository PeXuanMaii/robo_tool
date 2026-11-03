/**
 * autoCut
 * Auto-cut orchestration, progress, stop state and debug helpers.
 * Dependencies: config, environment, handDetection, logger, media, qcStore, runtime, storage, timeline, videoTransport.
 * Module state stays in this closure; cross-module mutable bindings use live accessors.
 */
module.exports = function createAutoCut(modules) {
    'use strict';
    let isAutoCutting = false;
    let loadedCutTimes = [];
    let loadedJsonName = '';
    let aiPhase = 'idle'; // idle | download | detect | preview
    let aiAbort = false;
    let activeCutSuggestions = null;
    let suggestionSequence = 0;
    const aiCache = new Map(); // videoKey (url bỏ query) -> ranges; đồng bộ với IndexedDB (không mất khi F5)
    const BUTTON_TONE_BY_COLOR = {
        '#6b7280': 'neutral',
        '#0891b2': 'info',
        '#be185d': 'info',
        '#7c3aed': 'primary'
    };

    function setButtonPresentation(button, color, state) {
        const existingTone = String(button.className || '')
            .split(/\s+/)
            .find(name => /^tbp-btn-(primary|success|info|danger|neutral|secondary|warning)$/.test(name));
        const tone = color ? BUTTON_TONE_BY_COLOR[color] || 'primary'
            : existingTone ? existingTone.slice('tbp-btn-'.length) : 'primary';
        const classes = String(button.className || '')
            .split(/\s+/)
            .filter(name => name && !name.startsWith('tbp-btn'));
        classes.push('tbp-btn', `tbp-btn-${tone}`);
        if (state)
            classes.push(`tbp-btn-${state}`);
        button.className = classes.join(' ');
    }

    function aiSetBtn(text, color) {
        const btn = document.getElementById('tb-inject-autocut');
        if (!btn)
            return;
        btn.textContent = text;
        setButtonPresentation(btn, color, aiPhase === 'idle' ? '' : 'loading');
    }
    // Nút duy nhất: bấm để chạy, bấm lần nữa để dừng
    let aiNeedFile = false; // true: tải ngầm thất bại -> lần bấm kế tiếp sẽ mở hộp chọn file video
    let aiNeedFileUrl = '';
    async function runAutoCut() {
        if (modules.qcStore.state.busy || modules.qcStore.state.workflow) {
            modules.logger.console.warn('[QC] Đang chạy QC; bấm Dừng QC trước.');
            return;
        }
        if (aiPhase !== 'idle' || isAutoCutting) {
            aiAbort = true;
            isAutoCutting = false;
            if (modules.videoTransport.aiXhr && modules.videoTransport.aiXhr.abort)
                modules.videoTransport.aiXhr.abort();
            if (modules.videoTransport.aiFetchCtrl)
                modules.videoTransport.aiFetchCtrl.abort();
            aiSetBtn('⏹ Đang dừng...', '#6b7280');
            return;
        }
        const v0 = modules.timeline.getVideos()[0];
        const url = v0 && (v0.currentSrc || v0.src);
        if (!url) {
            alert('Không tìm thấy video (đợi video load xong rồi bấm lại).');
            return;
        }
        if (aiNeedFileUrl !== url)
            aiNeedFile = false; // đổi task -> thử tải ngầm lại
        aiAbort = false;
        let objUrl = null;
        modules.runtime.bgBegin();
        try {
            let ranges = modules.storage.rangesGet(url);
            // Không có extension -> quay tab thay cho tải video
            if (!ranges && !aiNeedFile && !modules.videoTransport.getGmRequest()) {
                aiPhase = 'detect';
                aiSetBtn('🎥 Chọn tab...', '#be185d');
                ranges = await modules.handDetection.captureTabRanges(p => aiSetBtn(`🎥 ${p}%`));
                if (aiAbort)
                    return;
                if (ranges === null) {
                    aiNeedFile = true;
                    aiNeedFileUrl = url;
                    alert('Đã huỷ chia sẻ tab. Bấm "📂 Chọn video" để chọn file video đã tải về máy.');
                    return;
                }
                modules.storage.rangesSet(url, ranges);
            }
            if (!ranges) {
                let source = null;
                if (aiNeedFile) {
                    // Gọi ngay trong click để trình duyệt cho mở hộp chọn file
                    const file = await modules.videoTransport.pickLocalVideo();
                    if (!file)
                        return;
                    source = file;
                }
                else {
                    aiPhase = 'download';
                    aiSetBtn('⬇️ 0%', '#0891b2');
                    source = modules.media.vstore.url === url ? modules.media.vstore.blob : await modules.videoTransport.getVideoBlob(url, p => aiSetBtn(`⬇️ ${p}`));
                    if (source)
                        modules.media.rememberVideoBlob(url, source); // giữ lại cho Fill 1 / Fill All lấy frame
                    modules.videoTransport.aiXhr = null;
                    if (aiAbort)
                        return;
                    if (!source) {
                        aiNeedFile = true;
                        aiNeedFileUrl = url;
                        alert('Không tải ngầm được video (không chạy trong Tampermonkey và R2 chặn CORS).\n\n'
                            + 'Cách 1: Cài script vào Tampermonkey để tải ngầm tự động.\n'
                            + 'Cách 2: Tải video về máy, sau đó bấm nút "📂 Chọn video" để chọn file.');
                        return;
                    }
                }
                objUrl = source === modules.media.vstore.blob ? null : URL.createObjectURL(source);
                const scanUrl = objUrl || modules.media.vstore.objUrl;
                aiPhase = 'detect';
                aiSetBtn('🖐 Loading model...', '#be185d');
                await modules.handDetection.getHandModel();
                if (aiAbort)
                    return;
                aiSetBtn('🖐 0%', '#be185d');
                ranges = await modules.handDetection.detectHandRanges(scanUrl, p => aiSetBtn(`🖐 ${p}%`));
                if (objUrl)
                    URL.revokeObjectURL(objUrl);
                objUrl = null;
                if (aiAbort)
                    return;
                modules.storage.rangesSet(url, ranges);
                aiNeedFile = false;
            }
            modules.logger.console.log(`🖐 [AI] ${ranges.length} đoạn:`, ranges);
            if (!ranges.length) {
                alert('Không phát hiện đoạn nào có tay.');
                return;
            }
            // Hiển thị ranges gợi ý trên timeline/video; không sửa segment.
            loadedCutTimes = ranges;
            loadedJsonName = 'AI Handtrack';
            aiPhase = 'preview';
            await runAutoCutFromTimes(ranges, { sourceLabel: 'AI Auto-Cut' });
        }
        catch (err) {
            if (err.message !== 'ABORTED' && err.name !== 'AbortError') {
                modules.logger.console.error('❌ [AI Auto-Cut]', err);
                alert('AI Auto-Cut lỗi: ' + err.message);
            }
        }
        finally {
            if (objUrl)
                URL.revokeObjectURL(objUrl);
            modules.runtime.bgEnd();
            modules.videoTransport.aiXhr = null;
            modules.videoTransport.aiFetchCtrl = null;
            aiPhase = 'idle';
            aiAbort = false;
            updateAutoCutBtnState();
        }
    }
    // Nút luôn bật; khi đang chạy thì giữ nguyên chữ tiến trình (setInterval 500ms không ghi đè)
    function updateAutoCutBtnState() {
        const btn = document.getElementById('tb-inject-autocut');
        if (!btn)
            return;
        btn.disabled = false;
        btn.setAttribute('aria-disabled', 'false');
        if (aiPhase !== 'idle' || isAutoCutting)
            return;
        if (aiNeedFile) {
            btn.textContent = '📂 Chọn video';
            setButtonPresentation(btn, '#0891b2');
            btn.title = 'Phím tắt % · Chọn file video đã tải về máy → nhận diện tay → xem gợi ý, không sửa timeline';
        }
        else {
            btn.textContent = '🚀 AI Auto-Cut';
            setButtonPresentation(btn, '#7c3aed');
            btn.title = modules.videoTransport.getGmRequest()
                ? 'Phím tắt % · Tải video ngầm → nhận diện tay → xem gợi ý, không sửa timeline (bấm lần nữa để dừng)'
                : 'Phím tắt % · Quay tab → nhận diện tay → xem gợi ý, không sửa timeline (bấm lần nữa để dừng)';
        }
    }
    function normalizeSuggestionRanges(ranges, duration) {
        if (!Array.isArray(ranges) || !ranges.length)
            return null;
        const normalized = ranges.map(range => ({
            start: Number(range && range.start),
            end: Number(range && range.end)
        })).sort((a, b) => a.start - b.start);
        for (let i = 0; i < normalized.length; i++) {
            const range = normalized[i];
            if (!Number.isFinite(range.start) || !Number.isFinite(range.end)
                || range.start < 0 || range.end <= range.start || range.end > duration)
                return null;
            if (i > 0 && range.start < normalized[i - 1].end - 0.001)
                return null;
        }
        return normalized;
    }
    function cancelSuggestions() {
        const hadSuggestions = !!activeCutSuggestions;
        activeCutSuggestions = null;
        loadedCutTimes = [];
        loadedJsonName = '';
        const cleared = modules.timeline.clearSuggestionRanges();
        return hadSuggestions || cleared;
    }
    function runAutoCutFromTimes(ranges, options = {}) {
        const video = modules.timeline.getVideos()[0];
        if (!video || !Number.isFinite(video.duration) || video.duration <= 0) {
            modules.logger.console.warn('[Auto-Cut] Video chưa sẵn sàng để hiển thị gợi ý.');
            return false;
        }
        const normalized = normalizeSuggestionRanges(ranges, video.duration);
        if (!normalized) {
            modules.logger.console.warn('[Auto-Cut] Ranges không hợp lệ, vượt duration hoặc bị chồng lấn.');
            return false;
        }
        const sourceLabel = String(options.sourceLabel || 'Auto-Cut');
        if (!modules.timeline.showSuggestionRanges(normalized)) {
            activeCutSuggestions = null;
            loadedCutTimes = [];
            loadedJsonName = '';
            modules.logger.console.warn('[Auto-Cut] Không tìm được timeline/video để hiển thị vùng gợi ý.');
            return false;
        }
        activeCutSuggestions = {
            id: ++suggestionSequence,
            ranges: normalized,
            sourceLabel,
            video,
            videoUrl: video.currentSrc || video.src || '',
            pageKey: String(location.pathname || '') + String(location.search || '') + String(location.hash || '')
        };
        loadedCutTimes = normalized;
        loadedJsonName = sourceLabel;
        modules.logger.console.log(`[${sourceLabel}] Đang hiển thị ${normalized.length} vùng gợi ý; segment thật không thay đổi.`, normalized);
        return true;
    }
    let initialized = false;
    function init() {
        if (initialized)
            return;
        initialized = true;
        // Debug: gõ tbAutoCutDebug() trong console khi đang mở task.
        modules.environment.W.tbAutoCutDebug = function () {
            const btnInfo = b => b ? { title: b.title, text: b.textContent.trim(), disabled: b.disabled, aria: b.getAttribute('aria-disabled') } : null;
            modules.logger.console.log('New:', btnInfo(modules.timeline.findNewSegmentBtn()), '| Merge:', btnInfo(modules.timeline.findMergeBtn()), '| Trim tail:', btnInfo(modules.timeline.findTrimTailBtn()), '| Undo:', btnInfo(modules.timeline.findUndoBtn()));
            modules.logger.console.log('Range đang chọn:', modules.timeline.readActiveEpisodeRange(), '| rows:', modules.timeline.getEpisodeRows().map(modules.timeline.rowStartSec));
            const b = modules.timeline.findTimelineBlock(1);
            if (b) {
                const r = b.block.getBoundingClientRect();
                const edge = document.elementFromPoint(r.right - 2, r.top + r.height / 2);
                modules.logger.console.log('Khối #1:', b.dur, 's', b.block.outerHTML.slice(0, 600));
                modules.logger.console.log('Phần tử ở mép phải:', edge && edge.outerHTML.slice(0, 300));
            }
        };
    }
    return {
        get isAutoCutting() { return isAutoCutting; },
        set isAutoCutting(value) { isAutoCutting = value; },
        get aiPhase() { return aiPhase; },
        set aiPhase(value) { aiPhase = value; },
        get aiCache() { return aiCache; },
        get aiAbort() { return aiAbort; },
        set aiAbort(value) { aiAbort = value; },
        get aiSetBtn() { return aiSetBtn; },
        get runAutoCut() { return runAutoCut; },
        get loadedCutTimes() { return loadedCutTimes; },
        set loadedCutTimes(value) { loadedCutTimes = value; },
        get loadedJsonName() { return loadedJsonName; },
        set loadedJsonName(value) { loadedJsonName = value; },
        get runAutoCutFromTimes() { return runAutoCutFromTimes; },
        get hasActiveSuggestions() { return !!activeCutSuggestions; },
        get activeSuggestionContext() {
            if (!activeCutSuggestions)
                return null;
            return {
                id: activeCutSuggestions.id,
                video: activeCutSuggestions.video,
                videoUrl: activeCutSuggestions.videoUrl,
                pageKey: activeCutSuggestions.pageKey
            };
        },
        get cancelSuggestions() { return cancelSuggestions; },
        get updateAutoCutBtnState() { return updateAutoCutBtnState; },
        init
    };
};
