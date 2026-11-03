/**
 * environment
 * Browser/page bridge. No feature logic.
 * Dependencies: none.
 * Module state stays in this closure; cross-module mutable bindings use live accessors.
 */
module.exports = function createEnvironment(modules) {
    'use strict';
    // Window thật của trang (Tampermonkey sandbox khi có @grant)
    const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    return {
        get W() { return W; }
    };
};
