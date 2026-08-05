"""
身份证提取并排版到A4纸上，可直接打印
"""
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
import os
import math

IMG_DIR = Path(r"D:\Users\Administrator\Desktop\新建文件夹 (2)")
OUTPUT = IMG_DIR / "身份证_A4打印.png"

# A4纸在300DPI下的尺寸（像素）
A4_W, A4_H = 2480, 3508
# 身份证实际比例：85.6mm × 54mm ≈ 1.118:1
IDCARD_W_MM, IDCARD_H_MM = 85.6, 54.0
# 在A4上放置的身份证大小（在300DPI下按实际大小）
# 实际希望身份证在A4上大约占一半宽度多一点，按实际像素缩放
# 在300DPI下，实际身份证像素: 85.6mm * 300/25.4 ≈ 1011px, 54mm * 300/25.4 ≈ 638px
# 但为了打印清晰，我们适当放大
IDCARD_SCALE_MM = 1.0  # 1:1 实际大小
DPI = 300
MM_TO_PX = DPI / 25.4  # 11.81 px/mm
IDCARD_W = int(IDCARD_W_MM * MM_TO_PX)  # ≈ 1011
IDCARD_H = int(IDCARD_H_MM * MM_TO_PX)  # ≈ 638

# 身份证长宽比
IDCARD_ASPECT = IDCARD_W_MM / IDCARD_H_MM  # ≈ 1.585


def order_points(pts):
    """将4个点排序为：左上、右上、右下、左下"""
    pts = pts.reshape(4, 2)
    rect = np.zeros((4, 2), dtype="float32")
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]  # 左上
    rect[2] = pts[np.argmax(s)]  # 右下
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]  # 右上
    rect[3] = pts[np.argmax(diff)]  # 左下
    return rect


def imread_unicode(path):
    """用PIL读取图片（支持中文路径），转为OpenCV BGR格式"""
    pil_img = Image.open(str(path))
    # 如果是RGBA，转为RGB
    if pil_img.mode == 'RGBA':
        pil_img = pil_img.convert('RGB')
    elif pil_img.mode != 'RGB':
        pil_img = pil_img.convert('RGB')
    arr = np.array(pil_img)
    # PIL读取是RGB，OpenCV使用BGR
    return cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)


def imwrite_unicode(path, img):
    """用PIL保存图片（支持中文路径）"""
    arr = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    pil_img = Image.fromarray(arr)
    pil_img.save(str(path))


def detect_and_extract_idcard(img_path):
    """检测并提取身份证区域，返回矫正后的图像"""
    img = imread_unicode(img_path)
    if img is None:
        print(f"无法读取图片: {img_path}")
        return None, None

    h, w = img.shape[:2]
    original = img.copy()

    # 灰度化
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    # 高斯模糊
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)

    # Canny边缘检测
    edges = cv2.Canny(blurred, 50, 150)

    # 膨胀 + 腐蚀，闭合边缘
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (9, 9))
    closed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel)

    # 查找轮廓
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    # 按面积排序，找最大的矩形
    contours = sorted(contours, key=cv2.contourArea, reverse=True)

    idcard_corners = None
    for cnt in contours[:10]:
        peri = cv2.arcLength(cnt, True)
        approx = cv2.approxPolyDP(cnt, 0.02 * peri, True)
        if len(approx) == 4:
            area = cv2.contourArea(approx)
            if area > (h * w * 0.1):  # 面积至少占10%
                idcard_corners = approx
                break

    if idcard_corners is None:
        # 如果自动检测失败，使用整个图片（用户可能已经裁剪好了）
        print(f"  自动检测失败，使用整张图片: {img_path.name}")
        # 尝试用大轮廓
        for cnt in contours[:5]:
            rect = cv2.minAreaRect(cnt)
            box = cv2.boxPoints(rect)
            box = np.intp(box)
            area = cv2.contourArea(box)
            if area > (h * w * 0.15):
                idcard_corners = np.array(box).reshape(4, 1, 2)
                break

    if idcard_corners is None:
        print(f"  无法找到身份证区域，使用整张图片: {img_path.name}")
        return img_path.name, img

    # 透视变换
    corners = order_points(idcard_corners)
    (tl, tr, br, bl) = corners

    # 计算目标尺寸（保持身份证比例）
    width_top = np.linalg.norm(tr - tl)
    width_bottom = np.linalg.norm(br - bl)
    height_left = np.linalg.norm(bl - tl)
    height_right = np.linalg.norm(br - tr)

    max_width = max(int(width_top), int(width_bottom))
    max_height = max(int(height_left), int(height_right))

    # 按身份证标准比例调整
    if max_width / max_height > IDCARD_ASPECT:
        # 宽度主导，按宽度算高度
        target_w = max_width
        target_h = int(max_width / IDCARD_ASPECT)
    else:
        # 高度主导
        target_h = max_height
        target_w = int(max_height * IDCARD_ASPECT)

    dst = np.array([
        [0, 0],
        [target_w - 1, 0],
        [target_w - 1, target_h - 1],
        [0, target_h - 1]
    ], dtype="float32")

    M = cv2.getPerspectiveTransform(corners, dst)
    warped = cv2.warpPerspective(original, M, (target_w, target_h))

    return img_path.name, warped


def is_portrait_face(img):
    """判断是否是人像面（通过检测是否有较多肤色区域）"""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    # 肤色范围
    lower = np.array([0, 20, 70], dtype=np.uint8)
    upper = np.array([25, 255, 255], dtype=np.uint8)
    mask = cv2.inRange(hsv, lower, upper)
    skin_ratio = np.count_nonzero(mask) / (img.shape[0] * img.shape[1])
    return skin_ratio > 0.05


def process_images():
    """主处理流程"""
    img_files = sorted(IMG_DIR.glob("*.jpg")) + sorted(IMG_DIR.glob("*.jpeg")) + sorted(IMG_DIR.glob("*.png"))

    if len(img_files) < 2:
        print(f"错误: 在 {IMG_DIR} 中至少需要2张图片，当前找到 {len(img_files)} 张")
        return

    # 处理两张身份证图片（只处理前2张）
    results = []
    for f in img_files[:2]:
        print(f"处理: {f.name}")
        name, extracted = detect_and_extract_idcard(f)
        if extracted is not None:
            results.append((name, extracted))
            print(f"  提取成功: {extracted.shape[1]}x{extracted.shape[0]}")

    if len(results) == 0:
        print("没有成功提取任何身份证图片")
        return

    # 按人像面和国徽面分开
    face_img = None
    emblem_img = None

    for name, img in results:
        if is_portrait_face(img):
            face_img = img
            print(f"  识别为人像面: {name}")
        else:
            emblem_img = img
            print(f"  识别为国徽面: {name}")

    # 如果只有一个结果，或者两都被判定为同一面
    if face_img is None and emblem_img is None:
        print("无法区分正面和反面，按文件名顺序排列")
        face_img = results[0][1]
        if len(results) > 1:
            emblem_img = results[1][1]

    if face_img is None:
        face_img = results[0][1]
    if emblem_img is None and len(results) > 1:
        emblem_img = results[1][1]

    # 缩放身份证到A4上的目标大小
    def resize_idcard(img, target_w, target_h):
        h, w = img.shape[:2]
        current_aspect = w / h
        target_aspect = target_w / target_h

        if abs(current_aspect - target_aspect) < 0.2:
            # ratio接近，直接缩放
            resized = cv2.resize(img, (target_w, target_h))
        else:
            # 需要裁剪到正确比例
            if current_aspect > target_aspect:
                new_h = int(w / target_aspect)
                crop = (h - new_h) // 2
                img_cropped = img[crop:crop + new_h, :]
            else:
                new_w = int(h * target_aspect)
                crop = (w - new_w) // 2
                img_cropped = img[:, crop:crop + new_w]
            resized = cv2.resize(img_cropped, (target_w, target_h))
        return resized

    # A4纸上的排版：上方人像面，下方国徽面，居中放置
    # 间距和边距
    margin_top = 200  # 顶部边距
    margin_bottom = 200
    gap = 120  # 两个身份证之间的间距

    # 计算身份证在A4纸上的放置位置
    total_content_h = IDCARD_H * 2 + gap
    start_y = (A4_H - total_content_h) // 2

    # 创建A4画布（白色）
    a4_canvas = np.ones((A4_H, A4_W, 3), dtype=np.uint8) * 255

    face_resized = resize_idcard(face_img, IDCARD_W, IDCARD_H)
    face_x = (A4_W - IDCARD_W) // 2
    face_y = start_y
    a4_canvas[face_y:face_y + IDCARD_H, face_x:face_x + IDCARD_W] = face_resized

    if emblem_img is not None:
        emblem_resized = resize_idcard(emblem_img, IDCARD_W, IDCARD_H)
        emblem_y = face_y + IDCARD_H + gap
        a4_canvas[emblem_y:emblem_y + IDCARD_H, face_x:face_x + IDCARD_W] = emblem_resized

    # 使用PIL添加文字标注（因为OpenCV中文支持不好）
    a4_pil = Image.fromarray(cv2.cvtColor(a4_canvas, cv2.COLOR_BGR2RGB))

    draw = ImageDraw.Draw(a4_pil)
    # 尝试加载中文字体
    font_paths = [
        "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/simhei.ttf",
        "C:/Windows/Fonts/simsun.ttc",
        "C:/Windows/Fonts/STKAITI.TTF",
    ]
    font = None
    for fp in font_paths:
        if os.path.exists(fp):
            try:
                font = ImageFont.truetype(fp, 32)
                break
            except Exception:
                continue
    if font is None:
        font = ImageFont.load_default()
        print("警告: 未找到中文字体，将使用默认字体")

    # 添加标签
    label_y = face_y - 60
    # 人像面标签
    face_label = "身份证人像面（正面）"
    bbox = draw.textbbox((0, 0), face_label, font=font)
    tw = bbox[2] - bbox[0]
    draw.text((A4_W // 2 - tw // 2, label_y), face_label, fill=(0, 0, 0), font=font)

    if emblem_img is not None:
        label_y2 = emblem_y - 60
        emblem_label = "身份证国徽面（反面）"
        bbox2 = draw.textbbox((0, 0), emblem_label, font=font)
        tw2 = bbox2[2] - bbox2[0]
        draw.text((A4_W // 2 - tw2 // 2, label_y2), emblem_label, fill=(0, 0, 0), font=font)

    # 添加底部提示
    tip = "提示：打印时请选择A4纸、100%比例、彩色打印、无边距"
    bbox3 = draw.textbbox((0, 0), tip, font=font)
    tw3 = bbox3[2] - bbox3[0]
    draw.text((A4_W // 2 - tw3 // 2, A4_H - 100), tip, fill=(128, 128, 128), font=font)

    # 保存（使用PIL支持中文路径）
    a4_pil.save(str(OUTPUT), dpi=(DPI, DPI))
    print(f"\n[OK] Done! File saved: {OUTPUT}")
    print(f"  A4 size: {A4_W}x{A4_H} px (300 DPI)")
    print(f"  IDCard size: {IDCARD_W}x{IDCARD_H} px ({IDCARD_W_MM}mm x {IDCARD_H_MM}mm)")
    print(f"  Ready to print on A4 paper")
    print(f"  Print settings: A4 paper, 100% scale, 300 DPI, color, borderless")


if __name__ == "__main__":
    process_images()
