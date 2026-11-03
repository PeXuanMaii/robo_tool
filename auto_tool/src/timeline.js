/**
 * timeline
 * Video clock, episode rows, selection, timeline geometry, trim/drag/merge primitives.
 * Dependencies: autoCut, config, logger, runtime.
 * Module state stays in this closure; cross-module mutable bindings use live accessors.
 */
module.exports = function createTimeline(modules) {
    'use strict';
    const getVideos = () => Array.from(document.querySelectorAll('video'))
        .filter(v => Number.isFinite(v.duration) && v.duration > 0);
    const findNewSegmentBtn = () => document.querySelector('button[title^="New"]');
    // Đọc đồng hồ "1:06:25 / 36:05:00" (mm:ss:ff) -> giây
    function readClock() {
        const el = document.querySelector('[data-testid="transport-time"]');
        const m = el && el.textContent.match(/(\d+):(\d+):(\d+)\s*\/\s*(\d+):(\d+):(\d+)/);
        if (!m)
            return null;
        const toSec = (a, b, c) => (+a) * 60 + (+b) + (+c) / modules.config.AUTOCUT.fps;
        return { cur: toSec(m[1], m[2], m[3]), total: toSec(m[4], m[5], m[6]) };
    }
    // Seek cả 2 video rồi đợi đồng hồ của app nhảy theo
    async function seekTo(t, isCurrent = () => true) {
        if (!isCurrent())
            return false;
        getVideos().forEach(v => { v.pause(); v.currentTime = t; });
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
            if (!isCurrent())
                return false;
            const c = readClock();
            if (c && Math.abs(c.cur - t) < 0.6) {
                await modules.runtime.sleep(100); // cho React cập nhật trạng thái nút New
                return isCurrent();
            }
            // Tab ẩn: đồng hồ của app (vẽ bằng requestAnimationFrame) có thể không chạy -> tin vào video.currentTime
            if (document.hidden) {
                const v = getVideos()[0];
                if (v && !v.seeking && Math.abs(v.currentTime - t) < 0.6) {
                    await modules.runtime.sleep(150);
                    return isCurrent();
                }
            }
            await modules.runtime.sleep(50);
        }
        return false;
    }
    const findTrimTailBtn = () => document.querySelector('button[title^="Trim tail"]');
    const isBtnEnabled = b => !!b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
    // Chỉ để debug: in nhãn kiểu "#3 · 0:30" trên timeline
    function logSegmentLabels() {
        const labels = new Set(Array.from(document.querySelectorAll('*'))
            .filter(el => el.children.length <= 3 && el.textContent.length < 20 && /^#\d+\s*[·•]\s*[\d:]+$/.test(el.textContent.trim()))
            .map(el => el.textContent.trim()));
        modules.logger.console.log('   nhãn segment trên timeline:', Array.from(labels).join(' | '));
    }
    const findMergeBtn = () => document.querySelector('button[title^="Merge"]');
    const findUndoBtn = () => document.querySelector('button[title^="Undo"]');
    const getEpisodeRows = () => Array.from(document.querySelectorAll('[data-testid^="episode-index-row-"]'));
    const countEpisodes = () => getEpisodeRows().length;
    const mmssToSec = s => { const p = s.split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
    // Thời gian bắt đầu hiển thị trên dòng index ("4 no description ... 7:22")
    function rowStartSec(row) {
        const m = row.textContent.match(/(\d+:\d{2}(?::\d{2})?)\s*$/);
        return m ? mmssToSec(m[1]) : NaN;
    }
    // Tìm dòng index của segment bắt đầu tại t (sai số 1s vì index chỉ hiện tới giây)
    function findRowAt(t) {
        const rows = getEpisodeRows();
        const i = rows.findIndex(r => Math.abs(rowStartSec(r) - Math.floor(t)) <= 1);
        return i < 0 ? null : { row: rows[i], number: i + 1 };
    }
    async function waitFor(fn, ms = 1500, step = 80, isCurrent = () => true) {
        const deadline = Date.now() + ms;
        for (;;) {
            if (!isCurrent())
                return null;
            const v = fn();
            if (v || Date.now() >= deadline)
                return v;
            await modules.runtime.sleep(step);
        }
    }
    async function selectSegmentAt(t, isCurrent = () => true) {
        const r = await waitFor(() => findRowAt(t), 1500, 80, isCurrent);
        if (!r || !isCurrent())
            return null;
        r.row.scrollIntoView({ block: 'nearest' });
        if (!isCurrent())
            return null;
        r.row.click();
        await modules.runtime.sleep(modules.config.AUTOCUT.afterNewMs);
        return isCurrent() ? r : null;
    }
    // Đọc khoảng "7:22–7:52" của episode đang chọn (panel bên phải)
    function readActiveEpisodeRange() {
        const re = /^(\d+:\d{2}(?::\d{2})?)\s*[–—-]\s*(\d+:\d{2}(?::\d{2})?)$/;
        for (const el of document.querySelectorAll('span, div, p')) {
            if (el.children.length)
                continue;
            const m = el.textContent.trim().match(re);
            if (m)
                return { start: mmssToSec(m[1]), end: mmssToSec(m[2]), text: m[0] };
        }
        return null;
    }
    // Khối segment "#n · 0:30" trên timeline
    function findTimelineBlock(number) {
        const re = new RegExp(`^#${number}\\s*[·•]\\s*(\\d+:\\d{2}(?::\\d{2})?)$`);
        const label = Array.from(document.querySelectorAll('span, div, p'))
            .find(el => el.children.length === 0 && re.test(el.textContent.trim()));
        if (!label)
            return null;
        const lw = label.getBoundingClientRect().width;
        let block = label.parentElement;
        for (let d = 0; d < 5 && block; d++) {
            if (block.getBoundingClientRect().width > lw + 4)
                break;
            block = block.parentElement;
        }
        const dur = mmssToSec(label.textContent.trim().match(re)[1]);
        return block ? { block, label, dur } : null;
    }
    let suggestionOverlayState = null;
    function clearSuggestionRanges() {
        const state = suggestionOverlayState;
        if (!state)
            return false;
        suggestionOverlayState = null;
        if (state.resizeObserver)
            state.resizeObserver.disconnect();
        if (state.onResize)
            window.removeEventListener('resize', state.onResize);
        state.overlay.remove();
        if (state.changedPosition && state.host.style.position === 'relative')
            state.host.style.position = state.originalPosition;
        return true;
    }
    function showSuggestionRanges(ranges) {
        clearSuggestionRanges();
        if (!Array.isArray(ranges) || !ranges.length)
            return false;
        const rows = getEpisodeRows();
        let segmentAnchor = null;
        for (let i = 0; i < rows.length; i++) {
            const start = rowStartSec(rows[i]);
            const blockInfo = findTimelineBlock(i + 1);
            if (!Number.isFinite(start) || !blockInfo || !(blockInfo.dur > 0))
                continue;
            const blockRect = blockInfo.block.getBoundingClientRect();
            if (!(blockRect.width > 0) || !(blockRect.height > 0))
                continue;
            segmentAnchor = { start, blockInfo, blockRect };
            break;
        }
        let host;
        let contentWidth;
        let contentHeight;
        let anchorStart;
        let anchorLeft;
        let anchorTop;
        let pxPerSecond;
        let markerHeight;
        let clipLeft = 0;
        let clipRight;
        let resizeTarget;
        let usesVideoScale = false;
        if (segmentAnchor) {
            const scrollParent = getScrollParent(segmentAnchor.blockInfo.block);
            host = scrollParent || segmentAnchor.blockInfo.block.parentElement;
            if (!host || typeof host.appendChild !== 'function' || !host.style)
                return false;
            const hostRect = host.getBoundingClientRect();
            const scrollLeft = Number(host.scrollLeft) || 0;
            const scrollTop = Number(host.scrollTop) || 0;
            contentWidth = Math.max(Number(host.scrollWidth) || 0, Number(host.clientWidth) || 0, hostRect.width);
            contentHeight = Math.max(Number(host.scrollHeight) || 0, Number(host.clientHeight) || 0, hostRect.height);
            const clientLeft = Number(host.clientLeft) || 0;
            const clientTop = Number(host.clientTop) || 0;
            anchorStart = segmentAnchor.start;
            pxPerSecond = segmentAnchor.blockRect.width / segmentAnchor.blockInfo.dur;
            anchorLeft = segmentAnchor.blockRect.left - hostRect.left - clientLeft + scrollLeft;
            anchorTop = scrollParent
                ? segmentAnchor.blockRect.top - hostRect.top - clientTop + scrollTop
                : 0;
            markerHeight = scrollParent
                ? segmentAnchor.blockRect.height
                : Math.max(Number(host.clientHeight) || 0, hostRect.height);
            clipRight = contentWidth;
            resizeTarget = segmentAnchor.blockInfo.block;
        }
        else {
            const video = getVideos()[0];
            if (!video || !video.parentElement || typeof video.getBoundingClientRect !== 'function')
                return false;
            const videoRect = video.getBoundingClientRect();
            if (!(videoRect.width > 0) || !(videoRect.height > 0))
                return false;
            const scrollParent = getScrollParent(video);
            host = scrollParent || video.parentElement;
            if (!host || typeof host.appendChild !== 'function' || !host.style)
                return false;
            const hostRect = host.getBoundingClientRect();
            const scrollLeft = Number(host.scrollLeft) || 0;
            const scrollTop = Number(host.scrollTop) || 0;
            const clientLeft = Number(host.clientLeft) || 0;
            const clientTop = Number(host.clientTop) || 0;
            anchorStart = 0;
            anchorLeft = videoRect.left - hostRect.left - clientLeft + scrollLeft;
            anchorTop = videoRect.top - hostRect.top - clientTop + scrollTop;
            markerHeight = Math.min(8, videoRect.height);
            anchorTop += videoRect.height - markerHeight;
            pxPerSecond = videoRect.width / Number(video.duration);
            contentWidth = Math.max(Number(host.scrollWidth) || 0, Number(host.clientWidth) || 0, hostRect.width, anchorLeft + videoRect.width);
            contentHeight = Math.max(Number(host.scrollHeight) || 0, Number(host.clientHeight) || 0, hostRect.height, anchorTop + markerHeight);
            clipLeft = anchorLeft;
            clipRight = anchorLeft + videoRect.width;
            resizeTarget = video;
            usesVideoScale = true;
        }
        if (!(contentWidth > 0) || !(contentHeight > 0) || !Number.isFinite(pxPerSecond) || !(pxPerSecond > 0))
            return false;
        const overlay = document.createElement('div');
        overlay.id = 'tb-cut-suggestion-overlay';
        overlay.setAttribute('aria-hidden', 'true');
        overlay.style.position = 'absolute';
        overlay.style.left = '0';
        overlay.style.top = '0';
        overlay.style.width = `${contentWidth}px`;
        overlay.style.height = `${contentHeight}px`;
        overlay.style.pointerEvents = 'none';
        overlay.style.zIndex = '4';
        const markers = [];
        for (let i = 0; i < ranges.length; i++) {
            const range = ranges[i];
            const start = Number(range && range.start);
            const end = Number(range && range.end);
            if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
                continue;
            const rangeLeft = anchorLeft + (start - anchorStart) * pxPerSecond;
            const rangeRight = anchorLeft + (end - anchorStart) * pxPerSecond;
            const left = Math.max(0, clipLeft, rangeLeft);
            const right = Math.min(contentWidth, clipRight, rangeRight);
            if (right <= left)
                continue;
            const marker = document.createElement('div');
            marker.setAttribute('aria-hidden', 'true');
            marker.style.position = 'absolute';
            marker.style.left = `${left}px`;
            marker.style.top = `${anchorTop}px`;
            marker.style.width = `${right - left}px`;
            marker.style.height = `${markerHeight}px`;
            marker.style.boxSizing = 'border-box';
            marker.style.border = '1px solid rgba(234,179,8,.95)';
            marker.style.borderRadius = '2px';
            marker.style.backgroundColor = 'rgba(250,204,21,.32)';
            marker.style.pointerEvents = 'none';
            markers.push(marker);
            overlay.appendChild(marker);
        }
        if (!markers.length)
            return false;
        if (usesVideoScale) {
            const label = document.createElement('div');
            label.textContent = 'Gợi ý cắt';
            label.style.position = 'absolute';
            label.style.left = `${clipLeft}px`;
            label.style.top = `${Math.max(0, anchorTop - 18)}px`;
            label.style.padding = '2px 5px';
            label.style.borderRadius = '3px';
            label.style.backgroundColor = 'rgba(17,24,39,.88)';
            label.style.color = '#f9fafb';
            label.style.font = '10px/1.2 system-ui,sans-serif';
            label.style.pointerEvents = 'none';
            overlay.appendChild(label);
        }
        const originalPosition = host.style.position || '';
        const computedStyle = typeof getComputedStyle === 'function' ? getComputedStyle(host) : null;
        const changedPosition = !computedStyle || !computedStyle.position || computedStyle.position === 'static';
        if (changedPosition)
            host.style.position = 'relative';
        host.appendChild(overlay);
        const state = {
            host,
            overlay,
            originalPosition,
            changedPosition,
            ranges: ranges.map(range => ({ start: Number(range.start), end: Number(range.end) })),
            resizeObserver: null,
            onResize: null
        };
        suggestionOverlayState = state;
        if (typeof ResizeObserver === 'function') {
            state.resizeObserver = new ResizeObserver(() => {
                if (suggestionOverlayState === state)
                    showSuggestionRanges(state.ranges);
            });
            state.resizeObserver.observe(host);
            state.resizeObserver.observe(resizeTarget);
        }
        else if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            state.onResize = () => {
                if (suggestionOverlayState === state)
                    showSuggestionRanges(state.ranges);
            };
            window.addEventListener('resize', state.onResize);
        }
        return true;
    }
    // Đợi nút enable (React cập nhật trạng thái chậm sau khi seek/chọn segment)
    async function waitEnabled(getBtn, ms = 1500, isCurrent = () => true) {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
            if (!isCurrent())
                return null;
            const b = getBtn();
            if (isBtnEnabled(b))
                return b;
            await modules.runtime.sleep(80);
        }
        return null;
    }
    // Đọc lại khoảng thật của segment bắt đầu tại start
    async function readSegRange(start, isCurrent = () => true) {
        if (!(await selectSegmentAt(start, isCurrent)) || !isCurrent())
            return null;
        await modules.runtime.sleep(120);
        return isCurrent() ? readActiveEpisodeRange() : null;
    }
    // Trim tail có kiểm tra + thử lại tối đa 3 lần
    async function trimTailTo(start, end, isCurrent = () => true) {
        for (let a = 0; a < 3 && modules.autoCut.isAutoCutting && isCurrent(); a++) {
            if (!(await selectSegmentAt(start, isCurrent)) || !isCurrent())
                return false;
            if (!(await seekTo(end, isCurrent)) || !isCurrent())
                return false;
            await modules.runtime.sleep(150 + a * 200);
            if (!isCurrent())
                return false;
            const btn = await waitEnabled(findTrimTailBtn, 1500, isCurrent);
            if (!isCurrent())
                return false;
            if (btn) {
                if (!isCurrent())
                    return false;
                btn.click();
                await modules.runtime.sleep(modules.config.AUTOCUT.afterNewMs + 150);
                if (!isCurrent())
                    return false;
            }
            const r = await readSegRange(start, isCurrent);
            if (!isCurrent())
                return false;
            if (r && Math.abs(r.end - Math.floor(end)) <= 1)
                return true;
            modules.logger.console.warn(`   [trim] lần ${a + 1}: ${btn ? 'bấm rồi nhưng app hiển thị ' + (r ? r.text : '?') : 'nút Trim tail disabled'} (cần end ${end}s)`);
        }
        return false;
    }
    // Bấm New tại playhead hiện tại và xác nhận đã có dòng index bắt đầu tại t
    async function createSegmentAt(t, isCurrent = () => true, onAttempt = () => {}) {
        for (let a = 0; a < 2 && modules.autoCut.isAutoCutting && isCurrent(); a++) {
            const before = countEpisodes();
            const btn = await waitEnabled(findNewSegmentBtn, 800, isCurrent);
            if (!btn || !isCurrent())
                return false;
            onAttempt();
            btn.click();
            const ok = await waitFor(() => countEpisodes() > before && findRowAt(t), 2000, 80, isCurrent);
            if (!isCurrent())
                return false;
            if (ok) {
                await modules.runtime.sleep(120);
                return isCurrent();
            }
            modules.logger.console.warn(`   [new] lần ${a + 1}: bấm New tại ${t.toFixed(2)}s nhưng chưa thấy segment, thử lại...`);
            await seekTo(t, isCurrent);
            if (!isCurrent())
                return false;
        }
        return false;
    }
    async function clickIfEnabled(btn, waitMs = modules.config.AUTOCUT.afterNewMs, isCurrent = () => true) {
        if (!isCurrent() || !isBtnEnabled(btn))
            return false;
        btn.click();
        await modules.runtime.sleep(waitMs);
        return isCurrent();
    }
    // Giả lập kéo chuột (pointer + mouse events) từ (x0,y) tới (x1,y)
    async function simulateDrag(target, x0, x1, y, isCurrent = () => true) {
        const base = { bubbles: true, cancelable: true, composed: true, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 };
        const fire = (el, type, x, buttons) => {
            const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
            el.dispatchEvent(new Ctor(type, { ...base, clientX: x, buttons }));
        };
        let pressed = false;
        try {
            if (!isCurrent())
                return false;
            fire(target, 'pointerover', x0, 0);
            if (!isCurrent())
                return false;
            pressed = true;
            fire(target, 'pointerdown', x0, 1);
            fire(target, 'mousedown', x0, 1);
            await modules.runtime.sleep(30);
            for (let k = 1; k <= 12; k++) {
                if (!isCurrent())
                    return false;
                const x = x0 + (x1 - x0) * k / 12;
                [target, document, window].forEach(el => { fire(el, 'pointermove', x, 1); fire(el, 'mousemove', x, 1); });
                await modules.runtime.sleep(15);
            }
            return isCurrent();
        }
        finally {
            if (pressed) {
                [target, document, window].forEach(el => { fire(el, 'pointerup', x1, 0); fire(el, 'mouseup', x1, 0); });
                await modules.runtime.sleep(modules.config.AUTOCUT.afterNewMs);
            }
        }
    }
    // Container cuộn ngang của timeline
    function getScrollParent(el) {
        for (let p = el && el.parentElement; p; p = p.parentElement) {
            if (p.scrollWidth > p.clientWidth + 4) {
                const ox = getComputedStyle(p).overflowX;
                if (ox === 'auto' || ox === 'scroll' || ox === 'hidden')
                    return p;
            }
        }
        return null;
    }
    const findZoomOutBtn = () => document.querySelector('button[title^="Zoom out"]');
    // Kéo tay nắm đuôi segment #number cho tới khi độ dài >= wantDur.
    // Mỗi lần kéo: cuộn timeline để mép phải của khối nằm ở ~30% khung nhìn, zoom out nếu khoảng cần kéo vượt khung.
    async function extendByDrag(number, wantDur, isCurrent = () => true) {
        let noProgress = 0;
        for (let attempt = 0; attempt < 15 && modules.autoCut.isAutoCutting && isCurrent(); attempt++) {
            let b = findTimelineBlock(number);
            if (!isCurrent())
                return false;
            if (!b) {
                modules.logger.console.warn(`   [drag] không thấy khối #${number} trên timeline`);
                return false;
            }
            if (b.dur >= wantDur - 0.5)
                return true;
            const sc = getScrollParent(b.block);
            const viewRect = () => (sc || document.documentElement).getBoundingClientRect();
            // Zoom out cho tới khi đoạn cần kéo vừa ~60% khung nhìn (tối đa 6 lần)
            for (let z = 0; z < 6; z++) {
                if (!isCurrent())
                    return false;
                const r = b.block.getBoundingClientRect();
                const pxPerSec = r.width / Math.max(b.dur, 1);
                const vw = Math.min(viewRect().width, window.innerWidth);
                if ((wantDur - b.dur + 1) * pxPerSec <= vw * 0.6)
                    break;
                if (!(await clickIfEnabled(findZoomOutBtn(), 200, isCurrent))) {
                    if (!isCurrent())
                        return false;
                    break;
                }
                b = findTimelineBlock(number) || b;
            }
            // Cuộn để mép phải khối nằm ở 30% khung nhìn -> còn chỗ kéo sang phải
            if (sc) {
                if (!isCurrent())
                    return false;
                const vr = viewRect();
                sc.scrollLeft += b.block.getBoundingClientRect().right - (vr.left + vr.width * 0.3);
                await modules.runtime.sleep(120);
                if (!isCurrent())
                    return false;
                b = findTimelineBlock(number) || b;
            }
            const r = b.block.getBoundingClientRect();
            const vr = viewRect();
            const pxPerSec = r.width / Math.max(b.dur, 1);
            const y = r.top + r.height / 2;
            const x0 = r.right - 2;
            const needPx = ((wantDur - b.dur) * 1.3 + 2) * pxPerSec; // kéo dư, Trim tail sẽ cắt lại
            const roomPx = Math.min(vr.right, window.innerWidth) - 4 - x0;
            // Không đủ chỗ (mép khối sát mép phải khung nhìn) -> zoom out rồi thử lại, không kéo vài px vô ích
            if (roomPx < Math.min(needPx, 40)) {
                if (await clickIfEnabled(findZoomOutBtn(), 250, isCurrent)) {
                    modules.logger.console.log(`   [drag] #${number}: hết chỗ kéo (${Math.round(roomPx)}px) → zoom out`);
                    continue;
                }
                if (!isCurrent())
                    return false;
                modules.logger.console.warn(`   [drag] #${number}: không còn chỗ để kéo`);
                return false;
            }
            const x1 = x0 + Math.max(12, Math.min(needPx, roomPx));
            const target = document.elementFromPoint(x0, y) || b.block;
            if (!(await simulateDrag(target, x0, x1, y, isCurrent)) || !isCurrent())
                return false;
            const after = findTimelineBlock(number);
            modules.logger.console.log(`   [drag] #${number}: ${b.dur}s → ${after ? after.dur : '?'}s (cần ${wantDur.toFixed(1)}s, kéo ${Math.round(x1 - x0)}px)`);
            if (!after || after.dur <= b.dur) {
                if (++noProgress >= 3)
                    return false;
            }
            else
                noProgress = 0;
        }
        const fin = findTimelineBlock(number);
        return isCurrent() && !!fin && fin.dur >= wantDur - 0.5;
    }
    // Phương án dự phòng: New khúc 30s nối đuôi rồi Merge (chọn segment qua dòng index)
    async function extendByMerge(start, segEnd) {
        const before = countEpisodes();
        let made = false;
        let newAt = 0;
        for (let x = Math.ceil(segEnd); x <= Math.ceil(segEnd) + 1 && modules.autoCut.isAutoCutting; x += 0.25) {
            if (!(await seekTo(x)))
                return null;
            if (await createSegmentAt(x)) {
                made = true;
                newAt = x;
                break;
            }
        }
        if (!made) {
            modules.logger.console.warn(`   [merge] không tạo được khúc nối tại ${segEnd.toFixed(2)}s`);
            return null;
        }
        const afterNew = countEpisodes();
        const vDur = (getVideos()[0] || {}).duration || Infinity;
        // Thử Merge khi đang chọn khúc đầu (gộp với khúc sau), rồi khi chọn khúc sau (gộp với khúc trước)
        for (const t of [start, newAt]) {
            if (!(await selectSegmentAt(t)))
                continue;
            const mb = await waitEnabled(findMergeBtn, 1000);
            if (!mb)
                continue;
            mb.click();
            if (await waitFor(() => countEpisodes() < afterNew, 1500)) {
                await modules.runtime.sleep(150);
                const r = await readSegRange(start);
                return r ? r.end : Math.min(newAt + modules.config.AUTOCUT.segLen, vDur);
            }
        }
        // Merge không được -> xoá khúc thừa bằng Undo (chỉ khi chắc chắn còn khúc đó)
        modules.logger.console.warn(`   [merge] Merge không ăn (rows: ${getEpisodeRows().map(rowStartSec).join(', ')})`);
        if (countEpisodes() > before && findRowAt(newAt)) {
            await clickIfEnabled(findUndoBtn());
            await waitFor(() => countEpisodes() === before, 1500);
        }
        return null;
    }
    return {
        get readActiveEpisodeRange() { return readActiveEpisodeRange; },
        get getEpisodeRows() { return getEpisodeRows; },
        get rowStartSec() { return rowStartSec; },
        get findRowAt() { return findRowAt; },
        get getVideos() { return getVideos; },
        get seekTo() { return seekTo; },
        get waitEnabled() { return waitEnabled; },
        get findNewSegmentBtn() { return findNewSegmentBtn; },
        get createSegmentAt() { return createSegmentAt; },
        get selectSegmentAt() { return selectSegmentAt; },
        get showSuggestionRanges() { return showSuggestionRanges; },
        get clearSuggestionRanges() { return clearSuggestionRanges; },
        get extendByDrag() { return extendByDrag; },
        get findTimelineBlock() { return findTimelineBlock; },
        get extendByMerge() { return extendByMerge; },
        get trimTailTo() { return trimTailTo; },
        get findMergeBtn() { return findMergeBtn; },
        get findTrimTailBtn() { return findTrimTailBtn; },
        get findUndoBtn() { return findUndoBtn; }
    };
};
