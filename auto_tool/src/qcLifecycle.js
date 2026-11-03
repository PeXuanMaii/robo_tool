/**
 * qcLifecycle
 * QC interaction lock and backwards-compatible diagnostic report.
 * Dependencies: environment, qcStore.
 * Module state stays in this closure; cross-module mutable bindings use live accessors.
 */
module.exports = function createQcLifecycle(modules) {
    'use strict';
    let initialized = false;
    function init() {
        if (initialized)
            return;
        initialized = true;
        // Lock manual task edits while QC selects/writes. Keep Stop available in the toolbar.
        for (const type of ['click', 'pointerdown', 'keydown', 'beforeinput'])
            document.addEventListener(type, e => {
                if (!(modules.qcStore.state.busy || modules.qcStore.state.workflow) || !e.isTrusted || (e.target.closest && e.target.closest('#tb-page-tools')))
                    return;
                e.preventDefault();
                e.stopImmediatePropagation();
            }, true);
        modules.environment.W.tbQCMappingReport = () => JSON.parse(JSON.stringify({ taskId: modules.qcStore.state.taskId, submissionId: modules.qcStore.state.submissionId, items: modules.qcStore.state.items, backups: modules.qcStore.state.backups }));
    }
    return {
        init
    };
};
