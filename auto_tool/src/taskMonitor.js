/**
 * taskMonitor
 * Task-pool polling, rate-limit state and task acquisition.
 * Dependencies: auth, config, environment, logger, notifications, runtime.
 * Module state stays in this closure; cross-module mutable bindings use live accessors.
 */
module.exports = function createTaskMonitor(modules) {
    'use strict';
    /* ---------------------------------------------------------------------
     * AUTO-FETCH LOGIC & NETWORK INTERCEPTION
     * --------------------------------------------------------------------- */
    const log = {
        info: (...a) => modules.logger.console.log("[INFO]", ...a),
        warn: (...a) => modules.logger.console.warn("[WARN]", ...a),
        error: (...a) => modules.logger.console.error("[ERROR]", ...a)
    };
    const now = () => performance.now();
    function perf(label, start) {
        if (modules.config.PERF_LOG)
            log.info(`[PERF] ${label}: ${(now() - start).toFixed(1)} ms`);
    }
    const rateLimitState = { limit: null, remaining: null, resetAt: 0, pauseUntil: 0, lastStatus: null };
    function readRateLimitHeaders(response) {
        const headers = response.headers;
        const limitRaw = headers.get("x-ratelimit-limit");
        const remainingRaw = headers.get("x-ratelimit-remaining");
        const resetRaw = headers.get("x-ratelimit-reset");
        const limit = limitRaw === null ? NaN : Number(limitRaw);
        const remaining = remainingRaw === null ? NaN : Number(remainingRaw);
        if (Number.isFinite(limit) && limit >= 0)
            rateLimitState.limit = limit;
        if (Number.isFinite(remaining) && remaining >= 0)
            rateLimitState.remaining = remaining;
        if (resetRaw !== null) {
            const reset = Number(resetRaw);
            if (Number.isFinite(reset) && reset >= 0) {
                rateLimitState.resetAt = reset > 1e9 ? reset * 1000 : Date.now() + reset * 1000;
            }
        }
        rateLimitState.lastStatus = response.status;
        if (response.status === 429) {
            rateLimitState.pauseUntil = Math.max(rateLimitState.pauseUntil, Date.now() + modules.config.RATE_LIMIT_FALLBACK_WAIT + modules.config.RATE_LIMIT_SAFETY_MS);
        }
    }
    async function waitForRateLimit() {
        while (!stopped) {
            const waitMs = rateLimitState.pauseUntil - Date.now();
            if (waitMs <= 0)
                return;
            await modules.runtime.bgSleep(waitMs);
        }
        throw new Error("Task monitor stopped");
    }
    function getAdaptivePollInterval() {
        return Math.max(modules.config.POLL_INTERVAL, modules.config.MIN_SAFE_POLL_INTERVAL);
    }
    function getTaskId(task) {
        if (!task)
            return null;
        const id = task.id !== undefined ? task.id : task.taskId !== undefined ? task.taskId : task._id;
        return id != null ? String(id) : null;
    }
    function getExcludedL1Values(value) {
        return new Set(String(value == null ? '' : value)
            .split(',')
            .map(label => label.trim().toLowerCase())
            .filter(Boolean));
    }
    function hasExcludedL1(task, excludedL1) {
        if (!task || typeof task !== "object")
            return false;
        return [task.envL1, task.envl1].some(value => typeof value === "string"
            && excludedL1.has(value.trim().toLowerCase()));
    }
    async function fetchPool(token) {
        await waitForRateLimit();
        const controller = new AbortController();
        const timeout = modules.runtime.bgSetTimeout(() => controller.abort(), modules.config.REQUEST_TIMEOUT);
        try {
            const response = await modules.auth.origFetch.call(modules.environment.W, modules.config.API_URL, {
                method: "GET",
                headers: { Authorization: `Bearer ${token}`, Accept: "*/*" },
                credentials: "include",
                cache: "no-store",
                signal: controller.signal
            });
            readRateLimitHeaders(response);
            return response;
        }
        finally {
            modules.runtime.bgClearTimeout(timeout);
        }
    }
    async function acquireTask(token, taskObj) {
        await waitForRateLimit();
        const id = getTaskId(taskObj);
        try {
            const response = await modules.auth.origFetch.call(modules.environment.W, `${modules.config.API_BASE}/api/v1/tasks/${encodeURIComponent(id)}/acquire`, {
                method: "POST",
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "*/*" },
                credentials: "include",
                body: "{}"
            });
            readRateLimitHeaders(response);
            return { taskObj, id, ok: response.ok, status: response.status };
        }
        catch (error) {
            return { taskObj, id, ok: false, status: 0 };
        }
    }
    async function acquireNew(token, taskList) {
        let successfullyAcquired = [];
        for (const taskObj of taskList) {
            const res = await acquireTask(token, taskObj);
            if (res.ok) {
                successfullyAcquired.push({
                    id: res.id,
                    durationSeconds: taskObj.durationSeconds
                });
            }
        }
        if (successfullyAcquired.length > 0) {
            await modules.notifications.showAcquireNotification(successfullyAcquired);
        }
        return { success: successfullyAcquired.length, total: taskList.length };
    }
    function extractTasks(body) {
        if (Array.isArray(body))
            return body;
        if (!body || typeof body !== "object")
            return null;
        for (const key of ["tasks", "items", "results", "data", "records", "rows", "content"]) {
            if (Array.isArray(body[key]))
                return body[key];
        }
        return null;
    }
    const seenIds = new Set();
    let firstPoll = true;
    let timer = null;
    let stopped = false;
    let cycleRunning = false;
    async function runCycle() {
        let candidate = modules.auth.findToken() || modules.auth.findToken(true);
        if (!candidate)
            return modules.config.TOKEN_RETRY_INTERVAL;
        let response;
        try {
            response = await fetchPool(candidate.token);
        }
        catch (_) {
            return getAdaptivePollInterval();
        }
        if (response.status === 401 || response.status === 403) {
            modules.auth.rejectedTokens.add(candidate.token);
            modules.auth.cachedTokenCandidate = null;
            return modules.config.TOKEN_RETRY_INTERVAL;
        }
        if (!response.ok)
            return getAdaptivePollInterval();
        let body;
        try {
            body = await response.json();
        }
        catch (_) {
            return getAdaptivePollInterval();
        }
        const tasks = extractTasks(body);
        if (!tasks)
            return getAdaptivePollInterval();
        const excludedL1 = getExcludedL1Values(modules.config.L1_EXCEPT);
        const eligibleTasks = [];
        for (const task of tasks) {
            const id = getTaskId(task);
            if (id === null || seenIds.has(id))
                continue;
            if (hasExcludedL1(task, excludedL1))
                continue;
            const duration = Number(task && task.durationSeconds);
            if (Number.isFinite(duration) && duration > modules.config.MIN_DURATION_SECONDS) {
                seenIds.add(id);
                eligibleTasks.push(task);
            }
        }
        if (eligibleTasks.length > 0) {
            if (modules.config.AUTO_ACQUIRE) {
                await acquireNew(candidate.token, eligibleTasks);
            }
        }
        return getAdaptivePollInterval();
    }
    let fetchHold = false; // Web Lock là best-effort; trình duyệt/Android vẫn có thể tạm dừng tab.
    async function tick() {
        if (stopped || cycleRunning)
            return;
        if (!fetchHold) {
            fetchHold = true;
            modules.runtime.bgBegin();
        }
        cycleRunning = true;
        try {
            const delay = await runCycle();
            if (!stopped)
                timer = modules.runtime.bgSetTimeout(tick, delay);
        }
        catch (_) {
            if (!stopped)
                timer = modules.runtime.bgSetTimeout(tick, getAdaptivePollInterval());
        }
        finally {
            cycleRunning = false;
        }
    }
    function stop() {
        stopped = true;
        modules.runtime.bgClearTimeout(timer);
        timer = null;
        if (fetchHold) {
            fetchHold = false;
            modules.runtime.bgEnd();
        }
    }
    function wake() {
        if (stopped)
            return false;
        modules.runtime.bgClearTimeout(timer);
        timer = null;
        void tick();
        return true;
    }
    return {
        get getAdaptivePollInterval() { return getAdaptivePollInterval; },
        get stop() { return stop; },
        get tick() { return tick; },
        get wake() { return wake; },
        get log() { return log; },
        get stopped() { return stopped; },
        set stopped(value) { stopped = value; }
    };
};
