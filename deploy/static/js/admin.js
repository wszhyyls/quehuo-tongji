// ========================================
// 缺货统计系统 - 管理后台 (v22)
// 优化：统一公共模块、loading状态可视化、固定表头、防重加载、管理员操作日志
// ========================================

var token = localStorage.getItem('token');
var user = null;
try {
    user = JSON.parse(localStorage.getItem('user') || 'null');
} catch(e) { window.location.href = './'; }
if (!token || !user || (user.role !== 'admin' && user.role !== 'super_admin')) { window.location.href = './'; }

var summaryData = null;
var currentEditProduct = null;
var selectedProducts = {};
var autoRefreshTimer = null;
var autoRefreshInterval = 60000;
var currentPage = 1, pageSize = 20;
var filteredData = [], completedData = [], currentFilterStatus = '';
var isLoadingSummary = false; // 防重加载锁
var selectedSuppliers = []; // 供货商多选列表
var orderStatusCache = {}; // 订购入库/配送状态缓存 { buyMap:{}, sendMap:{} }
// 从 localStorage 恢复缓存（校验结构完整性）
(function() {
    try {
        var saved = localStorage.getItem('orderStatusCache');
        if (saved) {
            var parsed = JSON.parse(saved);
            if (parsed && typeof parsed === 'object') {
                orderStatusCache = parsed;
                if (!orderStatusCache.buyMap) orderStatusCache.buyMap = {};
                if (!orderStatusCache.sendMap) orderStatusCache.sendMap = {};
            }
        }
    } catch(e) {}
})();
var supplierSearchKeyword = ''; // 供货商关键字模糊搜索

var themes = ['purple', 'blue', 'green', 'dark', 'orange'];
var themeLabels = { purple: '💜 紫韵', blue: '🌊 海蓝', green: '🌿 翠绿', dark: '🌙 暗夜', orange: '🌅 暖橙' };

var supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ========== 权限系统 ==========
var defaultPermissions = { view_summary:true, edit_status:true, manage_order:true, manage_employees:true, manage_devices:true, manage_stores:true, manage_admins:false, sync_data:true, view_audit_log:true, manage_procurement:true };
function getPermissions() { return user.role === 'super_admin' ? Object.assign({}, defaultPermissions, { manage_admins:true }) : Object.assign({}, defaultPermissions, user.permissions || {}); }
function hasPermission(perm) { return getPermissions()[perm] === true; }
function checkPermission(perm, msg) { if (!hasPermission(perm)) { showAlert(msg || '您没有该操作的权限'); return false; } return true; }

function initPermissionUI() {
    var perms = getPermissions();
    var adminsTab = document.getElementById('adminsTabBtn'); if (adminsTab) adminsTab.style.display = user.role === 'super_admin' ? '' : 'none';
    var empTab = document.querySelector('[data-tab="employees"]'); if (empTab && !perms.manage_employees) empTab.style.display = 'none';
    var devTab = document.querySelector('[data-tab="devices"]'); if (devTab && !perms.manage_devices) devTab.style.display = 'none';
    var storeTab = document.querySelector('[data-tab="users"]'); if (storeTab && !perms.manage_stores) storeTab.style.display = 'none';
    var auditTab = document.querySelector('[data-tab="audit"]'); if (auditTab && !perms.view_audit_log) auditTab.style.display = 'none';
    // 采购记录按钮：无权限则隐藏
    var procBtn = document.querySelector('.tab-btn[onclick*="procurement"]');
    if (procBtn && !perms.manage_procurement) procBtn.style.display = 'none';
    var syncBtn = document.getElementById('syncPlanBtn'); if (syncBtn && !perms.sync_data) syncBtn.style.display = 'none';
    var selectAllTh = document.querySelector('#summaryTable th:first-child'); if (selectAllTh && !perms.edit_status) selectAllTh.style.display = 'none';
}

var savedTheme = localStorage.getItem('appTheme') || 'purple';
document.documentElement.setAttribute('data-theme', savedTheme);
document.getElementById('themeBtn').addEventListener('click', function() {
    var idx = themes.indexOf(document.documentElement.getAttribute('data-theme') || 'purple');
    var next = themes[(idx + 1) % themes.length];
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('appTheme', next); this.textContent = themeLabels[next];
});
document.getElementById('themeBtn').textContent = themeLabels[savedTheme];

document.getElementById('logoutBtn').addEventListener('click', async function() {
    showConfirm('确定退出登录？', async function() {
        try { await callEdgeFunction('logout_device', { target_type:'store', target_id:user.username, device_id:getDeviceId() }); } catch(e) {}
        localStorage.removeItem('token'); localStorage.removeItem('user'); window.location.href = './';
    }, null, '确定退出', '留在页面');
});

// Tab 切换
document.querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
        document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
        this.classList.add('active');
        document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
        var targetEl = document.getElementById('tab-' + (this.dataset.tab || ''));
        if (targetEl) targetEl.classList.add('active');
        if (this.dataset.tab === 'employees') loadEmployees();
        if (this.dataset.tab === 'devices') { loadPendingDevices(); loadAuthorizedDevices(); }
        if (this.dataset.tab === 'users') loadStores();
        if (this.dataset.tab === 'audit') loadLogs();
        stopAutoRefresh();
    });
});

// 自动刷新
document.getElementById('autoRefreshInterval').addEventListener('change', function() { var i = parseInt(this.value); if (i > 0) startAutoRefresh(i); else stopAutoRefresh(); });
document.getElementById('refreshBtn').addEventListener('click', async function() {
    var restore = setBtnLoading(this, '刷新中...');
    try { await loadSummary(); } finally { restore(); }
});
document.getElementById('refreshNewBtn').addEventListener('click', loadSummary);

function startAutoRefresh(interval) { stopAutoRefresh(); autoRefreshInterval = interval * 1000; document.getElementById('refreshIndicator').style.display = 'inline'; autoRefreshTimer = setInterval(function() { loadSummary(); }, autoRefreshInterval); }
function stopAutoRefresh() { if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; } document.getElementById('refreshIndicator').style.display = 'none'; }

// 批量选择
window.isBatchOperating = false;
window.toggleSelectAll = function() { var cb = document.getElementById('selectAllCheckbox'); document.querySelectorAll('.product-checkbox').forEach(function(cb2) { cb2.checked = cb.checked; var pc = cb2.dataset.productCode; if (cb.checked) selectedProducts[pc] = true; else delete selectedProducts[pc]; }); updateBatchToolbar(); };
window.toggleProductSelect = function(pc) { if (selectedProducts[pc]) delete selectedProducts[pc]; else selectedProducts[pc] = true; updateBatchToolbar(); var allC = true; document.querySelectorAll('.product-checkbox').forEach(function(cb) { if (!cb.checked) allC = false; }); document.getElementById('selectAllCheckbox').checked = allC; };
function updateBatchToolbar() { var c = Object.keys(selectedProducts).length; document.getElementById('selectedCount').textContent = c; document.getElementById('batchToolbar').style.display = c > 0 ? 'flex' : 'none'; }
window.clearSelection = function() { selectedProducts = {}; document.querySelectorAll('.product-checkbox').forEach(function(cb) { cb.checked = false; }); document.getElementById('selectAllCheckbox').checked = false; updateBatchToolbar(); };

window.batchSetArrived = async function() {
    if (!checkPermission('edit_status', '您没有批量修改状态的权限')) return;
    var codes = Object.keys(selectedProducts); if (codes.length === 0) return;
    if (window.isBatchOperating) return;
    if (!confirm('确定将选中 ' + codes.length + ' 个商品标记为「已到货」？')) return;
    window.isBatchOperating = true;
    var restore = setBtnLoading(document.getElementById('batchArrivedBtn'), '处理中...');
    try {
        var result = await callEdgeFunction('batch_update_status', { product_codes: codes, target_status: '已到货', operator: user.name || '管理员' });
        if (result.success) { showToast('批量标记完成！成功 ' + (result.data.success_count || codes.length) + ' 项', 'success'); }
        else { showAlert('批量标记失败：' + (result.error || '未知')); }
        clearSelection(); loadSummary();
    } finally { window.isBatchOperating = false; restore(); }
};

// 弹窗事件
document.getElementById('detailModalClose').addEventListener('click', function() { document.getElementById('detailModal').classList.remove('show'); });
document.getElementById('detailModal').addEventListener('click', function(e) { if (e.target === this) this.classList.remove('show'); });
document.getElementById('alertOkBtn').addEventListener('click', function() { document.getElementById('alertModal').classList.remove('show'); });

// ========== 状态变更日志 ==========
document.getElementById('statusLogQueryBtn').addEventListener('click', function() { fetchStatusChangeLog(document.getElementById('statusLogProductCode').value.trim() || null); });
document.getElementById('statusLogProductCode').addEventListener('keypress', function(e) { if (e.key === 'Enter') fetchStatusChangeLog(document.getElementById('statusLogProductCode').value.trim() || null); });

async function fetchStatusChangeLog(productCode) {
    var tbody = document.getElementById('statusLogTbody'); tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">⏳ 查询中...</td></tr>';
    try {
        var params = { top: 100 }; if (productCode) params.log_product_code = productCode;
        var result = await callEdgeFunction('get_status_change_log', params);
        if (!result.success) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);">查询失败</td></tr>'; return; }
        var logs = result.data || [];
        if (logs.length === 0) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);">暂无记录</td></tr>'; return; }
        tbody.innerHTML = '';
        logs.forEach(function(l) {
            var ds = l.变更时间 ? new Date(l.变更时间).toLocaleString('zh-CN') : '-';
            var ob = l.原状态 ? '<span class="replenish-badge replenish-text">' + safeText(l.原状态) + '</span>' : '-';
            var nb = '<span class="replenish-badge replenish-' + getBadgeClass(l.新状态) + '">' + safeText(l.新状态) + '</span>';
            tbody.innerHTML += '<tr><td style="font-size:12px;">'+safeText(ds)+'</td><td>'+safeText(l.商品编码||'-')+'</td><td>'+ob+'</td><td>'+nb+'</td><td>'+safeText(l.操作人||'-')+'</td><td style="font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis;">'+safeText(l.备注||'')+'</td></tr>';
        });
    } catch(e) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);">查询出错</td></tr>'; }
}
function getBadgeClass(status) { var m = { '待处理':'pending','已订购':'ordered','已完成':'completed','待付款':'payment','厂家断货':'outstock' }; return m[status] || 'text'; }

// 订货管理弹窗
document.getElementById('orderModalClose').addEventListener('click', function() { document.getElementById('orderModal').classList.remove('show'); });
document.getElementById('orderModal').addEventListener('click', function(e) { if (e.target === this) this.classList.remove('show'); });
document.getElementById('omCancelBtn').addEventListener('click', function() { document.getElementById('orderModal').classList.remove('show'); });
document.getElementById('omSaveBtn').addEventListener('click', handleOrderSave);

// ========== 一键同步（分步进度提示）==========
// 页面加载时从缓存读取上次同步时间
(function() {
    var lt = localStorage.getItem('lastSyncTime');
    var desc = '同步商品缓存 → 同步库存数据 → 自动检测状态变更';
    if (lt) document.getElementById('syncPlanBtn').title = desc + '\n上次同步：' + new Date(parseInt(lt)).toLocaleString('zh-CN');
})();
document.getElementById('syncPlanBtn').addEventListener('click', async function() {
    if (!checkPermission('sync_data', '您没有同步数据的权限')) return;
    var btn = this, restore = setBtnLoading(btn);
    btn.classList.add('btn-loading');
    try {
        btn.textContent = '同步商品数据... (1/3)';
        var pr = await callEdgeFunction('sync_product_cache', {});
        if (!pr.success) { showAlert('商品同步失败：' + (pr.error || '未知')); return; }
        btn.textContent = '同步库存数据... (2/3)';
        var r = await callEdgeFunction('sync_with_auto_status', {});
        if (!r.success) { showAlert('采购计划同步失败：' + (r.error || '未知')); return; }
        btn.textContent = '检测状态变更... (3/3)';
        btn.classList.remove('btn-loading'); btn.classList.add('btn-success');
        // 记录同步时间
        var now = Date.now();
        localStorage.setItem('lastSyncTime', now);
        btn.title = '同步商品缓存 → 同步库存数据 → 自动检测状态变更\n上次同步：' + new Date(now).toLocaleString('zh-CN');
        showToast('同步完成！商品' + (pr.data?.synced||0) + '个，已自动检测状态', 'success');
        loadSummary();
    } catch(e) { showAlert('同步异常：' + e.message); btn.classList.remove('btn-loading'); }
    finally { setTimeout(function() { restore(); btn.classList.remove('btn-success'); }, 1500); }
});

// ========== 校验异常按钮 ==========
document.getElementById('checkOrderBtn').addEventListener('click', async function() {
    var items = (summaryData && summaryData.shortage_by_product) || [];
    if (items.length === 0) { showAlert('请先加载数据'); return; }
    // 检测当前筛选后的所有商品
    var checkItems = filteredData.length > 0 ? filteredData : items;
    var codes = checkItems.map(function(p) { return p.product_code; });
    // 构建订购日期映射 + 门店映射
    var orderDates = {}, storePosNames = {};
    var storeNameById = {};
    STORE_CONFIG.forEach(function(s) { storeNameById[s.id] = s.name; });
    checkItems.forEach(function(p) {
        if (p.latest_report_time) {
            orderDates[p.product_code] = p.latest_report_time.slice(0, 10);
        }
        // 收集上报门店的PosName
        var names = [];
        for (var sid in p.stores) {
            var sn = storeNameById[sid] || '';
            if (sn && names.indexOf(sn) < 0) names.push(sn);
        }
        if (names.length > 0) storePosNames[p.product_code] = names;
    });
    if (codes.length === 0) { showAlert('没有商品可检测'); return; }
    var btn = this, restore = setBtnLoading(btn, '检测中...');
    btn.classList.add('btn-loading');
    try {
        var resp = await callEdgeFunction('check_order_status', { product_codes: codes, order_dates: orderDates, store_pos_names: storePosNames });
        if (!resp.success) { showAlert('检测失败：' + (resp.error || '未知')); return; }
        orderStatusCache = resp.data;
        localStorage.setItem('orderStatusCache', JSON.stringify(orderStatusCache));
        renderSummaryPage(); // 刷新显示
        // 统计异常
        var noBuy = codes.filter(function(c) { return !(resp.data.buyMap || {})[c]; });
        var noSend = codes.filter(function(c) { return !(resp.data.sendMap || {})[c]; });
        if (noBuy.length > 0 || noSend.length > 0) {
            showAlert('校验异常汇总：\n\n未入库：' + noBuy.length + ' 个商品\n未配送：' + noSend.length + ' 个商品\n\n请查看表格中的红色【未入库】【未配送】标记');
        } else {
            showToast('全部正常！已订购商品均已入库并配送', 'success');
        }
    } catch(e) { showAlert('检测异常：' + (e.message || '')); }
    finally { btn.classList.remove('btn-loading'); restore(); }
});

// 打开订货管理弹窗
window.showOrderManage = async function(productCode, productName) {
    if (!checkPermission('manage_order', '您没有管理订货数量的权限')) return;
    if (!productCode) return; currentEditProduct = productCode;
    var result = await callEdgeFunction('get_purchase_plan', { plan_product_code: productCode });
    var data = null;
    if (result.success && result.data) { var raw = result.data.plan ? result.data.plan[0] : result.data[0]; if (raw && raw[0]) data = raw[0]; }
    document.getElementById('omProductCode').textContent = productCode || '-';
    document.getElementById('omProductName').textContent = productName || (data ? data.商品名称 : '-');
    document.getElementById('omStock').textContent = data ? data.仓库库存数量 : '-';
    document.getElementById('omSuggested').textContent = data ? data.建议订货数量 : '-';
    document.getElementById('omCurrentStatus').innerHTML = data ? getReplenishBadge(data.补货状态) : getReplenishBadge('待处理');
    document.getElementById('omActualQty').value = (data && data.实际订货数量 > 0) ? data.实际订货数量 : '';
    document.getElementById('omTargetStatus').value = ''; document.getElementById('omRemark').value = (data && data.备注信息) || '';
    document.getElementById('orderModalTitle').textContent = '订货管理 - ' + (productName || productCode);
    document.getElementById('orderModal').classList.add('show');
};

async function handleOrderSave() {
    if (!checkPermission('manage_order', '您没有管理订货数量的权限')) return;
    if (!currentEditProduct) return;
    var aq = document.getElementById('omActualQty').value.trim(), ts = document.getElementById('omTargetStatus').value;
    var rk = document.getElementById('omRemark').value.trim(), op = user.name || user.phone || '管理员';
    if ((aq === '' || parseInt(aq) === 0) && !ts) { showAlert('请至少填写「实际订货数量」或选择「手动修改状态」'); return; }
    if (aq !== '') { var sqr = await callEdgeFunction('set_actual_order_qty', { product_code: currentEditProduct, actual_qty: parseInt(aq)||0, operator: op }); if (!sqr.success) { showAlert('设置订货数量失败'); return; } }
    if (ts) { var mr = await callEdgeFunction('manual_update_status', { product_code: currentEditProduct, target_status: ts, operator: op, remark: rk }); if (!mr.success) { showAlert('修改状态失败'); return; } }
    var msgs = []; if (aq !== '') msgs.push('订货数量已更新'); if (ts) msgs.push('状态改为「' + ts + '」');
    showAlert(msgs.join('\n') || '操作完成');
    document.getElementById('orderModal').classList.remove('show'); loadSummary();
}

// ========== 缺货汇总 ==========
async function loadSummary() {
    if (isLoadingSummary) return;
    isLoadingSummary = true;
    try {
        // 使用 get_summary 复合 action，一次请求获取 reports + plan
        var resp = await callEdgeFunction('get_summary', {});
        if (!resp.success) throw new Error(resp.error || '获取汇总失败');
        var reports = resp.data.reports || [], planRows = [], supplierLookup = resp.data.supplierLookup || {};
        if (resp.data.plan && resp.data.plan[0]) planRows = resp.data.plan[0];
        var planMap = {};
        if (planRows.length) planRows.forEach(function(p) { var nc = (p.商品编码||'').replace(/^0+/, ''); if (nc) planMap[nc] = p; });

        var storeNames = {}; STORE_CONFIG.forEach(function(s) { storeNames[s.id] = s.name; });

        summaryData = { overview: { reports_count: reports.length, stores: storeNames }, shortage_by_product: [], new_products: [], new_products_grouped: [], all_reports: reports };
        var sbp = {}, np = [], npg = {};

        // 交叉补全：从 reports 中的有效 product_name 建立映射，补全缺名的记录
        var reportNameMap = {};
        reports.forEach(function(r) { if (r.product_code && r.product_name) { reportNameMap[r.product_code] = r.product_name; reportNameMap[r.product_code.replace(/^0+/, '')] = r.product_name; } });

        reports.forEach(function(r) {
            var ri = r.reporter_name || '';
            if (r.order_type === '缺货订购') {
                var key = r.product_code, nk = key.replace(/^0+/, ''), pi = planMap[nk] || planMap[key];
                var sup = (pi && pi.供货商) || supplierLookup[nk] || supplierLookup[key] || '';
                var rs = (pi && pi.补货状态) || r.replenish_status || '待处理';
                var pname = (pi&&pi.商品名称) || r.product_name || reportNameMap[key] || reportNameMap[nk] || '';
                if (!sbp[key]) sbp[key] = { product_code:r.product_code, product_name:pname, specification:(pi&&pi.规格)||r.specification, manufacturer:(pi&&pi.生产企业)||r.manufacturer, supplier:sup, total_demand:0, replenish_status:rs, replenish_manual:(pi&&pi.实际订货数量)||0, dc_stock:(pi&&pi.仓库库存)||0, stores:{}, latest_report_time:'' };
                var rt = r.created_at || ''; if (rt > (sbp[key].latest_report_time||'')) sbp[key].latest_report_time = rt;
                sbp[key].total_demand += r.demand_quantity;
                sbp[key].stores[r.store_id] = { stock:r.current_stock, transit:r.in_transit, demand:r.demand_quantity, urgency_level:r.urgency_level||'普通', replenish_status:r.replenish_status||'待处理', reporter:ri, report_time:r.created_at };
            } else {
                np.push({ store_id:r.store_id, store_name:storeNames[r.store_id]||r.store_id, product_name:r.new_product_name, specification:r.new_specification, manufacturer:r.new_manufacturer, price_min:r.price_min, price_max:r.price_max, demand_quantity:r.demand_quantity, remark:r.remark, reporter:ri });
                var gk = r.new_product_name+'|'+r.new_specification;
                if (!npg[gk]) npg[gk] = { product_code: gk, product_name:r.new_product_name, specification:r.new_specification, manufacturer:r.new_manufacturer, total_demand:0, stores:[] };
                npg[gk].total_demand += r.demand_quantity; npg[gk].stores.push({ store_id:r.store_id, demand:r.demand_quantity });
            }
        });

        summaryData.shortage_by_product = Object.values(sbp).sort(function(a,b) { return (b.latest_report_time||'').localeCompare(a.latest_report_time||''); });
        summaryData.new_products = np; summaryData.new_products_grouped = Object.values(npg);

        var storeSet = {}; summaryData.shortage_by_product.forEach(function(p) { for (var sid in p.stores) storeSet[sid] = true; });
        document.getElementById('totalCount').textContent = summaryData.overview.reports_count;
        document.getElementById('productCount').textContent = summaryData.shortage_by_product.length;
        document.getElementById('storeCount').textContent = Object.keys(storeSet).length;
        // 新增卡片：待处理/已到货/今日上报
        var allForStats = summaryData.shortage_by_product;
        var pending = allForStats.filter(function(p) { return p.replenish_status === '待处理'; }).length;
        var arrived = allForStats.filter(function(p) { return p.replenish_status === '已到货'; }).length;
        var today = new Date().toISOString().slice(0,10);
        var todayReports = reports.filter(function(r) { return (r.created_at||'').slice(0,10) === today; }).length;
        document.getElementById('pendingCount').textContent = pending;
        document.getElementById('arrivedCount').textContent = arrived;
        document.getElementById('todayCount').textContent = todayReports;
        document.getElementById('newTotalCount').textContent = summaryData.new_products.reduce(function(s,n) { return s+n.demand_quantity; }, 0);
        document.getElementById('newProductCount').textContent = summaryData.new_products_grouped.length;
        document.getElementById('newTodayCount').textContent = reports.filter(function(r) { return r.order_type === '新品订购' && (r.created_at||'').slice(0,10) === today; }).length;

        var allItems = summaryData.shortage_by_product;
        completedData = allItems.filter(function(p) { return isCompletedStatus(p.replenish_status); });
        var activeData = allItems.filter(function(p) { return !isCompletedStatus(p.replenish_status); });

        // Excel样式供货商多选下拉初始化
        var suppliers = {};
        allItems.forEach(function(p) { if (p.supplier) suppliers[p.supplier] = true; });
        var supplierList = Object.keys(suppliers).sort();
        var dropdown = document.getElementById('supplierDropdown');
        dropdown.innerHTML = '<div class="excel-filter-option all"><label><input type="checkbox" class="excel-check" id="supplierCheckAll" checked onchange="toggleSupplierAllCheckbox(event)"> (全选)</label></div>';
        supplierList.forEach(function(s) {
            dropdown.innerHTML += '<div class="excel-filter-option" data-supplier="' + escapeHtml(s) + '"><label><input type="checkbox" class="excel-check" onchange="toggleSupplierItemCheckbox(this)"> ' + escapeHtml(s) + '</label></div>';
        });
        selectedSuppliers = [];
        updateSupplierDisplay();

        filteredData = activeData; currentPage = 1; currentFilterStatus = '';
        document.getElementById('statusFilter').value = '';
        selectedSuppliers = []; updateSupplierDisplay(); updateSupplierCheckmarks();
        renderSummaryPage(); renderCompletedSection();
        renderNewProductsTable();

        // 更新角标
        var ps = allItems.filter(function(p) { return p.replenish_status === '待处理'; }).length;
        var sb = document.getElementById('shortageBadge'); if (sb) { sb.textContent = ps > 0 ? ps : ''; sb.style.display = ps > 0 ? 'inline-block' : 'none'; }
        var nb = document.getElementById('newBadge'); if (nb) { var nc = summaryData.new_products_grouped.length; nb.textContent = nc > 0 ? nc : ''; nb.style.display = nc > 0 ? 'inline-block' : 'none'; }
        // 加载审批状态
        loadApprovals();
    } catch(err) { logError('加载汇总数据失败', err); showAlert('加载失败：' + friendlyErrorClient(err.message)); }
    finally { isLoadingSummary = false; }
}

var newProductApprovals = {}; // { product_code: { status, reason } }
function renderNewProductsTable() {
    var tbody = document.getElementById('newGroupTbody'); if (!tbody) return; tbody.innerHTML = '';
    summaryData.new_products_grouped.forEach(function(g, idx) {
        var approval = newProductApprovals[g.product_code] || {};
        var statusHtml = '';
        if (approval.status === '已审批') {
            statusHtml = '<span class="badge badge-approved" title="' + safeText(approval.reason || '') + '">已审批</span>';
        } else if (approval.status === '已驳回') {
            statusHtml = '<span class="badge badge-rejected" title="' + safeText(approval.reason || '') + '" style="cursor:pointer" onclick="showAlert(\'驳回原因：' + escapeHtml(approval.reason || '无') + '\')">已驳回</span>';
        } else {
            var canApprove = hasPermission('edit_status');
            statusHtml = canApprove
                ? '<button class="btn-sm btn-approve" onclick="approveNewProduct(\'' + escapeHtml(g.product_code) + '\')">审批</button><button class="btn-sm btn-reject" onclick="rejectNewProduct(\'' + escapeHtml(g.product_code) + '\')">驳回</button>'
                : '<span class="badge badge-pending">待处理</span>';
        }
        var delBtn = '<button class="btn-detail" style="color:#f44336;" onclick="deleteNewProduct(\'' + escapeHtml(g.product_code) + '\',\'' + escapeHtml(g.product_name || '') + '\')">删除</button>';
        tbody.innerHTML += '<tr><td>'+safeText(g.product_name)+'</td><td>'+safeText(g.specification)+'</td><td>'+safeText(g.manufacturer)+'</td><td>'+getUrgencyBadge('普通')+'</td><td><span class="type-badge type-new">'+safeText(g.total_demand)+'</span></td><td>'+statusHtml+'</td><td><button class="btn-detail" onclick="showNewDetail('+idx+')">明细</button></td><td>'+delBtn+'</td></tr>';
    });
}

function renderSummaryPage() {
    var tbody = document.getElementById('summaryTbody'); tbody.innerHTML = '';
    var canEdit = hasPermission('edit_status'), allItems = summaryData.shortage_by_product;
    var totalPages = Math.ceil(filteredData.length / pageSize) || 1;
    if (currentPage > totalPages) currentPage = totalPages;
    var start = (currentPage - 1) * pageSize, pageItems = filteredData.slice(start, start + pageSize);

    // 恢复索引映射
    var idxMap = {};
    pageItems.forEach(function(p) {
        for (var j = 0; j < allItems.length; j++) { if (allItems[j].product_code === p.product_code) { idxMap[p.product_code] = j; break; } }
    });

    pageItems.forEach(function(p) {
        var tr = document.createElement('tr'), isSel = selectedProducts[p.product_code] ? 'checked' : '';
        var statusDisplay, statusOptions = '';
        ORDER_STATUSES.forEach(function(s) { statusOptions += '<option value="'+s+'"'+(p.replenish_status===s?' selected':'')+'>'+s+'</option>'; });
        statusDisplay = canEdit ? '<select class="status-select" data-status="'+p.replenish_status+'" data-product-code="'+safeText(p.product_code)+'" onchange="updateReplenishStatus(this)">'+statusOptions+'</select>' : getReplenishBadge(p.replenish_status);
        var cbHtml = canEdit ? '<td><input type="checkbox" class="product-checkbox" data-product-code="'+safeText(p.product_code)+'" '+isSel+' onchange="toggleProductSelect(\''+escapeHtml(p.product_code)+'\')"></td>' : '<td></td>';
        var origIdx = idxMap[p.product_code] !== undefined ? idxMap[p.product_code] : 0;
        var ft = escapeHtml((p.product_code||'')+' '+(p.product_name||'')+' '+(p.specification||'')+' '+(p.manufacturer||''));
        var displayName = p.product_name || p.product_code || '';
        // 仅在编码/品名/规格列悬停时显示完整信息
        var nc = '<td title="'+escapeHtml(ft)+'"><span class="history-name">'+safeText(displayName)+'</span></td>';
        var codeTd = '<td title="'+escapeHtml(ft)+'">'+safeText(p.product_code)+'</td>';
        var specTd = '<td title="'+escapeHtml(ft)+'">'+safeText(p.specification||'')+'</td>';
        var sc = '<td style="white-space:nowrap;"><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;max-width:55px;text-align:left;" title="'+escapeHtml(p.supplier||'')+'">'+safeText(p.supplier||'-')+'</span></td>';
        // 入库/配送状态
        var buyStat = '-', sendStat = '-';
        if (orderStatusCache.buyMap) {
            buyStat = orderStatusCache.buyMap[p.product_code] ? '<span class="badge badge-ok">已入库</span>' : '<span class="badge badge-warn">未入库</span>';
        }
        if (orderStatusCache.sendMap) {
            sendStat = orderStatusCache.sendMap[p.product_code] ? '<span class="badge badge-ok">已配送</span>' : '<span class="badge badge-warn">未配送</span>';
        }
        tr.innerHTML = cbHtml + sc + codeTd + nc + specTd + '<td>'+getUrgencyBadge('普通')+'</td><td><span class="type-badge type-shortage">'+safeText(p.total_demand)+'</span></td><td>'+statusDisplay+'</td><td><button class="btn-detail" onclick="showShortageDetail('+origIdx+')">明细</button></td><td style="font-size:12px;">'+buyStat+'</td><td style="font-size:12px;">'+sendStat+'</td>';
        tbody.appendChild(tr);
    });

    var pb = document.getElementById('paginationBar'), pi = document.getElementById('pageInfo');
    var prev = document.getElementById('prevPageBtn'), next = document.getElementById('nextPageBtn');
    if (filteredData.length > pageSize) {
        pb.style.display = 'flex'; pi.textContent = '第 '+currentPage+' / '+totalPages+' 页（共 '+filteredData.length+' 条）';
        prev.disabled = currentPage <= 1; next.disabled = currentPage >= totalPages;
        var ji = document.getElementById('pageJumpInput');
        if (ji) { ji.max = totalPages; ji.value = currentPage; }
        // 生成页码按钮
        var pn = document.getElementById('pageNumbers');
        if (pn) {
            var html = '';
            var range = 2; // 当前页左右各显示几个
            for (var i = 1; i <= totalPages; i++) {
                var show = i === 1 || i === totalPages || (i >= currentPage - range && i <= currentPage + range);
                if (!show) {
                    // 检查是否需要省略号
                    if (i === currentPage - range - 1 || i === currentPage + range + 1) {
                        html += '<span style="padding:0 4px;color:#999;">...</span>';
                    }
                    continue;
                }
                // 重新渲染前清理重复省略号（把连续...合并）
                if (html.endsWith('<span style="padding:0 4px;color:#999;">...</span>') && i === currentPage - range) {
                    // 前一个已添加省略号，当前要显示的就直接追加，不重复加省略号
                }
                if (i === currentPage) {
                    html += '<button class="btn-pagenum active" onclick="goToPage(' + i + ')">' + i + '</button>';
                } else {
                    html += '<button class="btn-pagenum" onclick="goToPage(' + i + ')">' + i + '</button>';
                }
            }
            pn.innerHTML = html;
        }
    } else { pb.style.display = 'none'; }
}

window.changePage = function(delta) { currentPage += delta; renderSummaryPage(); };
window.goToPage = function(page) { currentPage = page; renderSummaryPage(); };
window.jumpToPage = function() {
    var inp = document.getElementById('pageJumpInput');
    var page = parseInt(inp.value);
    if (isNaN(page) || page < 1) page = 1;
    if (page > totalPages) page = totalPages;
    currentPage = page;
    renderSummaryPage();
};

function renderCompletedSection() {
    var cc = document.getElementById('completedCard'), ct = document.getElementById('completedTbody'), cn = document.getElementById('completedCount');
    if (completedData.length === 0) { cc.style.display = 'none'; return; }
    cc.style.display = ''; cn.textContent = '（共 '+completedData.length+' 条）'; ct.innerHTML = '';
    var allItems = summaryData.shortage_by_product;
    completedData.forEach(function(p) {
        var origIdx = 0;
        for (var j = 0; j < allItems.length; j++) { if (allItems[j].product_code === p.product_code) { origIdx = j; break; } }
        var tr = document.createElement('tr'), ft = escapeHtml((p.product_code||'')+' '+(p.product_name||'')+' '+(p.specification||'')+' '+(p.manufacturer||''));
        tr.setAttribute('title', ft);
        var so = ''; ORDER_STATUSES.forEach(function(s) { so += '<option value="'+s+'"'+(p.replenish_status===s?' selected':'')+'>'+s+'</option>'; });
        tr.innerHTML = '<td style="white-space:nowrap;"><span style="max-width:55px;overflow:hidden;text-overflow:ellipsis;display:block;" title="'+escapeHtml(p.supplier||'')+'">'+safeText(p.supplier||'-')+'</span></td><td>'+safeText(p.product_code)+'</td><td style="white-space:nowrap;"><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;">'+safeText(p.product_name)+'</span></td><td>'+safeText(p.specification||'')+'</td><td style="max-width:55px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="'+escapeHtml(p.manufacturer||'')+'">'+safeText(p.manufacturer||'-')+'</td><td style="color:'+(p.replenish_manual>0?'#e74c3c':'#999')+';font-weight:bold;">'+(p.replenish_manual>0?safeText(p.replenish_manual):'-')+'</td><td><select class="status-select" data-status="'+p.replenish_status+'" data-product-code="'+safeText(p.product_code)+'" onchange="updateReplenishStatus(this)">'+so+'</select></td><td><button class="btn-detail" onclick="showShortageDetail('+origIdx+')">明细</button></td>';
        ct.appendChild(tr);
    });
    document.getElementById('completedBody').style.display = 'none';
    document.getElementById('completedToggle').textContent = '▼ 展开';
}

window.toggleCompletedSection = function() {
    var body = document.getElementById('completedBody'), toggle = document.getElementById('completedToggle');
    if (body.style.display === 'none') { body.style.display = ''; toggle.textContent = '▲ 收起'; }
    else { body.style.display = 'none'; toggle.textContent = '▼ 展开'; }
};

window.applyStatusFilter = function() {
    var sv = document.getElementById('statusFilter').value;
    currentFilterStatus = sv; var allItems = summaryData.shortage_by_product || [];
    // 关键字模糊筛选：仅在未勾选供货商时生效（勾选后输入框显示的是选中项，非关键字）
    var sf = allItems;
    if (selectedSuppliers.length === 0) {
        var kw = document.getElementById('supplierSearchInput').value.trim();
        if (kw) {
            sf = sf.filter(function(p) { return p.supplier && p.supplier.toLowerCase().indexOf(kw.toLowerCase()) !== -1; });
        }
    } else {
        // 已勾选供货商时，忽略输入框文字，只用勾选筛选
        sf = sf.filter(function(p) { return selectedSuppliers.indexOf(p.supplier||'') >= 0; });
    }
    if (sv === '已完成') { filteredData = []; completedData = sf.filter(function(p) { return isCompletedStatus(p.replenish_status); }); }
    else if (!sv) { filteredData = sf.filter(function(p) { return !isCompletedStatus(p.replenish_status); }); completedData = sf.filter(function(p) { return isCompletedStatus(p.replenish_status); }); }
    else { filteredData = sf.filter(function(p) { return p.replenish_status === sv && !isCompletedStatus(p.replenish_status); }); completedData = sf.filter(function(p) { return isCompletedStatus(p.replenish_status); }); }
    currentPage = 1; renderSummaryPage(); renderCompletedSection();
};

// ========== 高级多条件筛选 ==========
var advFilterConditions = []; // [{field, op, value}]

// 切换高级筛选折叠
window.toggleAdvSection = function() {
    var sec = document.getElementById('advSection');
    var icon = document.getElementById('advToggleIcon');
    var isOpen = sec.style.display !== 'none';
    sec.style.display = isOpen ? 'none' : 'block';
    if (icon) icon.textContent = isOpen ? '▼' : '▲';
    if (!isOpen) {
        if (advFilterConditions.length === 0) addAdvFilterRow();
        renderAdvFilterRows();
    }
};

// 更新条件计数显示
function updateAdvCount() {
    var el = document.getElementById('advCondCount');
    if (el) {
        var cnt = advFilterConditions.filter(function(c) { return c.value && c.value.trim(); }).length;
        el.textContent = cnt > 0 ? '（'+cnt+'条生效）' : '';
    }
}

window.addAdvFilterRow = function() {
    advFilterConditions.push({ field: 'supplier', op: 'contains', value: '' });
    renderAdvFilterRows();
};

window.removeAdvFilterRow = function(idx) {
    advFilterConditions.splice(idx, 1);
    renderAdvFilterRows();
};

function renderAdvFilterRows() {
    var container = document.getElementById('advFilterRows');
    if (!container) return;
    var fields = [
        { key: 'supplier', label: '供货商' },
        { key: 'product_name', label: '品名' },
        { key: 'product_code', label: '编码' },
        { key: 'specification', label: '规格' },
        { key: 'replenish_status', label: '状态' }
    ];
    var ops = [
        { key: 'contains', label: '包含' },
        { key: 'equals', label: '等于' },
        { key: 'not_equals', label: '不等于' },
        { key: 'starts_with', label: '开头是' }
    ];
    var html = '';
    advFilterConditions.forEach(function(cond, i) {
        var fo = fields.map(function(f) {
            return '<option value="'+f.key+'"'+(cond.field===f.key?' selected':'')+'>'+f.label+'</option>';
        }).join('');
        var oo = ops.map(function(o) {
            return '<option value="'+o.key+'"'+(cond.op===o.key?' selected':'')+'>'+o.label+'</option>';
        }).join('');
        html += '<div style="display:flex;align-items:center;gap:4px;margin-bottom:6px;">' +
            '<select onchange="advFilterConditions['+i+'].field=this.value" style="width:72px;height:28px;font-size:12px;border-radius:4px;">'+fo+'</select>' +
            '<select onchange="advFilterConditions['+i+'].op=this.value" style="width:68px;height:28px;font-size:12px;border-radius:4px;">'+oo+'</select>' +
            '<input value="'+escapeHtml(cond.value)+'" oninput="advFilterConditions['+i+'].value=this.value" placeholder="输入值..." style="flex:1;height:28px;font-size:12px;border-radius:4px;border:1px solid var(--input-border);padding:0 6px;">' +
            '<button onclick="removeAdvFilterRow('+i+')" style="width:26px;height:26px;font-size:14px;border:none;background:#e74c3c;color:#fff;border-radius:4px;cursor:pointer;">✕</button>' +
            '</div>';
    });
    // AND 标记
    if (advFilterConditions.length > 1) {
        for (var j = 1; j < advFilterConditions.length; j++) {
            var markerIdx = html.indexOf('<div style="display:flex', html.indexOf('<div style="display:flex', 0) + 100 * (j - 1) + 1);
            // Better to insert AND marker between rows
        }
        // Simpler: wrap each subsequent row with AND prefix
        var rows = html.split('</div>');
        html = '';
        advFilterConditions.forEach(function(cond, i) {
            if (i > 0) html += '<div style="text-align:center;font-size:11px;color:var(--accent);font-weight:600;padding:2px 0;">AND</div>';
            html += rows[i] + '</div>';
        });
    }
    container.innerHTML = html;
    updateAdvCount();
}

window.applyAdvFilter = function() {
    var sf = (summaryData && summaryData.shortage_by_product) || [];
    if (!sf.length) { showAlert('请先加载数据'); return; }
    // 过滤出有效条件
    var valid = advFilterConditions.filter(function(c) { return c.value && c.value.trim(); });
    if (valid.length === 0) { showAlert('请输入至少一个筛选条件'); return; }
    sf = sf.filter(function(p) {
        return valid.every(function(c) {
            var fieldVal = (p[c.field] || '').toString().toLowerCase();
            var condVal = (c.value || '').toLowerCase();
            switch (c.op) {
                case 'contains': return fieldVal.indexOf(condVal) >= 0;
                case 'equals': return fieldVal === condVal;
                case 'not_equals': return fieldVal !== condVal;
                case 'starts_with': return fieldVal.indexOf(condVal) === 0;
                default: return true;
            }
        });
    });
    var sv = document.getElementById('statusFilter').value;
    currentFilterStatus = sv;
    if (sv === '已完成') { filteredData = []; completedData = sf.filter(function(p) { return isCompletedStatus(p.replenish_status); }); }
    else if (!sv) { filteredData = sf.filter(function(p) { return !isCompletedStatus(p.replenish_status); }); completedData = sf.filter(function(p) { return isCompletedStatus(p.replenish_status); }); }
    else { filteredData = sf.filter(function(p) { return p.replenish_status === sv && !isCompletedStatus(p.replenish_status); }); completedData = sf.filter(function(p) { return isCompletedStatus(p.replenish_status); }); }
    currentPage = 1; renderSummaryPage(); renderCompletedSection();
    updateAdvCount();
    showToast('高级筛选已应用（'+sf.length+' 条）', 'success');
};

window.clearAdvFilter = function() {
    advFilterConditions = [];
    renderAdvFilterRows();
    updateAdvCount();
    selectedSuppliers = [];
    updateSupplierDisplay();
    document.getElementById('supplierSearchInput').value = '';
    applyStatusFilter();
    showToast('筛选已清除', 'success');
};

window.updateReplenishStatus = async function(selectEl) {
    if (!checkPermission('edit_status', '您没有修改补货状态的权限')) return;
    var pc = selectEl.getAttribute('data-product-code'), ns = selectEl.value, os = selectEl.getAttribute('data-status')||'';
    if (!pc) return; selectEl.setAttribute('data-status', ns);
    if (!confirm('确定将 "'+pc+'" 状态改为 "'+ns+'"？')) { selectEl.value = os; selectEl.setAttribute('data-status', os); return; }
    var result = await callEdgeFunction('manual_update_status', { product_code: pc, target_status: ns, operator: user.name || '管理员' });
    if (!result.success) { showAlert('更新失败：'+(result.error||'未知')); selectEl.value = os; selectEl.setAttribute('data-status', os); return; }
    showToast('状态更新成功', 'success');
    // 更新内存数据（立即反映在筛选和表格中）
    if (summaryData && summaryData.shortage_by_product) {
        var item = summaryData.shortage_by_product.find(function(p) { return p.product_code === pc; });
        if (item) { item.replenish_status = ns; }
    }
    // 状态跨越已完成/非已完成时，重新加载数据以刷新表格分布
    if (isCompletedStatus(ns) || isCompletedStatus(os)) setTimeout(function() { loadSummary(); }, 500); else { currentPage = 1; applyStatusFilter(); }
};

window.showShortageDetail = function(idx) {
    if (!summaryData) return; var p = summaryData.shortage_by_product[idx]; if (!p) return;
    var displayName = p.product_name || p.product_code || '';
    // 如果名称仍是编码，从 all_reports 中最后尝试补全
    if (displayName === p.product_code) {
        var ar = summaryData.all_reports || [];
        for (var i = 0; i < ar.length; i++) { if (ar[i].product_code === p.product_code && ar[i].product_name) { displayName = ar[i].product_name; break; } }
    }
    document.getElementById('detailTitle').textContent = '需求明细';
    var ih = '<span style="font-weight:600;color:#1565c0;">'+safeText(p.product_code)+'</span> <span style="font-weight:600;color:#1565c0;">'+safeText(displayName)+'</span>';
    var sm = []; if (p.specification) sm.push(safeText(p.specification)); if (p.manufacturer) sm.push(safeText(p.manufacturer));
    if (sm.length > 0) ih += ' <span style="font-size:11px;color:#666;">('+sm.join(' | ')+')</span>';
    document.getElementById('detailProductInfo').innerHTML = ih;
    var tbody = document.getElementById('detailTbody'); tbody.innerHTML = '';
    var sns = summaryData.overview.stores, phoneToStore = { '15305479520':'wszhyy02' };
    function gsn(rid) { var mi = phoneToStore[rid]||rid; return sns[mi]||rid; }
    var sa = []; for (var sid in p.stores) { var s = p.stores[sid]; sa.push({ sid:sid, name:gsn(sid), stock:s.stock, transit:s.transit, demand:s.demand, report_time:s.report_time||'', reporter:s.reporter||'' }); }
    sa.sort(function(a,b) { return (b.report_time||'').localeCompare(a.report_time||''); });
    sa.forEach(function(s) { tbody.innerHTML += '<tr><td style="font-size:12px;color:#555;">'+safeText(s.report_time?new Date(s.report_time).toLocaleDateString('zh-CN'):'-')+'</td><td style="font-size:13px;">'+safeText(s.name)+'</td><td>'+safeText(s.stock)+'</td><td>'+safeText(s.transit)+'</td><td style="font-weight:600;color:var(--primary);">'+safeText(s.demand)+'</td><td style="font-size:12px;color:var(--text-muted);">'+safeText(s.reporter||'-')+'</td></tr>'; });
    document.getElementById('detailModal').classList.add('show');
};

// ========== 新品审批 ==========
// 管理员操作日志（静默，不阻塞主流程）
function logAdminAction(action, detail) {
    // 使用 callEdgeFunction 自动处理 token 续期，静默忽略错误
    callEdgeFunction('log_admin_action', { user: user.name || user.username, action: action, detail: detail }).catch(function() {});
}
async function loadApprovals() {
    try {
        var resp = await callEdgeFunction('get_approvals', {});
        if (resp.success && resp.data) {
            newProductApprovals = resp.data;
            renderNewProductsTable();
        }
    } catch(e) {}
}

window.approveNewProduct = async function(productCode) {
    if (!checkPermission('edit_status', '您没有审批权限')) return;
    var reason = prompt('审批通过？可输入备注（选填）：', '同意订购');
    if (reason === null) return;
    try {
        var resp = await callEdgeFunction('approve_report', { product_code: productCode, status: '已审批', reason: reason || '同意订购', operator: user.username || '管理员' });
        if (resp.success) { newProductApprovals[productCode] = { status: '已审批', reason: reason || '' }; renderNewProductsTable(); showToast('已审批！', 'success'); }
        else showAlert('审批失败：' + safeErrorMsg(resp.error));
    } catch(e) { showAlert('审批失败：' + safeErrorMsg(e)); }
};

window.rejectNewProduct = async function(productCode) {
    if (!checkPermission('edit_status', '您没有审批权限')) return;
    var reason = prompt('驳回原因（必填）：', '');
    if (!reason || !reason.trim()) { showAlert('驳回原因不能为空'); return; }
    try {
        var resp = await callEdgeFunction('approve_report', { product_code: productCode, status: '已驳回', reason: reason.trim(), operator: user.username || '管理员' });
        if (resp.success) { newProductApprovals[productCode] = { status: '已驳回', reason: reason.trim() }; renderNewProductsTable(); showToast('已驳回！', 'success'); }
        else showAlert('驳回失败：' + safeErrorMsg(resp.error));
    } catch(e) { showAlert('操作失败：' + safeErrorMsg(e)); }
};

// 安全提取错误信息，防止 [object Object]
function safeErrorMsg(err) {
    if (!err) return '未知错误';
    if (typeof err === 'string') return err;
    return err.message || err.details || err.hint || String(err);
}

// ========== 删除新品订购汇总 ==========
window.deleteNewProduct = async function(productCode, productName) {
    if (!checkPermission('edit_status', '您没有删除权限')) return;
    var name = productName || productCode;
    if (!confirm('确定删除新品【' + name + '】的所有上报记录吗？\n\n此操作不可撤销！')) return;
    try {
        var resp = await callEdgeFunction('delete_new_product', { product_code: productCode, operator: user.name || user.username || '管理员' });
        if (resp.success) {
            showToast('已删除新品：' + name, 'success');
            loadSummary();
        } else {
            showAlert('删除失败：' + safeErrorMsg(resp.error));
        }
    } catch(e) { showAlert('删除异常：' + safeErrorMsg(e)); }
};

window.showNewDetail = function(idx) {
    if (!summaryData) return; var g = summaryData.new_products_grouped[idx]; if (!g) return;
    document.getElementById('detailTitle').textContent = safeText(g.product_name) + ' - 需求明细';
    var tbody = document.getElementById('detailTbody'); tbody.innerHTML = '';
    var sns = summaryData.overview.stores, pts = { '15305479520':'wszhyy02' };
    g.stores.forEach(function(s) { tbody.innerHTML += '<tr><td>'+safeText(sns[pts[s.store_id]||s.store_id]||s.store_id)+'</td><td>-</td><td>-</td><td>'+getUrgencyBadge('普通')+'</td><td>'+safeText(s.demand)+'</td><td>-</td><td>-</td></tr>'; });
    document.getElementById('detailModal').classList.add('show');
};

// ========== 员工管理 ==========
var storeOptions = STORE_CONFIG.map(function(s) { return { id: s.id, name: s.name }; });
document.getElementById('addEmployeeBtn').addEventListener('click', showAddEmployeeModal);
document.getElementById('refreshEmpBtn').addEventListener('click', loadEmployees);
document.getElementById('empCancelBtn').addEventListener('click', function() { document.getElementById('empModal').classList.remove('show'); });
document.getElementById('empSaveBtn').addEventListener('click', handleAddEmployee);

function showAddEmployeeModal() {
    var sel = document.getElementById('empStoreSelect'); sel.innerHTML = '<option value="">请选择门店</option>';
    storeOptions.forEach(function(s) { var o = document.createElement('option'); o.value = s.id; o.textContent = s.name; sel.appendChild(o); });
    document.getElementById('empPhoneInput').value = ''; document.getElementById('empNameInput').value = '';
    document.getElementById('empModal').classList.add('show');
}

async function handleAddEmployee() {
    if (!checkPermission('manage_employees', '您没有管理员工的权限')) return;
    var ph = document.getElementById('empPhoneInput').value.trim(), nm = document.getElementById('empNameInput').value.trim(), si = document.getElementById('empStoreSelect').value;
    if (!ph || ph.length !== 11) { showAlert('请输入正确的11位手机号'); return; }
    if (!si) { showAlert('请选择所属门店'); return; }
    var sn = storeOptions.find(function(s) { return s.id === si; }).name || si;
    var result = await callEdgeFunction('add_employee', { phone:ph, name:nm, store_id:si, store_name:sn, created_by:user.id });
    if (result.success && result.data) { showToast('添加成功！' + ph + '可用手机号登录', 'success'); document.getElementById('empModal').classList.remove('show'); loadEmployees(); }
    else { showAlert('添加失败：' + (result.error || '未知错误')); }
}

async function loadEmployees() {
    try {
        var result = await callEdgeFunction('list_employees', {}), tbody = document.getElementById('employeeTbody'); tbody.innerHTML = '';
        if (!result.success || !result.data) { tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#999;">暂无员工数据</td></tr>'; return; }
        result.data.forEach(function(emp) {
            var bindings = emp.device_bindings || [];
            var ds = bindings.length > 0 ? '<span class="sync-success">已绑定('+bindings.length+'台)</span>' : '<span class="sync-fail">未绑定</span>';
            var sb = emp.is_active ? '<span class="replenish-badge replenish-ordered">正常</span>' : '<span class="replenish-badge replenish-text">停用</span>';
            var ts = emp.created_at ? new Date(emp.created_at).toLocaleString('zh-CN') : '-';
            var ah = '';
            if (emp.is_active) { ah += '<button class="btn-detail" onclick="toggleEmployee(\''+emp.id+'\', false)">停用</button> '; if (bindings.length > 0) ah += '<button class="btn-detail" style="color:red;" onclick="unbindDevice(\''+escapeHtml(bindings[0].device_id||'')+'\')">解绑</button>'; }
            else { ah = '<button class="btn-detail" onclick="toggleEmployee(\''+emp.id+'\', true)">启用</button>'; }
            tbody.innerHTML += '<tr><td>'+safeText(emp.phone)+'</td><td>'+safeText(emp.name||'-')+'</td><td>'+safeText(emp.store_name)+'</td><td>'+ds+'</td><td>'+sb+'</td><td style="font-size:12px;">'+safeText(ts)+'</td><td><button class="btn-primary" style="padding:4px 8px;font-size:12px;" onclick="showPasswordModal(\''+emp.id+'\',\''+escapeHtml(emp.phone)+'\')">修改密码</button></td><td>'+ah+'</td></tr>';
        });
    } catch(err) { logError('员工列表加载失败', err); }
}

window.toggleEmployee = async function(id, a) { if (!checkPermission('manage_employees')) return; if (!confirm(a?'确定启用？':'确定停用？停用后将无法登录')) return; await callEdgeFunction('toggle_employee', { id:id, is_active:a }); loadEmployees(); };
window.unbindDevice = async function(did) { if (!checkPermission('manage_devices')) return; if (!confirm('确定解绑？')) return; await callEdgeFunction('revoke_device', { device_id:did, target_type:'employee', target_id:'' }); showToast('解绑成功', 'success'); loadEmployees(); };

// ========== 修改密码 ==========
var currentEditEmpId = '';
document.getElementById('pwdCancelBtn').addEventListener('click', function() { document.getElementById('passwordModal').classList.remove('show'); clearPasswordModal(); });
window.showPasswordModal = function(id, phone) { if (!checkPermission('manage_employees')) return; currentEditEmpId = id; document.getElementById('pwdEmpPhone').value = phone; document.getElementById('pwdNewPassword').value = ''; document.getElementById('pwdConfirmPassword').value = ''; document.getElementById('passwordModal').classList.add('show'); };
function clearPasswordModal() { currentEditEmpId = ''; document.getElementById('pwdEmpPhone').value = ''; document.getElementById('pwdNewPassword').value = ''; document.getElementById('pwdConfirmPassword').value = ''; }
document.getElementById('pwdSaveBtn').addEventListener('click', async function() {
    var np = document.getElementById('pwdNewPassword').value.trim(), cp = document.getElementById('pwdConfirmPassword').value.trim();
    if (!np) { showAlert('请输入新密码'); return; } if (np.length < 4) { showAlert('密码至少4位'); return; } if (np !== cp) { showAlert('两次密码不一致'); return; }
    if (!confirm('确定修改密码？')) return;
    try { var r = await callEdgeFunction('update_employee_password', { id:currentEditEmpId, new_password:np }); if (r.success) { showToast('密码修改成功', 'success'); document.getElementById('passwordModal').classList.remove('show'); clearPasswordModal(); } else showAlert('修改失败：'+(r.error||'未知')); } catch(e) { showAlert('修改失败：'+e.message); }
});

// ========== 设备授权管理 ==========
document.getElementById('refreshDeviceBtn').addEventListener('click', loadPendingDevices);

async function loadPendingDevices() {
    try { var result = await callEdgeFunction('get_pending_devices', {}), tbody = document.getElementById('deviceTbody'); tbody.innerHTML = ''; if (!result.success) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#999;">暂无待授权设备</td></tr>'; return; } var devices = result.data.store_devices || []; if (devices.length === 0) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#999;">暂无待授权设备</td></tr>'; return; } var SND = {}; STORE_CONFIG.forEach(function(s) { SND[s.id] = s.name; }); SND['15305479520'] = '02第二药店'; devices.forEach(function(dev) { var dn = SND[dev.username] || dev.username, ch = ''; if (dev.conflict) { var bn = SND[dev.conflict.bound_to] || dev.conflict.bound_to; ch = ' <span style="color:#e74c3c;font-size:11px;">⚠ 被「'+safeText(bn)+'」绑定，授权后自动解除</span>'; } var ts = dev.last_login_at ? new Date(dev.last_login_at).toLocaleString('zh-CN') : '-'; tbody.innerHTML += '<tr><td>门店账号</td><td>'+safeText(dn)+'</td><td style="font-size:11px;word-break:break-all;">'+safeText(dev.device_id)+'</td><td>'+safeText(ts)+'</td><td><span class="replenish-badge replenish-text">待授权</span>'+ch+'</td><td><button class="btn-primary" onclick="authorizeDevice(\''+escapeHtml(dev.device_id)+'\',\'store\',\''+escapeHtml(dev.username)+'\',true)">授权</button> <button class="btn-detail" style="color:red;" onclick="authorizeDevice(\''+escapeHtml(dev.device_id)+'\',\'store\',\''+escapeHtml(dev.username)+'\',false)">拒绝</button></td></tr>'; }); } catch(err) { document.getElementById('deviceTbody').innerHTML = '<tr><td colspan="6" style="text-align:center;color:red;">加载失败</td></tr>'; } }

window.authorizeDevice = async function(did, tt, ti, auth) { if (!checkPermission('manage_devices')) return; if (!confirm(auth?'确定授权？授权后可正常登录':'确定拒绝？拒绝后需重新申请')) return; var r = await callEdgeFunction('authorize_device', { device_id:did, target_type:tt, target_id:ti, authorize:auth }); if (r.success) { showToast(auth?'授权成功':'已拒绝', 'success'); loadPendingDevices(); loadAuthorizedDevices(); } else showAlert('操作失败：'+(r.error||'未知')); };

window.batchAuthorizeAll = async function() {
    if (!checkPermission('manage_devices')) return;
    var r = await callEdgeFunction('get_pending_devices', {}); if (!r.success || !r.data) { showAlert('获取列表失败'); return; }
    var devs = r.data.store_devices || []; if (devs.length === 0) { showAlert('没有待授权设备'); return; }
    if (!confirm('确定一键授权全部 '+devs.length+' 个设备？')) return;
    var dl = devs.map(function(d) { return { device_id:d.device_id, target_id:d.username, target_type:'store' }; });
    var br = await callEdgeFunction('batch_authorize', { device_list:dl, authorize:true });
    if (br.success) { showToast('批量授权完成！成功 '+br.data.success_count+' 个'+(br.data.fail_count>0?'，失败 '+br.data.fail_count+' 个':''), 'success'); loadPendingDevices(); loadAuthorizedDevices(); }
    else showAlert('批量授权失败');
};

async function loadAuthorizedDevices() {
    try { var tbody = document.getElementById('authorizedDeviceTbody'); tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#999;">加载中...</td></tr>'; var r = await callEdgeFunction('debug_get_all_authorized', {}); if (!r.success || !r.data) { tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#999;">暂无已授权设备</td></tr>'; return; } var all = r.data; tbody.innerHTML = ''; if (all.length === 0) { tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#999;">暂无已授权设备</td></tr>'; return; } var seen = {}, ud = all.filter(function(d) { var k = d.username+'|'+d.device_id; if (seen[k]) return false; seen[k] = true; return true; }); var er = await callEdgeFunction('list_employees', {}), sr = await callEdgeFunction('list_stores', {}), em = {}; if (er.success && er.data) er.data.forEach(function(e) { em[e.phone] = e; }); var sm = {}; if (sr.success && sr.data) sr.data.forEach(function(s) { sm[s.username] = s; }); var snd = {}; STORE_CONFIG.forEach(function(s) { snd[s.id] = s.name; }); snd['15305479520'] = '02第二药店'; ud.forEach(function(d) { var ts = (d.authorized_at || d.last_login_at) ? new Date(d.authorized_at || d.last_login_at).toLocaleString('zh-CN') : '-'; var sb = d.is_authorized ? '<span class="replenish-badge replenish-ordered">已授权</span>' : '<span class="replenish-badge replenish-text">未授权</span>'; var tt = '门店', dn = snd[d.username] || d.username; if (em[d.username]) { tt = '员工'; dn = em[d.username].name || d.username; } tbody.innerHTML += '<tr><td>'+safeText(tt)+'</td><td>'+safeText(dn)+'</td><td>'+safeText(d.username)+'</td><td style="font-size:11px;word-break:break-all;">'+safeText(d.device_id)+'</td><td>'+sb+'</td><td><button class="btn-detail" style="color:red;" onclick="revokeDevice(\''+escapeHtml(d.device_id)+'\',\''+safeText(tt==='员工'?'employee':'store')+'\',\''+escapeHtml(d.username)+'\')">撤销</button></td></tr>'; }); } catch(err) { document.getElementById('authorizedDeviceTbody').innerHTML = '<tr><td colspan="5" style="text-align:center;color:red;">加载失败</td></tr>'; } }

window.revokeDevice = async function(did, tt, ti) { if (!checkPermission('manage_devices')) return; if (!confirm('确定撤销？撤销后需重新申请授权')) return; var r = await callEdgeFunction('revoke_device', { device_id:did, target_type:tt, target_id:ti }); if (r.success) { showToast('已撤销', 'success'); loadAuthorizedDevices(); loadPendingDevices(); } };
window.clearAllDeviceAuth = async function() { if (!checkPermission('manage_devices')) return; if (!confirm('警告：此操作将清除所有设备授权，所有门店必须重新申请授权！\n\n确定继续？')) return; var r = await callEdgeFunction('clear_all_device_auth', {}); if (r.success) showToast('已清除 '+ (r.data.device_count||0) +' 个设备授权', 'success'); else showAlert('清除失败'); loadAuthorizedDevices(); loadPendingDevices(); };

// ========== 门店管理 ==========
async function loadStores() { /* 使用STORE_CONFIG */ var tbody = document.getElementById('usersTbody'); tbody.innerHTML = ''; STORE_CONFIG.forEach(function(s) { tbody.innerHTML += '<tr><td>'+s.id+'</td><td style="white-space:nowrap;">'+s.name+'</td><td style="text-align:center;"><span class="replenish-badge replenish-done">正常</span></td></tr>'; }); }

// ========== 操作日志 ==========
var auditPage = 0, auditPageSize = 10, auditAllLogs = [];
document.getElementById('refreshAuditBtn').addEventListener('click', loadLogs);
async function loadLogs() { try { var r = await callEdgeFunction('get_audit_log', { limit:200 }); if (!r.success) throw new Error(r.error||'加载失败'); auditAllLogs = r.data || []; auditPage = 0; renderAuditPage(); } catch(err) { document.getElementById('auditTbody').innerHTML = '<tr><td colspan="4" style="text-align:center;color:red;">加载失败</td></tr>'; } }
function renderAuditPage() { var tb = document.getElementById('auditTbody'); if (auditAllLogs.length === 0) { tb.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#999;">暂无日志</td></tr>'; return; } var s = auditPage * auditPageSize, pi = auditAllLogs.slice(s, s + auditPageSize), tp = Math.ceil(auditAllLogs.length / auditPageSize); tb.innerHTML = ''; pi.forEach(function(l) { tb.innerHTML += '<tr><td>'+safeText(l.time?new Date(l.time).toLocaleString('zh-CN'):'-')+'</td><td>'+safeText(l.user||'-')+'</td><td>'+safeText(l.action||'-')+'</td><td>'+safeText(l.detail||'-')+'</td></tr>'; }); var pd = document.getElementById('auditPagination') || document.createElement('div'); pd.id = 'auditPagination'; pd.style.cssText = 'display:flex;justify-content:center;align-items:center;gap:12px;padding:12px 0;'; pd.innerHTML = tp > 1 ? '<button onclick="auditPage=Math.max(0,auditPage-1);renderAuditPage()" '+(auditPage===0?'disabled style="opacity:0.4"':'')+' style="padding:6px 14px;border:1px solid var(--input-border);border-radius:6px;cursor:pointer;">上一页</button><span>第 '+(auditPage+1)+'/'+tp+' 页（共 '+auditAllLogs.length+' 条）</span><button onclick="auditPage=Math.min('+(tp-1)+',auditPage+1);renderAuditPage()" '+(auditPage>=tp-1?'disabled style="opacity:0.4"':'')+' style="padding:6px 14px;border:1px solid var(--input-border);border-radius:6px;cursor:pointer;">下一页</button>' : ''; if (!document.getElementById('auditPagination')) tb.parentElement.parentElement.appendChild(pd); }

// ========== 子账号管理 ==========
document.getElementById('addAdminBtn').addEventListener('click', showAddAdminModal);
document.getElementById('refreshAdminBtn').addEventListener('click', loadAdmins);
document.getElementById('adminCancelBtn').addEventListener('click', function() { document.getElementById('adminModal').classList.remove('show'); });
document.getElementById('adminSaveBtn').addEventListener('click', handleAddAdmin);
document.getElementById('adminRoleSelect').addEventListener('change', function() { var iv = this.value === 'viewer'; document.querySelectorAll('.perm-check').forEach(function(cb) { var p = cb.dataset.perm; if (iv) { cb.checked = (p === 'view_summary' || p === 'view_audit_log'); cb.disabled = true; } else { cb.checked = (p !== 'manage_admins'); cb.disabled = false; } }); });

function showAddAdminModal() { document.getElementById('adminModalTitle').textContent = '添加子账号'; document.getElementById('adminEditId').value = ''; document.getElementById('adminUsernameInput').value = ''; document.getElementById('adminPasswordInput').value = ''; document.getElementById('adminNameInput').value = ''; document.getElementById('adminRoleSelect').value = 'admin'; document.getElementById('adminUsernameInput').disabled = false; document.getElementById('adminPasswordInput').placeholder = '登录密码'; document.querySelectorAll('.perm-check').forEach(function(cb) { var p = cb.dataset.perm; cb.checked = (p !== 'manage_admins'); cb.disabled = false; }); document.getElementById('adminModal').classList.add('show'); }
function getAdminPermissionsFromUI() { var p = {}; document.querySelectorAll('.perm-check').forEach(function(cb) { p[cb.dataset.perm] = cb.checked; }); return p; }

async function handleAddAdmin() { var id = document.getElementById('adminEditId').value, un = document.getElementById('adminUsernameInput').value.trim(), pw = document.getElementById('adminPasswordInput').value, nm = document.getElementById('adminNameInput').value.trim(), rl = document.getElementById('adminRoleSelect').value, ps = getAdminPermissionsFromUI(); if (!id) { if (!un) { showAlert('请输入账号'); return; } if (!pw || pw.length < 6) { showAlert('密码至少6位'); return; } if (!nm) nm = un; var r = await callEdgeFunction('add_admin_user', { username:un, password:pw, name:nm, role:rl, permissions:ps, created_by:user.id }); if (r.success && r.data) { showToast('添加成功！'+un+'可登录', 'success'); document.getElementById('adminModal').classList.remove('show'); loadAdmins(); } else showAlert('添加失败：'+(r.error||'未知')); } else { var r2 = await callEdgeFunction('update_admin_user', { id:id, name:nm, role:rl, permissions:ps }); if (r2.success && r2.data) { showToast('修改成功', 'success'); document.getElementById('adminModal').classList.remove('show'); loadAdmins(); } else showAlert('修改失败：'+(r2.error||'未知')); } }

async function loadAdmins() { try { var r = await callEdgeFunction('list_admin_users', {}), tb = document.getElementById('adminTbody'); tb.innerHTML = ''; if (!r.success || !r.data) { tb.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#999;">暂无子账号</td></tr>'; return; } var rl = { super_admin:'超级管理员', admin:'普通管理员', viewer:'只读用户' }; r.data.forEach(function(a) { var pc = Object.keys(a.permissions||{}).filter(function(k) { return a.permissions[k] === true; }).length; var sb = a.is_active ? '<span class="replenish-badge replenish-ordered">正常</span>' : '<span class="replenish-badge replenish-text">停用</span>'; var ts = a.created_at ? new Date(a.created_at).toLocaleString('zh-CN') : '-'; var ah = a.role !== 'super_admin' ? '<button class="btn-detail" onclick="editAdmin(\''+a.id+'\')">编辑</button> <button class="btn-detail" onclick="toggleAdminStatus(\''+a.id+'\','+(!a.is_active)+')">'+(a.is_active?'停用':'启用')+'</button> <button class="btn-detail" style="color:red;" onclick="deleteAdmin(\''+a.id+'\')">删除</button>' : '<span style="color:#999;font-size:12px;">不可操作</span>'; tb.innerHTML += '<tr><td>'+safeText(a.username)+'</td><td>'+safeText(a.name||'-')+'</td><td>'+safeText(rl[a.role]||a.role)+'</td><td>'+pc+' 项</td><td>'+sb+'</td><td style="font-size:12px;">'+safeText(ts)+'</td><td>'+ah+'</td></tr>'; }); } catch(err) {} }

window.editAdmin = async function(id) { try { var r = await callEdgeFunction('list_admin_users', {}); if (!r.success || !r.data) return; var a = r.data.find(function(x) { return x.id === id; }); if (!a) return; document.getElementById('adminModalTitle').textContent = '编辑子账号'; document.getElementById('adminEditId').value = a.id; document.getElementById('adminUsernameInput').value = a.username; document.getElementById('adminUsernameInput').disabled = true; document.getElementById('adminPasswordInput').value = ''; document.getElementById('adminPasswordInput').placeholder = '不修改请留空'; document.getElementById('adminNameInput').value = a.name || ''; document.getElementById('adminRoleSelect').value = a.role; document.querySelectorAll('.perm-check').forEach(function(cb) { var p = cb.dataset.perm; cb.checked = (a.permissions||{})[p] === true; cb.disabled = false; }); document.getElementById('adminModal').classList.add('show'); } catch(e) {} };
window.toggleAdminStatus = async function(id, a) { if (!confirm(a?'确定启用？':'确定停用？')) return; var r = await callEdgeFunction('toggle_admin_user', { id:id, is_active:a }); if (r.success) { showToast(a?'已启用':'已停用', 'success'); loadAdmins(); } else showAlert('失败'); };
window.deleteAdmin = async function(id) { if (!confirm('确定删除？删除后无法恢复')) return; var r = await callEdgeFunction('delete_admin_user', { id:id }); if (r.success) { showToast('已删除', 'success'); loadAdmins(); } else showAlert('删除失败'); };

// Tab 增强
document.querySelectorAll('.tab-btn').forEach(function(b) { b.addEventListener('click', function() { if (this.dataset.tab === 'admins') loadAdmins(); }); });

// ========== 页面初始化 ==========
loadSummary();
initPermissionUI();

// ========== 管理员操作日志（记录关键操作）==========
var _originalUpdateReplenish = window.updateReplenishStatus;
window.updateReplenishStatus = async function(sel) {
    var pc = sel.getAttribute('data-product-code'), ns = sel.value, os = sel.getAttribute('data-status')||'';
    await _originalUpdateReplenish(sel);
    // 记录操作日志
    try { await callEdgeFunction('log_admin_action', { user:user.name||user.username, action:'修改补货状态', detail:pc+' '+os+'→'+ns }); } catch(e) {}
};

// ========== 供货商 Excel 样式筛选下拉 ==========
var _supplierSearchTimer = 0;
var _pendingSuppliers = []; // 暂存临时勾选

window.toggleExcelFilter = function(e) {
    e.stopPropagation();
    var panel = document.getElementById('supplierFilterPanel');
    if (panel.classList.contains('show')) { panel.classList.remove('show'); return; }
    _pendingSuppliers = selectedSuppliers.slice();
    updateSupplierCheckmarks();
    updateSupplierDropdownFilter(document.getElementById('supplierSearchInput').value.trim());
    panel.classList.add('show');
    setTimeout(function() { document.getElementById('supplierSearchInput').focus(); }, 50);
    setTimeout(function() {
        var closeFn = function(ev) {
            var wrap = document.getElementById('supplierFilterWrap');
            if (wrap && !wrap.contains(ev.target)) { panel.classList.remove('show'); document.removeEventListener('click', closeFn); }
        };
        document.addEventListener('click', closeFn);
    }, 100);
};

window.onSupplierKeywordChange = function() {
    clearTimeout(_supplierSearchTimer);
    _supplierSearchTimer = setTimeout(function() {
        var kw = document.getElementById('supplierSearchInput').value.trim();
        updateSupplierDropdownFilter(kw);
        if (kw) {
            // 有关键字：自动勾选匹配项
            var dropdown = document.getElementById('supplierDropdown');
            var opts = dropdown.querySelectorAll('.excel-filter-option:not(.all)');
            _pendingSuppliers = [];
            opts.forEach(function(o) {
                if (o.style.display !== 'none') {
                    var s = o.getAttribute('data-supplier');
                    if (s) _pendingSuppliers.push(s);
                }
            });
            updateSupplierCheckmarks();
        } else {
            // 清空搜索 → 重置为全选
            _pendingSuppliers = [];
            updateSupplierCheckmarks();
        }
    }, 200);
};

function updateSupplierDropdownFilter(kw) {
    var dropdown = document.getElementById('supplierDropdown');
    if (!dropdown) return;
    var opts = dropdown.querySelectorAll('.excel-filter-option:not(.all)');
    var kwLower = (kw||'').toLowerCase();
    opts.forEach(function(o) {
        var s = (o.getAttribute('data-supplier') || '').toLowerCase();
        o.style.display = (!kwLower || s.indexOf(kwLower) !== -1) ? '' : 'none';
    });
}

window.toggleSupplierAllCheckbox = function(e) {
    e.stopPropagation();
    var cb = document.getElementById('supplierCheckAll');
    var checked = cb ? cb.checked : false;
    var dropdown = document.getElementById('supplierDropdown');
    var kw = document.getElementById('supplierSearchInput').value.trim();
    var opts = dropdown.querySelectorAll('.excel-filter-option:not(.all)');
    var visibleOpts = kw ? Array.from(opts).filter(function(o) { return o.style.display !== 'none'; }) : Array.from(opts);
    if (checked) {
        // 全选 → 清空 _pendingSuppliers
        _pendingSuppliers = [];
    } else {
        // 全部勾选可见项
        visibleOpts.forEach(function(o) { var s = o.getAttribute('data-supplier'); if (s && _pendingSuppliers.indexOf(s) < 0) _pendingSuppliers.push(s); });
    }
    updateSupplierCheckmarks();
};

window.toggleSupplierItemCheckbox = function(cb) {
    var row = cb.closest('.excel-filter-option');
    var supplier = row ? row.getAttribute('data-supplier') : null;
    if (!supplier) return;
    var idx = _pendingSuppliers.indexOf(supplier);
    if (cb.checked) {
        if (idx < 0) _pendingSuppliers.push(supplier);
    } else {
        if (idx >= 0) _pendingSuppliers.splice(idx, 1);
    }
    updateSupplierCheckmarks();
};

window.applySupplierFilter = function() {
    selectedSuppliers = _pendingSuppliers.slice();
    updateSupplierDisplay();
    document.getElementById('supplierFilterPanel').classList.remove('show');
    applyStatusFilter();
};

window.cancelSupplierFilter = function() {
    _pendingSuppliers = selectedSuppliers.slice();
    document.getElementById('supplierFilterPanel').classList.remove('show');
};

function updateSupplierCheckmarks() {
    var dropdown = document.getElementById('supplierDropdown');
    var opts = dropdown.querySelectorAll('.excel-filter-option:not(.all)');
    opts.forEach(function(o) {
        var s = o.getAttribute('data-supplier') || '';
        var cb = o.querySelector('input[type=checkbox]');
        if (cb) cb.checked = _pendingSuppliers.indexOf(s) >= 0;
    });
    // 全选复选框：当没有任何选中项时勾选，否则不勾选
    var allCb = document.getElementById('supplierCheckAll');
    if (allCb) allCb.checked = _pendingSuppliers.length === 0;
    // 更新全选行计数文本（保留 checkbox 元素不变）
    var allOptDiv = dropdown.querySelector('.excel-filter-option.all');
    if (allOptDiv) {
        var label = allOptDiv.querySelector('label');
        if (label) {
            var txtNode = label.lastChild;
            if (txtNode && txtNode.nodeType === 3) {
                txtNode.textContent = ' (全选)' + (_pendingSuppliers.length > 0 ? '（已选' + _pendingSuppliers.length + '项）' : '');
            }
        }
    }
}

function updateSupplierDisplay() {
    var text = document.getElementById('supplierFilterText');
    if (!text) return;
    if (selectedSuppliers.length === 0) {
        text.textContent = '筛选';
    } else if (selectedSuppliers.length <= 2) {
        text.textContent = selectedSuppliers.join(', ');
    } else {
        text.textContent = selectedSuppliers[0] + ', ' + selectedSuppliers[1] + '...共' + selectedSuppliers.length + '项';
    }
}


