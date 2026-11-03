/**
 * media
 * Frame capture, screen sharing, decoded video/blob reuse and frame cache.
 * Dependencies: config, environment, handDetection, logger, runtime, timeline, videoTransport.
 * Module state stays in this closure; cross-module mutable bindings use live accessors.
 */
module.exports = function createMedia(modules) {
    'use strict';
    const vstore = { url: '', blob: null, objUrl: '' }; // video đã tải vào RAM (dùng chung)
    let fdStream = null, fdCapVideo = null, fdOff = null, fdDlFailedUrl = '';
    function rememberVideoBlob(url, blob) {
        if (vstore.url === url && vstore.blob === blob)
            return vstore.objUrl;
        if (vstore.objUrl)
            URL.revokeObjectURL(vstore.objUrl);
        if (fdOff) {
            try {
                fdOff.v.removeAttribute('src');
                fdOff.v.load();
            }
            catch (_) { }
            fdOff = null;
        }
        vstore.url = url;
        vstore.blob = blob;
        vstore.objUrl = URL.createObjectURL(blob);
        return vstore.objUrl;
    }
    const isEmptyDesc = s => {
        const t = String(s == null ? '' : s).trim().toLowerCase();
        return !t || t === 'null' || t === 'undefined' || t === 'no description yet' || t === 'no description';
    };
    const rowLooksEmpty = row => /no description/i.test(row ? row.textContent : '');
    function getMainVideoUrl() {
        const v = modules.timeline.getVideos()[0];
        return v ? (v.currentSrc || v.src || '') : '';
    }
    // Đồng bộ: vẽ thử video lên canvas, đọc được pixel => không bị taint
    function canReadVideoPixels() {
        const v = modules.timeline.getVideos()[0];
        if (!v || v.readyState < 2)
            return false;
        try {
            const c = document.createElement('canvas');
            c.width = c.height = 2;
            const x = c.getContext('2d');
            x.drawImage(v, 0, 0, 2, 2);
            x.getImageData(0, 0, 1, 1);
            return true;
        }
        catch (_) {
            return false;
        }
    }
    const canUseDownload = () => {
        const url = getMainVideoUrl();
        return !!url && (vstore.url === url || (modules.config.FILLDESC.useDownload && !!modules.videoTransport.getGmRequest() && fdDlFailedUrl !== url));
    };
    const captureLive = () => !!(fdStream && fdStream.getVideoTracks().some(t => t.readyState === 'live'));
    // PHẢI gọi đồng bộ trong sự kiện click (trước mọi await) để trình duyệt cho mở hộp chọn tab
    function ensureCapture() {
        if (captureLive())
            return Promise.resolve(true);
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia)
            return Promise.resolve(false);
        return navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: 30 }, audio: false,
            preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude'
        }).then(async (stream) => {
            fdStream = stream;
            fdCapVideo = document.createElement('video');
            fdCapVideo.muted = true;
            fdCapVideo.playsInline = true;
            fdCapVideo.srcObject = stream;
            await fdCapVideo.play();
            stream.getVideoTracks()[0].addEventListener('ended', () => { fdStream = null; fdCapVideo = null; });
            return true;
        }).catch(e => { modules.logger.console.warn('⚠️ [FillDesc] Không quay được tab:', e.message); return false; });
    }
    // Quyết định (đồng bộ) có cần xin quyền quay tab không, rồi gọi luôn trong click
    function prepareFrameSource(needDesc) {
        if (!needDesc || canReadVideoPixels() || canUseDownload() || captureLive())
            return Promise.resolve(true);
        return ensureCapture();
    }
    // Video đã tải vào RAM -> thẻ <video> ẩn (cùng nguồn blob: nên đọc được pixel, tua được khi tab ẩn)
    async function getDownloadedVideo(onStatus) {
        const url = getMainVideoUrl();
        if (vstore.url !== url) {
            onStatus && onStatus('⬇️ 0%');
            let blob = null;
            try {
                blob = await modules.videoTransport.getVideoBlob(url, p => onStatus && onStatus(`⬇️ ${p}`));
            }
            catch (e) {
                if (e.message === 'ABORTED')
                    throw e;
                modules.logger.console.warn('⚠️ [FillDesc] Tải video lỗi:', e.message);
            }
            finally {
                modules.videoTransport.aiXhr = null;
            }
            if (!blob) {
                fdDlFailedUrl = url;
                return null;
            }
            rememberVideoBlob(url, blob);
        }
        if (fdOff && fdOff.objUrl === vstore.objUrl)
            return fdOff.v;
        const v = document.createElement('video');
        v.muted = true;
        v.playsInline = true;
        v.preload = 'auto';
        v.src = vstore.objUrl;
        await new Promise((res, rej) => {
            v.onloadeddata = res;
            v.onerror = () => rej(new Error('Trình duyệt không decode được video đã tải'));
        });
        fdOff = { objUrl: vstore.objUrl, v };
        return v;
    }
    function drawScaled(canvas, ctx, src, w, h) {
        const sc = Math.min(1, modules.config.FILLDESC.frameW / w);
        canvas.width = Math.max(1, Math.round(w * sc));
        canvas.height = Math.max(1, Math.round(h * sc));
        ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
    }
    async function composeFrameContactSheet(frames) {
        if (!Array.isArray(frames) || !frames.length)
            throw new Error('Không có frame để ghép');
        if (frames.length === 1)
            return frames[0];
        const images = await Promise.all(frames.map(data => new Promise((resolve, reject) => {
            const image = document.createElement('img');
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error('Không giải mã được frame để ghép contact sheet'));
            image.src = String(data).startsWith('data:') ? String(data) : `data:image/jpeg;base64,${data}`;
        })));
        const cellW = Math.max(...images.map(image => image.naturalWidth || image.width));
        const cellH = Math.max(...images.map(image => image.naturalHeight || image.height));
        if (!(cellW > 0) || !(cellH > 0))
            throw new Error('Kích thước frame không hợp lệ');
        const columns = 2, rows = Math.ceil(images.length / columns), labelH = 24, gap = 8;
        const canvas = document.createElement('canvas');
        canvas.width = columns * cellW + (columns + 1) * gap;
        canvas.height = rows * (cellH + labelH) + (rows + 1) * gap;
        const ctx = canvas.getContext('2d');
        if (!ctx)
            throw new Error('Không tạo được canvas ghép frame');
        ctx.fillStyle = '#111827';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        images.forEach((image, index) => {
            const x = gap + (index % columns) * (cellW + gap);
            const y = gap + Math.floor(index / columns) * (cellH + labelH + gap);
            ctx.fillStyle = '#111827';
            ctx.fillRect(x, y, cellW, labelH + cellH);
            ctx.fillStyle = '#f9fafb';
            ctx.font = 'bold 14px sans-serif';
            ctx.fillText(`Frame ${index + 1}`, x + 6, y + 17);
            const imageW = image.naturalWidth || image.width;
            const imageH = image.naturalHeight || image.height;
            const scale = Math.min(cellW / imageW, cellH / imageH);
            const drawW = imageW * scale, drawH = imageH * scale;
            ctx.drawImage(image, x + (cellW - drawW) / 2, y + labelH + (cellH - drawH) / 2, drawW, drawH);
        });
        return canvas.toDataURL('image/jpeg', modules.config.FILLDESC.jpegQ).split(',')[1];
    }
    async function grabSegmentFrames(start, end, onStatus) {
        const main = modules.timeline.getVideos()[0];
        if (!main)
            throw new Error('Không tìm thấy video');
        end = Math.min(end, main.duration || end);
        if (!(end > start))
            throw new Error(`Khoảng segment không hợp lệ (${start}s → ${end}s)`);
        const times = Array.from({ length: modules.config.FILLDESC.frames }, (_, k) => start + (end - start) * (k + 0.5) / modules.config.FILLDESC.frames);
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const frames = [];
        const toJpeg = () => frames.push(canvas.toDataURL('image/jpeg', modules.config.FILLDESC.jpegQ).split(',')[1]);
        // (2) vẽ trực tiếp video trên trang
        if (canReadVideoPixels()) {
            const oldT = main.currentTime;
            try {
                for (const t of times) {
                    await modules.handDetection.seekFrame(main, Math.min(t, main.duration - 0.05));
                    drawScaled(canvas, ctx, main, main.videoWidth, main.videoHeight);
                    toJpeg();
                }
            }
            finally {
                main.currentTime = oldT;
            }
            return frames;
        }
        // (3) video đã tải vào RAM
        if (canUseDownload()) {
            const v = await getDownloadedVideo(onStatus);
            if (v) {
                onStatus && onStatus('🖼️ Frames...');
                for (const t of times) {
                    await modules.handDetection.seekFrame(v, Math.min(t, v.duration - 0.05));
                    drawScaled(canvas, ctx, v, v.videoWidth, v.videoHeight);
                    toJpeg();
                }
                return frames;
            }
        }
        // (4) quay tab – cần tab đang hiện
        if (!captureLive())
            throw new Error('Video bị CORS chặn, không tải ngầm được và chưa chia sẻ tab (bấm lại Fill rồi chọn tab này)');
        const oldT = main.currentTime;
        try {
            for (const t of times) {
                await modules.runtime.waitVisible('Chế độ quay tab cần tab Tbrain đang hiện. Quay lại tab để tiếp tục lấy ảnh.');
                await modules.timeline.seekTo(t);
                await modules.runtime.nextPaint();
                await modules.runtime.sleep(modules.config.FILLDESC.settleMs); // đợi frame mới đi qua stream quay tab
                if (document.hidden) {
                    await modules.runtime.waitVisible('Quay lại tab Tbrain để tiếp tục lấy ảnh.');
                    await modules.runtime.sleep(modules.config.FILLDESC.settleMs);
                }
                const r = main.getBoundingClientRect();
                if (r.width < 10 || r.height < 10)
                    throw new Error('Video không hiển thị trên màn hình');
                const sx = fdCapVideo.videoWidth / window.innerWidth, sy = fdCapVideo.videoHeight / window.innerHeight;
                const sc = Math.min(1, modules.config.FILLDESC.frameW / (r.width * sx));
                canvas.width = Math.max(1, Math.round(r.width * sx * sc));
                canvas.height = Math.max(1, Math.round(r.height * sy * sc));
                ctx.drawImage(fdCapVideo, r.left * sx, r.top * sy, r.width * sx, r.height * sy, 0, 0, canvas.width, canvas.height);
                toJpeg();
            }
        }
        finally {
            await modules.timeline.seekTo(oldT).catch(() => { });
        }
        return frames;
    }
    let initialized = false;
    function init() {
        if (initialized)
            return;
        initialized = true;
        modules.environment.W.tbFreeVideo = () => {
            if (vstore.objUrl)
                URL.revokeObjectURL(vstore.objUrl);
            if (fdOff) {
                try {
                    fdOff.v.removeAttribute('src');
                    fdOff.v.load();
                }
                catch (_) { }
                fdOff = null;
            }
            vstore.url = '';
            vstore.blob = null;
            vstore.objUrl = '';
            modules.logger.console.log('🧹 Đã giải phóng video trong RAM');
        };
        window.addEventListener('beforeunload', () => {
            try {
                fdStream && fdStream.getTracks().forEach(t => t.stop());
            }
            catch (_) { }
        });
    }
    return {
        get prepareFrameSource() { return prepareFrameSource; },
        get grabSegmentFrames() { return grabSegmentFrames; },
        get composeFrameContactSheet() { return composeFrameContactSheet; },
        get isEmptyDesc() { return isEmptyDesc; },
        get getMainVideoUrl() { return getMainVideoUrl; },
        get rowLooksEmpty() { return rowLooksEmpty; },
        get vstore() { return vstore; },
        get rememberVideoBlob() { return rememberVideoBlob; },
        init
    };
};
