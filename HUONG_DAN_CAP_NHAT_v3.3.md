# RENEWZONE v3.3 – Giao diện nhân viên và phụ kiện bán riêng

## Cập nhật

1. Sao lưu repository hiện tại (đặc biệt `server.js` và `public/index.html`).
2. Thay hai file `server.js` và `public/index.html` bằng file trong ZIP.
3. Commit lên GitHub, chờ Render triển khai thành công, tải lại trang bằng Cmd+Shift+R.
4. Đăng nhập nhân viên, mở **Hiệu suất & thưởng của tôi** để xem giao diện mới.
5. Mở **Nhập liệu → Khách chỉ mua phụ kiện** để nhập phụ kiện bán riêng; không tạo đơn máy và không tính rớt bảo hiểm.

## Nguồn dữ liệu và giới hạn

- Doanh thu máy, bảo hiểm và KPI cá nhân lấy từ **đơn nhân viên nhập trên RENEWZONE**, theo quyền tài khoản đăng nhập.
- Doanh thu phụ kiện lấy từ **đơn phụ kiện bán riêng** vừa bổ sung, với thành tiền thực thu.
- Doanh thu khác hiển thị **Chưa có dữ liệu** vì phiên bản này chưa có nguồn dữ liệu dịch vụ/khác.
- Hoa hồng theo ngày là **tạm tính từ dữ liệu nhập tay**, không phải bảng lương KiotViet. Tính 30.000đ/máy, 15.000đ/phụ kiện có thu tiền; bảo hiểm tính 8% hoặc 10% theo tỷ lệ máy có BH của tháng. Không tính phụ kiện 0đ.
- Chưa cộng lương cơ bản, thưởng thu mua, thưởng KPI BH 2 triệu hoặc các khoản khấu trừ. Chưa thể tự động lấy chi tiết hóa đơn KiotViet khi chưa có API/file chi tiết.
- Không xóa hay ghi đè đơn KiotViet, KPI hoặc các đơn máy cũ. Khi khởi động, hệ thống tạo thêm bảng `accessory_sales` nếu chưa có.
- Dự kiến cuối tháng là ngoại suy theo tốc độ từ đầu tháng, chỉ mang tính tham khảo.

## Kiểm tra sau khi cập nhật

- Tài khoản nhân viên chỉ xem dữ liệu cá nhân; quản lý vẫn xem trang quản trị.
- Nhập một đơn phụ kiện 0đ: doanh thu và hoa hồng phụ kiện không tăng.
- Nhập một đơn phụ kiện có tiền: doanh thu và số lượng phụ kiện tăng; số đơn rớt bảo hiểm không tăng.
- Kiểm tra Đổi mật khẩu và menu quản lý trước khi sử dụng chính thức.
