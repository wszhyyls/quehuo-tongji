// ========================================
// 缺货统计系统 - 公共工具模块 (v19)
// 统一设备ID生成、XSS防护等公共函数
// ========================================

// ========== 设备指纹（统一实现）==========
function getDeviceId() {
    var key = 'wszh_device_id';
    var did = localStorage.getItem(key);
    if (!did) {
        var fp = [navigator.userAgent, screen.width+'x'+screen.height,
            screen.colorDepth, navigator.language, (new Date()).getTimezoneOffset(),
            navigator.hardwareConcurrency||''].join('|');
        var h = 0;
        for (var i = 0; i < fp.length; i++) { h = ((h<<5)-h)+fp.charCodeAt(i); }
        did = 'DEV_' + Math.abs(h).toString(36).toUpperCase();
        localStorage.setItem(key, did);
    }
    return did;
}

// ========== XSS 防护函数（统一实现）==========
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    if (typeof str !== 'string') str = String(str);
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/'/g, '&#39;')
        .replace(/"/g, '&quot;');
}

// ========== 安全输出函数（防止XSS）==========
function safeText(str) {
    return escapeHtml(str);
}

// ========== 安全HTML函数（用于需要部分HTML的场景）==========
function safeHtml(str, allowedTags) {
    if (str === null || str === undefined) return '';
    if (typeof str !== 'string') str = String(str);
    
    // 先转义所有
    var escaped = escapeHtml(str);
    
    // 如果有允许的标签，恢复部分标签（谨慎使用）
    if (allowedTags && allowedTags.length > 0) {
        // 只允许非常有限的标签
        var allowed = allowedTags.join('|');
        var regex = new RegExp('&lt;(' + allowed + ')\\s*([^&gt;]*)&gt;', 'gi');
        escaped = escaped.replace(regex, '<$1 $2>');
        // 闭合标签
        allowed.split('|').forEach(function(tag) {
            var closeRegex = new RegExp('&lt;/' + tag + '&gt;', 'gi');
            escaped = escaped.replace(closeRegex, '</' + tag + '>');
        });
    }
    
    return escaped;
}

// ========== 数字格式化 ==========
function formatNumber(num) {
    if (num === null || num === undefined || num === '') return '-';
    var n = parseFloat(num);
    if (isNaN(n)) return '-';
    return n.toLocaleString('zh-CN');
}

// ========== 日期格式化 ==========
function formatDate(dateStr) {
    if (!dateStr) return '-';
    try {
        var d = new Date(dateStr);
        if (isNaN(d.getTime())) return '-';
        return d.toLocaleString('zh-CN');
    } catch(e) {
        return '-';
    }
}

// ========== 错误日志（生产环境关闭）==========
var DEBUG_MODE = false;

function logError(msg, err) {
    if (DEBUG_MODE) {
        console.error('[Error]', msg, err);
    }
}

function logInfo(msg, data) {
    if (DEBUG_MODE) {
        console.log('[Info]', msg, data);
    }
}

// 导出给全局使用
window.getDeviceId = getDeviceId;
window.escapeHtml = escapeHtml;
window.safeText = safeText;
window.safeHtml = safeHtml;
window.formatNumber = formatNumber;
window.formatDate = formatDate;
window.logError = logError;
window.logInfo = logInfo;
