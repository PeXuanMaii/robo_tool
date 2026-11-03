/**
 * config
 * Single configuration boundary: IDs, selectors, schemas, thresholds and persisted-setting defaults.
 * Dependencies: none.
 * Module state stays in this closure; cross-module mutable bindings use live accessors.
 */
module.exports = function createConfig(modules) {
    'use strict';
    const PANEL = { id: 'tb-page-tools' };
    /* =====================================================================
     * TBRAIN AUTO-FILL & AUTO-FETCH – MASTER SCRIPT (NO TOOL IN ACTIVITY)
     * ===================================================================== */
    // ==================== CONFIG: GROQ API ====================
    const GROQ_API_KEY = "";
    const TOKEN_STORAGE_KEY = 'tb_groq_api_key_custom';
    const L1_EXCEPT_STORAGE_KEY = 'tb_fetch_l1_except';
    const DEFAULT_L1_EXCEPT = 'Automotive and Transport';
    const PROJECT_ID = "cfbe006a-9012-41bc-ba3c-afa8a3338139";
    let POLL_INTERVAL = 2000;
    let MIN_DURATION_SECONDS = 7200;
    let L1_EXCEPT = DEFAULT_L1_EXCEPT;
    const TOKEN_RETRY_INTERVAL = 60000;
    const API_BASE = "https://api.tbrain.ai";
    const API_URL = `${API_BASE}/api/v1/tasks/pool?projectId=${PROJECT_ID}&page=1&pageSize=20`;
    const STATS_API_URL = `${API_BASE}/api/v1/tasks/my-stats?projectId=${PROJECT_ID}`;
    const EXTRA_HOURS_API_URL = `${API_BASE}/api/v1/my/extra-hours?projectId=${PROJECT_ID}`;
    const EARNINGS_RATE_VND_PER_HOUR = 50000;
    const CLICK_URL = "https://beacon.tbrain.ai";
    const REQUEST_TIMEOUT = 5000;
    const NOTIFY_ON_FIRST_POLL = true;
    const MAX_SEEN_IDS = 5000;
    const AUTO_ACQUIRE = true;
    const PERF_LOG = true;
    const RATE_LIMIT_RESERVE = 30;
    const MIN_SAFE_POLL_INTERVAL = 2500;
    const MAX_SAFE_POLL_INTERVAL = 15000;
    const RATE_LIMIT_FALLBACK_WAIT = 30000;
    const RATE_LIMIT_SAFETY_MS = 1000;
    const MAX_CONCURRENT_ACQUIRE = 2;
    /* ==================== AI PROMPT / ANNOTATION SCHEMA ==================== */
    const SKILL_GROUPS = [
        ['Pick and Place / Object Handling', 'simply moving, lifting or transferring objects without changing them'],
        ['Tool Use & Technical Manipulation', 'using hand tools or crafting/shaping materials: weaving, carving, drilling, shaping baskets, wood or metal'],
        ['Food Preparation & Cooking', 'chopping, peeling, mixing ingredients, cooking, washing food'],
        ['Mechanical / Automotive Work', 'repairing vehicles, tires, engines, bicycles'],
        ['Repair & Maintenance', 'fixing broken furniture, appliances, plumbing'],
        ['Assembly & Installation', 'putting components together, screwing, mounting or installing items'],
        ['Construction & Building', 'bricklaying, plastering, pouring concrete, heavy building work'],
        ['Cleaning & Sanitation', 'wiping surfaces, sweeping, mopping, scrubbing (not dishes)'],
        ['Organization & Tidying', 'arranging items in drawers or shelves, sorting, tidying up'],
        ['Packing & Bagging', 'boxing, bagging, wrapping, sealing packages, folding boxes'],
        ['Clothing & Laundry', 'folding clothes, ironing, sewing, laundering'],
        ['Inventory & Stock Management', 'counting stock, shelving products, labeling items'],
        ['Retail & Service Operations', 'cashier checkout, serving customers'],
        ['Human Interaction & Handoffs', 'handing items to someone, greeting'],
        ['Healthcare & Caregiving', 'first aid, feeding patients, applying bandages'],
        ['Home Appliance Interaction', 'operating microwaves, washing machines or other home appliances'],
        ['Electronics & Diagnostics', 'soldering circuit boards, testing or repairing electronics'],
        ['Dish Handling', 'washing, drying and stacking plates, cups, cutlery']
    ];
    const SKILL_NAMES = SKILL_GROUPS.map(s => s[0]);
    const DEFAULT_SKILL = SKILL_NAMES[0];
    const DIFFICULTIES = ['Easy', 'Medium', 'Hard'];
    const PROMPT_RULES = [
        'You label short first-person video segments of manual hand work for a dataset.',
        'Return ONLY raw JSON: no markdown, no code fences, no comments, no text before or after the JSON.',
        '',
        'FIELDS',
        '1. "desc": ONE concise, natural English sentence describing the main hand activity.',
        '   - MUST start with a verb in -ing form, e.g. "Folding towels and stacking them on a shelf".',
        '   - Mention the main object(s) and EVERY main action, in the order they happen.',
        '   - Use generic object names; omit incidental visual modifiers such as size, color, shape or brand, even if visible.',
        '   - Keep modifiers only when they identify the workpiece or change the action (e.g. keep "excess plastic" when trimming it).',
        '   - Example: "Trimming excess plastic from a small green component using a knife" -> "Trimming excess plastic from component using a knife".',
        '   - Vietnamese input: translate it. English input: fix grammar and make it start with a V-ing verb.',
        '   - Keep the meaning; never invent actions or objects that are not in the input text/images.',
        '   - No trailing period. Do not mention the camera, frames, video, images or "the person".',
        '2. "act": activity slug derived from desc.',
        '   - Only lowercase a-z and 0-9, words joined by single hyphens "-". No spaces, underscores or other symbols.',
        '   - Format: <main-object>-<action1>-<action2>-... ; the main object comes first (1-2 words, singular noun).',
        '   - Include EVERY main action of desc in the same order, each as a gerund ending in "ing". Never use base verbs. No duplicates.',
        '   - Exclude tools, methods, articles, adjectives, locations and prepositions unless essential to identify the action.',
        '   - Examples: "Cutting carrots and putting them in a bowl" -> "carrot-cutting-putting";',
        '     "Wiping the kitchen counter with a cloth" -> "counter-wiping"; "Folding shirts and stacking them" -> "shirt-folding-stacking".',
        '3. "skill": EXACTLY one of these 18 values (copy the name exactly, without the number or the explanation):',
        ...SKILL_GROUPS.map((s, i) => `   ${i + 1}. ${s[0]} — ${s[1]}`),
        '   Choose by the main purpose of the work. If several fit, prefer the more specific group',
        '   (dishes -> "Dish Handling", not "Cleaning & Sanitation"; folding clothes -> "Clothing & Laundry", not "Packing & Bagging").',
        '4. "difficulty": exactly "Easy", "Medium" or "Hard".',
        '   - Easy: 1-2 simple, repetitive actions with light everyday objects; little precision; no tool or only a trivial one.',
        '   - Medium: several sequential steps, OR moderate precision, OR ordinary tool use (knife, screwdriver, iron), OR deformable objects (cloth, bags, dough).',
        '   - Hard: fine precision or dexterity (threading, soldering, small parts), skilled or powered tool use, heavy/awkward objects,',
        '     or long multi-step procedures with many object interactions.'
    ].join('\n');
    // ==================== CONFIG: AUTO-FILL ====================
    const CONFIG = {
        panelId: 'tb-helper-panel',
        segmentSelector: '',
        copyRequiresAllFields: true,
        activitySeparator: '_',
        maxObjectWords: 2,
        minL3Score: 18,
        delayBetweenEpisodes: 50,
        selectors: {
            description: [
                'textarea[data-testid="label-task-description"]',
                'textarea[name*="description" i]',
                'textarea[id*="description" i]'
            ],
            activity: [
                'input[data-testid*="activity" i]',
                'input[name*="activity" i]',
                'input[id*="activity" i]',
                'input[placeholder*="activity" i]'
            ],
            skillGroup: [
                'input[data-testid*="skill" i]',
                'input[name*="skill" i]',
                'input[id*="skill" i]',
                'input[placeholder*="skill" i]'
            ],
            scene: [
                'input[data-testid*="scene" i]',
                'input[data-testid*="environment" i]',
                'input[name*="scene" i]',
                'input[id*="scene" i]',
                'input[placeholder*="scene" i]',
                'input[placeholder*="environment" i]'
            ]
        }
    };
    const CACHE = { maxAgeDays: 30, maxEntries: 5000 };
    /* =====================================================================
     * 🚦 GROQ ENGINE: hàng đợi tuần tự + nhịp gọi chủ động + delay động
     *  - Mỗi request phải cách request trước ≥ gapMs (khởi điểm 1.5s)
     *  - Gặp 429: đọc Retry-After / thời gian retry trong phản hồi để chờ đúng,
     *    đồng thời tăng gapMs (x1.8) -> các request sau tự giãn ra, không bị 429 hàng loạt
     *  - Thành công: giảm dần gapMs (x0.85) về mức cơ bản
     *  - 5xx / lỗi mạng: lùi lũy thừa (2s, 4s, 8s...)
     *  - Hết quota NGÀY / sai API Key: dừng hẳn (GroqApiError)
     * ===================================================================== */
    const GROQ = {
        models: ['qwen/qwen3.8-27b'],
        endpoint: 'https://api.groq.com/openai/v1/chat/completions',
        baseGapMs: 1500,
        maxGapMs: 20000,
        gapUp: 1.8,
        gapDown: 0.85,
        maxAttempts: 6,
        default429Ms: 15000,
        maxBackoffMs: 90000,
        requestTimeoutMs: 120000,
        maxOutputTokens: 4096,
        batchSize: 15, // Fill All: số case text/ảnh tối đa trong một request kết hợp
        maxImagesPerRequest: 3, // Giới hạn Qwen vision; mỗi case ảnh dùng một contact sheet
        temperature: 0.2
    };
    const CLIPBOARD_KEY = 'tbHelperSegmentClipboard';
    const DIFFICULTY_NAMES = ['Easy', 'Medium', 'Hard'];
    /* =====================================================================
     * 🖼️ LẤY 4 FRAME CỦA SEGMENT -> AI VIẾT DESCRIPTION (khi Description đang trống)
     *  Thứ tự nguồn ảnh (1-3 chạy được cả khi tab ẩn / minimize):
     *   1) Vẽ trực tiếp video trên trang (nếu video không bị CORS "taint")
     *   2) Video đã tải ngầm vào RAM (Tampermonkey GM_xmlhttpRequest, tải 1 lần / video,
     *      dùng chung với 🚀 AI Auto-Cut)
     *   3) Quay chính tab Tbrain (getDisplayMedia) – CHỈ chạy khi tab đang hiện,
     *      tab ẩn thì tự tạm dừng và chờ bạn quay lại tab
     * ===================================================================== */
    const FILLDESC = {
        frames: 4, // số frame ghép thành contact sheet gửi Groq
        frameW: 448, // độ rộng ảnh
        jpegQ: 0.55, // chất lượng JPEG
        settleMs: 350, // chờ sau khi tua để frame hiện lên màn hình (chế độ quay tab)
        maxStartDiff: 3, // sai số (giây) khi tìm ảnh R2 có sẵn theo start
        useDownload: true // true: tải ngầm video vào RAM để lấy frame (chạy được khi tab ẩn)
    };
    /* ---------------------------------------------------------------------
     * AUTO CUT SEGMENTS
     * --------------------------------------------------------------------- */
    const AUTOCUT = {
        segLen: 30, // độ dài segment (khớp nút "New 30 s")
        gap: 0, // khoảng hở giữa 2 segment (đặt 3 nếu muốn giống 0:00, 0:33, 1:06)
        skipStep: 1, // nếu nút New đang disabled (đang trong segment cũ) thì nhảy tiếp 1s
        fps: 30, // phần "ff" của đồng hồ transport
        afterNewMs: 250 // chờ UI cập nhật sau mỗi lần cắt
    };
    /* =====================================================================
     * 🚀 AI CUT SUGGESTIONS: GM fetch -> Handtrack.js -> editable ranges preview
     * ===================================================================== */
    const AI = {
        sampleFps: 2, // 2 frame/giây (mỗi 0.5s)
        minScore: 0.6, // ngưỡng tin cậy của Handtrack
        minMove: 0, // 0 = chỉ cần thấy tay; >0 = tay phải dịch chuyển (tỉ lệ khung hình, vd 0.01)
        mergeGap: 5, // 2 đoạn có tay cách nhau < 5s thì merge thành 1 segment
        minLen: 30, // chỉ lấy segment có thời gian chuyển động tay >= 30s
        maxLen: 600, // ... và < 10 phút (600s)
        autoFillAfterDesc: true, // (v19) không cần nữa: mỗi segment được điền đủ 4 ô trong 1 lần gọi AI
        descModels: ['qwen/qwen3.8-27b'],
        pad: 0.5, // nới mỗi đầu đoạn 0.5s
        seekTimeoutMs: 3000,
        captureRate: 4 // chế độ quay tab: phát video x4 rồi quét (video 36 phút ≈ 9 phút quét)
    };
    const AUTOCUT_NUDGE = false; // true: nếu nút New bị disabled thì nhích từng 1s tìm chỗ trống (start sẽ bị lệch)
    return {
        get AI() { return AI; },
        get AUTOCUT() { return AUTOCUT; },
        get SKILL_NAMES() { return SKILL_NAMES; },
        get DIFFICULTIES() { return DIFFICULTIES; },
        get PROJECT_ID() { return PROJECT_ID; },
        get POLL_INTERVAL() { return POLL_INTERVAL; },
        set POLL_INTERVAL(value) { POLL_INTERVAL = value; },
        get MIN_DURATION_SECONDS() { return MIN_DURATION_SECONDS; },
        set MIN_DURATION_SECONDS(value) { MIN_DURATION_SECONDS = value; },
        get L1_EXCEPT() { return L1_EXCEPT; },
        set L1_EXCEPT(value) { L1_EXCEPT = String(value == null ? '' : value); },
        get L1_EXCEPT_STORAGE_KEY() { return L1_EXCEPT_STORAGE_KEY; },
        get DEFAULT_L1_EXCEPT() { return DEFAULT_L1_EXCEPT; },
        get GROQ() { return GROQ; },
        get PANEL() { return PANEL; },
        get CACHE() { return CACHE; },
        get TOKEN_STORAGE_KEY() { return TOKEN_STORAGE_KEY; },
        get GROQ_API_KEY() { return GROQ_API_KEY; },
        get DEFAULT_SKILL() { return DEFAULT_SKILL; },
        get PROMPT_RULES() { return PROMPT_RULES; },
        get CONFIG() { return CONFIG; },
        get DIFFICULTY_NAMES() { return DIFFICULTY_NAMES; },
        get FILLDESC() { return FILLDESC; },
        get CLIPBOARD_KEY() { return CLIPBOARD_KEY; },
        get CLICK_URL() { return CLICK_URL; },
        get PERF_LOG() { return PERF_LOG; },
        get RATE_LIMIT_FALLBACK_WAIT() { return RATE_LIMIT_FALLBACK_WAIT; },
        get RATE_LIMIT_SAFETY_MS() { return RATE_LIMIT_SAFETY_MS; },
        get MIN_SAFE_POLL_INTERVAL() { return MIN_SAFE_POLL_INTERVAL; },
        get REQUEST_TIMEOUT() { return REQUEST_TIMEOUT; },
        get API_URL() { return API_URL; },
        get API_BASE() { return API_BASE; },
        get STATS_API_URL() { return STATS_API_URL; },
        get EXTRA_HOURS_API_URL() { return EXTRA_HOURS_API_URL; },
        get EARNINGS_RATE_VND_PER_HOUR() { return EARNINGS_RATE_VND_PER_HOUR; },
        get TOKEN_RETRY_INTERVAL() { return TOKEN_RETRY_INTERVAL; },
        get AUTO_ACQUIRE() { return AUTO_ACQUIRE; }
    };
};
