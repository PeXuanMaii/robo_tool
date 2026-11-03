/**
 * qcApi
 * Authenticated read-only QC API adapter. No write endpoint is introduced.
 * Dependencies: auth, config, environment.
 * Module state stays in this closure; cross-module mutable bindings use live accessors.
 */
module.exports = function createQcApi(modules) {
    'use strict';
    async function getJson(path) {
        const candidate = modules.auth.findToken();
        if (!candidate || !candidate.token)
            throw new Error('Chưa có phiên đăng nhập hợp lệ. Mở task rồi thử lại.');
        const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 20000);
        try {
            const r = await modules.auth.origFetch.call(modules.environment.W, modules.config.API_BASE + path, { method: 'GET', headers: { Authorization: 'Bearer ' + candidate.token, Accept: 'application/json' }, credentials: 'include', cache: 'no-store', signal: ctrl.signal });
            if (!r.ok)
                throw new Error('Đọc QC HTTP ' + r.status);
            return await r.json();
        }
        finally {
            clearTimeout(timer);
        }
    }
    return {
        get getJson() { return getJson; }
    };
};
