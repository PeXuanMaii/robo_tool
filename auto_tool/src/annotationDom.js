/**
 * annotationDom
 * React-compatible field reads/writes and combobox/difficulty adapters.
 * Dependencies: config, runtime.
 * Module state stays in this closure; cross-module mutable bindings use live accessors.
 */
module.exports = function createAnnotationDom(modules) {
    'use strict';
    function normalizeText(text) {
        return String(text || '')
            .toLowerCase()
            .replace(/[’']/g, '')
            .replace(/[-_/]/g, ' ')
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }
    function findFirstElement(selectors, root = document) {
        for (const selector of selectors) {
            const el = root.querySelector(selector);
            if (el)
                return el;
        }
        return null;
    }
    function findInputNearLabel(labelTexts, root = document) {
        const candidates = Array.from(root.querySelectorAll('label, span, p, div'))
            .filter(el => el.children.length <= 2 && el.textContent.trim().length < 60);
        const label = candidates.find(el => {
            const t = normalizeText(el.textContent);
            return labelTexts.some(l => t === normalizeText(l) || t.startsWith(normalizeText(l)));
        });
        if (!label)
            return null;
        if (label.matches('label') && label.htmlFor) {
            const linked = document.getElementById(label.htmlFor);
            if (linked)
                return linked;
        }
        let node = label;
        for (let depth = 0; depth < 4 && node; depth++) {
            const input = node.querySelector('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea');
            if (input)
                return input;
            node = node.parentElement;
        }
        return null;
    }
    const getDescriptionElement = (root = document) => findFirstElement(modules.config.CONFIG.selectors.description, root) || findInputNearLabel(['task description', 'description'], root);
    const getActivityElement = (root = document) => findFirstElement(modules.config.CONFIG.selectors.activity, root) || findInputNearLabel(['activity'], root);
    const getSkillGroupElement = (root = document) => findFirstElement(modules.config.CONFIG.selectors.skillGroup, root) || findInputNearLabel(['skill group', 'skill'], root);
    const getSceneElement = (root = document) => findFirstElement(modules.config.CONFIG.selectors.scene, root) || findInputNearLabel(['scene environment l3', 'environment l3', 'scene', 'l3'], root);
    function setNativeValue(element, value) {
        if (!element)
            return false;
        const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter)
            setter.call(element, value);
        else
            element.value = value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }
    function clickOptionByText(targetText) {
        const target = normalizeText(targetText);
        const activeListboxes = Array.from(document.querySelectorAll('[role="listbox"], .dropdown-menu, .MuiAutocomplete-popper, [class*="dropdown"], [class*="menu"]'))
            .filter(el => el.offsetParent !== null);
        let candidates = [];
        if (activeListboxes.length > 0) {
            for (const box of activeListboxes) {
                const items = Array.from(box.querySelectorAll('button, [role="option"], [role="button"], li, div, span'))
                    .filter(el => el.offsetParent !== null && normalizeText(el.textContent) === target);
                candidates = candidates.concat(items);
            }
        }
        if (candidates.length === 0) {
            candidates = Array.from(document.querySelectorAll('button, [role="option"], [role="button"], li, div, span'))
                .filter(el => el.offsetParent !== null && normalizeText(el.textContent) === target);
        }
        if (candidates.length === 0)
            return false;
        candidates[0].click();
        return true;
    }
    async function setComboBoxValue(element, value, shouldContinue) {
        const canContinue = () => !shouldContinue || shouldContinue();
        if (!element || !value || !canContinue())
            return false;
        // 1. Focus và kích hoạt mở combobox
        element.focus();
        element.click();
        await modules.runtime.sleep(100);
        if (!canContinue())
            return false;
        // 2. Gán giá trị thông qua React Native Value Setter (nếu có)
        const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter)
            setter.call(element, value);
        else
            element.value = value;
        // 3. Bắn các sự kiện bàn phím và input để React state bắt được thay đổi
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        await modules.runtime.sleep(200);
        if (!canContinue())
            return false;
        // 4. Thử tìm và click vào option khớp với giá trị trong dropdown nếu có
        if (clickOptionByText(value)) {
            await modules.runtime.sleep(100);
            if (!canContinue())
                return false;
            element.blur();
            return true;
        }
        if (!canContinue())
            return false;
        // 5. Nếu không có option khớp, gửi phím Enter để xác nhận giá trị custom
        ['keydown', 'keypress', 'keyup'].forEach(type => {
            element.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        });
        await modules.runtime.sleep(150);
        if (!canContinue())
            return false;
        element.blur();
        // 6. Kiểm tra lại lần cuối, nếu bị React reset thì cưỡng bức gán lại giá trị setter
        if (element.value !== value) {
            if (setter)
                setter.call(element, value);
            else
                element.value = value;
            element.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return true;
    }
    function readDifficulty(root) {
        const isVisible = el => el.offsetParent !== null || el.getClientRects().length > 0;
        const isSelectedEl = el => {
            if (['aria-checked', 'aria-pressed', 'aria-selected', 'aria-current'].some(a => el.getAttribute(a) === 'true'))
                return true;
            const state = el.getAttribute('data-state');
            if (state && /^(checked|on|active|selected)$/i.test(state))
                return true;
            const cls = (el.className && el.className.toString()) || '';
            if (/(^|[\s_-])(selected|active|checked)([\s_-]|$)/i.test(cls))
                return true;
            const input = el.matches('input') ? el : el.querySelector('input[type="radio"], input[type="checkbox"]');
            return !!(input && input.checked);
        };
        const candidates = Array.from(root.querySelectorAll('button, [role="button"], [role="radio"], [role="option"], [role="tab"], label, li')).filter(isVisible);
        const hit = candidates.find(el => modules.config.DIFFICULTY_NAMES.some(n => normalizeText(n) === normalizeText(el.textContent)) && isSelectedEl(el));
        if (hit)
            return modules.config.DIFFICULTY_NAMES.find(n => normalizeText(n) === normalizeText(hit.textContent));
        return '';
    }
    function getCurrentSegmentRoot() {
        const descEl = getDescriptionElement();
        if (!descEl)
            return document.body;
        let node = descEl;
        while (node && node !== document.body) {
            if (node.querySelectorAll('[data-testid^="episode-index-row-"]').length > 0 || node.classList.contains('segment') || node.tagName === 'FORM') {
                return node;
            }
            node = node.parentElement;
        }
        return document.body;
    }
    function readCurrentSegmentData() {
        const root = getCurrentSegmentRoot();
        const val = el => (el && 'value' in el ? String(el.value).trim() : '');
        return {
            description: val(getDescriptionElement(root)),
            activity: val(getActivityElement(root)),
            skillGroup: val(getSkillGroupElement(root)),
            difficulty: readDifficulty(root),
            l3: val(getSceneElement(root))
        };
    }
    return {
        get readCurrentSegmentData() { return readCurrentSegmentData; },
        get getDescriptionElement() { return getDescriptionElement; },
        get getActivityElement() { return getActivityElement; },
        get getSkillGroupElement() { return getSkillGroupElement; },
        get getSceneElement() { return getSceneElement; },
        get setNativeValue() { return setNativeValue; },
        get setComboBoxValue() { return setComboBoxValue; },
        get clickOptionByText() { return clickOptionByText; },
        get readDifficulty() { return readDifficulty; },
        get getCurrentSegmentRoot() { return getCurrentSegmentRoot; }
    };
};
