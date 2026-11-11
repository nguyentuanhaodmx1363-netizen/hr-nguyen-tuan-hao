# RENEWZONE v3.1 — Lương & thưởng KiotViet

## Cập nhật
Thay `server.js` và `public/index.html` trên GitHub, Commit và chờ Render Live. Bảng dữ liệu bổ sung tự tạo trong Neon; không xóa dữ liệu cũ.

## Sử dụng
1. Quản lý đăng nhập → **Lương & thưởng Kiot**.
2. Chọn tháng, chi nhánh.
3. Trong **Phân loại dòng hàng KiotViet**, chọn từng dòng: Sản phẩm lớn / Phụ kiện / Phát sinh thu mua / Bảo hiểm / Không tính thưởng.
4. Trong **Thông tin lương cơ bản & ngày vào làm**, nhập thông tin từng người. Tên nhân viên lấy nguyên văn từ file Kiot.
5. Xem bảng thưởng tạm tính; chỉ đối soát và chốt sau khi hết dòng chưa phân loại và kiểm tra file Kiot.

## Công thức
- Sản phẩm lớn: 30.000đ × số lượng.
- Phụ kiện: 15.000đ × số lượng.
- Phát sinh từ đơn thu mua: 10.000đ × số lượng.
- Bảo hiểm: 8% doanh thu bảo hiểm, tăng thành 10% cho **toàn bộ doanh thu bảo hiểm** khi số gói BH / số máy bán **>=65%**.
- Thưởng thêm 2.000.000đ **một lần/tháng** khi số gói BH / số máy bán **>=80%** và đủ điều kiện làm việc từ một tháng.
- Bản này xét điều kiện đủ một tháng theo cách bảo thủ: ngày vào làm không muộn hơn ngày 1 của tháng trước. Nếu chính sách công ty tính theo ngày tròn tháng, cần điều chỉnh trước khi chốt.
- Tổng tạm tính = lương cơ bản nhập tay + hoa hồng hàng + hoa hồng BH + thưởng 2 triệu. Chưa tính công, phép, khấu trừ, thuế, bảo hiểm xã hội hoặc khoản khác.

## Quan trọng về dữ liệu
- File Kiot hiện lưu tên hàng, giá/ thành tiền, số lượng, người bán. **Không có phân loại sản phẩm chuẩn, ngày vào làm hoặc căn cứ tách đơn bảo hiểm**. Do đó không tự động phân loại để tránh trả thưởng sai.
- Cần bảo đảm cột `giá bán`/`thành tiền` của file Kiot là **tổng tiền dòng hàng**, không phải đơn giá. Nếu là đơn giá, tổng doanh thu BH trong bản này sẽ thiếu nhân số lượng; phải sửa parser theo mẫu CSV thực tế trước khi chốt.
- Mã dòng Kiot hiện gắn với thứ tự dòng trong mỗi file CSV. Nhập lại file khác thứ tự có thể tạo trùng đơn; cần đối chiếu dữ liệu trước khi chốt.
- Bản này chỉ quản lý xem bảng lương, chưa cấp quyền nhân viên xem bảng lương riêng vì tên nhân viên trong Kiot chưa được liên kết xác thực với tài khoản đăng nhập.
- Không dùng kết quả tạm tính để trả lương chính thức khi còn cảnh báo chưa phân loại hoặc chưa xác minh cấu trúc CSV.
