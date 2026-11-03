/**
 * controls
 * Fill/fetch/key controls and keyboard shortcuts.
 * Dependencies: config, fill, logger, panel, taskMonitor, timeline.
 * Module state stays in this closure; cross-module mutable bindings use live accessors.
 */
module.exports = function createControls(modules) {
    'use strict';
    const PLAYBACK_BOOST_RATE = 16;
    const PLAYBACK_BOOST_FALLBACK_RATES = [12, 10, 8, 6, 4, 3, 2];
    const FETCH_STORAGE_KEYS = {
        active: 'tb_fetch_active_state',
        poll: 'tb_poll_interval_val',
        duration: 'tb_min_duration_val',
        l1Except: modules.config.L1_EXCEPT_STORAGE_KEY,
        token: modules.config.TOKEN_STORAGE_KEY
    };
    const RESPONSIVE_STYLE_ID = 'tb-fetch-responsive-style';
    const RESPONSIVE_CSS = `
#tb-page-tools .tbp-btn,#tb-fetch-control-wrapper .tbp-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:5px;height:31px;min-height:30px;padding:0 10px;border:1px solid transparent;border-radius:7px;background:#334155;color:#e2e8f0;font:600 11px/1 system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer;white-space:nowrap;user-select:none;transition:background-color .14s ease,border-color .14s ease,box-shadow .14s ease,transform .14s ease,opacity .14s ease,filter .14s ease}
#tb-page-tools .tbp-btn-primary,#tb-fetch-control-wrapper .tbp-btn-primary{background:#3730a3;border-color:#4f46e5;color:#eef2ff}
#tb-page-tools .tbp-btn-primary:hover:not(:disabled),#tb-fetch-control-wrapper .tbp-btn-primary:hover:not(:disabled){background:#4338ca;border-color:#6366f1}
#tb-page-tools .tbp-btn-success,#tb-fetch-control-wrapper .tbp-btn-success{background:#065f46;border-color:#047857;color:#ecfdf5}
#tb-page-tools .tbp-btn-success:hover:not(:disabled),#tb-fetch-control-wrapper .tbp-btn-success:hover:not(:disabled){background:#047857;border-color:#10b981}
#tb-page-tools .tbp-btn-info,#tb-fetch-control-wrapper .tbp-btn-info{background:#075985;border-color:#0284c7;color:#f0f9ff}
#tb-page-tools .tbp-btn-info:hover:not(:disabled),#tb-fetch-control-wrapper .tbp-btn-info:hover:not(:disabled){background:#0369a1;border-color:#0ea5e9}
#tb-page-tools .tbp-btn-danger,#tb-fetch-control-wrapper .tbp-btn-danger{background:#7f1d1d;border-color:#b91c1c;color:#fff1f2}
#tb-page-tools .tbp-btn-danger:hover:not(:disabled),#tb-fetch-control-wrapper .tbp-btn-danger:hover:not(:disabled){background:#991b1b;border-color:#dc2626}
#tb-page-tools .tbp-btn-neutral,#tb-fetch-control-wrapper .tbp-btn-neutral{background:#1e293b;border-color:#475569;color:#e2e8f0}
#tb-page-tools .tbp-btn-neutral:hover:not(:disabled),#tb-fetch-control-wrapper .tbp-btn-neutral:hover:not(:disabled){background:#334155;border-color:#64748b}
#tb-page-tools .tbp-btn-secondary,#tb-fetch-control-wrapper .tbp-btn-secondary{background:#273449;border-color:#3b4b63;color:#e2e8f0}
#tb-page-tools .tbp-btn-secondary:hover:not(:disabled),#tb-fetch-control-wrapper .tbp-btn-secondary:hover:not(:disabled){background:#334155;border-color:#64748b}
#tb-page-tools .tbp-btn-warning,#tb-fetch-control-wrapper .tbp-btn-warning{background:#78350f;border-color:#b45309;color:#fffbeb}
#tb-page-tools .tbp-btn-warning:hover:not(:disabled),#tb-fetch-control-wrapper .tbp-btn-warning:hover:not(:disabled){background:#92400e;border-color:#d97706}
#tb-page-tools .tbp-btn:not(:disabled):hover,#tb-fetch-control-wrapper .tbp-btn:not(:disabled):hover{transform:translateY(-1px);box-shadow:0 2px 6px rgba(0,0,0,.2)}
#tb-page-tools .tbp-btn:not(:disabled):active,#tb-fetch-control-wrapper .tbp-btn:not(:disabled):active{transform:translateY(0);filter:brightness(.92);box-shadow:none}
#tb-page-tools .tbp-btn-active,#tb-fetch-control-wrapper .tbp-btn-active{box-shadow:inset 0 0 0 1px rgba(255,255,255,.2)}
#tb-page-tools .tbp-btn-loading,#tb-fetch-control-wrapper .tbp-btn-loading{cursor:progress}
#tb-page-tools .tbp-btn:disabled,#tb-fetch-control-wrapper .tbp-btn:disabled{opacity:.5;cursor:not-allowed;transform:none;box-shadow:none;filter:none}
#tb-page-tools button:focus-visible,#tb-page-tools input:focus-visible,#tb-page-tools select:focus-visible,#tb-fetch-control-wrapper button:focus-visible,#tb-fetch-control-wrapper input:focus-visible{outline:none;box-shadow:0 0 0 2px rgba(56,189,248,.72)}
#tb-page-tools .tbp-mini{height:30px;min-height:30px;padding:0 8px;font-size:11px}
#tb-page-tools .tbp-control-input,#tb-fetch-control-wrapper .tbp-control-input{box-sizing:border-box;height:31px;padding:0 8px;border:1px solid #475569;border-radius:7px;background:#0f172a;color:#e2e8f0;font:500 11px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;transition:border-color .14s ease,box-shadow .14s ease}
#tb-page-tools .tbp-control-input::placeholder,#tb-fetch-control-wrapper .tbp-control-input::placeholder{color:#94a3b8}
#tb-page-tools .tbp-control-l3{width:120px}
#tb-page-tools .tbp-control-select{box-sizing:border-box;height:31px;padding:0 8px;border:1px solid #475569;border-radius:7px;background:#0f172a;color:#e2e8f0;font:500 11px/1 system-ui,-apple-system,"Segoe UI",sans-serif}
#tb-fetch-control-wrapper{position:relative;z-index:20;box-sizing:border-box;padding:4px;border:1px solid rgba(71,85,105,.72);border-radius:9px;background:rgba(15,23,42,.78)}
#tb-fetch-control-wrapper>button{flex:0 0 auto}
#tb-fetch-settings-wrapper{position:absolute;top:calc(100% + 6px);left:0;z-index:10000;box-sizing:border-box;display:grid;grid-template-columns:minmax(0,1fr);gap:10px;width:min(320px,calc(100vw - 24px));max-width:calc(100vw - 24px);max-height:min(70vh,480px);overflow:auto;padding:12px;border:1px solid #475569;border-radius:10px;background:#111827;color:#e2e8f0;white-space:normal;box-shadow:0 10px 24px rgba(0,0,0,.32)}
#tb-fetch-settings-wrapper[hidden]{display:none!important}
#tb-fetch-settings-wrapper .tbp-fetch-settings-heading{padding-bottom:7px;border-bottom:1px solid #334155;color:#f8fafc;font-size:12px;font-weight:700}
#tb-fetch-settings-wrapper .tbp-fetch-settings-field{display:flex;flex-direction:column;gap:5px;min-width:0;color:#cbd5e1;font-size:11px;font-weight:600}
#tb-fetch-settings-wrapper .tbp-fetch-settings-field .tbp-control-input{width:100%;min-width:0;max-width:none;height:34px}
#tb-fetch-settings-wrapper .tbp-fetch-settings-hint{margin-top:-5px;color:#94a3b8;font-size:10px;font-weight:400}
#tb-api-key-modal.tbp-modal{display:none;position:absolute;top:38px;right:0;box-sizing:border-box;width:260px;max-width:calc(100vw - 24px);padding:12px;border:1px solid #475569;border-radius:9px;background:#111827;color:#e2e8f0;z-index:9999;box-shadow:0 10px 24px rgba(0,0,0,.32)}
#tb-api-key-modal .tbp-modal-title{margin-bottom:8px;color:#f8fafc;font-size:11px;font-weight:600}
#tb-api-key-modal .tbp-modal-input{width:100%;margin-bottom:8px}
#tb-api-key-modal .tbp-modal-actions{display:flex;justify-content:flex-end;gap:6px}
#tb-earnings-header-display.tbp-earnings-group{display:flex;align-items:center;gap:6px;white-space:nowrap;padding:4px 7px;border:1px solid rgba(71,85,105,.72);border-radius:8px;background:rgba(15,23,42,.78)}
#tb-earnings-header-display.tbp-earnings-group>span{font:600 11px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;white-space:nowrap}
#tb-earnings-header-display .tbp-earnings-total{color:#34d399}
#tb-earnings-header-display .tbp-earnings-today{color:#fbbf24}
#tb-earnings-header-display .tbp-earnings-task{color:#38bdf8}
@media screen and (max-width:700px) {
 .tb-fetch-mobile-host{box-sizing:border-box;flex-wrap:wrap!important;align-items:center!important;width:100%!important;max-width:100%;gap:6px}
 #tb-fetch-control-wrapper{box-sizing:border-box;min-width:0!important;max-width:100%!important;width:100%!important;flex:1 1 100%!important;flex-wrap:wrap!important;white-space:normal!important;gap:8px!important}
 #tb-fetch-control-wrapper>button{height:40px!important;min-height:40px!important;padding:0 10px!important;font-size:13px!important;touch-action:manipulation}
 #tb-fetch-settings-wrapper{width:min(340px,calc(100vw - 24px))!important;max-width:calc(100vw - 24px)!important;max-height:70vh!important}
 #tb-fetch-settings-wrapper .tbp-control-input{height:40px!important;font-size:14px!important;touch-action:manipulation}
 #tb-api-key-modal{position:fixed!important;top:50%!important;left:50%!important;right:auto!important;transform:translate(-50%,-50%)!important;width:min(90vw,320px)!important;max-height:80vh!important;overflow:auto!important}
 #tb-api-key,#tb-api-key-modal,#tb-earnings-header-display{display:none!important}
 #tb-page-tools .tbp-row:not(#tbp-row-fetch),#tb-page-tools .tbp-status{display:none!important}
 #tb-page-tools .tbp-btn{height:40px;min-height:40px;padding:0 12px;font-size:13px;touch-action:manipulation}
 #tb-page-tools .tbp-mini{height:36px;min-height:36px;padding:0 10px;font-size:12px;touch-action:manipulation}
 #tb-page-tools .tbp-r2-sensitivity{height:40px;min-height:40px;max-width:100%;padding:0 8px;font-size:12px;touch-action:manipulation}
 #tbp-row-fetch{justify-content:flex-start!important}
}
`;
    let leftShiftHeld = false;
    let playbackBoostAttempted = false;
    let playbackRateSnapshot = null;
    function ensureResponsiveStyles() {
        if (document.getElementById(RESPONSIVE_STYLE_ID))
            return;
        const host = document.head || document.documentElement;
        if (!host || typeof host.appendChild !== 'function')
            return;
        const style = document.createElement('style');
        style.id = RESPONSIVE_STYLE_ID;
        style.textContent = RESPONSIVE_CSS;
        host.appendChild(style);
    }
    function updateNotificationButton(button) {
        const state = modules.notifications.getPermissionState();
        if (state === 'granted' || state === 'userscript') {
            button.textContent = '🔔 Noti ON';
            button.className = 'tbp-btn tbp-btn-success tbp-btn-active';
            button.title = state === 'userscript'
                ? 'Userscript manager notification API sẵn sàng; Android vẫn có thể tạm dừng tab nền.'
                : 'Đã bật notification. Android vẫn có thể tạm dừng tab nền.';
            button.setAttribute('aria-label', 'Thông báo đã bật');
        }
        else if (state === 'denied') {
            button.textContent = '🔕 Noti bị chặn';
            button.className = 'tbp-btn tbp-btn-danger';
            button.title = 'Bật quyền thông báo trong cài đặt trang của Kiwi và cài đặt thông báo Android.';
            button.setAttribute('aria-label', 'Thông báo bị chặn; cần bật quyền trong cài đặt');
        }
        else if (state === 'unsupported') {
            button.textContent = '🔕 Noti N/A';
            button.className = 'tbp-btn tbp-btn-neutral';
            button.title = 'Trình duyệt hoặc userscript manager không hỗ trợ notification.';
            button.setAttribute('aria-label', 'Notification không được hỗ trợ');
        }
        else {
            button.textContent = '🔔 Bật Noti';
            button.className = 'tbp-btn tbp-btn-secondary';
            button.title = 'Chạm để yêu cầu quyền notification; thao tác này chỉ chạy sau khi bạn bấm nút.';
            button.setAttribute('aria-label', 'Bật thông báo');
        }
        button.disabled = state === 'unsupported';
    }
    function setKeyboardHint(button, key, action) {
        button.setAttribute('aria-keyshortcuts', key);
        button.title = `Phím tắt ${key}: ${action}`;
    }
    function keepFetchControlsHorizontal(element) {
        element.style.flexDirection = 'row';
        element.style.flexWrap = 'nowrap';
        element.style.alignItems = 'center';
        element.style.gap = '6px';
        element.style.whiteSpace = 'nowrap';
        element.style.flex = '0 0 auto';
        element.style.width = 'max-content';
    }
    function setSupportedPlaybackBoost(video, originalRate) {
        for (const rate of [PLAYBACK_BOOST_RATE, ...PLAYBACK_BOOST_FALLBACK_RATES]) {
            if (rate <= originalRate)
                continue;
            try {
                video.playbackRate = rate;
                const appliedRate = video.playbackRate;
                if (Number.isFinite(appliedRate) && appliedRate > originalRate)
                    return appliedRate;
            }
            catch (error) {
                if (!error || error.name !== 'NotSupportedError')
                    throw error;
            }
        }
        return originalRate;
    }
    function startPlaybackBoost() {
        if (playbackRateSnapshot)
            return;
        const videos = modules.timeline.getVideos();
        if (!videos.length)
            return;
        const originalRates = new Map(videos.map(video => [video, video.playbackRate]));
        const boostedRates = new Map();
        const fallbackRates = [];
        let unsupportedCount = 0;
        try {
            for (const [video, originalRate] of originalRates) {
                const appliedRate = setSupportedPlaybackBoost(video, originalRate);
                if (appliedRate <= originalRate) {
                    unsupportedCount++;
                    continue;
                }
                boostedRates.set(video, originalRate);
                if (appliedRate < PLAYBACK_BOOST_RATE)
                    fallbackRates.push(appliedRate);
            }
        }
        catch (error) {
            for (const [video, playbackRate] of boostedRates)
                video.playbackRate = playbackRate;
            throw error;
        }
        playbackRateSnapshot = boostedRates.size ? boostedRates : null;
        if (fallbackRates.length) {
            const rates = [...new Set(fallbackRates)].sort((a, b) => b - a);
            modules.logger.console.warn(`[Playback] ${PLAYBACK_BOOST_RATE}× is unsupported; using ${rates.join('×, ')}× instead.`);
        }
        if (unsupportedCount)
            modules.logger.console.warn(`[Playback] No faster supported rate for ${unsupportedCount} video(s).`);
    }
    function restorePlaybackBoost() {
        if (!playbackRateSnapshot)
            return;
        const snapshot = playbackRateSnapshot;
        playbackRateSnapshot = null;
        for (const [video, playbackRate] of snapshot)
            video.playbackRate = playbackRate;
    }
    function handleSpeedBoostKeyDown(event) {
        if (event.code === 'ShiftLeft')
            leftShiftHeld = true;
        const controlKeyPressed = event.code === 'ControlLeft' || event.code === 'ControlRight';
        if (leftShiftHeld && (event.ctrlKey || controlKeyPressed)) {
            event.preventDefault();
            if (!playbackBoostAttempted) {
                playbackBoostAttempted = true;
                startPlaybackBoost();
            }
        }
    }
    function handleSpeedBoostKeyUp(event) {
        if (event.code === 'ShiftLeft')
            leftShiftHeld = false;
        if (!event.ctrlKey || !leftShiftHeld) {
            playbackBoostAttempted = false;
            restorePlaybackBoost();
        }
    }
    function clearSpeedBoost() {
        leftShiftHeld = false;
        playbackBoostAttempted = false;
        restorePlaybackBoost();
    }
    function ensureFetchHeaderControls(actionGroup, themeToggleBtn) {
        let wrapper = document.getElementById('tb-fetch-control-wrapper');
        if (!wrapper) {
            wrapper = document.createElement('div');
            wrapper.id = 'tb-fetch-control-wrapper';
            wrapper.setAttribute('aria-label', 'Fetch Task and API key controls');
            let isActive = localStorage.getItem(FETCH_STORAGE_KEYS.active) !== null
                ? JSON.parse(localStorage.getItem(FETCH_STORAGE_KEYS.active))
                : true;
            const toggleBtn = document.createElement('button');
            toggleBtn.id = 'tb-fetch-toggle';
            toggleBtn.type = 'button';
            toggleBtn.className = 'tbp-btn tbp-btn-primary tbp-btn-active';
            toggleBtn.setAttribute('aria-label', 'Bật hoặc tắt Fetch Task');
            toggleBtn.title = 'Polling chỉ chạy khi userscript còn hoạt động; Android/Kiwi có thể tạm dừng tab nền.';
            const settingsToggleBtn = document.createElement('button');
            settingsToggleBtn.id = 'tb-fetch-settings-toggle';
            settingsToggleBtn.type = 'button';
            settingsToggleBtn.className = 'tbp-btn tbp-btn-neutral';
            settingsToggleBtn.textContent = '⚙ Cài đặt';
            settingsToggleBtn.title = 'Mở cài đặt Fetch Task';
            settingsToggleBtn.setAttribute('aria-label', 'Mở cài đặt Fetch Task');
            settingsToggleBtn.setAttribute('aria-controls', 'tb-fetch-settings-wrapper');
            settingsToggleBtn.setAttribute('aria-expanded', 'false');
            function setSettingsOpen(open) {
                const settings = document.getElementById('tb-fetch-settings-wrapper');
                const shouldOpen = isActive && !!open;
                if (settings)
                    settings.hidden = !shouldOpen;
                settingsToggleBtn.setAttribute('aria-expanded', String(shouldOpen));
            }
            settingsToggleBtn.onclick = () => {
                const settings = document.getElementById('tb-fetch-settings-wrapper');
                setSettingsOpen(!settings || settings.hidden);
            };
            function updateToggleButton() {
                toggleBtn.textContent = isActive ? 'Fetch Task: ON' : 'Fetch Task: OFF';
                toggleBtn.className = isActive
                    ? 'tbp-btn tbp-btn-primary tbp-btn-active'
                    : 'tbp-btn tbp-btn-neutral';
                settingsToggleBtn.style.display = isActive ? '' : 'none';
                if (!isActive)
                    setSettingsOpen(false);
            }
            updateToggleButton();
            toggleBtn.onclick = () => {
                isActive = !isActive;
                localStorage.setItem(FETCH_STORAGE_KEYS.active, JSON.stringify(isActive));
                if (isActive) {
                    modules.taskMonitor.stopped = false;
                    updateToggleButton();
                    modules.taskMonitor.tick();
                }
                else {
                    modules.taskMonitor.stop();
                    updateToggleButton();
                }
            };
            const notificationBtn = document.createElement('button');
            notificationBtn.id = 'tb-enable-notifications';
            notificationBtn.type = 'button';
            notificationBtn.className = 'tbp-btn tbp-btn-secondary';
            updateNotificationButton(notificationBtn);
            notificationBtn.onclick = async () => {
                notificationBtn.disabled = true;
                modules.notifications.activateAudio();
                try {
                    await modules.notifications.enableNotifications();
                }
                catch (error) {
                    modules.logger.console.error('[Notifications] Không bật được notification:', error);
                }
                updateNotificationButton(notificationBtn);
            };
            window.getStoredApiKey = function () {
                const saved = localStorage.getItem(FETCH_STORAGE_KEYS.token);
                return saved ? JSON.parse(saved) : (typeof modules.config.GROQ_API_KEY !== 'undefined' ? modules.config.GROQ_API_KEY : '');
            };
            const btnKey = document.createElement('button');
            btnKey.id = 'tb-api-key';
            btnKey.type = 'button';
            btnKey.className = 'tbp-btn tbp-btn-neutral';
            btnKey.textContent = '🔑 Key';
            btnKey.title = 'Cấu hình Groq API key';
            const tokenModal = document.createElement('div');
            tokenModal.id = 'tb-api-key-modal';
            tokenModal.className = 'tbp-modal';
            tokenModal.style.display = 'none';
            tokenModal.innerHTML = `
                <div class="tbp-modal-title">Nhập Groq API Key:</div>
                <input type="password" id="tb-token-input" class="tbp-control-input tbp-modal-input" value="${window.getStoredApiKey()}" placeholder="Dán Groq API Key vào đây..." />
                <div class="tbp-modal-actions">
                    <button type="button" id="tb-token-save" class="tbp-btn tbp-btn-success">Lưu</button>
                    <button type="button" id="tb-token-close" class="tbp-btn tbp-btn-neutral">Đóng</button>
                </div>
            `;
            btnKey.onclick = event => {
                event.stopPropagation();
                const isVisible = tokenModal.style.display === 'block';
                tokenModal.style.display = isVisible ? 'none' : 'block';
                if (!isVisible)
                    tokenModal.querySelector('#tb-token-input').value = window.getStoredApiKey();
            };
            setTimeout(() => {
                const saveBtn = tokenModal.querySelector('#tb-token-save');
                const closeBtn = tokenModal.querySelector('#tb-token-close');
                const inputEl = tokenModal.querySelector('#tb-token-input');
                if (saveBtn) {
                    saveBtn.onclick = () => {
                        const newKey = inputEl.value.trim();
                        localStorage.setItem(FETCH_STORAGE_KEYS.token, JSON.stringify(newKey));
                        tokenModal.style.display = 'none';
                    };
                }
                if (closeBtn)
                    closeBtn.onclick = () => { tokenModal.style.display = 'none'; };
            }, 100);
            wrapper.appendChild(toggleBtn);
            wrapper.appendChild(settingsToggleBtn);
            wrapper.appendChild(notificationBtn);
            wrapper.appendChild(btnKey);
            wrapper.appendChild(tokenModal);
        }
        keepFetchControlsHorizontal(wrapper);
        wrapper.style.display = 'flex';
        const earningsContainer = document.getElementById('tb-earnings-header-display');
        const insertionTarget = earningsContainer && earningsContainer.parentElement === actionGroup
            ? earningsContainer
            : themeToggleBtn && themeToggleBtn.parentElement === actionGroup ? themeToggleBtn : null;
        if (actionGroup.classList && typeof actionGroup.classList.add === 'function')
            actionGroup.classList.add('tb-fetch-mobile-host');
        const siblings = actionGroup.children ? Array.from(actionGroup.children) : [];
        const wrapperIndex = siblings.indexOf(wrapper);
        const targetIndex = insertionTarget ? siblings.indexOf(insertionTarget) : -1;
        if (wrapper.parentElement !== actionGroup
            || (insertionTarget && targetIndex >= 0 && wrapperIndex > targetIndex))
            actionGroup.insertBefore(wrapper, insertionTarget);
        return wrapper;
    }
    function ensureFetchSettings(controlsWrapper) {
        if (!controlsWrapper)
            return;
        const settingsToggle = document.getElementById('tb-fetch-settings-toggle');
        const keyButton = document.getElementById('tb-api-key');
        const notificationButton = document.getElementById('tb-enable-notifications');
        let wrapper = document.getElementById('tb-fetch-settings-wrapper');
        const activeState = localStorage.getItem(FETCH_STORAGE_KEYS.active);
        const isActive = activeState === null || JSON.parse(activeState);
        if (wrapper) {
            if (wrapper.parentElement !== controlsWrapper)
                controlsWrapper.insertBefore(wrapper, notificationButton && notificationButton.parentElement === controlsWrapper
                    ? notificationButton
                    : keyButton && keyButton.parentElement === controlsWrapper ? keyButton : null);
            if (settingsToggle)
                settingsToggle.style.display = isActive ? '' : 'none';
            wrapper.hidden = !isActive || !settingsToggle || settingsToggle.getAttribute('aria-expanded') !== 'true';
            return;
        }
        const currentPoll = localStorage.getItem(FETCH_STORAGE_KEYS.poll) !== null
            ? parseInt(localStorage.getItem(FETCH_STORAGE_KEYS.poll), 10)
            : modules.config.POLL_INTERVAL;
        const currentDuration = localStorage.getItem(FETCH_STORAGE_KEYS.duration) !== null
            ? parseInt(localStorage.getItem(FETCH_STORAGE_KEYS.duration), 10)
            : modules.config.MIN_DURATION_SECONDS;
        const currentL1Except = localStorage.getItem(FETCH_STORAGE_KEYS.l1Except) !== null
            ? localStorage.getItem(FETCH_STORAGE_KEYS.l1Except)
            : modules.config.DEFAULT_L1_EXCEPT;
        modules.config.POLL_INTERVAL = currentPoll;
        modules.config.MIN_DURATION_SECONDS = currentDuration;
        modules.config.L1_EXCEPT = currentL1Except;
        wrapper = document.createElement('div');
        wrapper.id = 'tb-fetch-settings-wrapper';
        wrapper.className = 'tbp-fetch-settings-popover';
        wrapper.setAttribute('role', 'group');
        wrapper.setAttribute('aria-label', 'Fetch Task settings');
        wrapper.hidden = true;
        const heading = document.createElement('div');
        heading.id = 'tb-fetch-settings-title';
        heading.className = 'tbp-fetch-settings-heading';
        heading.textContent = 'Fetch Task settings';
        wrapper.setAttribute('aria-labelledby', heading.id);
        wrapper.appendChild(heading);
        const pollInput = document.createElement('input');
        pollInput.id = 'tb-fetch-poll-interval';
        pollInput.className = 'tbp-control-input';
        pollInput.type = 'number';
        pollInput.value = currentPoll;
        pollInput.min = '500';
        pollInput.title = 'Poll interval (ms)';
        pollInput.setAttribute('aria-label', 'Poll interval (ms)');
        pollInput.onchange = event => {
            const value = parseInt(event.target.value, 10);
            if (value >= 500) {
                modules.config.POLL_INTERVAL = value;
                localStorage.setItem(FETCH_STORAGE_KEYS.poll, value);
            }
        };
        const durationInput = document.createElement('input');
        durationInput.id = 'tb-fetch-min-duration';
        durationInput.className = 'tbp-control-input';
        durationInput.type = 'number';
        durationInput.value = currentDuration;
        durationInput.min = '0';
        durationInput.title = 'Thời lượng task tối thiểu (giây)';
        durationInput.setAttribute('aria-label', 'Thời lượng task tối thiểu (giây)');
        durationInput.onchange = event => {
            const value = parseInt(event.target.value, 10);
            if (value >= 0) {
                modules.config.MIN_DURATION_SECONDS = value;
                localStorage.setItem(FETCH_STORAGE_KEYS.duration, value);
            }
        };
        const l1ExceptInput = document.createElement('input');
        l1ExceptInput.id = 'tb-fetch-l1-except';
        l1ExceptInput.className = 'tbp-control-input';
        l1ExceptInput.type = 'text';
        l1ExceptInput.value = currentL1Except;
        l1ExceptInput.placeholder = 'Automotive and Transport, ...';
        l1ExceptInput.title = 'L1 cần bỏ qua, phân cách bằng dấu phẩy';
        l1ExceptInput.setAttribute('aria-label', 'L1 Except');
        l1ExceptInput.onchange = event => {
            const value = String(event.target.value || '');
            modules.config.L1_EXCEPT = value;
            localStorage.setItem(FETCH_STORAGE_KEYS.l1Except, value);
        };
        const appendField = (labelText, input) => {
            const field = document.createElement('label');
            field.className = 'tbp-fetch-settings-field';
            field.setAttribute('for', input.id);
            const label = document.createElement('span');
            label.className = 'tbp-fetch-setting-label';
            label.textContent = labelText;
            field.appendChild(label);
            field.appendChild(input);
            wrapper.appendChild(field);
        };
        appendField('Poll interval (ms)', pollInput);
        appendField('Thời lượng tối thiểu (giây)', durationInput);
        appendField('L1 Except', l1ExceptInput);
        const hint = document.createElement('div');
        hint.className = 'tbp-fetch-settings-hint';
        hint.textContent = 'Nhập các giá trị L1 cần bỏ qua, phân cách bằng dấu phẩy.';
        wrapper.appendChild(hint);
        if (settingsToggle)
            settingsToggle.style.display = isActive ? '' : 'none';
        controlsWrapper.insertBefore(wrapper, notificationButton && notificationButton.parentElement === controlsWrapper
            ? notificationButton
            : keyButton && keyButton.parentElement === controlsWrapper ? keyButton : null);
    }
    /* ---------------------------------------------------------------------
     * UI INJECTION - GẮN ĐIỀU KHIỂN VÀO HEADER TASK ĐANG LÀM
     * --------------------------------------------------------------------- */
    function injectUIControls() {
         ensureResponsiveStyles();
         const toolsHost = modules.panel.ensurePanel();
         const fillRow = toolsHost && document.getElementById('tbp-row-fill');
        if (fillRow && !document.getElementById('tb-inject-fill')) {
            const btnBaseClass = 'tbp-btn';
            // Tạo một Wrapper chứa toàn bộ thanh công cụ tự động
            const helperToolbar = document.createElement('div');
            helperToolbar.id = 'tb-helper-toolbar';
            helperToolbar.className = 'tbp-row tbp-toolbar';
            // 1. Ô nhập L3 Custom
            const l3Input = document.createElement('input');
            l3Input.id = 'tb-l3-custom-input';
            l3Input.type = 'text';
            l3Input.placeholder = 'Enter L3...';
            l3Input.setAttribute('aria-label', 'Giá trị L3 (Scene)');
            l3Input.className = 'tbp-control-input tbp-control-l3';
            // 2. Nút Fill 1
            const btnFill = document.createElement('button');
            btnFill.id = 'tb-inject-fill';
            btnFill.type = 'button';
            btnFill.className = `${btnBaseClass} tbp-btn-primary`;
            btnFill.innerHTML = '⚡ Fill 1';
            setKeyboardHint(btnFill, '!', 'Fill 1');
            btnFill.addEventListener('click', modules.fill.runAutoFill);
            // 3. Nút Fill All
            const btnLoop = document.createElement('button');
            btnLoop.id = 'tb-inject-loop';
            btnLoop.type = 'button';
            btnLoop.className = `tb-inject-loop-btn ${btnBaseClass} tbp-btn-primary`;
            btnLoop.innerHTML = '🔄 Fill All';
            setKeyboardHint(btnLoop, '@', 'Fill All');
            btnLoop.addEventListener('click', modules.fill.runLoopAllEpisodes);
            // 4. Nút Fill L3 All
            const btnFillL3Loop = document.createElement('button');
            btnFillL3Loop.id = 'tb-inject-l3-loop';
            btnFillL3Loop.type = 'button';
            btnFillL3Loop.className = `tb-inject-fill-l3-loop-btn ${btnBaseClass} tbp-btn-success`;
            btnFillL3Loop.innerHTML = '🔄 Fill L3 All';
            setKeyboardHint(btnFillL3Loop, '#', 'Fill L3 All');
            btnFillL3Loop.addEventListener('click', modules.fill.runLoopFillL3);
            // 5. Nút Copy
            const btnCopy = document.createElement('button');
            btnCopy.id = 'tb-inject-copy';
            btnCopy.type = 'button';
            btnCopy.className = `${btnBaseClass} tbp-btn-secondary`;
            btnCopy.innerHTML = '📋 Copy';
            btnCopy.addEventListener('click', modules.fill.runCopySegment);
            // 6. Nút Paste
            const btnPaste = document.createElement('button');
            btnPaste.id = 'tb-inject-paste';
            btnPaste.type = 'button';
            btnPaste.className = `${btnBaseClass} tbp-btn-info`;
            btnPaste.innerHTML = '📥 Paste';
            setKeyboardHint(btnPaste, '$', 'Paste');
            btnPaste.addEventListener('click', modules.fill.runPasteSegment);
            // 7. Nút Paste All
            const btnPasteAll = document.createElement('button');
            btnPasteAll.id = 'tb-inject-paste-all';
            btnPasteAll.type = 'button';
            btnPasteAll.className = `${btnBaseClass} tbp-btn-info`;
            btnPasteAll.innerHTML = '📥 Paste All';
            setKeyboardHint(btnPasteAll, '%', 'Paste All');
            btnPasteAll.title = 'Phím tắt %: Paste All. Dán các trường đã copy lên mọi segment sau khi xác nhận.';
            btnPasteAll.addEventListener('click', modules.fill.runPasteAllSegments);
            // Đưa tất cả vào thanh công cụ chung
            helperToolbar.appendChild(l3Input);
            helperToolbar.appendChild(btnFillL3Loop);
            helperToolbar.appendChild(btnFill);
            helperToolbar.appendChild(btnLoop);
            helperToolbar.appendChild(btnPaste);
            helperToolbar.appendChild(btnPasteAll);
            helperToolbar.appendChild(btnCopy);
            fillRow.appendChild(helperToolbar);
        }
        const themeToggleBtn = document.querySelector('[data-testid="theme-toggle"]');
        const actionGroup = themeToggleBtn && themeToggleBtn.parentElement
            ? themeToggleBtn.parentElement
            : document.getElementById('tbp-row-fetch');
        if (actionGroup) {
            const fetchControls = ensureFetchHeaderControls(actionGroup, themeToggleBtn);
            ensureFetchSettings(fetchControls);
            const notificationButton = document.getElementById('tb-enable-notifications');
            if (notificationButton)
                updateNotificationButton(notificationButton);
        }
    }
    function wakeFetchMonitorIfVisible() {
        if (!document.hidden && !modules.taskMonitor.stopped)
            modules.taskMonitor.wake();
    }
    let initialized = false;
    function init() {
        if (initialized)
            return;
        initialized = true;
        document.addEventListener('keydown', handleSpeedBoostKeyDown, true);
        document.addEventListener('keyup', handleSpeedBoostKeyUp, true);
        document.addEventListener('visibilitychange', () => {
            if (document.hidden)
                clearSpeedBoost();
            else
                wakeFetchMonitorIfVisible();
        });
        window.addEventListener('pageshow', wakeFetchMonitorIfVisible);
        window.addEventListener('focus', wakeFetchMonitorIfVisible);
        window.addEventListener('blur', clearSpeedBoost);
        document.addEventListener('keydown', function (e) {
            // Chỉ kích hoạt khi không gõ trong ô input/textarea khác (ngoại trừ ô nhập L3 tùy chỉnh)
            const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
            const activeId = document.activeElement ? document.activeElement.id : '';
            if (activeTag === 'textarea' || (activeTag === 'input' && activeId !== 'tb-l3-custom-input')) {
                return;
            }
            if (e.ctrlKey || e.altKey || e.metaKey)
                return;
            if (e.key === '!') {
                e.preventDefault();
                const btn = document.getElementById('tb-inject-fill');
                if (btn)
                    btn.click();
            }
            else if (e.key === '@') {
                e.preventDefault();
                const btn = document.getElementById('tb-inject-loop'); // Nút "Fill All" (Loop All)
                if (btn)
                    btn.click();
            }
            else if (e.key === '#') {
                e.preventDefault();
                const btn = document.getElementById('tb-inject-l3-loop'); // Nút "Fill L3 All"
                if (btn)
                    btn.click();
            }
            else if (e.key === '$') {
                e.preventDefault();
                const btn = document.getElementById('tb-inject-paste'); // Nút "Paste"
                if (btn)
                    btn.click();
            }
            else if (e.key === '%') {
                e.preventDefault();
                const btn = document.getElementById('tb-inject-paste-all');
                if (btn)
                    btn.click();
            }
        });
    }
    return {
        get injectUIControls() { return injectUIControls; },
        init
    };
};
