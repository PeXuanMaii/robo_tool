/**
 * auth
 * Existing signed-in session discovery and same-site request interception.
 * Dependencies: environment.
 * Module state stays in this closure; cross-module mutable bindings use live accessors.
 */
module.exports = function createAuth(modules) {
    'use strict';
    const JWT_RE = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
    const interceptedTokens = new Map();
    const rejectedTokens = new Set();
    let cachedTokenCandidate = null;
    let lastTokenValue = null;
    function decodePayload(token) {
        try {
            let p = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
            p += "=".repeat((4 - p.length % 4) % 4);
            const binary = atob(p);
            const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
            return JSON.parse(new TextDecoder().decode(bytes));
        }
        catch (_) {
            return null;
        }
    }
    function scoreSource(source) {
        let score = 0;
        if (/access|auth|jwt|bearer|token|session/i.test(source))
            score += 2;
        if (/refresh/i.test(source))
            score -= 5;
        return score;
    }
    function scanString(raw, source, found) {
        if (typeof raw !== "string" || raw.length < 20)
            return;
        JWT_RE.lastIndex = 0;
        let match;
        while ((match = JWT_RE.exec(raw)) !== null) {
            const token = match[0];
            if (rejectedTokens.has(token))
                continue;
            const payload = decodePayload(token);
            if (!payload)
                continue;
            const candidate = { token, source, payload, score: scoreSource(source) };
            const existing = found.get(token);
            if (!existing || candidate.score > existing.score)
                found.set(token, candidate);
        }
    }
    function scanStorage(storage, label, found) {
        try {
            for (let i = 0; i < storage.length; i++) {
                const key = storage.key(i);
                if (key !== null)
                    scanString(storage.getItem(key), `${label}:${key}`, found);
            }
        }
        catch (_) { }
    }
    function scanCookies(found) {
        try {
            for (const pair of document.cookie.split(";")) {
                const index = pair.indexOf("=");
                if (index >= 0)
                    scanString(pair.slice(index + 1).trim(), `cookie:${pair.slice(0, index).trim()}`, found);
            }
        }
        catch (_) { }
    }
    function findToken(forceScan = false) {
        const timestamp = Date.now();
        if (!forceScan && cachedTokenCandidate) {
            const cached = cachedTokenCandidate;
            const expiry = Number(cached.payload.exp);
            if (!rejectedTokens.has(cached.token) && (!expiry || expiry * 1000 > timestamp + 5000))
                return cached;
            cachedTokenCandidate = null;
        }
        const found = new Map();
        for (const token of interceptedTokens.keys()) {
            if (!rejectedTokens.has(token)) {
                const payload = decodePayload(token);
                if (payload)
                    found.set(token, { token, source: "intercepted request", payload, score: 10 });
            }
        }
        if (forceScan || found.size === 0) {
            scanStorage(window.localStorage, "localStorage", found);
            scanStorage(window.sessionStorage, "sessionStorage", found);
            scanCookies(found);
        }
        let best = null;
        for (const candidate of found.values()) {
            if (!rejectedTokens.has(candidate.token)) {
                const expiry = Number(candidate.payload.exp);
                if (!expiry || expiry * 1000 > timestamp + 5000) {
                    if (!best || candidate.score > best.score)
                        best = candidate;
                }
            }
        }
        cachedTokenCandidate = best;
        return best;
    }
    const origFetch = modules.environment.W.fetch;
    const xhrProto = modules.environment.W.XMLHttpRequest.prototype;
    const origOpen = xhrProto.open;
    const origSetHeader = xhrProto.setRequestHeader;
    function captureAuth(value, url) {
        try {
            if (typeof value !== "string" || !url)
                return;
            const parsed = new URL(String(url), location.href);
            if (parsed.hostname.endsWith("tbrain.ai")) {
                JWT_RE.lastIndex = 0;
                let match;
                while ((match = JWT_RE.exec(value)) !== null)
                    interceptedTokens.set(match[0], Date.now());
            }
        }
        catch (_) { }
    }
    function readHeaders(headers) {
        if (!headers)
            return null;
        try {
            if (headers instanceof Headers)
                return headers.get("authorization");
            if (Array.isArray(headers)) {
                for (const pair of headers)
                    if (String(pair[0]).toLowerCase() === "authorization")
                        return String(pair[1]);
            }
            else if (typeof headers === "object") {
                for (const key of Object.keys(headers))
                    if (key.toLowerCase() === "authorization")
                        return String(headers[key]);
            }
        }
        catch (_) { }
        return null;
    }
    let initialized = false;
    function init() {
        if (initialized)
            return;
        initialized = true;
        modules.environment.W.fetch = function (input, init) {
            try {
                const url = typeof input === "string" ? input : input instanceof URL ? input.href : input && input.url;
                const auth = readHeaders(init && init.headers) || readHeaders(input && input.headers);
                if (auth)
                    captureAuth(auth, url);
            }
            catch (_) { }
            return origFetch.apply(this, arguments);
        };
        xhrProto.open = function (method, url) { this.tbMonitorUrl = String(url); return origOpen.apply(this, arguments); };
        xhrProto.setRequestHeader = function (name, value) {
            if (String(name).toLowerCase() === "authorization")
                captureAuth(value, this.tbMonitorUrl);
            return origSetHeader.apply(this, arguments);
        };
    }
    return {
        get findToken() { return findToken; },
        get origFetch() { return origFetch; },
        get rejectedTokens() { return rejectedTokens; },
        get cachedTokenCandidate() { return cachedTokenCandidate; },
        set cachedTokenCandidate(value) { cachedTokenCandidate = value; },
        init
    };
};
