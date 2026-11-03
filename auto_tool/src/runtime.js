/**
 * runtime
 * Worker timers, sleep, visibility, notifications and background job accounting.
 * Dependencies: logger.
 * Module state stays in this closure; cross-module mutable bindings use live accessors.
 */
module.exports = function createRuntime(modules) {
    'use strict';
    /* =====================================================================
     * Best-effort background support.
     * Worker timers and Web Locks do not prevent the browser or Android from
     * throttling, suspending, or terminating a background tab.
     * ===================================================================== */
    const bgTimer = (() => {
        let worker = null, seq = 0;
        const cbs = new Map();
        const fallbackAll = () => {
            worker = null;
            for (const [id, f] of cbs) {
                cbs.delete(id);
                setTimeout(f.fn, Math.max(0, f.at - Date.now()));
            }
        };
        try {
            const src = 'const T=new Map();onmessage=e=>{const d=e.data;'
                + 'if(d.c==="s"){T.set(d.id,setTimeout(()=>{T.delete(d.id);postMessage(d.id)},d.ms))}'
                + 'else{clearTimeout(T.get(d.id));T.delete(d.id)}}';
            const blobUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
            worker = new Worker(blobUrl);
            worker.onmessage = e => {
                const f = cbs.get(e.data);
                if (f) {
                    cbs.delete(e.data);
                    f.fn();
                }
            };
            worker.onerror = ev => { modules.logger.console.warn('⚠️ [BG] Worker timer lỗi, dùng setTimeout thường:', ev && ev.message); fallbackAll(); };
        }
        catch (e) {
            modules.logger.console.warn('⚠️ [BG] Không tạo được Worker timer (CSP?), tab ẩn sẽ chạy chậm hơn:', e.message);
            worker = null;
        }
        return {
            get usingWorker() { return !!worker; },
            set(fn, ms) {
                ms = Math.max(0, +ms || 0);
                if (!worker)
                    return 'n' + setTimeout(fn, ms);
                const id = ++seq;
                cbs.set(id, { fn, at: Date.now() + ms });
                try {
                    worker.postMessage({ c: 's', id, ms });
                }
                catch (_) {
                    cbs.delete(id);
                    return 'n' + setTimeout(fn, ms);
                }
                return id;
            },
            clear(id) {
                if (id == null)
                    return;
                if (typeof id === 'string') {
                    clearTimeout(+id.slice(1));
                    return;
                }
                cbs.delete(id);
                if (worker) {
                    try {
                        worker.postMessage({ c: 'c', id });
                    }
                    catch (_) { }
                }
            }
        };
    })();
    const bgSetTimeout = (fn, ms) => bgTimer.set(fn, ms);
    const bgClearTimeout = id => bgTimer.clear(id);
    const bgSleep = ms => new Promise(r => bgTimer.set(r, ms));
    // Keep a Web Lock while work is active; it is not a keep-alive guarantee.
    let bgJobs = 0, bgLockRelease = null;
    function bgBegin() {
        if (bgJobs++ > 0)
            return;
        try {
            if (navigator.locks && navigator.locks.request) {
                navigator.locks.request('tbrain-helper-keepalive-' + Math.random().toString(36).slice(2), () => new Promise(r => { bgLockRelease = r; })).catch(() => { });
            }
        }
        catch (_) { }
    }
    function bgEnd() {
        if (bgJobs <= 0)
            return;
        if (--bgJobs === 0 && bgLockRelease) {
            bgLockRelease();
            bgLockRelease = null;
        }
    }
    async function bgJob(fn) {
        bgBegin();
        try {
            return await fn();
        }
        finally {
            bgEnd();
        }
    }
    // Thông báo hệ thống (chỉ khi tab đang ẩn và đã cho phép Notification)
    function notifyBg(title, body) {
        try {
            if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted')
                return;
            const n = new Notification(title, { body: body || '', tag: 'tbrain-helper-bg', renotify: true });
            n.onclick = () => {
                try {
                    window.focus();
                }
                catch (_) { }
                n.close();
            };
        }
        catch (_) { }
    }
    // Đợi tab hiện lại (dùng cho chế độ quay tab: tab ẩn thì ảnh quay bị đứng hình)
    function waitVisible(msg) {
        if (!document.hidden)
            return Promise.resolve();
        modules.logger.console.warn('⏸ [BG]', msg);
        notifyBg('⏸ Tbrain tool đang chờ', msg);
        return new Promise(r => {
            const f = () => {
                if (!document.hidden) {
                    document.removeEventListener('visibilitychange', f);
                    r();
                }
            };
            document.addEventListener('visibilitychange', f);
        });
    }
    // rAF kép khi tab hiện; tab ẩn thì rAF không chạy -> chỉ chờ timer
    const nextPaint = () => document.hidden ? bgSleep(40)
        : Promise.race([new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))), bgSleep(250)]);
    const sleep = ms => bgSleep(ms); // Worker timer can still be suspended with the page.
    return {
        get sleep() { return sleep; },
        get bgSleep() { return bgSleep; },
        get waitVisible() { return waitVisible; },
        get nextPaint() { return nextPaint; },
        get bgBegin() { return bgBegin; },
        get notifyBg() { return notifyBg; },
        get bgEnd() { return bgEnd; },
        get bgClearTimeout() { return bgClearTimeout; },
        get bgSetTimeout() { return bgSetTimeout; },
        get bgTimer() { return bgTimer; }
    };
};
