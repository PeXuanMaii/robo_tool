/**
 * qcDomain
 * Pure feedback extraction, per-clause ledger, field mapping and conflict validation.
 * Dependencies: config.
 * Module state stays in this closure; cross-module mutable bindings use live accessors.
 */
module.exports = function createQcDomain(modules) {
    'use strict';
    const QC_FIELDS = ['environment_l3', 'task_description', 'activity_key', 'skill_group', 'task_difficulty'];
    const FIELD_UI_KEYS = { environment_l3: 'l3', task_description: 'description', activity_key: 'activity', skill_group: 'skillGroup', task_difficulty: 'difficulty' };
    const getTaskIdFromPage = () => (location.pathname.match(/\/tasks\/([a-zA-Z0-9-]+)/) || [])[1] || '';
    const normalizeFieldValue = (field, v) => field === 'task_difficulty' ? String(v || '').trim().toLowerCase() : String(v || '').trim();
    function extractEpisodes(sub) {
        const out = [];
        for (const a of sub.artifacts || [])
            for (const e of (a.data && a.data.episodes) || []) {
                if (e.episode_key && Number.isFinite(e.start_seconds) && Number.isFinite(e.end_seconds) && e.end_seconds > e.start_seconds)
                    out.push({ key: e.episode_key, artifactId: a.id, start: e.start_seconds, end: e.end_seconds, labels: { ...(e.labels || {}) } });
            }
        return out;
    }
    function extractFeedback(sub, history) {
        const feedback = [];
        const text = r => [r.reworkReason, r.reason, r.failReason].filter(x => typeof x === 'string' && x.trim()).join('\n');
        const latest = (rows) => rows.slice().sort((a, b) => (Number(b.round) || 0) - (Number(a.round) || 0) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
        const global = latest((sub.reviewHistory || []).filter(r => r.decision !== 'reopen'));
        // Keep each layer's latest decision; conflicts across layers are resolved only by explicit review.
        const layers = new Set();
        for (const r of global) {
            const layer = r.layer || '';
            if (layers.has(layer))
                continue;
            layers.add(layer);
            if (['rework', 'fail', 'reject', 'rejected'].includes(r.decision) && text(r))
                feedback.push({ id: 'task:' + r.id, scope: 'TASK', text: text(r), layer, at: r.createdAt || '' });
        }
        const groups = new Map();
        for (const r of history || []) {
            if (!r.episodeKey || r.source === 'system' || r.decision === 'reopen')
                continue;
            const k = (r.artifactInstanceId || '') + '|' + r.episodeKey;
            if (!groups.has(k))
                groups.set(k, []);
            groups.get(k).push(r);
        }
        for (const rows of groups.values()) {
            const r = latest(rows)[0];
            if (['fail', 'rework', 'reject', 'rejected'].includes(r.decision) && text(r))
                feedback.push({ id: 'episode:' + r.id, scope: 'EPISODE', episodeKey: r.episodeKey, artifactId: r.artifactInstanceId || '', text: text(r), round: r.round, at: r.createdAt || '' });
        }
        // A requirement ledger per clause prevents a compound comment from being silently dropped.
        return feedback.flatMap(f => f.text.split(/[;\n]+|[.!?](?:\s+|$)/).map(t => t.trim()).filter(Boolean).map((text, i) => ({ ...f, sourceId: f.id, id: f.id + ':clause:' + i, text })));
    }
    function createFeedbackSignature(sub, history) { return JSON.stringify({ id: sub.id, version: sub.version, feedback: extractFeedback(sub, history) }); }
    function getAllowedFields(text) {
        const t = String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\u0111/g, 'd'), fields = [];
        if (/\bl3\b|environment|scene|boi canh|moi truong/.test(t))
            fields.push('environment_l3');
        if (/description|\bdesc\b|mo ta|v-ing|grammar|ngu phap/.test(t))
            fields.push('task_description');
        if (/activity|\bact\b|slug/.test(t))
            fields.push('activity_key');
        if (/skill|ky nang/.test(t))
            fields.push('skill_group');
        if (/difficulty|do kho|\beasy\b|\bmedium\b|\bhard\b/.test(t))
            fields.push('task_difficulty');
        if (/object|doi tuong|vat the|fabric|farbic|\bvai\b/.test(t))
            fields.push('task_description', 'activity_key');
        return [...new Set(fields)];
    }
    function requiresTimelineReview(text) { return /start_seconds|end_seconds|\bstart\b|\bend\b|split|merge|trim|timestamp|bat dau|ket thuc|moc cat|cat lai|gop|tach|\d+:\d{2}/i.test(String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\u0111\u0110]/g, 'd')); }
    function isValidFieldValue(field, value) {
        if (typeof value !== 'string' || !value.trim() || value.length > 1200)
            return false;
        if (field === 'skill_group')
            return modules.config.SKILL_NAMES.includes(value);
        if (field === 'task_difficulty')
            return ['easy', 'medium', 'hard'].includes(value);
        if (field === 'activity_key')
            return /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(value);
        if (field === 'task_description')
            return /^[A-Za-z]+ing\b/.test(value) && !/[.。]$/.test(value);
        return field === 'environment_l3' && value.length <= 120;
    }
    function validateMappings(raw, feedback) {
        const out = [];
        if (!raw || !Array.isArray(raw.mappings))
            throw new Error('JSON mapping QC không hợp lệ');
        for (const m of raw.mappings) {
            const f = feedback.find(x => x.id === m.feedbackId);
            if (!f || typeof m.quote !== 'string' || !m.quote.trim() || !f.text.includes(m.quote))
                throw new Error('Mapping không có trích dẫn khớp feedback');
            const allowed = getAllowedFields(m.quote);
            let valid = m.mode === 'SET' && QC_FIELDS.includes(m.field) && allowed.includes(m.field) && isValidFieldValue(m.field, m.value);
            // L3 direct targets are compared independently of the model's interpretation.
            const l3Target = f.text.match(/(?:\bL3\b|environment_l3)\s*(?:để|de|là|la|=|:|to|should be|set to)\s*["']?([^"'\n.;!?]+)/i);
            if (valid && m.field === 'environment_l3' && l3Target && String(m.value).trim().toLowerCase() !== l3Target[1].trim().toLowerCase())
                valid = false;
            // A quoted explicit target must not be silently paraphrased.
            const literal = f.text.match(/(?:description|task_description|activity_key|difficulty|task_difficulty)\s*(?:=|:|to|thành|thanh|là|la)\s*["']([^"']+)["']/i);
            if (valid && literal && ['task_description', 'activity_key', 'task_difficulty'].includes(m.field) && normalizeFieldValue(m.field, m.value) !== normalizeFieldValue(m.field, literal[1]))
                valid = false;
            out.push({ feedbackId: f.id, scope: f.scope, quote: m.quote, field: QC_FIELDS.includes(m.field) ? m.field : 'MANUAL', value: typeof m.value === 'string' ? m.value : '', mode: valid ? 'SET' : 'REVIEW', reason: String(m.reason || ''), approved: false, status: valid ? 'PROPOSED' : 'REVIEW' });
        }
        for (const f of feedback) {
            if (!out.some(m => m.feedbackId === f.id))
                out.push({ feedbackId: f.id, scope: f.scope, quote: f.text, field: 'MANUAL', value: '', mode: 'REVIEW', reason: 'Feedback chưa được ánh xạ', approved: false, status: 'REVIEW' });
            if (requiresTimelineReview(f.text))
                out.push({ feedbackId: f.id, scope: f.scope, quote: f.text, field: 'TIMING', value: '', mode: 'REVIEW', reason: 'Mốc cắt/tách/gộp cần xem video; không tự thay đổi', approved: false, status: 'REVIEW' });
        }
        // Conflicting requests are not resolved by model confidence or implicit precedence.
        for (const field of QC_FIELDS) {
            const group = out.filter(m => m.field === field && m.mode === 'SET');
            if (new Set(group.map(m => m.value)).size > 1)
                for (const m of group) {
                    m.mode = 'REVIEW';
                    m.status = 'CONFLICT';
                    m.reason = 'Feedback yêu cầu giá trị mâu thuẫn cho cùng field';
                }
        }
        return out;
    }
    const MAPPING_SCHEMA = { type: 'OBJECT', properties: { mappings: { type: 'ARRAY', items: { type: 'OBJECT', properties: { feedbackId: { type: 'STRING' }, quote: { type: 'STRING' }, field: { type: 'STRING', enum: [...QC_FIELDS, 'MANUAL'] }, value: { type: 'STRING' }, mode: { type: 'STRING', enum: ['SET', 'REVIEW'] }, reason: { type: 'STRING' } }, required: ['feedbackId', 'quote', 'field', 'value', 'mode', 'reason'] } } }, required: ['mappings'] };
    return {
        get extractFeedback() { return extractFeedback; },
        get extractEpisodes() { return extractEpisodes; },
        get validateMappings() { return validateMappings; },
        get getAllowedFields() { return getAllowedFields; },
        get requiresTimelineReview() { return requiresTimelineReview; },
        get isValidFieldValue() { return isValidFieldValue; },
        get normalizeFieldValue() { return normalizeFieldValue; },
        get createFeedbackSignature() { return createFeedbackSignature; },
        get getTaskIdFromPage() { return getTaskIdFromPage; },
        get MAPPING_SCHEMA() { return MAPPING_SCHEMA; },
        get QC_FIELDS() { return QC_FIELDS; },
        get FIELD_UI_KEYS() { return FIELD_UI_KEYS; }
    };
};
