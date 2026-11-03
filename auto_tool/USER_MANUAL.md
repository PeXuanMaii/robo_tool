# Hướng dẫn sử dụng — tbrain_tool_for_labeler

Tài liệu này hướng dẫn cài đặt và sử dụng userscript. Tổng quan dự án ở [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md), lịch sử phiên bản ở [CHANGELOG.md](CHANGELOG.md), flow và chi tiết module ở [COMPONENT_FLOW_TECH.md](COMPONENT_FLOW_TECH.md).

## Yêu cầu

- Chrome, Edge, Brave hoặc trình duyệt Chromium tương thích.
- Tampermonkey hoặc Violentmonkey.
- Kiwi Browser trên Android với một userscript manager tương thích.
- Groq API key cho các chức năng AI.

## Cài đặt

1. Tắt các userscript Tbrain cũ có chức năng trùng lặp để tránh chạy song song.
2. Mở `tbrain_tool_for_labeler.user.js` trong trình quản lý userscript hoặc tạo script mới và dán toàn bộ nội dung file.
3. Lưu, bật script rồi tải lại trang `https://*.tbrain.ai/*`.
4. Thử trên một task trước; kiểm tra segment và annotation trước khi sử dụng trên nhiều task.

Userscript tải Handtrack.js từ jsDelivr. Các chức năng tương ứng cần kết nối tới Tbrain API, `api.groq.com` và CDN này. Userscript manager nên hỗ trợ `GM_xmlhttpRequest` để gửi request cross-origin ổn định.

## Cấu hình ban đầu

### Groq API key

Trên desktop, chọn **🔑 Key** trên header, dán Groq API key rồi bấm **Lưu**. Nút này được ẩn trên điện thoại. Key được lưu trong `localStorage` của trình duyệt dưới khóa `tb_groq_api_key_custom`; Gemini API key cũ không dùng được với Groq. Không đưa key vào file tài liệu, chia sẻ bundle có key hoặc commit vào source.

### Thông báo

Bấm **🔔 Bật Noti** trên thanh Fetch Task để yêu cầu quyền từ thao tác người dùng. Nếu userscript manager hỗ trợ `GM_notification`, tool dùng API notification của manager; nếu không, tool dùng notification của trình duyệt. Khi quyền bị chặn, bật lại trong cài đặt thông báo của trang/trình duyệt và Android.

## Vị trí điều khiển

| Vị trí | Điều khiển |
|---|---|
| Header trang, cạnh nút đổi theme | Desktop: Fetch Task, notification, API Key và badge tiền. Điện thoại: chỉ Fetch Task, notification và cài đặt Fetch. |
| Cùng cụm Fetch Task khi đang ON | Poll interval và Min Duration; hai ô tự đổi độ rộng theo nội dung nhập (56–160 px), vẫn nằm ngang và có thể xuống hàng trên màn hình hẹp. Khi Fetch OFF, hai ô được ẩn. |
| Header của task **Claimed/Rework** | Desktop: Fill, Fill L3 All, Copy/Paste/Paste All, **Mở video**, **Dán gợi ý**, **Hủy gợi ý**, QC và Cache. Các tool này ẩn trên điện thoại. |
| Developer Tools → **Console** | Log tiến trình, lỗi, feedback QC và các lệnh debug. |

## Fetch Task

- **Fetch Task: ON/OFF** bật hoặc dừng polling.
- **Poll interval** nhập bằng mili giây; mặc định `2000`. Bộ lập lịch áp dụng mức sàn an toàn `2500 ms`, nên không poll nhanh hơn mức này.
- **Min Duration** nhập bằng giây; mặc định `7200` giây (2 giờ). Task phải vượt ngưỡng này mới đủ điều kiện.
- Trạng thái Fetch và các giá trị cấu hình được lưu trong trình duyệt, nên vẫn còn sau khi tải lại trang.
- Khi Fetch bật, userscript có thể tự nhận task phù hợp và gửi notification. Khi trang quay lại foreground hoặc được khôi phục, tool chạy một lượt poll ngay.
- Worker timer và Web Lock chỉ hỗ trợ best-effort; chúng không thể ngăn Kiwi/Android đình chỉ hoặc kết thúc tab.
- Trên điện thoại, UI userscript chỉ hiển thị cụm Fetch Task (kèm notification và cài đặt Fetch); các nút Fill, R2, QC, Cache, earnings và API key được ẩn.

### Kiwi Browser trên Android

- Dùng nút **🔔 Bật Noti** khi trang Tbrain đang mở, rồi cho phép notification trong Kiwi/userscript manager và cài đặt notification của Android.
- Bật Fetch Task và để tab Tbrain mở. Cho phép Kiwi hoạt động nền/không bị giới hạn pin nếu thiết bị có tùy chọn đó.
- Android có thể dừng polling khi khóa màn hình, đóng Kiwi hoặc thu hồi tiến trình. Polling sẽ tiếp tục và chạy ngay khi tab được mở/khôi phục; userscript không thể bảo đảm chạy hoặc gửi push khi Kiwi đã bị hệ điều hành dừng.
- Các thao tác cần Developer Tools/Console (ví dụ chạy R2 scanner) vẫn cần môi trường có Console; phần mobile hiện tập trung vào Fetch Task, notification và controls responsive.

## Điền nhãn

- **Fill 1**: phân tích segment hiện tại. Nếu Description trống, Groq nhận một contact sheet gồm 4 frame mẫu và ngữ cảnh; nếu có text, Groq dịch Description tiếng Việt hoặc kiểm tra/chuẩn hóa Description tiếng Anh.
- **Fill All**: tạo một danh sách case có thứ tự, trộn Description text và case ảnh trong cùng request Groq (tối đa 15 case/request và tối đa 3 case ảnh/request). Bốn frame của mỗi case được ghép thành một contact sheet. Case trùng input/ngữ cảnh dùng chung một kết quả cache.
- **Stop/Resume Fill All**: nút dừng giữ tiến độ và kết quả batch đang chạy trong tab hiện tại; bấm lại để tiếp tục hoặc thử lại case lỗi. Nếu reload trang, cache vẫn giữ kết quả AI đã nhận. Nếu task/video đổi, phiên cũ bị hủy để tránh ghi nhầm.
- Fill chỉ cập nhật Activity, Skill Group, Difficulty và L3 khi các ô đó còn trống; Description được dịch/chuẩn hóa theo yêu cầu. Nếu người dùng sửa Description hoặc ngữ cảnh trong lúc AI chạy, case đó được bỏ qua.
- Description tập trung vào hành động và tên đối tượng chung; bỏ chi tiết ngoại hình không cần thiết như màu sắc/kích thước. Ví dụ: `Trimming excess plastic from a small green component using a knife` → `Trimming excess plastic from component using a knife`.
- **Fill L3 All**: áp dụng giá trị trong ô L3 cho toàn bộ segment.
- **Copy / Paste**: sao chép annotation của segment đang chọn và dán vào segment hiện tại.
- **Paste All**: dán các trường không trống đã Copy lên tất cả segment sau khi xác nhận. Trường được copy sẽ ghi đè nội dung hiện có; có thể bấm nút lần nữa để dừng.

Model mặc định là `qwen/qwen3.8-27b` qua Groq Chat Completions. Groq có thể nhận tiêu đề/hướng dẫn task đang hiển thị, L3, Description và contact sheet 4 frame của segment. Chỉ chạy nếu nội dung task được phép gửi tới Groq. Kiểm tra nội dung được điền, đặc biệt Description, Activity, Skill Group và Difficulty, trước khi gửi task.

Request dùng [Groq API reference](https://console.groq.com/docs/api-reference#) và [tài liệu model Qwen 3.8 27B](https://console.groq.com/docs/model/qwen/qwen3.8-27b); model hỗ trợ tối đa 3 ảnh mỗi request, vì vậy Fill All giới hạn case ảnh theo mức này.

## Gợi ý ranges bằng R2

Thanh công cụ chỉ xuất hiện trong task còn chỉnh sửa được (**Claimed/Rework**), không xuất hiện trong view **Submitted/Delivered** chỉ đọc. Có các nút **Mở video**, **Dán gợi ý**, **Hủy gợi ý** và preset độ nhạy; không còn nút hoặc phím tắt chạy AI Auto-Cut.

1. Chọn preset trước khi bấm **Mở video**: **Cân bằng** giữ cấu hình mặc định, **Nhạy hơn** quét dày/giữ đoạn ngắn nhưng có thể chậm và nhiễu hơn, **Ít nhiễu** lọc chặt hơn nhưng có thể bỏ sót.
2. Bấm **Mở video** để mở video của task trên R2 và sao chép scanner đã gắn với video/preset hiện tại.
3. Trong tab R2, mở Developer Tools (`F12`) → **Console**, dán scanner (`Ctrl+V`) và chạy. Lần đầu Console có thể yêu cầu gõ `allow pasting`.
4. Quay lại Tbrain, bấm **Dán gợi ý**. Không cần tạo segment trước. Các khoảng hợp lệ được tô vàng và gắn với task/video đang mở; kết quả cũ hoặc không khớp video sẽ bị từ chối/cảnh báo.
5. Preview mặc định chỉ đọc: không có khoảng nào được chọn và chưa thay đổi segment. Dùng danh sách review để tua đến đầu/cuối hoặc phát lặp; checkbox hoặc **Chọn tất cả** để chọn các khoảng muốn áp dụng.
6. Bấm **Áp dụng đã chọn** rồi xác nhận. Userscript chỉ tạo segment mới cho các khoảng đã chọn; nếu bất kỳ khoảng nào chồng lấn segment hiện có thì cả batch bị từ chối trước khi thay đổi. Segment cũ không bị chỉnh sửa.
7. Kiểm tra timeline sau khi áp dụng. Nếu thao tác thất bại hoặc bị dừng, range cuối có thể chưa hoàn tất; review cảnh báo và cần kiểm tra thủ công. Dùng Undo gốc của Tbrain để hoàn tác segment đã tạo nếu cần. **Hủy gợi ý** chỉ xóa preview, không undo segment.

Các vùng tạo bằng Q/W cũng dùng chung danh sách review và luồng áp dụng tường minh này. Dùng Fill riêng nếu cần điền annotation.

### Dùng task Pass làm ví dụ cho Groq

1. Chỉ trên task bạn đã xác nhận là **Pass**, mở Developer Tools → **Console** và chạy `tbLearnPassCase()`.
2. Xác nhận hộp thoại để lưu labels và thời gian segment vào IndexedDB cục bộ. Userscript không tự kiểm tra trạng thái Pass; bạn chịu trách nhiệm chọn đúng task.
3. Tối đa 3 ví dụ có nội dung gần với input hiện tại được thêm vào request Groq kế tiếp để hướng dẫn phong cách/nhãn. Chúng không phải bằng chứng cho task hiện tại và không tự huấn luyện hay fine-tune Groq/Handtrack.
4. Không lưu nội dung bạn không được phép gửi tới Groq: các ví dụ phù hợp có thể được gửi cùng prompt với request Groq. Không lưu ảnh/video; ví dụ chỉ giữ text labels và thời gian segment.

## Thu nhập

- **💰 Tổng tiền** cộng `labelledSeconds` từ `my-stats` với `seconds` trong `extra-hours`, quy đổi theo mức `50.000 đ/giờ`. Dữ liệu được làm mới khi khởi động và mỗi 30 giây.
- **📅 Hôm nay** dùng breakdown theo ngày nếu API có. Nếu API chỉ trả tổng tích lũy hoặc extra-hours thiếu ngày, userscript lưu snapshot cục bộ và cộng phần tăng mới theo ngày; số tạm tính có dấu `~`, tooltip ghi mốc bắt đầu theo dõi và không tính lùi dữ liệu trước mốc đó.
- **🎯 Task** tính từ phần thời gian đã record trước dấu `/` trong timeline, cập nhật mỗi giây. Khi chưa đọc được thời lượng, badge hiển thị `—`.
- Nếu API lỗi, tổng tiền hợp lệ gần nhất được giữ lại; tooltip hiển thị lỗi gần nhất thay vì thay bằng số 0.

## Kiểm tra QC

1. Khu vực QC chỉ xuất hiện khi task hiện tại có feedback rework.
2. Chọn **CheckQC** để đọc feedback, đối chiếu nhãn và phân tích bằng Groq với contact sheet 4 frame mẫu.
3. Xem từng đề xuất field/value và lý do. Chỉ đánh dấu duyệt những thay đổi phù hợp.
4. Chọn **FixQC** để áp dụng các thay đổi đã duyệt. Userscript kiểm tra lại task, feedback và dữ liệu trước/sau khi ghi; không Submit task.
5. **Undo FixQC** chỉ hiện khi có backup. Nút khôi phục batch FixQC gần nhất sau khi xác nhận task/submission/segment còn đúng và các field chưa bị thay đổi ngoài các giá trị đã lưu; nếu có khác biệt, thao tác bị từ chối để tránh ghi đè. Backup được giữ nếu khôi phục chưa xác nhận và tuân theo thời hạn cache đã cấu hình.

Feedback gốc, đề xuất chi tiết, lỗi và tiến trình được ghi vào Console. Bốn frame là ảnh mẫu, không xác minh được toàn bộ chuyển động hoặc yêu cầu timing/split/merge.

## Phím tắt

Các phím tắt Fill/Paste không hoạt động khi con trỏ đang ở input/textarea, ngoại trừ ô L3.

| Phím | Thao tác |
|---|---|
| `!` | Fill 1 |
| `@` | Fill All |
| `#` | Fill L3 All |
| `$` | Paste |
| `%` | Paste All |
| `Q` | Ghi điểm bắt đầu của vùng gợi ý tiếp theo tại vị trí video hiện tại |
| `W` | Lấy vị trí hiện tại làm điểm kết thúc và thêm vùng `[Q, W]` màu vàng vào timeline |
| Giữ `Ctrl` + `Shift trái` | Tạm phát video tối đa 16×; nếu trình duyệt không hỗ trợ, userscript dùng mức nhanh thấp hơn được hỗ trợ. Nhả một trong hai phím để khôi phục tốc độ đã chọn. |

Q/W không cần có segment, nhưng cần video đã load và không hoạt động khi đang nhập trong input, textarea, select hoặc vùng contenteditable. Mỗi cặp Q rồi W thêm một vùng; lặp lại để tạo nhiều vùng không chồng lấn. Danh sách review cho phép tua đầu/cuối và lặp từng vùng. Khi chưa có segment, vùng vàng dùng thời lượng video làm thước đo. Vùng Q/W mặc định chỉ là preview; chọn checkbox rồi bấm **Áp dụng đã chọn** và xác nhận nếu muốn tạo segment mới. Bấm **Hủy gợi ý** để dừng loop và xóa preview.

Nếu chuyển tab hoặc cửa sổ mất focus, tốc độ video cũng được khôi phục.

## Console và xử lý sự cố

Mở Developer Tools (`F12`) → **Console** để xem log và chạy lệnh:

| Lệnh | Tác dụng |
|---|---|
| `tbClearCache()` | Xóa cache AI; không xóa backup Undo FixQC. |
| `tbFreeVideo()` | Giải phóng video blob đang giữ trong bộ nhớ. |
| `tbAutoCutDebug()` | In thông tin hỗ trợ chẩn đoán Auto-Cut. |
| `tbGroqStats()` | Xem thống kê request Groq và model đang dùng. |
| `tbQCMappingReport()` | Xuất trạng thái mapping QC và backup. |
| `tbLearnPassCase()` | Xác nhận và lưu annotation của task Pass hiện tại làm ví dụ few-shot cục bộ. |
| `tbListPassCases()` | Liệt kê task/submission và số segment trong kho ví dụ Pass. |
| `tbClearPassCases()` | Xác nhận xóa toàn bộ ví dụ Pass; `tbClearCache()` không xóa chúng. |

Nếu nút không xuất hiện, kiểm tra userscript đã bật và trang đã tải lại. Nếu QC bị ẩn, task có thể không có feedback rework hoặc trạng thái chưa xác định được; xem Console để biết lỗi API. Nếu có vấn đề trong lúc automation chạy, dừng luồng và kiểm tra task hiện tại trước khi tiếp tục.
