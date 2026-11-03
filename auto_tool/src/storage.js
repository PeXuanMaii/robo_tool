/**
 * storage
 * IndexedDB cache, approved Pass examples, local storage and Groq key access.
 * Dependencies: autoCut, config, environment, logger, media.
 * Module state stays in this closure; cross-module mutable bindings use live accessors.
 */
module.exports = function createStorage(modules) {
    'use strict';
    /* =====================================================================
     * 💾 CACHE THÔNG MINH: IndexedDB (không mất khi F5) + Map trong RAM
     *  - res|txt|<hash>       : kết quả phân tích theo nội dung Description
     *  - res|img|<video>|a-b  : kết quả phân tích theo ảnh của segment (video + khoảng thời gian)
     *  - ranges|<video>       : kết quả nhận diện tay của cả video
     *  - pass-example|<ids>   : ví dụ annotation từ task Pass do người dùng chọn
     *  Gõ tbClearCache() trong console (hoặc nút 🗑 Cache trên panel) để xoá.
     * ===================================================================== */
    const TBDB = (() => {
        let dbp = null;
        function open() {
            if (dbp)
                return dbp;
            dbp = new Promise(res => {
                try {
                    const rq = indexedDB.open('tbrain-helper', 1);
                    rq.onupgradeneeded = () => {
                        const db = rq.result;
                        if (!db.objectStoreNames.contains('kv'))
                            db.createObjectStore('kv');
                    };
                    rq.onsuccess = () => res(rq.result);
                    rq.onerror = () => { modules.logger._con.warn('⚠️ [Cache] Không mở được IndexedDB:', rq.error && rq.error.message); res(null); };
                    rq.onblocked = () => res(null);
                }
                catch (e) {
                    res(null);
                }
            });
            return dbp;
        }
        async function write(fn) {
            const db = await open();
            if (!db)
                return false;
            return new Promise(res => {
                try {
                    const t = db.transaction('kv', 'readwrite');
                    fn(t.objectStore('kv'));
                    t.oncomplete = () => res(true);
                    t.onerror = t.onabort = () => res(false);
                }
                catch (e) {
                    res(false);
                }
            });
        }
        return {
            set: (k, v) => write(st => st.put(v, k)),
            del: k => write(st => st.delete(k)),
            clear: () => write(st => st.clear()),
            async entries() {
                const db = await open();
                if (!db)
                    return [];
                return new Promise(res => {
                    const out = [];
                    try {
                        const rq = db.transaction('kv', 'readonly').objectStore('kv').openCursor();
                        rq.onsuccess = () => {
                            const c = rq.result;
                            if (c) {
                                out.push([c.key, c.value]);
                                c.continue();
                            }
                            else
                                res(out);
                        };
                        rq.onerror = () => res(out);
                    }
                    catch (e) {
                        res(out);
                    }
                });
            }
        };
    })();
    const memRes = new Map(); // key -> { r, t }
    const PASS_EXAMPLE_PREFIX = 'pass-example|';
    const PASS_EXAMPLE_FIELDS = ['environment_l3', 'task_description', 'activity_key', 'skill_group', 'task_difficulty'];
    const passExamples = new Map();
    let passExamplesLoaded = false;
    let passExamplesLoading = null;
    function hashStr(s) {
        let h = 0x811c9dc5;
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return (h >>> 0).toString(36) + '-' + s.length.toString(36);
    }
    function videoKeyOf(u) {
        try {
            const x = new URL(u, location.href);
            return x.origin + x.pathname;
        }
        catch (_) {
            return String(u || '');
        }
    }
    const txtKey = t => 'txt|' + hashStr(String(t || '').trim().toLowerCase().replace(/\s+/g, ' '));
    const imgKeyFor = (vurl, start, end) => 'img|' + videoKeyOf(vurl) + '|' + Math.round(start) + '-' + Math.round(end);
    const imgKey = (start, end) => imgKeyFor(modules.media.getMainVideoUrl(), start, end);
    function resGet(k) { const e = memRes.get(k); return e ? e.r : null; }
    function resSet(k, r) {
        if (!k || !r)
            return;
        const e = { r, t: Date.now() };
        memRes.set(k, e);
        TBDB.set('res|' + k, e);
    }
    function rememberResult(keys, r) {
        keys.filter(Boolean).forEach(k => resSet(k, r));
        if (r && r.desc)
            resSet(txtKey(r.desc), r);
    }
    function rangesGet(url) { return modules.autoCut.aiCache.get(videoKeyOf(url)) || null; }
    function rangesSet(url, ranges) {
        const k = videoKeyOf(url);
        modules.autoCut.aiCache.set(k, ranges);
        TBDB.set('ranges|' + k, { r: ranges, t: Date.now() });
    }
    function normalizePassExample(input) {
        if (!input || typeof input !== 'object')
            throw new Error('Dữ liệu ví dụ Pass không hợp lệ');
        const taskId = String(input.taskId || '').trim();
        const submissionId = String(input.submissionId || '').trim();
        if (!taskId || !submissionId || !Array.isArray(input.episodes))
            throw new Error('Thiếu task/submission hoặc danh sách segment của ví dụ Pass');
        const episodes = input.episodes.map(episode => {
            const start = Number(episode && episode.start);
            const end = Number(episode && episode.end);
            const labels = {};
            for (const field of PASS_EXAMPLE_FIELDS) {
                const raw = episode && episode.labels && episode.labels[field];
                const value = typeof raw === 'string' ? raw.trim() : '';
                if (value && value.length <= 1200)
                    labels[field] = value;
            }
            return { start, end, labels };
        }).filter(episode => Number.isFinite(episode.start) && Number.isFinite(episode.end)
            && episode.start >= 0 && episode.end > episode.start && Object.keys(episode.labels).length);
        if (!episodes.length)
            throw new Error('Ví dụ Pass không có segment hợp lệ hoặc annotation để lưu');
        return { t: Date.now(), taskId, submissionId, episodes };
    }
    function isPassExampleRecord(value) {
        return !!(value && typeof value === 'object' && typeof value.taskId === 'string'
            && value.taskId && typeof value.submissionId === 'string' && value.submissionId
            && Number.isFinite(Number(value.t)) && Array.isArray(value.episodes)
            && value.episodes.length > 0 && value.episodes.every(episode => episode
                && Number.isFinite(Number(episode.start)) && Number.isFinite(Number(episode.end))
                && Number(episode.start) >= 0 && Number(episode.end) > Number(episode.start)
                && episode.labels && typeof episode.labels === 'object'
                && PASS_EXAMPLE_FIELDS.every(field => episode.labels[field] === undefined
                    || (typeof episode.labels[field] === 'string' && episode.labels[field].length <= 1200))));
    }
    async function loadPassExamples() {
        if (passExamplesLoaded)
            return;
        if (passExamplesLoading)
            return passExamplesLoading;
        passExamplesLoading = (async () => {
            const rows = await TBDB.entries();
            passExamples.clear();
            for (const [key, value] of rows) {
                if (key.startsWith(PASS_EXAMPLE_PREFIX) && isPassExampleRecord(value))
                    passExamples.set(key.slice(PASS_EXAMPLE_PREFIX.length), value);
            }
            passExamplesLoaded = true;
        })();
        try {
            await passExamplesLoading;
        }
        finally {
            passExamplesLoading = null;
        }
    }
    async function savePassExample(input) {
        const record = normalizePassExample(input);
        const key = encodeURIComponent(record.taskId) + '|' + encodeURIComponent(record.submissionId);
        const saved = await TBDB.set(PASS_EXAMPLE_PREFIX + key, record);
        if (!saved)
            throw new Error('Không lưu được ví dụ Pass vào IndexedDB');
        passExamples.set(key, record);
        passExamplesLoaded = true;
        return { taskId: record.taskId, submissionId: record.submissionId, segments: record.episodes.length, savedAt: record.t };
    }
    async function listPassExamples() {
        await loadPassExamples();
        return Array.from(passExamples.values())
            .map(record => ({ taskId: record.taskId, submissionId: record.submissionId, segments: record.episodes.length, savedAt: record.t }))
            .sort((a, b) => b.savedAt - a.savedAt);
    }
    function searchTokens(value) {
        const text = String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\u0111/g, 'd');
        return new Set((text.match(/[a-z0-9]+/g) || []).filter(token => token.length > 1
            && !['the', 'and', 'for', 'with', 'from', 'into', 'then', 'while', 'this', 'that', 'are', 'was', 'were', 'dang', 'duoc', 'mot', 'cac', 'nhung', 'tren', 'vao'].includes(token)));
    }
    async function getRelevantPassExamples({ text, context } = {}) {
        await loadPassExamples();
        const query = searchTokens([text || '', context && context.l3 || ''].join(' '));
        if (!query.size)
            return [];
        const matches = [];
        for (const record of passExamples.values()) {
            for (const episode of record.episodes) {
                const labels = episode.labels || {};
                const exampleText = [
                    labels.environment_l3,
                    labels.task_description,
                    String(labels.activity_key || '').replace(/-/g, ' '),
                    labels.skill_group
                ].filter(Boolean).join(' ');
                const tokens = searchTokens(exampleText);
                if (!tokens.size)
                    continue;
                let overlap = 0;
                for (const token of query)
                    if (tokens.has(token))
                        overlap++;
                const score = overlap / Math.sqrt(query.size * tokens.size);
                if (score >= 0.1) {
                    matches.push({
                        score,
                        scene: labels.environment_l3 || '',
                        description: labels.task_description || '',
                        activity: labels.activity_key || '',
                        skill: labels.skill_group || '',
                        difficulty: labels.task_difficulty || ''
                    });
                }
            }
        }
        return matches.sort((a, b) => b.score - a.score).slice(0, 3).map(({ score, ...example }) => example);
    }
    async function clearPassExamples() {
        await loadPassExamples();
        const rows = await TBDB.entries();
        const keys = rows.map(([key]) => key).filter(key => key.startsWith(PASS_EXAMPLE_PREFIX));
        const deleted = await Promise.all(keys.map(key => TBDB.del(key)));
        deleted.forEach((ok, index) => {
            if (ok)
                passExamples.delete(keys[index].slice(PASS_EXAMPLE_PREFIX.length));
        });
        if (deleted.some(ok => !ok))
            throw new Error('Không xóa được toàn bộ ví dụ Pass trong IndexedDB');
        passExamplesLoaded = true;
        return keys.length;
    }
    async function loadCaches() {
        const rows = await TBDB.entries();
        const cutoff = Date.now() - modules.config.CACHE.maxAgeDays * 864e5;
        const stale = [];
        let nRes = 0, nRanges = 0, nQcBackups = 0, nPassExamples = 0;
        passExamples.clear();
        rows.sort((a, b) => ((b[1] && b[1].t) || 0) - ((a[1] && a[1].t) || 0));
        for (const [k, v] of rows) {
            if (k.startsWith('qc21-backup|')) {
                const at = v && Number(v.at);
                if (!v || !Number.isFinite(at) || at < cutoff) {
                    stale.push(k);
                    continue;
                }
                nQcBackups++;
                continue;
            }
            if (k.startsWith(PASS_EXAMPLE_PREFIX)) {
                if (!isPassExampleRecord(v)) {
                    stale.push(k);
                    continue;
                }
                passExamples.set(k.slice(PASS_EXAMPLE_PREFIX.length), v);
                nPassExamples++;
                continue;
            }
            if (!v || (v.t || 0) < cutoff) {
                stale.push(k);
                continue;
            }
            if (k.startsWith('res|')) {
                if (nRes >= modules.config.CACHE.maxEntries) {
                    stale.push(k);
                    continue;
                }
                if (!memRes.has(k.slice(4)))
                    memRes.set(k.slice(4), v);
                nRes++;
            }
            else if (k.startsWith('ranges|')) {
                if (!modules.autoCut.aiCache.has(k.slice(7)))
                    modules.autoCut.aiCache.set(k.slice(7), v.r);
                nRanges++;
            }
        }
        if (stale.length) {
            const deleted = await Promise.all(stale.map(key => TBDB.del(key)));
            if (deleted.some(ok => !ok))
                modules.logger.console.warn('[Cache] Không xóa được toàn bộ mục IndexedDB đã hết hạn');
        }
        passExamplesLoaded = true;
        modules.logger.console.log(`💾 [Cache] Nạp ${nRes} kết quả AI + ${nRanges} video đã quét tay + ${nQcBackups} backup QC + ${nPassExamples} ví dụ Pass từ IndexedDB` + (stale.length ? `, dọn ${stale.length} mục cũ` : ''));
    }
    function storageGet(key) {
        try {
            return JSON.parse(localStorage.getItem(key));
        }
        catch (e) {
            return null;
        }
    }
    function storageSet(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        }
        catch (e) { }
    }
    // ==================== QUẢN LÝ GROQ API KEY BẰNG LOCALSTORAGE ====================
    function getStoredApiKey() {
        // Ưu tiên lấy key người dùng đã nhập trong UI, nếu không có thì lấy biến cứng mặc định
        const saved = localStorage.getItem(modules.config.TOKEN_STORAGE_KEY);
        return saved ? JSON.parse(saved) : (typeof modules.config.GROQ_API_KEY !== 'undefined' ? modules.config.GROQ_API_KEY : "");
    }
    function saveStoredApiKey(key) {
        localStorage.setItem(modules.config.TOKEN_STORAGE_KEY, JSON.stringify(key.trim()));
    }
    let initialized = false;
    function init() {
        if (initialized)
            return;
        initialized = true;
        modules.environment.W.tbClearCache = async () => {
            memRes.clear();
            modules.autoCut.aiCache.clear();
            const entries = await TBDB.entries();
            const cacheKeys = entries.map(([key]) => key).filter(key => key.startsWith('res|') || key.startsWith('ranges|'));
            const deleted = await Promise.all(cacheKeys.map(key => TBDB.del(key)));
            if (deleted.some(ok => !ok)) {
                const error = new Error('Không xóa được toàn bộ cache AI trong IndexedDB');
                modules.logger.console.error('[Cache]', error);
                throw error;
            }
            modules.logger.console.log('🧹 [Cache] Đã xoá toàn bộ cache AI');
        };
    }
    return {
        get getStoredApiKey() { return getStoredApiKey; },
        get storageGet() { return storageGet; },
        get storageSet() { return storageSet; },
        get txtKey() { return txtKey; },
        get resGet() { return resGet; },
        get rememberResult() { return rememberResult; },
        get imgKey() { return imgKey; },
        get rangesGet() { return rangesGet; },
        get rangesSet() { return rangesSet; },
        get imgKeyFor() { return imgKeyFor; },
        get TBDB() { return TBDB; },
        get loadCaches() { return loadCaches; },
        get savePassExample() { return savePassExample; },
        get listPassExamples() { return listPassExamples; },
        get getRelevantPassExamples() { return getRelevantPassExamples; },
        get clearPassExamples() { return clearPassExamples; },
        init
    };
};
