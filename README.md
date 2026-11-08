# HR Nguyễn Tuấn Hảo – bản đồng bộ PostgreSQL (đã sửa)

## Đã sửa trong bản này
- Một cơ sở dữ liệu PostgreSQL dùng chung cho tất cả thiết bị và trình duyệt.
- Tự động tải dữ liệu từ máy chủ trước khi giao diện khởi động.
- Tự lưu thay đổi lên máy chủ cho lịch phân ca, yêu cầu đổi ca/nhờ làm thay, thiết lập lương và dữ liệu chấm công có trong mã nguồn.
- Tự kiểm tra dữ liệu mới mỗi 5 giây; khi máy khác cập nhật, trang đang mở tự nhận dữ liệu mà không cần tải lại.
- Hiển thị trạng thái lưu/đồng bộ ngay trên đầu trang.
- Sửa giao dịch PostgreSQL để BEGIN/COMMIT/ROLLBACK chạy trên cùng một kết nối, tránh lỗi transaction qua connection pool.
- Không đồng bộ mật khẩu nhân viên và không thay đổi giao diện/chức năng phân quyền hiện có.

## Cách cập nhật website hiện tại
1. Giải nén ZIP.
2. Mở repository GitHub `nguyentuanhaodmx1363-netizen/hr-nguyen-tuan-hao`, nhánh `main`.
3. Chép đè `package.json`, `server.js` và thư mục `public` từ thư mục `hr_shared` lên repository. Không xóa các tệp khác.
4. Commit thay đổi. Render Web Service `nth-hr` sẽ tự deploy theo commit.
5. Trong Render → Web Service `nth-hr` → Environment, kiểm tra đã có `DATABASE_URL` trỏ tới database `hr-nguyen-tuan-hao-db` bằng **Internal Database URL**. Không đưa giá trị URL này cho người khác.
6. Sau khi deploy Live, mở `https://hr-nguyen-tuan-hao-app.onrender.com/api/health`. Kết quả phải là `{"ok":true,"database":"connected"}`.
7. Mở `https://hr-nguyen-tuan-hao-app.onrender.com` trên máy tính và điện thoại. Dòng trạng thái trên đầu trang phải báo đã kết nối/đã đồng bộ.

## Lưu ý dữ liệu cũ
Website cũ `hr-nguyen-tuan-hao.onrender.com` là Static Site và dùng localStorage riêng theo từng trình duyệt/thiết bị. Trình duyệt khác hoặc điện thoại không tự đọc được dữ liệu localStorage đó. Không xóa website cũ cho đến khi đã kiểm tra và chuyển dữ liệu cần giữ sang bản Web Service mới. Bản sửa này không tự gom dữ liệu nằm rải rác trong localStorage của các thiết bị cũ.

## Bảo mật và vận hành
Mã PIN quản lý/mật khẩu nhân viên của bản giao diện cũ vẫn đang được kiểm tra phía trình duyệt, chưa phải xác thực bảo mật phía máy chủ. Không dùng bản hiện tại làm hệ thống bảo mật cao hoặc căn cứ trả lương chính thức cho đến khi nâng cấp xác thực. PostgreSQL Free hiện có thời hạn; kiểm tra thời hạn database và sao lưu định kỳ.
