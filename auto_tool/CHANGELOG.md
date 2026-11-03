# Changelog

Ghi thay đổi theo phiên bản, phiên bản mới nhất đặt trước. Khi phát hành thay đổi, cập nhật version đồng bộ trong `package.json`, `manifest.json` và `userscript.header.txt`, rồi build lại userscript.

## [24.0.12] - 2026-10-31

### Changed

- Chuyển Fill, Fill All và QC từ Gemini sang Groq Chat Completions với model `qwen/qwen3.8-27b`, JSON mode và API key lưu riêng.
- Ghép 4 frame thành contact sheet; giới hạn tối đa 3 case ảnh mỗi request Groq để tuân thủ vision image cap.
- Dùng `GM_xmlhttpRequest` cho request cross-origin; cập nhật giao diện cấu hình key, tài liệu và thống kê `tbGroqStats()`.
- Đồng bộ version `24.0.12` trong source và bundle.

## [24.0.11] - 2026-10-31

### Added

- Thêm **Paste All** để dán các trường annotation đã Copy lên mọi segment, có xác nhận ghi đè, phím tắt `%` và nút dừng.

### Changed

- Đồng bộ version `24.0.11` trong source và bundle.

## [24.0.10] - 2026-10-31

### Fixed

- Sửa badge **Hôm nay** khi `my-stats` chỉ trả tổng tích lũy: lưu snapshot cục bộ và cộng phần tăng theo ngày, giữ dữ liệu qua lần tải lại.
- Khi API không có dữ liệu ngày, đánh dấu số tiền tạm tính bằng `~` và tooltip nêu rõ thời điểm bắt đầu theo dõi; không tính lùi phần trước thời điểm đó.

### Changed

- Đồng bộ version `24.0.10` trong source và bundle.

## [24.0.9] - 2026-10-31

### Added

- Thêm badge thu nhập **Hôm nay**, cộng thống kê task và extra-hours khớp ngày hiện tại theo giờ địa phương; không dùng tổng tích lũy thay cho dữ liệu thiếu ngày.

### Changed

- Đồng bộ version `24.0.9` trong source và bundle.

## [24.0.8] - 2026-10-31

### Changed

- Chuẩn hóa Description Gemini để bỏ màu sắc/kích thước và các chi tiết ngoại hình không cần thiết, giữ hành động cùng đối tượng chính.
- Đồng bộ version `24.0.8` trong source và bundle.

## [24.0.7] - 2026-10-31

### Added

- Thêm preset độ nhạy R2 **Cân bằng**, **Nhạy hơn**, **Ít nhiễu**; kết quả scanner được gắn scan ID và fingerprint để phát hiện nhầm video.
- Tách preview R2/QW khỏi thao tác timeline: range mặc định chưa chọn; chỉ tạo segment mới sau khi chọn range và xác nhận.

### Changed

- Từ chối apply nếu range chồng lấn segment hiện có; guard thao tác timeline theo task/video và hiển thị cảnh báo nếu dừng/thất bại giữa chừng.
- Đồng bộ version `24.0.7` trong source và bundle.

## [24.0.6] - 2026-10-31

### Added

- Thêm danh sách review ranges R2/QW với timecode `HH:MM:SS`, nút seek đầu/cuối và phát lặp từng khoảng; hủy gợi ý sẽ dừng loop.

### Changed

- Dừng loop và xóa gợi ý cũ khi task/video đổi; đồng bộ version `24.0.6` trong source và bundle.

## [24.0.5] - 2026-10-30

### Changed

- Dán gợi ý R2 và phím Q/W không còn yêu cầu segment; khi chưa có segment, vùng gợi ý được căn theo thời lượng video và hiển thị trên player.
- Giữ nguyên chế độ preview: không tự tạo hoặc chỉnh segment thật.
- Đồng bộ version `24.0.5` trong source và bundle.

## [24.0.4] - 2026-10-30

### Added

- Fill All gom Description tiếng Việt/tiếng Anh và case Description trống có 4 frame thành danh sách to-do theo index; mỗi request xử lý tối đa 15 case hỗn hợp.
- Fill All giữ tiến độ và kết quả batch trong tab hiện tại để có thể dừng/tiếp tục; case lỗi được thử lại trong lần tiếp tục sau.

### Changed

- Bổ sung tiêu đề/hướng dẫn task đang hiển thị và L3 làm ngữ cảnh cho Gemini; cache phân biệt theo nội dung và ngữ cảnh.
- Fill chỉ điền Activity, Skill Group, Difficulty và L3 còn trống; trước khi ghi, kiểm tra lại task, video, segment, Description và ngữ cảnh.
- Đồng bộ version `24.0.4` trong source và bundle.

## [24.0.3] - 2026-10-30

### Changed

- Mỗi cặp Q/W thêm một vùng gợi ý vào các vùng đang hiển thị; có thể lặp lại để tạo nhiều vùng và hủy tất cả bằng nút **Hủy gợi ý**.

## [24.0.2] - 2026-10-30

### Added

- Nhấn `Q` để đánh dấu thời điểm bắt đầu và `W` để tô vùng gợi ý tương ứng trên timeline; cần có ít nhất một segment, không sửa segment thật.

### Changed

- Bỏ qua shortcut Q/W khi đang nhập liệu; thông báo rõ nếu chưa có segment, điểm kết thúc không hợp lệ hoặc video đã thay đổi.

## [24.0.1] - 2026-10-30

### Added

- Hỗ trợ notification qua userscript manager hoặc browser; polling được kích hoạt lại khi tab hiện lại/được khôi phục.
- Ghi rõ giới hạn chạy nền trên Kiwi/Android: userscript không bảo đảm chạy khi browser bị hệ điều hành đình chỉ hoặc đóng.

### Changed

- UI trên điện thoại chỉ giữ Fetch Task, notification và cài đặt Fetch; ẩn API key, earnings và các công cụ khác.
- Tốc độ phát video khi giữ Ctrl + Shift trái giới hạn tối đa 16×.

### Fixed

- Sửa CSS Fetch Task bị tràn/chồng trên mobile.
- Yêu cầu có ít nhất một segment trước khi dán gợi ý R2; nếu chưa có, báo cách khắc phục trước khi đọc clipboard.
