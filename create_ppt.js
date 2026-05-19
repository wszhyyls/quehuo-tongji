const pptxgen = require("pptxgenjs");

let pres = new pptxgen();
pres.layout = 'LAYOUT_16x9';
pres.author = '众和医药';
pres.title = '缺货统计系统使用说明';

// 配色方案 - 医药主题（蓝绿色调）
const COLORS = {
  primary: "1E5F74",      // 深青色
  secondary: "289D8F",    // 青绿色
  accent: "F4A261",        // 暖橙色
  dark: "133B5C",          // 深蓝
  light: "F8F9FA",         // 浅灰白
  text: "2D3436",          // 深灰文字
  white: "FFFFFF",
  lightBlue: "E8F6F3"
};

// ==================== 幻灯片1：封面 ====================
let slide1 = pres.addSlide();
slide1.background = { color: COLORS.dark };

// 顶部装饰线
slide1.addShape(pres.shapes.RECTANGLE, {
  x: 0, y: 0, w: 10, h: 0.08, fill: { color: COLORS.secondary }
});

// 左侧装饰块
slide1.addShape(pres.shapes.RECTANGLE, {
  x: 0, y: 1.5, w: 0.15, h: 2.5, fill: { color: COLORS.accent }
});

// 主标题
slide1.addText("缺货统计系统", {
  x: 0.8, y: 1.6, w: 8.5, h: 1.2,
  fontSize: 54, fontFace: "Microsoft YaHei", bold: true,
  color: COLORS.white
});

// 副标题
slide1.addText("前台操作使用手册", {
  x: 0.8, y: 2.8, w: 8.5, h: 0.7,
  fontSize: 32, fontFace: "Microsoft YaHei",
  color: COLORS.secondary
});

// 分割线
slide1.addShape(pres.shapes.RECTANGLE, {
  x: 0.8, y: 3.7, w: 3, h: 0.04, fill: { color: COLORS.accent }
});

// 公司名称
slide1.addText("微山县众和医药连锁有限公司", {
  x: 0.8, y: 4.0, w: 8.5, h: 0.5,
  fontSize: 18, fontFace: "Microsoft YaHei",
  color: "94A3B8"
});

// 版本信息
slide1.addText("V2.0  |  2026年", {
  x: 0.8, y: 4.6, w: 8.5, h: 0.4,
  fontSize: 14, fontFace: "Microsoft YaHei",
  color: "64748B"
});

// ==================== 幻灯片2：目录 ====================
let slide2 = pres.addSlide();
slide2.background = { color: COLORS.light };

// 左侧色块
slide2.addShape(pres.shapes.RECTANGLE, {
  x: 0, y: 0, w: 3.2, h: 5.625, fill: { color: COLORS.dark }
});

// 目录标题
slide2.addText("目录", {
  x: 0.4, y: 0.8, w: 2.4, h: 0.8,
  fontSize: 36, fontFace: "Microsoft YaHei", bold: true,
  color: COLORS.white
});

slide2.addText("CONTENTS", {
  x: 0.4, y: 1.5, w: 2.4, h: 0.4,
  fontSize: 12, fontFace: "Arial",
  color: COLORS.secondary, charSpacing: 4
});

// 目录项
const tocItems = [
  { num: "01", title: "系统简介", desc: "系统概述与功能架构" },
  { num: "02", title: "账号登录", desc: "员工账号与门店账号登录" },
  { num: "03", title: "门店前台", desc: "缺货上报与新品订购" },
  { num: "04", title: "设备授权", desc: "新设备授权管理流程" },
  { num: "05", title: "常见问题", desc: "FAQ与故障排除" }
];

tocItems.forEach((item, i) => {
  const y = 0.7 + i * 0.95;

  // 序号
  slide2.addText(item.num, {
    x: 3.6, y: y, w: 0.7, h: 0.6,
    fontSize: 28, fontFace: "Arial", bold: true,
    color: COLORS.secondary
  });

  // 标题
  slide2.addText(item.title, {
    x: 4.4, y: y, w: 3, h: 0.45,
    fontSize: 20, fontFace: "Microsoft YaHei", bold: true,
    color: COLORS.text
  });

  // 描述
  slide2.addText(item.desc, {
    x: 4.4, y: y + 0.4, w: 4.5, h: 0.35,
    fontSize: 12, fontFace: "Microsoft YaHei",
    color: "64748B"
  });

  // 分隔线
  if (i < tocItems.length - 1) {
    slide2.addShape(pres.shapes.LINE, {
      x: 3.6, y: y + 0.85, w: 5.5, h: 0,
      line: { color: "E2E8F0", width: 1 }
    });
  }
});

// ==================== 幻灯片3：系统简介 ====================
let slide3 = pres.addSlide();
slide3.background = { color: COLORS.light };

// 顶部色带
slide3.addShape(pres.shapes.RECTANGLE, {
  x: 0, y: 0, w: 10, h: 0.9, fill: { color: COLORS.dark }
});

slide3.addText("01", {
  x: 0.5, y: 0.15, w: 0.8, h: 0.6,
  fontSize: 32, fontFace: "Arial", bold: true,
  color: COLORS.accent
});

slide3.addText("系统简介", {
  x: 1.4, y: 0.2, w: 3, h: 0.5,
  fontSize: 26, fontFace: "Microsoft YaHei", bold: true,
  color: COLORS.white
});

// 系统概述卡片
slide3.addShape(pres.shapes.RECTANGLE, {
  x: 0.5, y: 1.2, w: 9, h: 1.3, fill: { color: COLORS.white },
  shadow: { type: "outer", color: "000000", blur: 8, offset: 2, angle: 135, opacity: 0.08 }
});

slide3.addShape(pres.shapes.RECTANGLE, {
  x: 0.5, y: 1.2, w: 0.08, h: 1.3, fill: { color: COLORS.secondary }
});

slide3.addText("系统概述", {
  x: 0.8, y: 1.35, w: 2, h: 0.4,
  fontSize: 16, fontFace: "Microsoft YaHei", bold: true,
  color: COLORS.secondary
});

slide3.addText("缺货统计系统是一款面向医药连锁门店的库存管理工具，帮助门店员工快速上报缺货商品，管理员统一汇总并协调采购，提高补货效率，减少药品缺货情况。", {
  x: 0.8, y: 1.75, w: 8.5, h: 0.6,
  fontSize: 13, fontFace: "Microsoft YaHei",
  color: COLORS.text
});

// 功能模块卡片
const modules = [
  { icon: "📝", title: "缺货上报", desc: "员工快速上报缺货商品信息" },
  { icon: "🆕", title: "新品订购", desc: "申请采购未在库的新药品" },
  { icon: "📊", title: "数据汇总", desc: "管理员汇总各店缺货数据" },
  { icon: "🔄", title: "采购同步", desc: "自动同步采购计划状态" },
  { icon: "📱", title: "设备管理", desc: "管理员工登录设备授权" },
  { icon: "🔐", title: "安全登录", desc: "设备绑定保障账号安全" }
];

modules.forEach((mod, i) => {
  const col = i % 3;
  const row = Math.floor(i / 3);
  const x = 0.5 + col * 3.1;
  const y = 2.8 + row * 1.35;

  slide3.addShape(pres.shapes.RECTANGLE, {
    x: x, y: y, w: 2.9, h: 1.15, fill: { color: COLORS.white },
    shadow: { type: "outer", color: "000000", blur: 6, offset: 2, angle: 135, opacity: 0.06 }
  });

  slide3.addText(mod.icon, {
    x: x + 0.15, y: y + 0.25, w: 0.6, h: 0.6,
    fontSize: 24
  });

  slide3.addText(mod.title, {
    x: x + 0.8, y: y + 0.2, w: 1.9, h: 0.4,
    fontSize: 14, fontFace: "Microsoft YaHei", bold: true,
    color: COLORS.text
  });

  slide3.addText(mod.desc, {
    x: x + 0.8, y: y + 0.6, w: 1.9, h: 0.4,
    fontSize: 11, fontFace: "Microsoft YaHei",
    color: "64748B"
  });
});

// ==================== 幻灯片4：账号登录 ====================
let slide4 = pres.addSlide();
slide4.background = { color: COLORS.light };

// 顶部色带
slide4.addShape(pres.shapes.RECTANGLE, {
  x: 0, y: 0, w: 10, h: 0.9, fill: { color: COLORS.dark }
});

slide4.addText("02", {
  x: 0.5, y: 0.15, w: 0.8, h: 0.6,
  fontSize: 32, fontFace: "Arial", bold: true,
  color: COLORS.accent
});

slide4.addText("账号登录", {
  x: 1.4, y: 0.2, w: 3, h: 0.5,
  fontSize: 26, fontFace: "Microsoft YaHei", bold: true,
  color: COLORS.white
});

// 账号类型说明
// 员工账号卡片
slide4.addShape(pres.shapes.RECTANGLE, {
  x: 0.5, y: 1.2, w: 4.4, h: 2.8, fill: { color: COLORS.white },
  shadow: { type: "outer", color: "000000", blur: 8, offset: 2, angle: 135, opacity: 0.08 }
});

slide4.addShape(pres.shapes.RECTANGLE, {
  x: 0.5, y: 1.2, w: 4.4, h: 0.5, fill: { color: COLORS.secondary }
});

slide4.addText("👤  员工账号", {
  x: 0.7, y: 1.28, w: 4, h: 0.35,
  fontSize: 16, fontFace: "Microsoft YaHei", bold: true,
  color: COLORS.white
});

slide4.addText([
  { text: "登录方式", options: { bold: true, breakLine: true } },
  { text: "使用手机号 + 密码登录", options: { breakLine: true } },
  { text: "", options: { breakLine: true } },
  { text: "适用对象", options: { bold: true, breakLine: true } },
  { text: "各门店一线员工", options: { breakLine: true } },
  { text: "", options: { breakLine: true } },
  { text: "默认密码", options: { bold: true, breakLine: true } },
  { text: "123456（首次登录后请修改）", options: { breakLine: true } },
  { text: "", options: { breakLine: true } },
  { text: "主要功能", options: { bold: true, breakLine: true } },
  { text: "上报缺货商品、申请新品订购", options: {} }
], {
  x: 0.7, y: 1.85, w: 4, h: 2,
  fontSize: 12, fontFace: "Microsoft YaHei",
  color: COLORS.text, valign: "top"
});

// 门店账号卡片
slide4.addShape(pres.shapes.RECTANGLE, {
  x: 5.1, y: 1.2, w: 4.4, h: 2.8, fill: { color: COLORS.white },
  shadow: { type: "outer", color: "000000", blur: 8, offset: 2, angle: 135, opacity: 0.08 }
});

slide4.addShape(pres.shapes.RECTANGLE, {
  x: 5.1, y: 1.2, w: 4.4, h: 0.5, fill: { color: COLORS.primary }
});

slide4.addText("🏪  门店账号", {
  x: 5.3, y: 1.28, w: 4, h: 0.35,
  fontSize: 16, fontFace: "Microsoft YaHei", bold: true,
  color: COLORS.white
});

slide4.addText([
  { text: "登录方式", options: { bold: true, breakLine: true } },
  { text: "使用门店编号 + 密码登录", options: { breakLine: true } },
  { text: "", options: { breakLine: true } },
  { text: "适用对象", options: { bold: true, breakLine: true } },
  { text: "门店店长或负责人", options: { breakLine: true } },
  { text: "", options: { breakLine: true } },
  { text: "账号格式", options: { bold: true, breakLine: true } },
  { text: "如：wszhyy02、wszhyy03 等", options: { breakLine: true } },
  { text: "", options: { breakLine: true } },
  { text: "主要功能", options: { bold: true, breakLine: true } },
  { text: "管理员工、管理门店数据", options: {} }
], {
  x: 5.3, y: 1.85, w: 4, h: 2,
  fontSize: 12, fontFace: "Microsoft YaHei",
  color: COLORS.text, valign: "top"
});

// 登录提示
slide4.addShape(pres.shapes.RECTANGLE, {
  x: 0.5, y: 4.2, w: 9, h: 1.1, fill: { color: "FEF3C7" }
});

slide4.addText("⚠️  登录提示", {
  x: 0.7, y: 4.35, w: 2, h: 0.35,
  fontSize: 14, fontFace: "Microsoft YaHei", bold: true,
  color: "92400E"
});

slide4.addText("• 每个员工账号只能在唯一设备登录，换设备需联系管理员重新授权\n• 新设备首次登录会显示设备码，需等待管理员授权后才能使用", {
  x: 0.7, y: 4.7, w: 8.5, h: 0.5,
  fontSize: 11, fontFace: "Microsoft YaHei",
  color: "92400E"
});

// ==================== 幻灯片5：门店前台功能 ====================
let slide5 = pres.addSlide();
slide5.background = { color: COLORS.light };

// 顶部色带
slide5.addShape(pres.shapes.RECTANGLE, {
  x: 0, y: 0, w: 10, h: 0.9, fill: { color: COLORS.dark }
});

slide5.addText("03", {
  x: 0.5, y: 0.15, w: 0.8, h: 0.6,
  fontSize: 32, fontFace: "Arial", bold: true,
  color: COLORS.accent
});

slide5.addText("门店前台操作", {
  x: 1.4, y: 0.2, w: 4, h: 0.5,
  fontSize: 26, fontFace: "Microsoft YaHei", bold: true,
  color: COLORS.white
});

// 功能1：缺货上报
slide5.addShape(pres.shapes.RECTANGLE, {
  x: 0.5, y: 1.15, w: 4.4, h: 2.0, fill: { color: COLORS.white },
  shadow: { type: "outer", color: "000000", blur: 6, offset: 2, angle: 135, opacity: 0.06 }
});

slide5.addShape(pres.shapes.RECTANGLE, {
  x: 0.5, y: 1.15, w: 0.08, h: 2.0, fill: { color: COLORS.secondary }
});

slide5.addText("📝  缺货上报", {
  x: 0.75, y: 1.3, w: 3, h: 0.4,
  fontSize: 16, fontFace: "Microsoft YaHei", bold: true,
  color: COLORS.secondary
});

slide5.addText([
  { text: "1. 点击「缺货上报」按钮", options: { breakLine: true } },
  { text: "2. 搜索或扫描药品条码", options: { breakLine: true } },
  { text: "3. 填写当前库存数量", options: { breakLine: true } },
  { text: "4. 设置紧急程度（普通/加急/紧急）", options: { breakLine: true } },
  { text: "5. 确认提交即可", options: {} }
], {
  x: 0.75, y: 1.75, w: 4, h: 1.3,
  fontSize: 12, fontFace: "Microsoft YaHei",
  color: COLORS.text, valign: "top"
});

// 功能2：新品订购
slide5.addShape(pres.shapes.RECTANGLE, {
  x: 5.1, y: 1.15, w: 4.4, h: 2.0, fill: { color: COLORS.white },
  shadow: { type: "outer", color: "000000", blur: 6, offset: 2, angle: 135, opacity: 0.06 }
});

slide5.addShape(pres.shapes.RECTANGLE, {
  x: 5.1, y: 1.15, w: 0.08, h: 2.0, fill: { color: COLORS.accent }
});

slide5.addText("🆕  新品订购", {
  x: 5.35, y: 1.3, w: 3, h: 0.4,
  fontSize: 16, fontFace: "Microsoft YaHei", bold: true,
  color: COLORS.accent
});

slide5.addText([
  { text: "1. 点击「新品订购」按钮", options: { breakLine: true } },
  { text: "2. 填写药品名称、规格、厂家", options: { breakLine: true } },
  { text: "3. 填写参考价格范围", options: { breakLine: true } },
  { text: "4. 填写需求数量", options: { breakLine: true } },
  { text: "5. 确认提交即可", options: {} }
], {
  x: 5.35, y: 1.75, w: 4, h: 1.3,
  fontSize: 12, fontFace: "Microsoft YaHei",
  color: COLORS.text, valign: "top"
});

// 注意事项
slide5.addShape(pres.shapes.RECTANGLE, {
  x: 0.5, y: 3.35, w: 9, h: 1.95, fill: { color: COLORS.white },
  shadow: { type: "outer", color: "000000", blur: 6, offset: 2, angle: 135, opacity: 0.06 }
});

slide5.addShape(pres.shapes.RECTANGLE, {
  x: 0.5, y: 3.35, w: 0.08, h: 1.95, fill: { color: COLORS.primary }
});

slide5.addText("💡  操作注意事项", {
  x: 0.75, y: 3.5, w: 3, h: 0.4,
  fontSize: 14, fontFace: "Microsoft YaHei", bold: true,
  color: COLORS.primary
});

slide5.addText([
  { text: "• 紧急程度说明：", options: { bold: true, breakLine: true } },
  { text: "  - 普通：一般缺货，3天内补货即可", options: { breakLine: true } },
  { text: "  - 加急：近期销量好的药品，1-2天内补货", options: { breakLine: true } },
  { text: "  - 紧急：畅销药品断货，需立即处理", options: { breakLine: true } },
  { text: "", options: { breakLine: true } },
  { text: "• 上报后可在「我的上报」中查看处理进度", options: {} }
], {
  x: 0.75, y: 3.9, w: 8.5, h: 1.3,
  fontSize: 12, fontFace: "Microsoft YaHei",
  color: COLORS.text, valign: "top"
});

// ==================== 幻灯片6：设备授权 ====================
let slide6 = pres.addSlide();
slide6.background = { color: COLORS.light };

// 顶部色带
slide6.addShape(pres.shapes.RECTANGLE, {
  x: 0, y: 0, w: 10, h: 0.9, fill: { color: COLORS.dark }
});

slide6.addText("04", {
  x: 0.5, y: 0.15, w: 0.8, h: 0.6,
  fontSize: 32, fontFace: "Arial", bold: true,
  color: COLORS.accent
});

slide6.addText("设备授权管理", {
  x: 1.4, y: 0.2, w: 4, h: 0.5,
  fontSize: 26, fontFace: "Microsoft YaHei", bold: true,
  color: COLORS.white
});

// 流程说明
slide6.addText("新设备登录流程", {
  x: 0.5, y: 1.15, w: 3, h: 0.4,
  fontSize: 16, fontFace: "Microsoft YaHei", bold: true,
  color: COLORS.text
});

// 流程步骤
const steps = [
  { num: "1", text: "员工在新设备\n尝试登录", color: COLORS.secondary },
  { num: "2", text: "系统显示\n设备码", color: COLORS.primary },
  { num: "3", text: "联系管理员\n提供设备码", color: COLORS.accent },
  { num: "4", text: "管理员后台\n授权设备", color: COLORS.secondary },
  { num: "5", text: "授权成功\n正常登录", color: COLORS.primary }
];

steps.forEach((step, i) => {
  const x = 0.5 + i * 1.9;

  // 圆形背景
  slide6.addShape(pres.shapes.OVAL, {
    x: x + 0.55, y: 1.65, w: 0.7, h: 0.7, fill: { color: step.color }
  });

  // 序号
  slide6.addText(step.num, {
    x: x + 0.55, y: 1.75, w: 0.7, h: 0.5,
    fontSize: 20, fontFace: "Arial", bold: true,
    color: COLORS.white, align: "center"
  });

  // 文字
  slide6.addText(step.text, {
    x: x, y: 2.5, w: 1.8, h: 0.7,
    fontSize: 11, fontFace: "Microsoft YaHei",
    color: COLORS.text, align: "center"
  });

  // 箭头
  if (i < steps.length - 1) {
    slide6.addText("→", {
      x: x + 1.6, y: 1.8, w: 0.4, h: 0.4,
      fontSize: 24, color: "CBD5E1", align: "center"
    });
  }
});

// 管理员操作说明
slide6.addShape(pres.shapes.RECTANGLE, {
  x: 0.5, y: 3.4, w: 9, h: 1.9, fill: { color: COLORS.white },
  shadow: { type: "outer", color: "000000", blur: 6, offset: 2, angle: 135, opacity: 0.06 }
});

slide6.addShape(pres.shapes.RECTANGLE, {
  x: 0.5, y: 3.4, w: 0.08, h: 1.9, fill: { color: COLORS.secondary }
});

slide6.addText("🔐  管理员授权操作（admin账号）", {
  x: 0.75, y: 3.55, w: 5, h: 0.4,
  fontSize: 14, fontFace: "Microsoft YaHei", bold: true,
  color: COLORS.secondary
});

slide6.addText([
  { text: "1. 登录管理后台（admin账号）", options: { breakLine: true } },
  { text: "2. 点击「设备授权」Tab", options: { breakLine: true } },
  { text: "3. 查看「待授权设备」列表", options: { breakLine: true } },
  { text: "4. 核对员工信息，点击「授权」按钮", options: { breakLine: true } },
  { text: "5. 授权后员工即可使用该设备登录", options: {} }
], {
  x: 0.75, y: 4.0, w: 8.5, h: 1.2,
  fontSize: 12, fontFace: "Microsoft YaHei",
  color: COLORS.text, valign: "top"
});

// ==================== 幻灯片7：常见问题 ====================
let slide7 = pres.addSlide();
slide7.background = { color: COLORS.light };

// 顶部色带
slide7.addShape(pres.shapes.RECTANGLE, {
  x: 0, y: 0, w: 10, h: 0.9, fill: { color: COLORS.dark }
});

slide7.addText("05", {
  x: 0.5, y: 0.15, w: 0.8, h: 0.6,
  fontSize: 32, fontFace: "Arial", bold: true,
  color: COLORS.accent
});

slide7.addText("常见问题", {
  x: 1.4, y: 0.2, w: 3, h: 0.5,
  fontSize: 26, fontFace: "Microsoft YaHei", bold: true,
  color: COLORS.white
});

// FAQ 列表
const faqs = [
  {
    q: "忘记密码怎么办？",
    a: "请联系管理员重置密码，默认密码为 123456"
  },
  {
    q: "换了新手机无法登录？",
    a: "新设备需要管理员授权，请提供设备码给管理员"
  },
  {
    q: "设备码在哪里查看？",
    a: "在新设备登录界面会显示设备码，格式如 DEV_XXXXXX"
  },
  {
    q: "一个账号可以同时在多台设备登录吗？",
    a: "不可以，系统限制同一账号只能在唯一设备登录"
  },
  {
    q: "如何申请管理员权限？",
    a: "请联系公司总部系统管理员进行账号权限配置"
  }
];

faqs.forEach((faq, i) => {
  const y = 1.15 + i * 0.85;

  slide7.addShape(pres.shapes.RECTANGLE, {
    x: 0.5, y: y, w: 9, h: 0.75, fill: { color: COLORS.white },
    shadow: { type: "outer", color: "000000", blur: 4, offset: 1, angle: 135, opacity: 0.05 }
  });

  slide7.addText("Q", {
    x: 0.65, y: y + 0.15, w: 0.4, h: 0.4,
    fontSize: 16, fontFace: "Arial", bold: true,
    color: COLORS.secondary
  });

  slide7.addText(faq.q, {
    x: 1.1, y: y + 0.12, w: 8, h: 0.35,
    fontSize: 13, fontFace: "Microsoft YaHei", bold: true,
    color: COLORS.text
  });

  slide7.addText(faq.a, {
    x: 1.1, y: y + 0.42, w: 8, h: 0.3,
    fontSize: 11, fontFace: "Microsoft YaHei",
    color: "64748B"
  });
});

// ==================== 幻灯片8：结束页 ====================
let slide8 = pres.addSlide();
slide8.background = { color: COLORS.dark };

// 装饰线
slide8.addShape(pres.shapes.RECTANGLE, {
  x: 0, y: 0, w: 10, h: 0.08, fill: { color: COLORS.secondary }
});

slide8.addShape(pres.shapes.RECTANGLE, {
  x: 0, y: 5.545, w: 10, h: 0.08, fill: { color: COLORS.secondary }
});

// 感谢语
slide8.addText("感谢使用", {
  x: 0.5, y: 1.8, w: 9, h: 1,
  fontSize: 48, fontFace: "Microsoft YaHei", bold: true,
  color: COLORS.white, align: "center"
});

slide8.addText("THANK YOU", {
  x: 0.5, y: 2.7, w: 9, h: 0.5,
  fontSize: 18, fontFace: "Arial",
  color: COLORS.secondary, align: "center", charSpacing: 8
});

// 分割线
slide8.addShape(pres.shapes.RECTANGLE, {
  x: 4, y: 3.4, w: 2, h: 0.03, fill: { color: COLORS.accent }
});

// 联系信息
slide8.addText("如有疑问，请联系系统管理员", {
  x: 0.5, y: 3.7, w: 9, h: 0.5,
  fontSize: 16, fontFace: "Microsoft YaHei",
  color: "94A3B8", align: "center"
});

slide8.addText("微山县众和医药连锁有限公司", {
  x: 0.5, y: 4.3, w: 9, h: 0.5,
  fontSize: 14, fontFace: "Microsoft YaHei",
  color: "64748B", align: "center"
});

// 保存文件
pres.writeFile({ fileName: "缺货统计系统使用说明.pptx" })
  .then(() => console.log("PPT 创建成功：缺货统计系统使用说明.pptx"))
  .catch(err => console.error("创建失败:", err));
