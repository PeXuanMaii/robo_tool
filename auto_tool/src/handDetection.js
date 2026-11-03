/**
 * handDetection
 * Handtrack model loading, hand detection and range planning.
 * Dependencies: autoCut, config, environment, logger, runtime, timeline.
 * Module state stays in this closure; cross-module mutable bindings use live accessors.
 */
module.exports = function createHandDetection(modules) {
    'use strict';
    let handModel = null;
    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src;
            s.onload = resolve;
            s.onerror = () => reject(new Error('Không tải được ' + src + ' (có thể bị CSP chặn)'));
            (document.head || document.documentElement).appendChild(s);
        });
    }
    function getHandTrackLib() {
        try {
            if (typeof handTrack !== 'undefined')
                return handTrack;
        }
        catch (_) { }
        return modules.environment.W.handTrack || window.handTrack || null;
    }
    async function getHandModel() {
        if (handModel)
            return handModel;
        let lib = getHandTrackLib();
        if (!lib) {
            await loadScript('https://cdn.jsdelivr.net/npm/handtrackjs@latest/dist/handtrack.min.js');
            lib = getHandTrackLib();
        }
        if (!lib)
            throw new Error('Chưa nạp được Handtrack.js');
        handModel = await lib.load({
            flipHorizontal: false, maxNumBoxes: 4, iouThreshold: 0.5,
            scoreThreshold: modules.config.AI.minScore, modelType: 'ssd320fpnlite', modelSize: 'small'
        });
        return handModel;
    }
    function seekFrame(v, t) {
        return new Promise(resolve => {
            if (Math.abs(v.currentTime - t) < 1e-3 && v.readyState >= 2 && !v.seeking)
                return resolve();
            const done = () => { modules.runtime.bgClearTimeout(to); v.removeEventListener('seeked', done); resolve(); };
            const to = modules.runtime.bgSetTimeout(done, modules.config.AI.seekTimeoutMs);
            v.addEventListener('seeked', done);
            v.currentTime = t;
        });
    }
    // Bước 3: gộp các mốc thấy tay thành {start, end}
    function buildRanges(hits, step, dur) {
        // 1. Gom các frame có tay liên tiếp thành đoạn thô
        const raw = [];
        for (const t of hits) {
            const last = raw[raw.length - 1];
            if (last && t - last.end <= step + 1e-6)
                last.end = t + step;
            else
                raw.push({ start: t, end: t + step });
        }
        // 2. Merge 2 đoạn cách nhau < mergeGap (5s)
        const merged = [];
        for (const r of raw) {
            const last = merged[merged.length - 1];
            if (last && r.start - last.end < modules.config.AI.mergeGap)
                last.end = r.end;
            else
                merged.push({ ...r });
        }
        // 3. Chỉ giữ đoạn 30s <= độ dài < 10 phút (tính trên thời gian có tay, trước khi nới pad)
        const r2 = n => Math.round(n * 100) / 100;
        const kept = merged.filter(r => {
            const len = r.end - r.start;
            return len >= modules.config.AI.minLen && len < modules.config.AI.maxLen;
        });
        modules.logger.console.log(`🖐 [AI] ${raw.length} đoạn thô → merge còn ${merged.length} → giữ ${kept.length} đoạn (${modules.config.AI.minLen}s ≤ dài < ${modules.config.AI.maxLen / 60} phút)`);
        merged.filter(r => !kept.includes(r)).forEach(r => modules.logger.console.log(`   bỏ ${r2(r.start)}s → ${r2(r.end)}s (${r2(r.end - r.start)}s)`));
        return kept.map(r => ({ start: r2(Math.max(0, r.start - modules.config.AI.pad)), end: r2(Math.min(dur, r.end + modules.config.AI.pad)) }));
    }
    // Bước 2: tua qua từng frame (2fps) và quét tay bằng Handtrack.js
    async function detectHandRanges(src, onProgress) {
        const model = await getHandModel();
        const v = document.createElement('video');
        v.muted = true;
        v.playsInline = true;
        v.preload = 'auto';
        v.src = src;
        await new Promise((res, rej) => {
            v.onloadeddata = res;
            v.onerror = () => rej(new Error('Trình duyệt không decode được video'));
        });
        v.width = v.videoWidth;
        v.height = v.videoHeight;
        const dur = v.duration, step = 1 / modules.config.AI.sampleFps, hits = [];
        let prev = null;
        for (let t = 0; t < dur && !modules.autoCut.aiAbort; t += step) {
            await seekFrame(v, t);
            const preds = await model.detect(v);
            const hands = preds.filter(p => p.label !== 'face' && p.score >= modules.config.AI.minScore);
            let active = hands.length > 0;
            if (!active)
                prev = null;
            else if (modules.config.AI.minMove > 0) {
                const c = hands.map(p => [(p.bbox[0] + p.bbox[2] / 2) / v.videoWidth, (p.bbox[1] + p.bbox[3] / 2) / v.videoHeight]);
                active = !!prev && c.some(a => prev.some(b => Math.hypot(a[0] - b[0], a[1] - b[1]) >= modules.config.AI.minMove));
                prev = c;
            }
            if (active)
                hits.push(t);
            onProgress(Math.round(t / dur * 100));
        }
        v.removeAttribute('src');
        v.load(); // giải phóng decoder
        return buildRanges(hits, step, dur);
    }
    // Chế độ KHÔNG CẦN EXTENSION: quay chính tab Tbrain (getDisplayMedia) -> crop vùng video -> Handtrack
    // Ảnh quay màn hình không bị CORS "taint" nên đọc được pixel mà không cần tải video.
    // Trả về null nếu người dùng huỷ hộp thoại chia sẻ.
    async function captureTabRanges(onProgress) {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            throw new Error('Trình duyệt không hỗ trợ chia sẻ tab (dùng Chrome/Edge bản mới)');
        }
        let stream;
        try {
            // Gọi ngay trong sự kiện click (chưa có await nào trước đó)
            stream = await navigator.mediaDevices.getDisplayMedia({
                video: { frameRate: 30 }, audio: false,
                preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude'
            });
        }
        catch (e) {
            modules.logger.console.warn('⚠️ [AI] Huỷ chia sẻ tab:', e.message);
            return null;
        }
        const track = stream.getVideoTracks()[0];
        const cap = document.createElement('video');
        cap.muted = true;
        cap.playsInline = true;
        cap.srcObject = stream;
        const vids = modules.timeline.getVideos();
        const oldRates = vids.map(v => v.playbackRate);
        try {
            await cap.play();
            modules.autoCut.aiSetBtn('🖐 Loading model...', '#be185d');
            const model = await getHandModel();
            const main = vids[0];
            if (!main)
                throw new Error('Không tìm thấy video');
            const dur = main.duration;
            await modules.timeline.seekTo(0);
            vids.forEach(v => { v.muted = true; v.playbackRate = modules.config.AI.captureRate; v.play().catch(() => { }); });
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const hits = [];
            let prev = null;
            while (!modules.autoCut.aiAbort && track.readyState === 'live') {
                if (document.hidden) { // tab ẩn: ảnh quay đứng hình -> tạm dừng, chờ quay lại rồi quét tiếp
                    const resumeAt = main.currentTime;
                    vids.forEach(v => v.pause());
                    modules.autoCut.aiSetBtn('⏸ Quay lại tab', '#6b7280');
                    await modules.runtime.waitVisible('AI Auto-Cut (quay tab) cần tab Tbrain đang hiện. Quay lại tab để quét tiếp.');
                    await modules.timeline.seekTo(resumeAt);
                    vids.forEach(v => { v.playbackRate = modules.config.AI.captureRate; v.play().catch(() => { }); });
                    await modules.runtime.sleep(300);
                    continue;
                }
                const t = main.currentTime;
                if (main.ended || t >= dur - 0.05)
                    break;
                if (main.paused)
                    main.play().catch(() => { });
                // Crop đúng vùng thẻ <video> trong ảnh quay tab
                const r = main.getBoundingClientRect();
                const sx = cap.videoWidth / window.innerWidth, sy = cap.videoHeight / window.innerHeight;
                const w = Math.max(1, Math.round(r.width * sx)), h = Math.max(1, Math.round(r.height * sy));
                if (canvas.width !== w)
                    canvas.width = w;
                if (canvas.height !== h)
                    canvas.height = h;
                ctx.drawImage(cap, r.left * sx, r.top * sy, r.width * sx, r.height * sy, 0, 0, w, h);
                const preds = await model.detect(canvas);
                const hands = preds.filter(p => p.label !== 'face' && p.score >= modules.config.AI.minScore);
                let active = hands.length > 0;
                if (!active)
                    prev = null;
                else if (modules.config.AI.minMove > 0) {
                    const c = hands.map(p => [(p.bbox[0] + p.bbox[2] / 2) / w, (p.bbox[1] + p.bbox[3] / 2) / h]);
                    active = !!prev && c.some(a => prev.some(b => Math.hypot(a[0] - b[0], a[1] - b[1]) >= modules.config.AI.minMove));
                    prev = c;
                }
                if (active)
                    hits.push(t);
                onProgress(Math.round(t / dur * 100));
                // Nhịp quét ~ mỗi 1/sampleFps giây thời gian video
                await modules.runtime.sleep(Math.max(0, 1000 / modules.config.AI.sampleFps / modules.config.AI.captureRate - 40));
            }
            if (track.readyState !== 'live' && !modules.autoCut.aiAbort)
                throw new Error('Đã dừng chia sẻ tab giữa chừng');
            return buildRanges(hits, 1 / modules.config.AI.sampleFps, dur);
        }
        finally {
            track.stop();
            cap.srcObject = null;
            vids.forEach((v, i) => { v.pause(); v.playbackRate = oldRates[i] || 1; });
        }
    }
    return {
        get buildRanges() { return buildRanges; },
        get seekFrame() { return seekFrame; },
        get captureTabRanges() { return captureTabRanges; },
        get getHandModel() { return getHandModel; },
        get detectHandRanges() { return detectHandRanges; }
    };
};
