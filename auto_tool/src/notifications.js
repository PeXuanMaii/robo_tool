/**
 * notifications
 * Task-acquisition audio and browser/userscript-manager notifications.
 * Dependencies: config, taskMonitor.
 * Module state stays in this closure; cross-module mutable bindings use live accessors.
 */
module.exports = function createNotifications(modules) {
    'use strict';
    let audioCtx = null;
    let deniedLogged = false;

    function getUserscriptNotification() {
        if (typeof GM_notification === 'function')
            return GM_notification;
        if (typeof GM !== 'undefined' && GM && typeof GM.notification === 'function')
            return GM.notification.bind(GM);
        return null;
    }

    function getPermissionState() {
        if (getUserscriptNotification())
            return 'userscript';
        if (!('Notification' in window) || typeof Notification !== 'function'
            || typeof Notification.permission !== 'string')
            return 'unsupported';
        return Notification.permission;
    }

    async function ensurePermission() {
        const state = getPermissionState();
        if (state === 'granted' || state === 'userscript')
            return true;
        if (state === 'denied') {
            if (!deniedLogged) {
                modules.taskMonitor.log.warn("Notification permission denied.");
                deniedLogged = true;
            }
            return false;
        }
        return false;
    }

    async function enableNotifications() {
        unlockAudio();
        const state = getPermissionState();
        if (state !== 'default')
            return state;
        if (typeof Notification.requestPermission !== 'function')
            return 'unsupported';
        try {
            const permission = await Notification.requestPermission();
            return typeof permission === 'string' ? permission : getPermissionState();
        }
        catch (error) {
            modules.taskMonitor.log.error('Notification permission request failed:', error);
            return getPermissionState();
        }
    }

    function unlockAudio() {
        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (AC && !audioCtx)
                audioCtx = new AC();
            if (audioCtx && audioCtx.state === "suspended")
                void audioCtx.resume();
        }
        catch (error) {
            modules.taskMonitor.log.warn('Audio notification could not be enabled:', error);
        }
    }

    function beep() {
        try {
            if (!audioCtx)
                unlockAudio();
            if (!audioCtx || audioCtx.state !== "running")
                return;
            const start = audioCtx.currentTime;
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.frequency.value = 880;
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start(start);
            osc.stop(start + 0.15);
        }
        catch (error) {
            modules.taskMonitor.log.warn('Task notification sound failed:', error);
        }
    }

    function openTask(notification) {
        try {
            if (typeof window.open === 'function')
                window.open(modules.config.CLICK_URL, '_blank');
            if (typeof window.focus === 'function')
                window.focus();
        }
        catch (error) {
            modules.taskMonitor.log.warn('Could not open Tbrain from notification:', error);
        }
        if (notification && typeof notification.close === 'function')
            notification.close();
    }

    function getNotificationContent(item) {
        const hours = Number.isFinite(item.durationSeconds)
            ? (item.durationSeconds / 3600).toFixed(2)
            : 'Unknown';
        return {
            title: '🚀 Đã nhận Task mới thành công!',
            body: `ID: ${item.id}\nThời lượng: ${hours} giờ`,
            tag: `tbrain-acquired-${item.id}`
        };
    }

    async function showBrowserNotification(item) {
        const content = getNotificationContent(item);
        const options = {
            body: content.body,
            tag: content.tag,
            renotify: true,
            data: { url: modules.config.CLICK_URL }
        };
        const serviceWorker = navigator.serviceWorker;
        if (serviceWorker && typeof serviceWorker.getRegistration === 'function') {
            try {
                const registration = await serviceWorker.getRegistration();
                if (registration && typeof registration.showNotification === 'function') {
                    try {
                        await registration.showNotification(content.title, options);
                        return;
                    }
                    catch (error) {
                        modules.taskMonitor.log.warn('Service-worker notification failed; trying browser notification:', error);
                    }
                }
            }
            catch (error) {
                modules.taskMonitor.log.warn('Could not access the service-worker registration:', error);
            }
        }
        if (typeof Notification !== 'function')
            throw new Error('Browser Notification API is unavailable');
        const notification = new Notification(content.title, options);
        notification.onclick = event => {
            if (event && typeof event.preventDefault === 'function')
                event.preventDefault();
            openTask(notification);
        };
    }

    async function showAcquireNotification(acquiredTasks) {
        if (!Array.isArray(acquiredTasks) || acquiredTasks.length === 0)
            return;
        beep();
        const managerNotify = getUserscriptNotification();
        if (managerNotify) {
            for (const item of acquiredTasks) {
                const content = getNotificationContent(item);
                try {
                    const result = managerNotify({
                        title: content.title,
                        text: content.body,
                        tag: content.tag,
                        timeout: 10000,
                        onclick: () => openTask()
                    });
                    if (result && typeof result.then === 'function')
                        await result;
                }
                catch (error) {
                    modules.taskMonitor.log.error('Userscript-manager notification failed:', error);
                    if ('Notification' in window && typeof Notification === 'function'
                        && Notification.permission === 'granted') {
                        try {
                            await showBrowserNotification(item);
                        }
                        catch (fallbackError) {
                            modules.taskMonitor.log.error('Browser notification fallback failed:', fallbackError);
                        }
                    }
                }
            }
            return;
        }
        if (!(await ensurePermission())) {
            modules.taskMonitor.log.info('[NOTIFICATION PERMISSION REQUIRED]', acquiredTasks);
            return;
        }
        for (const item of acquiredTasks) {
            try {
                await showBrowserNotification(item);
            }
            catch (error) {
                modules.taskMonitor.log.error('Browser notification failed:', error);
            }
        }
    }

    return {
        get ensurePermission() { return ensurePermission; },
        get enableNotifications() { return enableNotifications; },
        get getPermissionState() { return getPermissionState; },
        get activateAudio() { return unlockAudio; },
        get showAcquireNotification() { return showAcquireNotification; }
    };
};
