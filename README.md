# HR Nguyễn Tuấn Hảo – bản 1.0.5 (đồng bộ PostgreSQL)

## Thay đổi ở bản 1.0.5
- Bổ sung đồng bộ mật khẩu nhân viên qua PostgreSQL bằng khóa `nth_hr_employee_passwords`.
- Khi triển khai lần đầu, nếu database chưa có khóa mật khẩu nhưng trình duyệt máy quản lý đang có mật khẩu cũ trong localStorage, ứng dụng sẽ tự chuyển dữ liệu đó lên PostgreSQL.
- Các điện thoại/máy tính mở cùng website sẽ nhận danh sách mật khẩu dùng chung; không cần cài lại mật khẩu trên từng thiết bị.
- Giữ nguyên lịch phân ca, yêu cầu, thiết lập lương, chấm công và tính năng chọn khoảng ngày tính lương của v1.0.4.

## Cách cập nhật website hiện tại
1. Tải ZIP và giải nén.
2. Mở repository GitHub `nguyentuanhaodmx1363-netizen/hr-nguyen-tuan-hao`, nhánh `main`.
3. Cập nhật đúng 3 thành phần từ thư mục `hr_shared`: `package.json`, `server.js` và thư mục `public` (chép đè `public/index.html`). Không xóa các tệp khác trong repository.
4. Commit thay đổi. Render Web Service `nth-hr` sẽ tự deploy theo commit.
5. Không xóa PostgreSQL/database hoặc tạo database mới. Giữ nguyên `DATABASE_URL` hiện tại của dịch vụ `nth-hr`.
6. Chờ Render báo deploy **Live**, sau đó mở `https://hr-nguyen-tuan-hao-app.onrender.com/api/health`. Kết quả cần là `{"ok":true,"database":"connected"}`.

## Cách chuyển mật khẩu cũ sang điện thoại
1. Sau khi deploy Live, dùng đúng trình duyệt máy tính mà quản lý đã cài mật khẩu trước đây, mở `https://hr-nguyen-tuan-hao-app.onrender.com`.
2. Chờ dòng trạng thái báo đã kết nối/đồng bộ. Lần mở này sẽ tự chuyển mật khẩu cũ từ trình duyệt máy tính lên PostgreSQL nếu database chưa có danh sách mật khẩu.
3. Mở cùng địa chỉ trên điện thoại, tải lại trang rồi thử đăng nhập bằng tên nhân viên và mật khẩu đã cài.
4. Nếu điện thoại vẫn báo chưa có mật khẩu, không cài lại ngay; kiểm tra máy tính đã mở đúng địa chỉ `hr-nguyen-tuan-hao-app.onrender.com` và trạng thái đã đồng bộ thành công chưa.

## Lưu ý dữ liệu và bảo mật
- Không xóa website/database cũ trong lúc kiểm tra.
- Mật khẩu hiện vẫn được lưu dưới dạng văn bản trong trạng thái dùng chung PostgreSQL và kiểm tra ở trình duyệt, chưa phải cơ chế xác thực bảo mật hoàn chỉnh. Chỉ dùng trong phạm vi nội bộ tin cậy; không dùng chung mật khẩu nhạy cảm.
- Mã PIN quản lý hiện tại vẫn là mã demo phía trình duyệt. Cần nâng cấp xác thực phía máy chủ riêng nếu muốn bảo vệ hệ thống ở mức cao hơn.
- Bản sửa này không tự gom dữ liệu ở các trình duyệt khác nhau; riêng mật khẩu được chuyển từ trình duyệt quản lý cũ khi mở phiên bản mới lần đầu.


## v1.0.6 – Đổi mật khẩu
- Thêm nút **Đổi mật khẩu** trên thanh công cụ sau khi đăng nhập.
- Quản lý và nhân viên đều có thể tự đổi mật khẩu bằng cách xác nhận mật khẩu hiện tại, nhập mật khẩu mới và xác nhận lại.
- Mật khẩu quản lý được đồng bộ qua PostgreSQL bằng khóa `nth_hr_admin_password`; mật khẩu nhân viên tiếp tục dùng `nth_hr_employee_passwords`.
- Mật khẩu quản lý cũ mặc định là `1234` nếu cơ sở dữ liệu chưa có khóa mật khẩu quản lý.
- Cập nhật danh sách khóa được phép lưu trên máy chủ để đồng bộ mật khẩu quản lý.

**Lưu ý bảo mật:** kiến trúc hiện tại vẫn lưu mật khẩu dạng văn bản trong trạng thái dùng chung và API trạng thái chưa có xác thực phía máy chủ. Đây là tiện ích đổi mật khẩu đồng bộ cho hệ thống hiện tại, chưa nên dùng như cơ chế bảo mật mạnh cho dữ liệu nhạy cảm.
