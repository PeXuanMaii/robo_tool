/**
 * logger
 * Tool-local logging to the browser console, including QC status records.
 * Dependencies: status.
 * Module state stays in this closure; cross-module mutable bindings use live accessors.
 */
module.exports = function createLogger(modules) {
    'use strict';
    const _con = window.console;
    function qcStatusLog(phase, item) {
        const tone = modules.status.qcStatusTone(item.status);
        const details = {
            feedback: Array.isArray(item.feedback) ? item.feedback.map(feedback => ({
                scope: feedback.scope,
                id: feedback.id,
                text: feedback.text
            })) : [],
            mappings: Array.isArray(item.mappings) ? item.mappings.map(mapping => ({
                field: mapping.field,
                before: mapping.before,
                value: mapping.value,
                status: mapping.status,
                quote: mapping.quote,
                reason: mapping.reason
            })) : []
        };
        _con.log(`[QC] ${phase} ${item.key}: ${tone.icon} ${item.status}${item.error ? ' · ' + item.error : ''}`, details);
    }
    const console = {
        log: (...args) => _con.log(...args),
        info: (...args) => _con.info(...args),
        warn: (...args) => _con.warn(...args),
        error: (...args) => _con.error(...args),
        debug: (...args) => _con.debug(...args),
        table: (...args) => _con.table(...args)
    };
    return {
        get console() { return console; },
        get _con() { return _con; },
        get qcStatusLog() { return qcStatusLog; }
    };
};
