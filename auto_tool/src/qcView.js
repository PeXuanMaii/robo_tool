/**
 * qcView
 * QC rendering, approval checkboxes and gated QC actions.
 * Dependencies: logger, panel, qcController, qcDomain, qcStore, status.
 * Module state stays in this closure; cross-module mutable bindings use live accessors.
 */
module.exports = function createQcView(modules) {
    'use strict';
    let lastSummary = '';
    function render() {
        const state = modules.qcStore.state;
        const taskId = modules.qcDomain.getTaskIdFromPage();
        const taskMatches = state.taskId === taskId;
        const reworkAvailable = state.eligibilityTaskId === taskId && state.isReworkTask;
        const hasBackups = state.backups.some(backup => backup.taskId === taskId
            && backup.submissionId === state.submissionId);
        const available = reworkAvailable || hasBackups;
        const section = document.getElementById('tb-q21');
        if (section)
            section.hidden = !available;
        const box = document.getElementById('tb-q21-results');
        if (!box)
            return;
        box.replaceChildren();
        if (!available) {
            lastSummary = '';
            return;
        }
        const feedback = taskMatches && reworkAvailable ? state.feedback : [];
        const items = taskMatches && reworkAvailable ? state.items : [];
        const summary = `${state.busy ? 'busy' : 'idle'} · ${feedback.length} feedback · ${items.length} segments`;
        if (summary !== lastSummary) {
            modules.logger.console.info('[QC]', summary);
            lastSummary = summary;
        }
        const add = (parent, text) => { const d = document.createElement('div'); d.textContent = text; parent.appendChild(d); return d; };
        for (const item of items) {
            const card = add(box, `${item.start.toFixed(1)}–${item.end.toFixed(1)}s · ${item.key} · ${item.status}`);
            card.style.cssText = 'border-top:1px solid #64748b;margin-top:6px;padding-top:5px;overflow-wrap:anywhere';
            const tone = modules.status.qcStatusTone(item.status);
            card.style.color = tone.color;
            card.style.borderLeft = '3px solid ' + tone.color;
            card.style.paddingLeft = '7px';
            card.setAttribute('data-qc-status', item.status);
            card.prepend(document.createTextNode(tone.icon + ' '));
            for (const m of item.mappings) {
                const line = document.createElement('label');
                line.style.cssText = 'display:block;padding:4px 0;white-space:pre-wrap';
                const mt = modules.status.qcStatusTone(m.status);
                line.style.color = mt.color;
                line.style.borderLeft = '2px solid ' + mt.color;
                line.style.paddingLeft = '6px';
                line.setAttribute('data-qc-status', m.status);
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = m.approved;
                cb.disabled = state.busy || state.workflow || m.mode !== 'SET' || m.status !== 'PROPOSED';
                cb.addEventListener('change', () => { m.approved = cb.checked; render(); });
                line.append(cb, document.createTextNode(` ${mt.icon} ${m.field}: ${m.before || '—'} → ${m.value || '—'} [${m.status}]`));
                card.appendChild(line);
            }
        }
        const checking = state.workflow && state.action === 'check';
        const fixing = state.workflow && state.action === 'fix';
        const undoing = state.workflow && state.action === 'undo';
        const check = document.getElementById('tb-q21-check');
        if (check) {
            check.textContent = 'CheckQC';
            check.style.display = reworkAvailable ? '' : 'none';
            check.disabled = fixing || undoing;
            check.title = checking ? 'Bấm lại để dừng kiểm tra' : 'Đọc feedback QC mới nhất và kiểm tra mapping';
            check.className = checking
                ? 'tbp-btn tbp-btn-warning tbp-btn-active tbp-btn-loading'
                : 'tbp-btn tbp-btn-info';
            check.setAttribute('aria-pressed', String(checking));
        }
        const fix = document.getElementById('tb-q21-fix');
        if (fix) {
            fix.textContent = 'FixQC';
            fix.style.display = reworkAvailable ? '' : 'none';
            fix.disabled = checking || undoing || (!fixing && !items.some(item => !item.error && item.mappings.some(m => m.approved && m.mode === 'SET' && m.status === 'PROPOSED')));
            fix.title = fixing ? 'Bấm lại để dừng sửa' : 'Sửa các thay đổi đã tick duyệt';
            fix.className = fixing
                ? 'tbp-btn tbp-btn-warning tbp-btn-active tbp-btn-loading'
                : 'tbp-btn tbp-btn-info';
            fix.setAttribute('aria-pressed', String(fixing));
        }
        const undo = document.getElementById('tb-q21-undo');
        if (undo) {
            undo.style.display = hasBackups ? '' : 'none';
            undo.textContent = undoing ? 'Stop Undo' : 'Undo FixQC';
            undo.disabled = !undoing && (state.busy || checking || fixing || !hasBackups);
            undo.title = undoing ? 'Bấm lại để dừng khôi phục an toàn' : 'Khôi phục batch FixQC gần nhất nếu dữ liệu server chưa bị thay đổi';
            undo.className = undoing
                ? 'tbp-btn tbp-btn-warning tbp-btn-active tbp-btn-loading'
                : 'tbp-btn tbp-btn-info';
            undo.setAttribute('aria-pressed', String(undoing));
        }
    }
    function mount() {
        const p = modules.panel.ensurePanel();
        if (!p)
            return;
        if (!document.getElementById('tb-q21')) {
            const sec = document.createElement('section');
            sec.id = 'tb-q21';
            const row = document.createElement('div');
            row.className = 'tbp-row tbp-toolbar';
            const btn = (id, text, fn) => {
                const b = document.createElement('button');
                b.id = id;
                b.type = 'button';
                b.className = 'tbp-btn tbp-btn-info';
                b.textContent = text;
                b.addEventListener('click', () => {
                    try {
                        Promise.resolve(fn()).catch(e => modules.logger.console.warn('[QC]', e.message));
                    }
                    catch (e) {
                        modules.logger.console.warn('[QC]', e.message);
                    }
                });
                row.appendChild(b);
            };
            btn('tb-q21-check', 'CheckQC', modules.qcController.onCheckClick);
            btn('tb-q21-fix', 'FixQC', modules.qcController.onFixClick);
            btn('tb-q21-undo', 'Undo FixQC', modules.qcController.onUndoClick);
            sec.appendChild(row);
            const out = document.createElement('div');
            out.id = 'tb-q21-results';
            out.setAttribute('aria-live', 'polite');
            out.style.cssText = 'max-height:260px;overflow:auto;font-size:11px';
            sec.appendChild(out);
            p.querySelector('.tbp-body').appendChild(sec);
        }
        void modules.qcController.refreshEligibility();
        render();
    }
    return {
        get render() { return render; },
        get mount() { return mount; }
    };
};
