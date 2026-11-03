/** Single startup boundary. No business logic belongs here. */
module.exports = function createBootstrap(modules) {
    'use strict';
    const jobs = new Map();
    let started = false;
    function safely(name, action) {
        try { action(); }
        catch (error) { modules.logger.console.warn(`[UI:${name}]`, error); }
    }
    function refresh(name, action, interval) {
        if (jobs.has(name)) return;
        safely(name, action);
        jobs.set(name, setInterval(() => safely(name, action), interval));
    }
    function start() {
        if (started) return;
        started = true;
        // Mount controls first so persisted polling/duration settings are restored.
        refresh('panel', modules.panel.ensurePanel, 1000);
        refresh('report-hours', modules.earnings.ensureMyReportWorkingHoursCard, 1000);
        refresh('controls', modules.controls.injectUIControls, 500);
        refresh('r2', modules.r2Bridge.injectR2Btns, 500);
        refresh('qc', modules.qcView.mount, 750);
        modules.storage.loadCaches().catch(error => modules.logger.console.warn('[Cache]', error.message));
        // Do not restart polling when the user previously switched Fetch off.
        modules.taskMonitor.stopped = modules.storage.storageGet('tb_fetch_active_state') === false;
        if (!modules.taskMonitor.stopped) modules.taskMonitor.tick();
        modules.earnings.start();
        void modules.notifications.ensurePermission();
        modules.logger.console.log('tbrain_tool_for_labeler ready.' +
            (modules.runtime.bgTimer.usingWorker
                ? ' Worker timers ON (background execution remains best-effort).'
                : ' Worker timers unavailable; native timers active.'));
    }
    return { start };
};
