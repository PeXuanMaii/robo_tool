/**
 * videoTransport
 * Video download transports, abort state and local-file picker.
 * Dependencies: auth, autoCut, environment, logger.
 * Module state stays in this closure; cross-module mutable bindings use live accessors.
 */
module.exports = function createVideoTransport(modules) {
    'use strict';
    let aiXhr = null;
    // GM request: Tampermonkey (GM_xmlhttpRequest) / Violentmonkey, Greasemonkey 4 (GM.xmlHttpRequest)
    function getGmRequest() {
        try {
            if (typeof GM_xmlhttpRequest === 'function')
                return GM_xmlhttpRequest;
        }
        catch (_) { }
        try {
            if (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function')
                return GM.xmlHttpRequest;
        }
        catch (_) { }
        return null;
    }
    // Bước 1a: tải ngầm video bằng GM request (bỏ qua CORS của R2) -> ArrayBuffer -> Blob
    function gmFetchVideo(gmReq, url, onProgress) {
        return new Promise((resolve, reject) => {
            aiXhr = gmReq({
                method: 'GET',
                url,
                responseType: 'arraybuffer',
                timeout: 10 * 60 * 1000,
                onprogress: e => onProgress(e.lengthComputable && e.total
                    ? `${Math.round(e.loaded / e.total * 100)}%`
                    : `${(e.loaded / 1048576).toFixed(0)}MB`),
                onload: r => (r.status >= 200 && r.status < 300 && r.response)
                    ? resolve(new Blob([r.response], { type: 'video/mp4' }))
                    : reject(new Error('HTTP ' + r.status)),
                onerror: () => reject(new Error('Lỗi mạng khi tải video')),
                ontimeout: () => reject(new Error('Timeout khi tải video')),
                onabort: () => reject(new Error('ABORTED'))
            });
        });
    }
    // Bước 1b: fetch thường (chỉ được nếu R2 có CORS), có % tiến trình
    let aiFetchCtrl = null;
    async function corsFetchVideo(url, onProgress) {
        aiFetchCtrl = new AbortController();
        const res = await modules.auth.origFetch.call(modules.environment.W, url, { mode: 'cors', credentials: 'omit', signal: aiFetchCtrl.signal });
        if (!res.ok || res.type === 'opaque')
            throw new Error('HTTP ' + res.status);
        const total = Number(res.headers.get('content-length')) || 0;
        if (!res.body || !res.body.getReader)
            return await res.blob();
        const reader = res.body.getReader();
        const chunks = [];
        let loaded = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            chunks.push(value);
            loaded += value.length;
            onProgress(total ? `${Math.round(loaded / total * 100)}%` : `${(loaded / 1048576).toFixed(0)}MB`);
        }
        return new Blob(chunks, { type: res.headers.get('content-type') || 'video/mp4' });
    }
    // Lấy video: GM request -> fetch CORS -> null (phải chọn file thủ công)
    async function getVideoBlob(url, onProgress) {
        const gmReq = getGmRequest();
        if (gmReq)
            return await gmFetchVideo(gmReq, url, onProgress);
        try {
            return await corsFetchVideo(url, onProgress);
        }
        catch (err) {
            if (modules.autoCut.aiAbort)
                throw new Error('ABORTED');
            modules.logger.console.warn('⚠️ [AI] Không có GM_xmlhttpRequest và fetch bị CORS chặn:', err.message);
            return null;
        }
        finally {
            aiFetchCtrl = null;
        }
    }
    // Bước 1c (dự phòng): chọn file video đã tải về máy - phải gọi trực tiếp trong sự kiện click
    function pickLocalVideo() {
        return new Promise(resolve => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'video/*';
            input.style.display = 'none';
            input.addEventListener('change', () => { resolve(input.files && input.files[0] || null); input.remove(); });
            input.addEventListener('cancel', () => { resolve(null); input.remove(); });
            document.body.appendChild(input);
            input.click();
        });
    }
    return {
        get getGmRequest() { return getGmRequest; },
        get getVideoBlob() { return getVideoBlob; },
        get aiXhr() { return aiXhr; },
        set aiXhr(value) { aiXhr = value; },
        get aiFetchCtrl() { return aiFetchCtrl; },
        set aiFetchCtrl(value) { aiFetchCtrl = value; },
        get pickLocalVideo() { return pickLocalVideo; }
    };
};
