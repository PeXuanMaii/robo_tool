# Flow và kỹ thuật theo component

Tài liệu này mô tả luồng dữ liệu, trách nhiệm module và các invariant cần giữ khi sửa code. Hướng dẫn thao tác nằm trong [USER_MANUAL.md](USER_MANUAL.md); tổng quan project ở [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md).

## Luồng khởi động chung

```text
userscript.header.txt
    → build.cjs ghép factory trong src/ theo manifest.json
    → tạo bundle .user.js
    → module registry được tạo
    → các init hook chạy
    → bootstrap.start()
    → UI refresh, trạng thái Fetch, thu nhập và notifications
```

`manifest.json` là nguồn chuẩn cho danh sách module, dependency, thứ tự tạo và module có `init()`. `bootstrap.js` tạo các refresh job có tên cho panel, controls, R2 và QC; khôi phục trạng thái Fetch đã lưu trước khi bắt đầu polling.

## Flow theo component

| Component | Flow | Kỹ thuật và module |
|---|---|---|
| Nền tảng và startup | Header/metadata → module factory → init → bootstrap. | `environment`, `config`, `runtime`, `storage`, `bootstrap`; state được giữ trong closure và dùng accessor khi cần chia sẻ giá trị mutable. |
| UI và log | Tìm header của task đang chỉnh sửa → mount panel/controls → xử lý click, input và shortcut → log vào Console. | `panel`, `controls`, `status`, `logger`; ẩn các nút chỉnh sửa trong view Submitted/Delivered chỉ đọc, giữ ổn định DOM ID và vị trí mount. |
| Fetch Task và thu nhập | Controls → task monitor/auth → task pool → lọc/acquire → notification; earnings → stats/extra-hours → tổng tiền, tổng theo ngày và timeline. | `auth`, `taskMonitor`, `notifications`, `earnings`; ngày được tính theo lịch địa phương từ dữ liệu có timestamp/ngày, giữ số hợp lệ gần nhất nếu API lỗi. |
| Annotation | Fill → đọc context/segment → cache hoặc Groq + ví dụ Pass liên quan → validate kết quả → ghi field vào UI. | `fill`, `annotationDom`, `gemini` (Groq provider), `storage`; examples được người dùng chọn, lưu text cục bộ và tối đa 3 ví dụ được thêm vào mỗi prompt phù hợp. |
| R2 suggestions | Mở video/chọn preset → scanner → dán JSON hoặc nhấn Q/W → preview vàng chỉ đọc → chọn ranges → xác nhận áp dụng hoặc hủy; không cần segment để preview và không sửa annotation. | `r2Scanner`, `r2Bridge`, `autoCut`, `timeline`; scan/video identity và preset được gắn với kết quả, range overlap bị từ chối, thao tác tạo/trim chỉ chạy sau xác nhận và kiểm tra task/video context. |
| QC | Kiểm tra eligibility → đọc feedback/history → map theo segment → Groq + contact sheet 4 frame → duyệt → backup, ghi field/read-back → Undo batch gần nhất có guard. | `qcStore`, `qcDomain`, `qcApi`, `qcController`, `qcView`, `qcLifecycle`; chỉ cho phép field trong allowlist, xác nhận task/feedback còn đúng, rollback có kiểm tra server state và không Submit task. |

## Chi tiết kỹ thuật

### Nền tảng, cấu hình và startup

- `environment.js`: chọn cầu nối `window`/`unsafeWindow`.
- `config.js`: API URL, selector/DOM ID, prompt/schema, ngưỡng và mặc định.
- `runtime.js`: timer nền, sleep, trạng thái visibility và quản lý background job.
- `storage.js`: localStorage, IndexedDB, cache AI/video/ranges, Groq key, examples Pass và clipboard annotation.
- `bootstrap.js`: khởi động một lần, mount/refresh UI và bắt đầu Fetch, earnings, notifications.
- `manifest.json`: khai báo module factory, dependency và init hook; không tự suy dependency từ thứ tự file.
- `build.cjs`: xác thực cú pháp bundle và ghi `tbrain_tool_for_labeler.user.js`.

### UI và controls

- `panel.js` mount toolbar vào header task có trạng thái Claimed/Rework; không mount vào màn hình Submitted/Delivered chỉ đọc.
- `controls.js` mount Fetch Task, notification, API Key và hai ô polling trên header; nếu thiếu header theme thì dùng hàng Fetch của panel. Trên mobile chỉ hiện Fetch/notification/settings; ẩn API key, earnings và các hàng công cụ khác.
- `status.js` quản lý trạng thái UI QC; `logger.js` gửi log ra browser Console.
- Các nút automation cần giữ DOM ID/ARIA contract tương ứng; shortcut Fill/Speed nằm ở `controls`, shortcut Q/W cho vùng gợi ý nằm ở `r2Bridge` và không chạy khi người dùng đang nhập liệu.

### Fetch Task và earnings

```text
Fetch ON → taskMonitor.tick()
          → auth tìm token
          → GET task pool
          → lọc duration và task đã thấy
          → acquire task phù hợp
          → notification
```

- `taskMonitor.js` đọc rate-limit headers, chờ khi gặp 429 và chọn poll interval không thấp hơn `MIN_SAFE_POLL_INTERVAL`.
- `auth.js` tìm session token và cung cấp original fetch cho request của userscript.
- `notifications.js` yêu cầu quyền từ nút bấm, ưu tiên `GM_notification`/`GM.notification`, rồi dùng browser Notification hoặc service-worker registration nếu có.
- `controls.js` gọi `taskMonitor.wake()` khi tab hiện lại hoặc phát `pageshow`, để poll lại ngay sau khi trình duyệt khôi phục.
- Worker timer và Web Lock chỉ best-effort; trình duyệt/Android vẫn có thể throttle, suspend hoặc terminate tab. Push khi Kiwi đã đóng cần service worker và hạ tầng push ngoài userscript.
- `earnings.js` gọi hai endpoint stats/extra-hours cùng session. Badge tổng cộng toàn bộ thời gian; badge hôm nay ưu tiên dữ liệu có ngày từ API, nếu thiếu thì cộng chênh lệch của tổng tích lũy vào bộ đếm localStorage theo ngày địa phương. Badge tạm tính có dấu `~` và ghi rõ mốc bắt đầu, nên không tính lùi dữ liệu trước lần theo dõi đầu tiên. Tổng refresh mỗi 30 giây; badge task đọc timeline mỗi giây.

### Annotation và Groq

```text
Fill 1/Fill All
    → annotationDom đọc segment và field
    → fill tạo input text hoặc frame context
    → storage kiểm tra cache
    → Groq Chat Completions phân tích nếu cache miss
    → annotationDom ghi các field hợp lệ
```

- `annotationDom.js` là adapter duy nhất cho việc đọc/ghi input, combobox và React-backed fields.
- `fill.js` điều phối Fill 1, Fill All, Fill L3 All và copy/paste; state loop được giữ riêng theo module.
- `gemini.js` là tên file/module legacy nhưng hiện quản lý Groq Chat Completions, key Bearer, queue tuần tự, retry/backoff, JSON mode, parse và kiểm tra output.
- Người dùng có thể lưu task Pass đã xác minh làm text example; Groq chỉ nhận tối đa 3 ví dụ gần input, không có huấn luyện/fine-tuning model.
- Description có nội dung dùng text; Description trống lấy 4 frame qua `media`, ghép thành contact sheet rồi gửi Groq. Fill All giới hạn tối đa 3 case ảnh/request, trong khi text case vẫn có thể được batch đến 15 case/request.
- QC cũng ghép 4 frame thành một contact sheet để tuân thủ giới hạn ảnh của model. Model mặc định là `qwen/qwen3.8-27b`; request dùng JSON mode và ảnh base64 qua `image_url`.

### Video suggestions và timeline

```text
Mở video/chọn preset → R2 Scanner dùng Handtrack nhận ranges
                    → Dán gợi ý → preview vàng chỉ đọc trên timeline/player
                    → Chọn ranges → xác nhận → tạo/điều chỉnh segment mới
                    → Hủy gợi ý để xóa preview (không undo segment đã áp dụng)
```

- `r2Scanner.js` chạy Handtrack trên tab R2 và copy JSON có scan ID, fingerprint video, thời lượng và preset; không gửi URL video thô trong metadata.
- `r2Bridge.js` hiển thị preset và review list; preview mặc định không chọn range nào. Chỉ khi người dùng chọn, xác nhận, và không có overlap, bridge mới gọi thao tác timeline.
- `autoCut.js` xác thực ranges theo duration, quản lý ngữ cảnh/vòng đời gợi ý; không tự tạo/trim segment.
- `timeline.js` căn overlay vàng từ thời điểm bắt đầu và tỷ lệ pixel/giây; thao tác apply được guard theo task/video, tạo segment mới, chỉnh đúng độ dài và xác minh kết quả. Segment hiện có không bị sửa.
- Nếu context đổi hoặc thao tác thất bại giữa chừng, apply dừng, hiển thị lỗi/range cần kiểm tra; userscript không tự undo. Dùng Undo gốc của Tbrain sau khi xác minh timeline.
- Trước khi sửa ngưỡng hoặc thuật toán cắt, kiểm tra `config.js`, regression fixtures và các thao tác timeline liên quan.

### QC

```text
qcView mount
    → qcController refreshEligibility
    → task/submission/history qua qcApi
    → qcDomain trích feedback và segment scope
    → CheckQC tạo mappings từ labels + 4 frame
    → người dùng duyệt
    → FixQC kiểm tra lại version/labels, backup theo batch, ghi field, read-back
    → Undo kiểm tra task/submission/episode và current labels trước khi khôi phục/read-back
```

- `qcStore.js` giữ state workflow; state được cô lập theo app instance.
- `qcDomain.js` chuẩn hóa feedback, scope, field allowlist và mapping validation.
- `qcApi.js` thực hiện request QC bằng session hiện tại.
- `qcController.js` bảo vệ task identity, chặn xung đột với Fill/Auto-Cut, kiểm tra eligibility, điều phối CheckQC/FixQC và cung cấp console commands để lưu/list/xóa ví dụ Pass.
- `qcView.js` chỉ hiện CheckQC/FixQC cho task có feedback rework; Undo FixQC hiện khi có backup phù hợp, kể cả sau khi feedback rework không còn active. Detail log nằm trong Console.
- `qcLifecycle.js` quản lý lifecycle/diagnostic của workflow QC.
- FixQC chỉ ghi field được duyệt và đủ điều kiện; lưu backup theo batch trước khi ghi, sau đó read-back từ server. Undo chỉ khôi phục khi mọi field hiện tại khớp giá trị trước FixQC hoặc giá trị do batch đó ghi; khác biệt ngoài dự kiến sẽ chặn rollback. Không tự Submit task.

## Quy ước bảo trì

1. Mỗi module là factory nhận `modules`; API liên module phải được export trong object `return`.
2. Giữ state nội bộ trong closure. Dùng getter/setter accessor cho binding mutable; không giữ primitive mutable bằng destructuring.
3. Đăng ký hook trong `init()` sau khi các factory được tạo. Truy cập dependency vòng qua callback/lifecycle, không gọi workflow từ constructor.
4. Giữ ổn định API contract, DOM ID, storage key, schema annotation và scanner payload nếu không có yêu cầu nghiệp vụ.
5. Sửa source trong `src/`, sau đó chạy `npm test` và `npm run build`; không chỉnh tay bundle đã tạo.

## Kiểm thử

`tests/` chạy offline bằng browser doubles và fixture; không gọi API thật hoặc dùng token thật. Chúng bao phủ dependency/export, regression, UI mount, queue, startup và bundle syntax. Thay đổi DOM/React, screen sharing, Tbrain API hoặc request Groq thật vẫn cần kiểm tra thủ công trên môi trường phù hợp.
