/**
 * panel
 * Mounts controls in the active task header, not the read-only submitted view.
 * Dependencies: config, environment.
 * Module state stays in this closure; cross-module mutable bindings use live accessors.
 */
module.exports = function createPanel(modules) {
    'use strict';
    let panelStatusText = '';
    function setPanelStatus(text) {
        panelStatusText = text || '';
        const el = document.getElementById('tbp-status');
        if (el)
            el.textContent = panelStatusText;
    }
    const PANEL_CSS = `
.tbp-task-header{flex-wrap:wrap}
#tb-page-tools{box-sizing:border-box;flex:1 1 680px;min-width:0;max-width:100%;color:#e2e8f0;font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
#tb-page-tools *{box-sizing:border-box}
#tb-page-tools .tbp-body{display:flex;flex-direction:column;align-items:flex-end;gap:6px;min-width:0;max-width:100%}
#tb-page-tools .tbp-status{max-width:100%;overflow-wrap:anywhere;text-align:right;color:#fbbf24}
#tb-page-tools .tbp-status:empty{display:none}
#tb-page-tools .tbp-row{width:100%;display:flex;flex-wrap:wrap;gap:6px;align-items:center;justify-content:flex-end}
#tb-page-tools .tbp-row:empty{display:none}
#tb-page-tools .tbp-toolbar{width:100%;min-width:0;display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:6px;padding:5px;border:1px solid rgba(71,85,105,.72);border-radius:9px;background:rgba(15,23,42,.72)}
#tb-page-tools #tb-inject-fill::after,
#tb-page-tools #tb-inject-loop::after,
#tb-page-tools #tb-inject-l3-loop::after,
#tb-page-tools #tb-inject-paste::after{display:inline-flex;align-items:center;margin-left:5px;padding:2px 3px;border:1px solid rgba(148,163,184,.24);border-radius:4px;background:rgba(15,23,42,.24);color:#cbd5e1;font:600 9px/1 system-ui,sans-serif;opacity:.82}
#tb-page-tools #tb-inject-fill::after{content:'!'}
#tb-page-tools #tb-inject-loop::after{content:'@'}
#tb-page-tools #tb-inject-l3-loop::after{content:'#'}
#tb-page-tools #tb-inject-paste::after{content:'$'}
#tb-page-tools .tbp-r2-sensitivity{height:31px;max-width:160px;padding:0 8px}
#tb-page-tools #tbp-row-cut-review{align-items:flex-start}
#tb-page-tools .tbp-r2-review{flex:1 1 100%;min-width:0;width:100%;max-width:680px;padding:6px;border:1px solid #475569;border-radius:6px;background:#0f172a;text-align:left}
#tb-page-tools .tbp-r2-review-head{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px;color:#facc15;font-weight:600}
#tb-page-tools .tbp-r2-review-hint{color:#94a3b8;font-size:10px;font-weight:400}
#tb-page-tools .tbp-r2-review-list{display:flex;flex-direction:column;gap:4px;max-height:180px;overflow:auto;margin-top:6px}
#tb-page-tools .tbp-r2-review-item{display:flex;align-items:center;gap:4px;min-width:0}
#tb-page-tools .tbp-r2-review-select{flex:0 0 auto;width:14px;height:14px;margin:0 3px;accent-color:#38bdf8}
#tb-page-tools .tbp-r2-review-select:disabled{opacity:.5;cursor:not-allowed}
#tb-page-tools .tbp-r2-review-range{flex:1 1 auto;min-width:0;justify-content:flex-start;font-family:ui-monospace,Consolas,monospace;white-space:nowrap}
#tb-page-tools .tbp-r2-review-applied,#tb-page-tools .tbp-r2-review-partial{flex:0 0 auto;width:78px;text-align:center;font-size:10px}
#tb-page-tools .tbp-r2-review-applied{color:#86efac}
#tb-page-tools .tbp-r2-review-partial{color:#fbbf24}
#tb-page-tools .tbp-r2-review-actions{display:flex;flex-wrap:wrap;align-items:center;gap:5px;margin-top:6px}
#tb-page-tools .tbp-r2-review-note{flex:1 1 100%;color:#94a3b8;font-size:10px}
#tb-page-tools #tb-q21{width:100%;max-width:520px;min-width:0;padding-top:6px;border-top:1px solid #475569;overflow-wrap:anywhere}
#tb-page-tools #tb-q21>div{margin-top:4px}
#tb-page-tools #tb-q21-results{max-height:180px;overflow:auto;font-size:11px}
@media screen and (max-width:700px) {
 #tb-page-tools{flex:1 1 100%;width:100%;font-size:14px}
 #tb-page-tools .tbp-body{align-items:stretch}
 #tb-page-tools .tbp-status{text-align:left}
 #tb-page-tools .tbp-row{justify-content:flex-start;gap:8px}
 #tb-page-tools .tbp-r2-sensitivity{height:40px;min-height:40px;max-width:100%;padding:0 8px;font-size:12px;touch-action:manipulation}
 #tb-page-tools .tbp-r2-review-select{width:18px;height:18px}
}
`;
    function isEditableTaskStatus(text) {
        const status = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
        return ['claimed', 'rework', 'reworked', 'rework needed', 'rework requested', 'rework required', 'needs rework', 'in progress'].includes(status);
    }
    function containsNode(parent, node) {
        for (let current = node; current; current = current.parentElement) {
            if (current === parent)
                return true;
        }
        return false;
    }
    function hasEditableTaskForm() {
        const descriptionSelector = modules.config.CONFIG.selectors.description[0];
        const field = document.querySelector(descriptionSelector);
        return !!field && !field.disabled && !field.readOnly;
    }
    function findActiveTaskHeader() {
        if (!hasEditableTaskForm())
            return null;
        const statuses = document.querySelectorAll('span, [role="status"], [data-testid*="status" i]');
        const headings = document.querySelectorAll('h1, h2, h3, [role="heading"]');
        let headingTarget = null;
        let fallbackTarget = null;
        for (const status of statuses) {
            if (!isEditableTaskStatus(status.textContent))
                continue;
            let candidate = status.parentElement;
            while (candidate && candidate !== document.body) {
                if (Array.from(headings).some(heading => containsNode(candidate, heading))) {
                    headingTarget = candidate;
                    break;
                }
                candidate = candidate.parentElement;
            }
            const statusParent = status.parentElement;
            if (statusParent)
                fallbackTarget = statusParent.parentElement || statusParent;
        }
        return headingTarget || fallbackTarget;
    }
    function ensurePanel() {
        let panel = document.getElementById(modules.config.PANEL.id);
        const target = findActiveTaskHeader();
        if (!target) {
            if (panel)
                panel.style.display = 'none';
            return null;
        }
        target.classList.add('tbp-task-header');
        if (panel) {
            panel.style.display = '';
            if (panel.parentElement !== target)
                target.appendChild(panel);
            return panel;
        }
        panel = document.createElement('div');
        panel.id = modules.config.PANEL.id;
        panel.setAttribute('role', 'group');
        panel.setAttribute('aria-label', 'tbrain_tool_for_labeler controls');
        panel.innerHTML = '<style>' + PANEL_CSS + '</style>'
            + '<div class="tbp-body">'
            + '<div id="tbp-status" class="tbp-status" aria-live="polite"></div>'
            + '<div class="tbp-row" id="tbp-row-fill"></div>'
            + '<div class="tbp-row" id="tbp-row-cut"></div>'
            + '<div class="tbp-row" id="tbp-row-cut-review"></div>'
            + '<div class="tbp-row" id="tbp-row-fetch"></div>'
            + '<div class="tbp-row" id="tbp-row-tools"></div>'
            + '</div>';
        target.appendChild(panel);
        const cacheButton = document.createElement('button');
        cacheButton.type = 'button';
        cacheButton.className = 'tbp-mini tbp-btn tbp-btn-neutral';
        cacheButton.id = 'tbp-clear-cache';
        cacheButton.title = 'Xoá kết quả AI đã lưu trong IndexedDB';
        cacheButton.textContent = '🗑 Cache';
        cacheButton.addEventListener('click', () => {
            if (confirm('Xoá toàn bộ kết quả AI (Groq + quét tay) đã lưu trong IndexedDB?'))
                modules.environment.W.tbClearCache();
        });
        const toolsRow = document.getElementById('tbp-row-tools');
        if (toolsRow)
            toolsRow.appendChild(cacheButton);
        setPanelStatus(panelStatusText);
        return panel;
    }
    return {
        get setPanelStatus() { return setPanelStatus; },
        get ensurePanel() { return ensurePanel; }
    };
};
