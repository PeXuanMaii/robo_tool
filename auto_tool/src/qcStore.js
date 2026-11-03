/**
 * qcStore
 * QC workflow state, scoped to the current task/submission.
 * Dependencies: none.
 * Module state stays in this closure; cross-module mutable bindings use live accessors.
 */
module.exports = function createQcStore(modules) {
    'use strict';
    /* ==================== QC v21: feedback -> field-scoped patches ==================== */
    const state = { busy: false, stop: false, taskId: '', submissionId: '', items: [], feedback: [], signature: '', allEpisodes: [], backups: [], workflow: false, action: '', eligibilityTaskId: '', eligibilityChecked: false, eligibilityCheckedAt: 0, eligibilityPending: false, isReworkTask: false };
    return {
        get state() { return state; }
    };
};
