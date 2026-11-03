/**
 * status
 * Pure QC status-to-color mapping. No DOM or network dependencies.
 * Dependencies: none.
 * Module state stays in this closure; cross-module mutable bindings use live accessors.
 */
module.exports = function createStatus(modules) {
    'use strict';
    // Explicit status colors; never infer success from arbitrary feedback text.
    function qcStatusTone(status) {
        if (['PASS', 'MATCH', 'ALREADY_MATCHES', 'MATCHES_MAPPED_FIELDS', 'SAVED_FIELD_VERIFIED', 'MAPPED_FIELDS_SAVED'].includes(status))
            return { color: '#4ade80', icon: '✅', label: 'Đã khớp / đã xác nhận' };
        if (['FAIL', 'ERROR', 'PROPOSED', 'WRONG', 'SAVE_FAILED'].includes(status))
            return { color: '#f87171', icon: '❌', label: 'Còn sai / cần sửa' };
        if (['REVIEW', 'CONFLICT', 'PARTIAL_REVIEW', 'SAVE_UNCONFIRMED', 'UI_APPLIED_SAVE_UNCONFIRMED'].includes(status))
            return { color: '#fbbf24', icon: '⚠️', label: 'Cần review / chưa xác nhận' };
        return { color: '#cbd5e1', icon: '⏳', label: 'Chưa kiểm tra / đang xử lý' };
    }
    return {
        get qcStatusTone() { return qcStatusTone; }
    };
};
