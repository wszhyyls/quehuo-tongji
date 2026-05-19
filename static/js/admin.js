// ========================================
// 缺货统计系统 - 管理后台 (v21)
// 优化：同步采购计划时自动同步商品缓存（从ZHYYLS.Vptype获取完整数据）
// ========================================

var token = localStorage.getItem('token');
var user = null;
try {
    user = JSON.parse(localStorage.getItem('user') || 'null');
} catch(e) {
    logError('用户信息解析失败', e);
    window.location.href = './';
}
var summaryData = null;
var currentEditProduct = null;  // 当前正在编辑的商品

// 批量选择相关
var selectedProducts = {};  // {productCode: true}

// 自动刷新相关
var autoRefreshTimer = null;
var autoRefreshInterval = 60000;  // 默认1分钟

var themes = ['purple', 'blue', 'green', 'dark', 'orange'];
var themeLabels = { purple: '💜 紫韵', blue: '🌊 海蓝', green: '🌿 翠绿', dark: '🌙 暗夜', orange: '🌅 暖橙' };

var SUPABASE_URL = "https://qswpgnnedqvuegwfbprd.supabase.co";
var SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzd3Bnbm5lZHF2dWVnd2ZicHJkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3Mjc0NjEsImV4cCI6MjA5NDMwMzQ2MX0.mY_nlWoHc5UYDHB9jOif0zkYJ2OVx79KTgejcSGkhBI";
var EDGE_FUNCTION_URL = SUPABASE_URL + "/functions/v1/query-shortage-data";

var supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

if (!token || !user || (user.role !== 'admin' && user.role !== 'super_admin')) { window.location.href = './'; }

// ========== 权限系统 ==========
// 默认权限（向后兼容：无permissions字段的管理员拥有全部权限）
var defaultPermissions = {
    view_summary: true, edit_status: true, manage_order: true,
    manage_employees: true, manage_devices: true, manage_stores: true,
    manage_admins: false, sync_data: true, view_audit_log: true
};

function getPermissions() {
    if (user.role === 'super_admin') {
        return { ...defaultPermissions, manage_admins: true };
    }
    return Object.assign({}, defaultPermissions, user.permissions || {});
}

function hasPermission(perm) {
    return getPermissions()[perm] === true;
}

function checkPermission(perm, msg) {
    if (!hasPermission(perm)) {
        showAlert(msg || '您没有该操作的权限');
        return false;
    }
    return true;
}

// 根据权限初始化界面
function initPermissionUI() {
    var perms = getPermissions();
    var isSuper = user.role === 'super_admin';

    // 子账号管理Tab：仅超级管理员可见
    var adminsTab = document.getElementById('adminsTabBtn');
    if (adminsTab) adminsTab.style.display = isSuper ? '' : 'none';

    // 员工管理Tab
    var empTab = document.querySelector('[data-tab="employees"]');
    if (empTab && !perms.manage_employees) empTab.style.display = 'none';

    // 设备授权Tab
    var devTab = document.querySelector('[data-tab="devices"]');
    if (devTab && !perms.manage_devices) devTab.style.display = 'none';

    // 门店管理Tab
    var storeTab = document.querySelector('[data-tab="users"]');
    if (storeTab && !perms.manage_stores) storeTab.style.display = 'none';

    // 操作日志Tab
    var auditTab = document.querySelector('[data-tab="audit"]');
    if (auditTab && !perms.view_audit_log) auditTab.style.display = 'none';

    // 同步采购计划按钮
    var syncBtn = document.getElementById('syncPlanBtn');
    if (syncBtn && !perms.sync_data) syncBtn.style.display = 'none';

    // 批量操作：无 edit_status 权限时隐藏全选和批量按钮
    var selectAllTh = document.querySelector('#summaryTable th:first-child');
    if (selectAllTh && !perms.edit_status) selectAllTh.style.display = 'none';

    console.log('[权限] 当前用户权限:', perms);
}

var savedTheme = localStorage.getItem('appTheme') || 'purple';
document.documentElement.setAttribute('data-theme', savedTheme);

document.getElementById('themeBtn').addEventListener('click', function() {
    var current = document.documentElement.getAttribute('data-theme') || 'purple';
    var idx = themes.indexOf(current);
    var next = themes[(idx + 1) % themes.length];
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('appTheme', next);
    this.textContent = themeLabels[next];
});
document.getElementById('themeBtn').textContent = themeLabels[savedTheme];

document.getElementById('logoutBtn').addEventListener('click', async function() {
    if (!confirm('确定退出登录？')) return;
    
    // 调用退出登录接口
    try {
        await callEdgeFunction('logout_device', {
            target_type: 'store',
            target_id: user.username,
            device_id: getDeviceId()
        });
    } catch(e) {}
    
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = './';
});

// Tab 切换
document.querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
        document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
        this.classList.add('active');
        document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
        var tabId = 'tab-' + (this.dataset.tab || '');
        var targetEl = document.getElementById(tabId);
        if (targetEl) targetEl.classList.add('active');

        // 员工管理Tab激活时加载员工列表
        if (this.dataset.tab === 'employees') loadEmployees();
        
        // 设备授权Tab激活时加载待授权设备 + 已授权设备
        if (this.dataset.tab === 'devices') {
            loadPendingDevices();
            loadAuthorizedDevices();
        }
        
        // 门店管理Tab
        if (this.dataset.tab === 'users') loadStores();
        
        // 操作日志Tab
        if (this.dataset.tab === 'audit') loadLogs();
        
        // 切换Tab时停止自动刷新
        stopAutoRefresh();
    });
});

// 自动刷新设置
document.getElementById('autoRefreshInterval').addEventListener('change', function() {
    var interval = parseInt(this.value);
    if (interval > 0) {
        startAutoRefresh(interval);
    } else {
        stopAutoRefresh();
    }
});

document.getElementById('refreshBtn').addEventListener('click', loadSummary);
document.getElementById('refreshNewBtn').addEventListener('click', loadSummary);

// 自动刷新函数
function startAutoRefresh(interval) {
    stopAutoRefresh();
    autoRefreshInterval = interval * 1000;
    document.getElementById('refreshIndicator').style.display = 'inline';
    autoRefreshTimer = setInterval(function() {
        loadSummary();
    }, autoRefreshInterval);
}

function stopAutoRefresh() {
    if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
    }
    document.getElementById('refreshIndicator').style.display = 'none';
}

// 批量选择相关函数
window.isBatchOperating = false;

window.toggleSelectAll = function() {
    var checkbox = document.getElementById('selectAllCheckbox');
    var checkboxes = document.querySelectorAll('.product-checkbox');
    checkboxes.forEach(function(cb) {
        cb.checked = checkbox.checked;
        var productCode = cb.dataset.productCode;
        if (checkbox.checked) {
            selectedProducts[productCode] = true;
        } else {
            delete selectedProducts[productCode];
        }
    });
    updateBatchToolbar();
};

window.toggleProductSelect = function(productCode) {
    if (selectedProducts[productCode]) {
        delete selectedProducts[productCode];
    } else {
        selectedProducts[productCode] = true;
    }
    updateBatchToolbar();
    
    // 更新全选状态
    var checkboxes = document.querySelectorAll('.product-checkbox');
    var allChecked = true;
    var anyChecked = false;
    checkboxes.forEach(function(cb) {
        if (!cb.checked) allChecked = false;
        if (cb.checked) anyChecked = true;
    });
    document.getElementById('selectAllCheckbox').checked = allChecked;
};

function updateBatchToolbar() {
    var count = Object.keys(selectedProducts).length;
    document.getElementById('selectedCount').textContent = count;
    document.getElementById('batchToolbar').style.display = count > 0 ? 'flex' : 'none';
}

window.clearSelection = function() {
    selectedProducts = {};
    document.querySelectorAll('.product-checkbox').forEach(function(cb) {
        cb.checked = false;
    });
    document.getElementById('selectAllCheckbox').checked = false;
    updateBatchToolbar();
};

// 批量标记已到货
window.batchSetArrived = async function() {
    if (!checkPermission('edit_status', '您没有批量修改状态的权限')) return;
    var productCodes = Object.keys(selectedProducts);
    if (productCodes.length === 0) return;
    if (isBatchOperating) return;
    
    if (!confirm('确定要将选中的 ' + productCodes.length + ' 个商品标记为「已到货」？')) return;
    
    isBatchOperating = true;
    var batchBtn = document.getElementById('batchArrivedBtn');
    var originalText = batchBtn ? batchBtn.textContent : '批量标记已到货';
    if (batchBtn) { batchBtn.disabled = true; batchBtn.textContent = '处理中...'; }
    
    var successCount = 0;
    var failCount = 0;
    
    try {
        for (var i = 0; i < productCodes.length; i++) {
            var code = productCodes[i];
            var result = await callEdgeFunction('manual_update_status', {
                product_code: code,
                target_status: '已到货',
                operator: user.name || '管理员',
                remark: '批量操作'
            });
            if (result.success) {
                successCount++;
            } else {
                failCount++;
            }
        }
        
        if (failCount === 0) {
            showAlert('批量标记完成！成功 ' + successCount + ' 项');
        } else {
            showAlert('完成！成功 ' + successCount + ' 项，失败 ' + failCount + ' 项');
        }
        
        clearSelection();
        loadSummary();
    } finally {
        isBatchOperating = false;
        if (batchBtn) { batchBtn.disabled = false; batchBtn.textContent = originalText; }
    }
};

document.getElementById('detailModalClose').addEventListener('click', function() {
    document.getElementById('detailModal').classList.remove('show');
});
document.getElementById('detailModal').addEventListener('click', function(e) {
    if (e.target === this) this.classList.remove('show');
});
document.getElementById('alertOkBtn').addEventListener('click', function() {
    document.getElementById('alertModal').classList.remove('show');
});

function showAlert(msg) { document.getElementById('alertMsg').textContent = msg; document.getElementById('alertModal').classList.add('show'); }

// ========== 订货状态管理 ==========
document.getElementById('orderModalClose').addEventListener('click', function() {
    document.getElementById('orderModal').classList.remove('show');
});
document.getElementById('orderModal').addEventListener('click', function(e) {
    if (e.target === this) this.classList.remove('show');
});
document.getElementById('omCancelBtn').addEventListener('click', function() {
    document.getElementById('orderModal').classList.remove('show');
});
document.getElementById('omSaveBtn').addEventListener('click', handleOrderSave);

// 同步采购计划按钮（增加自动检测）
document.getElementById('syncPlanBtn').addEventListener('click', async function() {
    if (!checkPermission('sync_data', '您没有同步数据的权限')) return;
    this.disabled = true;
    this.textContent = '同步商品数据...';
    try {
        // 第一步：先同步商品缓存（从ZHYYLS.Vptype获取完整商品列表）
        var productResult = await callEdgeFunction('sync_product_cache', {});
        if (!productResult.success) {
            showAlert('商品数据同步失败：' + (productResult.error || '未知错误'));
            return;
        }
        var syncedCount = productResult.data?.synced || 0;
        
        // 第二步：同步采购计划
        this.textContent = '同步采购计划...';
        var result = await callEdgeFunction('sync_with_auto_status', {});
        if (result.success) {
            showAlert(`同步完成！商品数据：${syncedCount}个，已自动检测订货状态变化`);
            loadSummary();
        } else {
            showAlert('采购计划同步失败：' + (result.error || '未知错误'));
        }
    } catch(e) { showAlert('同步异常：' + e.message); }
    finally { this.disabled = false; this.textContent = '同步采购计划'; }
});

// 打开订货管理弹窗
window.showOrderManage = async function(productCode, productName) {
    if (!checkPermission('manage_order', '您没有管理订货数量的权限')) return;
    if (!productCode) return;
    currentEditProduct = productCode;
    
    // 从 Edge Function 获取该商品最新的采购计划数据
    var result = await callEdgeFunction('get_purchase_plan', { plan_product_code: productCode });
    
    var data = null;
    if (result.success && result.data && result.data[0] && result.data[0][0]) {
        data = result.data[0][0];
    }

    document.getElementById('omProductCode').textContent = productCode || '-';
    document.getElementById('omProductName').textContent = productName || (data ? data.商品名称 : '-');
    document.getElementById('omStock').textContent = data ? data.仓库库存数量 : '-';
    document.getElementById('omSuggested').textContent = data ? data.建议订货数量 : '-';
    document.getElementById('omCurrentStatus').innerHTML = data ? getReplenishBadge(data.补货状态) : getReplenishBadge('待处理');
    
    document.getElementById('omActualQty').value = (data && data.实际订货数量 > 0) ? data.实际订货数量 : '';
    document.getElementById('omTargetStatus').value = '';
    document.getElementById('omRemark').value = (data && data.备注信息) || '';
    document.getElementById('orderModalTitle').textContent = '订货管理 - ' + (productName || productCode);
    document.getElementById('orderModal').classList.add('show');
};

// 保存订货修改
async function handleOrderSave() {
    if (!checkPermission('manage_order', '您没有管理订货数量的权限')) return;
    if (!currentEditProduct) return;

    var actualQtyVal = document.getElementById('omActualQty').value.trim();
    var actualQty = actualQtyVal === '' ? 0 : parseInt(actualQtyVal);
    var targetStatus = document.getElementById('omTargetStatus').value;
    var remark = document.getElementById('omRemark').value.trim();
    var operator = user.name || user.phone || '管理员';

    // 至少需要填写一个
    if (actualQty === 0 && !targetStatus) {
        showAlert('请至少填写「实际订货数量」或选择「手动修改状态」');
        return;
    }

    // 步骤1: 设置实际订货数量（如果有值或清空）
    var setQtyResult = null;
    if (actualQtyVal !== '') {
        setQtyResult = await callEdgeFunction('set_actual_order_qty', {
            product_code: currentEditProduct,
            actual_qty: actualQty,
            operator: operator
        });
        if (!setQtyResult.success) {
            showAlert('设置订货数量失败：' + (setQtyResult.error || '未知'));
            return;
        }
    }

    // 步骤2: 手动修改状态（如果选择了目标状态）
    if (targetStatus) {
        var manualResult = await callEdgeFunction('manual_update_status', {
            product_code: currentEditProduct,
            target_status: targetStatus,
            operator: operator,
            remark: remark
        });
        if (!manualResult.success) {
            showAlert('修改状态失败：' + (manualResult.error || '未知'));
            return;
        }
    }

    // 成功提示
    var msgs = [];
    if (setQtyResult && setQtyResult.data && setQtyResult.data[0]) {
        msgs.push('订货数量已更新 → ' + setQtyResult.data[0].新状态);
    }
    if (targetStatus) {
        msgs.push('状态手动改为「' + targetStatus + '」');
    }
    alert(msgs.join('\n') || '操作完成');

    document.getElementById('orderModal').classList.remove('show');
    loadSummary();  // 刷新列表
}

function getUrgencyBadge(level) {
    var cls = 'urgency-badge ';
    if (level === '紧急') cls += 'urgency-urgent';
    else if (level === '加急') cls += 'urgency-expedite';
    else cls += 'urgency-normal';
    return '<span class="' + cls + '">' + (level || '普通') + '</span>';
}

function getReplenishBadge(status) {
    var cls = 'replenish-badge ';
    var label = status || '待处理';
    if (label === '已订购' || label === '已下单') cls += 'replenish-ordered';
    else if (label === '在途') cls += 'replenish-intransit';
    else if (label === '已到货' || label === '到货') cls += 'replenish-arrived';
    else if (label === '待处理') cls += 'replenish-pending';
    else cls += 'replenish-text';
    return '<span class="' + cls + '">' + label + '</span>';
}

// ========== Edge Function 调用（异常统一处理）==========
async function callEdgeFunction(action, params) {
    try {
        var resp = await fetch(EDGE_FUNCTION_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({ action: action, params: params })
        });
        var respBody = await resp.json().catch(function() { return {}; });
        if (!resp.ok) {
            var errMsg = respBody.error || respBody.message || ('请求失败: ' + resp.status);
            throw new Error(errMsg);
        }
        return respBody;
    } catch(err) { 
        logError('Edge Function调用失败', err);
        return { success: false, error: err.message }; 
    }
}

// ========== 缺货汇总（带上报人信息）==========
async function loadSummary() {
    try {
        // 同时获取上报数据和采购计划数据
        var [resultReports, resultPlan] = await Promise.all([
            callEdgeFunction('get_reports', {}),
            callEdgeFunction('get_purchase_plan', {})
        ]);

        if (!resultReports.success) throw new Error(resultReports.error || '获取上报数据失败');
        var reports = resultReports.data || [];
        
        // 构建采购计划数据Map
        var planMap = {};
        if (resultPlan.success && resultPlan.data && resultPlan.data[0]) {
            resultPlan.data[0].forEach(function(p) {
                planMap[p.商品编码] = p;
            });
        }

        summaryData = {
            overview: {
                reports_count: reports.length,
                stores: {
                    'wszhyy02': '02第二药店', 'wszhyy03': '03第三药店',
                    'wszhyy04': '04第四药店', 'wszhyy06': '06常口店',
                    'wszhyy08': '08第八药店', 'wszhyy09': '09第九药店',
                    'wszhyy14': '14第十四药店', 'wszhyy16': '16凤凰山药店',
                    'wszhyy17': '17益丰店', 'wszhyy21': '21富源店'
                }
            },
            shortage_by_product: [],
            new_products: [],
            new_products_grouped: [],
            all_reports: reports
        };

        var shortageByProduct = {};
        var newProducts = [];
        var newProductsGrouped = {};

        reports.forEach(function(r) {
            // 记录上报人信息到stores中
            var reporterInfo = r.reporter_name ? r.reporter_name : '';

            if (r.order_type === '缺货订购') {
                var key = r.product_code;
                
                // 从采购计划获取完整商品信息
                var planInfo = planMap[key];
                var spec = (planInfo && planInfo.规格) ? planInfo.规格 : r.specification;
                var manu = (planInfo && planInfo.生产企业) ? planInfo.生产企业 : r.manufacturer;
                var actualQty = (planInfo && planInfo.实际订货数量) ? planInfo.实际订货数量 : 0;
                var stockQty = (planInfo && planInfo.仓库库存) ? planInfo.仓库库存 : 0;
                
                // 使用 SQL Server 返回的真实补货状态
                var realStatus = (planInfo && planInfo.补货状态) ? planInfo.补货状态 : '待处理';
                
                if (!shortageByProduct[key]) {
                    shortageByProduct[key] = {
                        product_code: r.product_code,
                        product_name: (planInfo && planInfo.商品名称) ? planInfo.商品名称 : r.product_name,
                        specification: spec,
                        manufacturer: manu,
                        total_demand: 0,
                        replenish_status: realStatus,
                        replenish_manual: actualQty,
                        dc_stock: stockQty,
                        stores: {}
                    };
                }
                shortageByProduct[key].total_demand += r.demand_quantity;
                shortageByProduct[key].stores[r.store_id] = {
                    stock: r.current_stock, transit: r.in_transit,
                    demand: r.demand_quantity,
                    urgency_level: r.urgency_level || '普通',
                    replenish_status: r.replenish_status || '待处理',
                    reporter: reporterInfo,
                    report_time: r.created_at
                };
            } else {
                newProducts.push({
                    store_id: r.store_id,
                    store_name: summaryData.overview.stores[r.store_id] || r.store_id,
                    product_name: r.new_product_name,
                    specification: r.new_specification,
                    manufacturer: r.new_manufacturer,
                    price_min: r.price_min, price_max: r.price_max,
                    demand_quantity: r.demand_quantity, remark: r.remark,
                    reporter: reporterInfo
                });

                var groupKey = r.new_product_name + '|' + r.new_specification;
                if (!newProductsGrouped[groupKey]) {
                    newProductsGrouped[groupKey] = {
                        product_name: r.new_product_name,
                        specification: r.new_specification,
                        manufacturer: r.new_manufacturer,
                        total_demand: 0, stores: []
                    };
                }
                newProductsGrouped[groupKey].total_demand += r.demand_quantity;
                newProductsGrouped[groupKey].stores.push({ store_id: r.store_id, demand: r.demand_quantity });
            }
        });

        summaryData.shortage_by_product = Object.values(shortageByProduct);
        summaryData.new_products = newProducts;
        summaryData.new_products_grouped = Object.values(newProductsGrouped);

        var storeSet = {};
        summaryData.shortage_by_product.forEach(function(p) {
            for (var sid in p.stores) { storeSet[sid] = true; }
        });

        document.getElementById('totalCount').textContent = summaryData.overview.reports_count;
        document.getElementById('productCount').textContent = summaryData.shortage_by_product.length;
        document.getElementById('storeCount').textContent = Object.keys(storeSet).length;

        var newTotal = summaryData.new_products.reduce(function(sum, n) { return sum + n.demand_quantity; }, 0);
        document.getElementById('newTotalCount').textContent = newTotal;
        document.getElementById('newProductCount').textContent = summaryData.new_products_grouped.length;

        // 渲染缺货汇总表（增强XSS防护）
        var tbody = document.getElementById('summaryTbody');
        tbody.innerHTML = '';
        var canEdit = hasPermission('edit_status');
        summaryData.shortage_by_product.forEach(function(p, idx) {
            var tr = document.createElement('tr');
            var isSelected = selectedProducts[p.product_code] ? 'checked' : '';
            
            // 构建状态显示（有权限=下拉框，无权限=只读标签）
            var statusDisplay;
            if (canEdit) {
                var statusOptions = '';
                var statuses = ['待处理', '已订购', '已到货'];
                statuses.forEach(function(s) {
                    statusOptions += '<option value="' + s + '"' + (p.replenish_status === s ? ' selected' : '') + '>' + s + '</option>';
                });
                statusDisplay = '<select class="status-select" data-product-code="' + safeText(p.product_code) + '" onchange="updateReplenishStatus(this)">' + statusOptions + '</select>';
            } else {
                statusDisplay = getReplenishBadge(p.replenish_status);
            }
            
            var checkboxHtml = canEdit
                ? '<td><input type="checkbox" class="product-checkbox" data-product-code="' + safeText(p.product_code) + '" ' + isSelected + ' onchange="toggleProductSelect(\'' + escapeHtml(p.product_code) + '\')"></td>'
                : '<td></td>';
            
            tr.innerHTML = checkboxHtml +
                '<td>' + safeText(p.product_code) + '</td>' +
                '<td>' + safeText(p.product_name) + '</td><td>' + safeText(p.specification || '') + '</td>' +
                '<td>' + safeText(p.manufacturer || '') + '</td><td>' + getUrgencyBadge('普通') + '</td>' +
                '<td><span class="type-badge type-shortage">' + safeText(p.total_demand) + '</span></td>' +
                '<td style="color:' + (p.replenish_manual > 0 ? '#e74c3c' : '#999') + ';font-weight:bold;">' + 
                    (p.replenish_manual > 0 ? safeText(p.replenish_manual) : '-') + '</td>' +
                '<td>' + statusDisplay + '</td>' +
                '<td>' +
                    '<button class="btn-detail" onclick="showShortageDetail(' + idx + ')">明细</button>' +
                '</td>';
            tbody.appendChild(tr);
        });

        // 渲染新品汇总表（增强XSS防护）
        var newGroupTbody = document.getElementById('newGroupTbody');
        newGroupTbody.innerHTML = '';
        summaryData.new_products_grouped.forEach(function(g, idx) {
            var tr = document.createElement('tr');
            tr.innerHTML = '<td>' + safeText(g.product_name) + '</td><td>' + safeText(g.specification) + '</td>' +
                '<td>' + safeText(g.manufacturer) + '</td><td>' + getUrgencyBadge('普通') + '</td>' +
                '<td><span class="type-badge type-new">' + safeText(g.total_demand) + '</span></td>' +
                '<td><button class="btn-detail" onclick="showNewDetail(' + idx + ')">明细</button></td>';
            newGroupTbody.appendChild(tr);
        });
        
        // 更新Tab角标
        var pendingShortage = summaryData.shortage_by_product.filter(function(p) { return p.replenish_status === '待处理'; }).length;
        var shortageBadge = document.getElementById('shortageBadge');
        if (shortageBadge) {
            shortageBadge.textContent = pendingShortage > 0 ? pendingShortage : '';
            shortageBadge.style.display = pendingShortage > 0 ? 'inline-block' : 'none';
        }
        var newBadge = document.getElementById('newBadge');
        if (newBadge) {
            var newCount = summaryData.new_products_grouped.length;
            newBadge.textContent = newCount > 0 ? newCount : '';
            newBadge.style.display = newCount > 0 ? 'inline-block' : 'none';
        }
    } catch(err) { logError('加载汇总数据失败', err); showAlert('加载失败：' + err.message); }
}

// ========== 更新补货状态 ==========
window.updateReplenishStatus = async function(selectEl) {
    if (!checkPermission('edit_status', '您没有修改补货状态的权限')) return;
    try {
        var productCode = selectEl.getAttribute('data-product-code');
        var newStatus = selectEl.value;
        
        if (!productCode) return;
        
        var confirmMsg = '确定要将商品 "' + productCode + '" 的状态更新为 "' + newStatus + '" 吗？';
        if (!confirm(confirmMsg)) {
            // 恢复原状态
            loadSummary();
            return;
        }
        
        var result = await callEdgeFunction('manual_update_status', {
            product_code: productCode,
            target_status: newStatus,
            operator: '管理员'
        });
        
        if (!result.success) {
            showAlert('更新失败：' + (result.error || '未知错误'));
            loadSummary(); // 刷新数据
            return;
        }
        
        showAlert('状态更新成功');
    } catch(err) {
        logError('更新补货状态失败', err);
        showAlert('更新失败：' + err.message);
        loadSummary();
    }
}

window.showShortageDetail = function(idx) {
    if (!summaryData) return;
    var p = summaryData.shortage_by_product[idx]; if (!p) return;
    document.getElementById('detailTitle').textContent = safeText(p.product_name) + ' - 需求明细（含上报人）';
    var tbody = document.getElementById('detailTbody');
    tbody.innerHTML = '';
    var storeNames = summaryData.overview.stores;
    var storeArray = [];
    for (var sid in p.stores) {
        var s = p.stores[sid];
        storeArray.push({
            name: storeNames[sid] || sid, stock: s.stock, transit: s.transit,
            urgency: s.urgency_level || '普通', demand: s.demand,
            replenish_status: s.replenish_status, reporter: s.reporter || ''
        });
    }
    storeArray.sort(function(a, b) { return a.name.localeCompare(b.name, 'zh-CN'); });
    storeArray.forEach(function(s) {
        var tr = document.createElement('tr');
        tr.innerHTML = '<td>' + safeText(s.name) + '</td><td>' + safeText(s.stock) + '</td><td>' + safeText(s.transit) + '</td>' +
            '<td>' + getUrgencyBadge(s.urgency) + '</td><td>' + safeText(s.demand) + '</td>' +
            '<td>' + getReplenishBadge(s.replenish_status) + '</td>' +
            '<td style="font-size:12px;color:#667eea;">' + safeText(s.reporter || '-') + '</td>';
        tbody.appendChild(tr);
    });
    document.getElementById('detailModal').classList.add('show');
};

window.showNewDetail = function(idx) {
    if (!summaryData) return;
    var g = summaryData.new_products_grouped[idx]; if (!g) return;
    document.getElementById('detailTitle').textContent = safeText(g.product_name) + ' - 需求明细';
    var tbody = document.getElementById('detailTbody');
    tbody.innerHTML = '';
    var storeNames = summaryData.overview.stores;
    g.stores.forEach(function(s) {
        var tr = document.createElement('tr');
        tr.innerHTML = '<td>' + safeText(storeNames[s.store_id] || s.store_id) + '</td><td>-</td><td>-</td>' +
            '<td>' + getUrgencyBadge('普通') + '</td><td>' + safeText(s.demand) + '</td><td>-</td><td>-</td>';
        tbody.appendChild(tr);
    });
    document.getElementById('detailModal').classList.add('show');
};

// ========== 员工管理 ==========
var storeOptions = [
    { id: 'wszhyy02', name: '02第二药店' }, { id: 'wszhyy03', name: '03第三药店' },
    { id: 'wszhyy04', name: '04第四药店' }, { id: 'wszhyy06', name: '06常口店' },
    { id: 'wszhyy08', name: '08第八药店' }, { id: 'wszhyy09', name: '09第九药店' },
    { id: 'wszhyy14', name: '14第十四药店' }, { id: 'wszhyy16', name: '16凤凰山药店' },
    { id: 'wszhyy17', name: '17益丰店' }, { id: 'wszhyy21', name: '21富源店' }
];

// 添加员工按钮
document.getElementById('addEmployeeBtn').addEventListener('click', showAddEmployeeModal);
document.getElementById('refreshEmpBtn').addEventListener('click', loadEmployees);
document.getElementById('empCancelBtn').addEventListener('click', function() {
    document.getElementById('empModal').classList.remove('show');
});
document.getElementById('empSaveBtn').addEventListener('click', handleAddEmployee);

function showAddEmployeeModal() {
    // 填充门店下拉框
    var select = document.getElementById('empStoreSelect');
    select.innerHTML = '<option value="">请选择门店</option>';
    storeOptions.forEach(function(s) {
        var opt = document.createElement('option');
        opt.value = s.id; opt.textContent = s.name;
        select.appendChild(opt);
    });
    document.getElementById('empPhoneInput').value = '';
    document.getElementById('empNameInput').value = '';
    document.getElementById('empModal').classList.add('show');
}

async function handleAddEmployee() {
    if (!checkPermission('manage_employees', '您没有管理员工的权限')) return;
    var phone = document.getElementById('empPhoneInput').value.trim();
    var name = document.getElementById('empNameInput').value.trim();
    var storeId = document.getElementById('empStoreSelect').value;

    if (!phone || phone.length !== 11) { alert('请输入正确的11位手机号'); return; }
    if (!storeId) { alert('请选择所属门店'); return; }

    var storeName = storeOptions.find(function(s) { return s.id === storeId; }).name || storeId;

    var result = await callEdgeFunction('add_employee', {
        phone: phone, name: name, store_id: storeId, store_name: storeName, created_by: user.id
    });

    if (result.success && result.data) {
        alert('添加成功！员工可用手机号+' + phone + '登录');
        document.getElementById('empModal').classList.remove('show');
        loadEmployees();
    } else {
        alert('添加失败：' + (result.error || '未知错误'));
    }
}

async function loadEmployees() {
    try {
        var result = await callEdgeFunction('list_employees', {});
        
        var tbody = document.getElementById('employeeTbody');
        tbody.innerHTML = '';

        if (!result.success || !result.data) {
            tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#999;">暂无员工数据，请先执行SQL升级脚本</td></tr>';
            return;
        }

        result.data.forEach(function(emp) {
            var tr = document.createElement('tr');
            var bindings = emp.device_bindings || [];
            var deviceStatus = bindings.length > 0
                ? ('<span class="sync-success">已绑定(' + bindings.length + '台)</span>')
                : '<span class="sync-fail">未绑定</span>';

            var statusBadge = emp.is_active
                ? '<span class="replenish-badge replenish-ordered">正常</span>'
                : '<span class="replenish-badge replenish-text">停用</span>';

            var timeStr = emp.created_at ? new Date(emp.created_at).toLocaleString('zh-CN') : '-';
            
            var actionHtml = '';
            if (emp.is_active) {
                actionHtml = '<button class="btn-detail" onclick="toggleEmployee(\'' + emp.id + '\', false)">停用</button> ';
                if (bindings.length > 0) {
                    actionHtml += '<button class="btn-detail" style="color:red;" onclick="unbindDevice(\'' + 
                        escapeHtml(bindings[0].device_id || '') + '\')">解绑设备</button>';
                }
            } else {
                actionHtml = '<button class="btn-detail" onclick="toggleEmployee(\'' + emp.id + '\', true)">启用</button>';
            }

            tr.innerHTML = '<td>' + safeText(emp.phone) + '</td>' +
                '<td>' + safeText(emp.name || '-') + '</td>' +
                '<td>' + safeText(emp.store_name) + '</td>' +
                '<td>' + deviceStatus + '</td>' +
                '<td>' + statusBadge + '</td>' +
                '<td style="font-size:12px;">' + safeText(timeStr) + '</td>' +
                '<td><button class="btn-primary" style="padding:4px 8px;font-size:12px;" onclick="showPasswordModal(\'' + emp.id + '\', \'' + escapeHtml(emp.phone) + '\')">修改密码</button></td>' +
                '<td>' + actionHtml + '</td>';
            tbody.appendChild(tr);
        });
    } catch(err) {
        logError('员工列表加载失败', err);
        document.getElementById('employeeTbody').innerHTML =
            '<tr><td colspan="8" style="text-align:center;color:red;">加载失败：' + safeText(err.message) + '</td></tr>';
    }
}

window.toggleEmployee = async function(empId, isActive) {
    if (!checkPermission('manage_employees', '您没有管理员工的权限')) return;
    if (!confirm(isActive ? '确定启用该员工？' : '确定停用该员工？停用后将无法登录')) return;
    await callEdgeFunction('toggle_employee', { id: empId, is_active: isActive });
    loadEmployees();
};

window.unbindDevice = async function(deviceId) {
    if (!checkPermission('manage_devices', '您没有管理设备授权的权限')) return;
    if (!confirm('确定解绑该设备？员工需要重新绑定新设备才能登录')) return;
    await callEdgeFunction('revoke_device', { device_id: deviceId, target_type: 'employee', target_id: '' });
    alert('解绑成功');
    loadEmployees();
};

// ========== 修改员工密码 ==========
var currentEditEmpId = '';

document.getElementById('pwdCancelBtn').addEventListener('click', function() {
    document.getElementById('passwordModal').classList.remove('show');
    clearPasswordModal();
});

window.showPasswordModal = function(empId, empPhone) {
    if (!checkPermission('manage_employees', '您没有管理员工的权限')) return;
    currentEditEmpId = empId;
    document.getElementById('pwdEmpPhone').value = empPhone;
    document.getElementById('pwdNewPassword').value = '';
    document.getElementById('pwdConfirmPassword').value = '';
    document.getElementById('passwordModal').classList.add('show');
    document.getElementById('pwdNewPassword').focus();
};

function clearPasswordModal() {
    currentEditEmpId = '';
    document.getElementById('pwdEmpPhone').value = '';
    document.getElementById('pwdNewPassword').value = '';
    document.getElementById('pwdConfirmPassword').value = '';
}

document.getElementById('pwdSaveBtn').addEventListener('click', async function() {
    var newPwd = document.getElementById('pwdNewPassword').value.trim();
    var confirmPwd = document.getElementById('pwdConfirmPassword').value.trim();
    
    if (!newPwd) {
        alert('请输入新密码');
        return;
    }
    
    if (newPwd.length < 4) {
        alert('密码长度至少4位');
        return;
    }
    
    if (newPwd !== confirmPwd) {
        alert('两次输入的密码不一致');
        return;
    }
    
    if (!confirm('确定修改该员工的密码？')) return;
    
    try {
        var result = await callEdgeFunction('update_employee_password', {
            id: currentEditEmpId,
            new_password: newPwd
        });
        
        if (result.success) {
            alert('密码修改成功');
            document.getElementById('passwordModal').classList.remove('show');
            clearPasswordModal();
        } else {
            alert('修改失败：' + (result.error || '未知错误'));
        }
    } catch(err) {
        alert('修改失败：' + err.message);
    }
});

// 回车提交密码修改
document.getElementById('pwdConfirmPassword').addEventListener('keypress', function(e) {
    if (e.key === 'Enter') {
        document.getElementById('pwdSaveBtn').click();
    }
});

// ========== 设备授权管理 ==========
document.getElementById('refreshDeviceBtn').addEventListener('click', loadPendingDevices);

async function loadPendingDevices() {
    try {
        // 查询所有门店的待授权设备
        var result = await callEdgeFunction('get_pending_devices', {});
        
        var tbody = document.getElementById('deviceTbody');
        tbody.innerHTML = '';

        if (!result.success) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#999;">暂无待授权设备</td></tr>';
            return;
        }

        var devices = [...(result.data.employee_devices || []), ...(result.data.store_devices || [])];
        
        if (devices.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#999;">暂无待授权设备</td></tr>';
            return;
        }

        devices.forEach(function(dev) {
            var tr = document.createElement('tr');
            var deviceType = dev.employee_id ? '员工' : '门店账号';
            var deviceName = dev.store_employees ? (dev.store_employees.name || dev.store_employees.phone) : dev.username;
            var deviceId = dev.device_id;
            var timeStr = dev.created_at || dev.first_login_at ? new Date(dev.created_at || dev.first_login_at).toLocaleString('zh-CN') : '-';
            
            var actionHtml = '<button class="btn-primary" onclick="authorizeDevice(\'' + escapeHtml(deviceId) + '\', \'' + deviceType + '\', \'' + escapeHtml(dev.employee_id || dev.username) + '\', true)">授权</button> ';
            actionHtml += '<button class="btn-detail" style="color:red;" onclick="authorizeDevice(\'' + escapeHtml(deviceId) + '\', \'' + deviceType + '\', \'' + escapeHtml(dev.employee_id || dev.username) + '\', false)">拒绝</button>';

            tr.innerHTML = '<td>' + deviceType + '</td>' +
                '<td>' + safeText(deviceName) + '</td>' +
                '<td style="font-size:11px;word-break:break-all;">' + safeText(deviceId) + '</td>' +
                '<td>' + safeText(timeStr) + '</td>' +
                '<td><span class="replenish-badge replenish-text">待授权</span></td>' +
                '<td>' + actionHtml + '</td>';
            tbody.appendChild(tr);
        });
    } catch(err) {
        logError('待授权设备加载失败', err);
        document.getElementById('deviceTbody').innerHTML =
            '<tr><td colspan="6" style="text-align:center;color:red;">加载失败</td></tr>';
    }
}

window.authorizeDevice = async function(deviceId, targetType, targetId, authorize) {
    if (!checkPermission('manage_devices', '您没有管理设备授权的权限')) return;
    if (authorize) {
        if (!confirm('确定授权该设备？授权后该设备即可正常登录')) return;
    } else {
        if (!confirm('确定拒绝该设备？拒绝后需要重新申请授权')) return;
    }
    
    var result = await callEdgeFunction('authorize_device', {
        device_id: deviceId,
        target_type: targetType === '员工' ? 'employee' : 'store',
        target_id: targetId,
        authorize: authorize
    });

    if (result.success) {
        alert(authorize ? '授权成功' : '已拒绝');
        loadPendingDevices();
    } else {
        alert('操作失败：' + (result.error || '未知错误'));
    }
};

// 加载已授权设备
async function loadAuthorizedDevices() {
    try {
        var tbody = document.getElementById('authorizedDeviceTbody');
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#999;">加载中...</td></tr>';
        
        // 获取所有员工的授权设备
        var empResult = await callEdgeFunction('list_employees', {});
        
        var allDevices = [];
        if (empResult.success && empResult.data) {
            for (var emp of empResult.data) {
                var devResult = await callEdgeFunction('get_authorized_devices', {
                    target_type: 'employee',
                    target_id: emp.id
                });
                if (devResult.success && devResult.data) {
                    devResult.data.forEach(function(d) {
                        d.employee_name = emp.name || emp.phone;
                        d.employee_phone = emp.phone;
                        d.target_type = '员工';
                        allDevices.push(d);
                    });
                }
            }
        }
        
        tbody.innerHTML = '';
        if (allDevices.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#999;">暂无已授权设备</td></tr>';
            return;
        }

        allDevices.forEach(function(dev) {
            var tr = document.createElement('tr');
            var timeStr = dev.authorized_at || dev.last_login_at ? new Date(dev.authorized_at || dev.last_login_at).toLocaleString('zh-CN') : '-';
            var statusBadge = dev.is_authorized 
                ? '<span class="replenish-badge replenish-ordered">已授权</span>'
                : '<span class="replenish-badge replenish-text">未授权</span>';

            tr.innerHTML = '<td>' + safeText(dev.target_type) + '</td>' +
                '<td>' + safeText(dev.employee_name) + '</td>' +
                '<td>' + safeText(dev.employee_phone) + '</td>' +
                '<td style="font-size:11px;word-break:break-all;">' + safeText(dev.device_id) + '</td>' +
                '<td>' + statusBadge + '</td>' +
                '<td><button class="btn-detail" style="color:red;" onclick="revokeDevice(\'' + escapeHtml(dev.device_id) + '\', \'employee\', \'' + escapeHtml(dev.employee_id) + '\')">撤销</button></td>';
            tbody.appendChild(tr);
        });
    } catch(err) {
        logError('已授权设备加载失败', err);
    }
}

window.revokeDevice = async function(deviceId, targetType, targetId) {
    if (!checkPermission('manage_devices', '您没有管理设备授权的权限')) return;
    if (!confirm('确定撤销该设备授权？撤销后该设备需要重新申请授权')) return;
    
    var result = await callEdgeFunction('revoke_device', {
        device_id: deviceId,
        target_type: targetType,
        target_id: targetId
    });

    if (result.success) {
        alert('已撤销授权');
        loadAuthorizedDevices();
        loadPendingDevices();
    }
};

// ========== 门店管理 ==========
// 硬编码门店列表（作为后备数据源）
var defaultStoreList = [
    { id: 'wszhyy02', name: '02第二药店' }, { id: 'wszhyy03', name: '03第三药店' },
    { id: 'wszhyy04', name: '04第四药店' }, { id: 'wszhyy06', name: '06常口店' },
    { id: 'wszhyy08', name: '08第八药店' }, { id: 'wszhyy09', name: '09第九药店' },
    { id: 'wszhyy14', name: '14第十四药店' }, { id: 'wszhyy16', name: '16凤凰山药店' },
    { id: 'wszhyy17', name: '17益丰店' }, { id: 'wszhyy21', name: '21富源店' }
];

async function loadStores() {
    try {
        var tbody = document.getElementById('usersTbody');
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#999;">加载中...</td></tr>';
        
        var stores = [];
        
        // 优先从后端获取实时数据
        try {
            var result = await callEdgeFunction('list_stores', {});
            if (result.success && result.data && result.data.length > 0) {
                stores = result.data;
                storeOptions = stores.map(function(s) { 
                    return { id: s.username, name: s.username }; 
                });
            }
        } catch(e) {
            console.warn('后端门店数据获取失败，使用默认列表');
        }
        
        // 后端无数据时，使用硬编码列表
        if (stores.length === 0) {
            stores = defaultStoreList.map(function(s) {
                return { username: s.id, store_name: s.name, is_active: true };
            });
            storeOptions = defaultStoreList;
        }
        
        tbody.innerHTML = '';
        
        if (stores.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#999;">暂无门店数据</td></tr>';
            return;
        }
        
        stores.forEach(function(store) {
            var tr = document.createElement('tr');
            var displayName = store.store_name || store.username;
            var statusBadge = store.is_active !== false
                ? '<span class="replenish-badge replenish-done">正常</span>'
                : '<span class="replenish-badge replenish-text">停用</span>';
            
            tr.innerHTML = '<td>' + store.username + '</td>' +
                '<td style="white-space:nowrap;">' + displayName + '</td>' +
                '<td style="text-align:center;color:#999;">-</td>' +
                '<td style="text-align:center;">' + statusBadge + '</td>' +
                '<td style="text-align:center;color:#999;">-</td>';
            tbody.appendChild(tr);
        });
    } catch(err) {
        console.error('门店列表加载失败:', err);
        document.getElementById('usersTbody').innerHTML =
            '<tr><td colspan="5" style="text-align:center;color:red;">加载失败：' + err.message + '</td></tr>';
    }
}

// ========== 操作日志 ==========
async function loadLogs() {
    try {
        var tbody = document.getElementById('auditTbody');
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#999;">加载中...</td></tr>';
        
        var result = await callEdgeFunction('get_audit_log', {});
        
        if (!result.success) throw new Error(result.error || '加载失败');
        
        var logs = result.data || [];
        tbody.innerHTML = '';
        
        if (logs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#999;">暂无日志数据</td></tr>';
            return;
        }
        
        logs.forEach(function(log) {
            var tr = document.createElement('tr');
            var timeStr = log.time ? new Date(log.time).toLocaleString('zh-CN') : '-';
            tr.innerHTML = '<td>' + safeText(timeStr) + '</td>' +
                '<td>' + safeText(log.user || '-') + '</td>' +
                '<td>' + safeText(log.action || '-') + '</td>' +
                '<td>' + safeText(log.detail || '-') + '</td>';
            tbody.appendChild(tr);
        });
    } catch(err) {
        logError('操作日志加载失败', err);
        document.getElementById('auditTbody').innerHTML =
            '<tr><td colspan="4" style="text-align:center;color:red;">加载失败：' + safeText(err.message) + '</td></tr>';
    }
}

// 操作日志刷新按钮绑定
document.getElementById('refreshAuditBtn').addEventListener('click', loadLogs);

// ========== 子账号管理（仅超级管理员）==========
document.getElementById('addAdminBtn').addEventListener('click', showAddAdminModal);
document.getElementById('refreshAdminBtn').addEventListener('click', loadAdmins);
document.getElementById('adminCancelBtn').addEventListener('click', function() {
    document.getElementById('adminModal').classList.remove('show');
});
document.getElementById('adminSaveBtn').addEventListener('click', handleAddAdmin);

// 角色选择变化时自动设置默认权限
document.getElementById('adminRoleSelect').addEventListener('change', function() {
    var isViewer = this.value === 'viewer';
    document.querySelectorAll('.perm-check').forEach(function(cb) {
        var perm = cb.dataset.perm;
        if (isViewer) {
            // 只读用户：只能查看
            cb.checked = (perm === 'view_summary' || perm === 'view_audit_log');
            cb.disabled = true;
        } else {
            // 普通管理员：默认全开（除 manage_admins）
            cb.checked = (perm !== 'manage_admins');
            cb.disabled = false;
        }
    });
});

function showAddAdminModal() {
    document.getElementById('adminModalTitle').textContent = '添加子账号';
    document.getElementById('adminEditId').value = '';
    document.getElementById('adminUsernameInput').value = '';
    document.getElementById('adminPasswordInput').value = '';
    document.getElementById('adminNameInput').value = '';
    document.getElementById('adminRoleSelect').value = 'admin';
    document.getElementById('adminUsernameInput').disabled = false;
    document.getElementById('adminPasswordInput').placeholder = '登录密码';
    // 默认权限
    document.querySelectorAll('.perm-check').forEach(function(cb) {
        var perm = cb.dataset.perm;
        cb.checked = (perm !== 'manage_admins');
        cb.disabled = false;
    });
    document.getElementById('adminModal').classList.add('show');
}

function getAdminPermissionsFromUI() {
    var perms = {};
    document.querySelectorAll('.perm-check').forEach(function(cb) {
        perms[cb.dataset.perm] = cb.checked;
    });
    return perms;
}

async function handleAddAdmin() {
    var editId = document.getElementById('adminEditId').value;
    var username = document.getElementById('adminUsernameInput').value.trim();
    var password = document.getElementById('adminPasswordInput').value;
    var name = document.getElementById('adminNameInput').value.trim();
    var role = document.getElementById('adminRoleSelect').value;
    var perms = getAdminPermissionsFromUI();

    if (!editId) {
        // 新增模式
        if (!username) { alert('请输入账号'); return; }
        if (!password || password.length < 6) { alert('密码至少6位'); return; }
        if (!name) name = username;

        var result = await callEdgeFunction('add_admin_user', {
            username: username,
            password: password,
            name: name,
            role: role,
            permissions: perms,
            created_by: user.id
        });

        if (result.success && result.data) {
            alert('添加成功！子账号可用「' + username + '」登录');
            document.getElementById('adminModal').classList.remove('show');
            loadAdmins();
        } else {
            alert('添加失败：' + (result.error || '未知错误'));
        }
    } else {
        // 编辑模式
        var result = await callEdgeFunction('update_admin_user', {
            id: editId,
            name: name,
            role: role,
            permissions: perms
        });

        if (result.success && result.data) {
            alert('修改成功');
            document.getElementById('adminModal').classList.remove('show');
            loadAdmins();
        } else {
            alert('修改失败：' + (result.error || '未知错误'));
        }
    }
}

async function loadAdmins() {
    try {
        var result = await callEdgeFunction('list_admin_users', {});
        var tbody = document.getElementById('adminTbody');
        tbody.innerHTML = '';

        if (!result.success || !result.data) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#999;">加载失败</td></tr>';
            return;
        }

        var admins = result.data;
        if (admins.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#999;">暂无子账号</td></tr>';
            return;
        }

        var roleLabels = { super_admin: '超级管理员', admin: '普通管理员', viewer: '只读用户' };

        admins.forEach(function(adm) {
            var tr = document.createElement('tr');
            var permCount = Object.keys(adm.permissions || {}).filter(function(k) {
                return adm.permissions[k] === true;
            }).length;
            var statusBadge = adm.is_active
                ? '<span class="replenish-badge replenish-ordered">正常</span>'
                : '<span class="replenish-badge replenish-text">停用</span>';
            var timeStr = adm.created_at ? new Date(adm.created_at).toLocaleString('zh-CN') : '-';

            var actionHtml = '';
            if (adm.role !== 'super_admin') {
                actionHtml = '<button class="btn-detail" onclick="editAdmin(\'' + adm.id + '\')">编辑</button> ';
                actionHtml += '<button class="btn-detail" onclick="toggleAdminStatus(\'' + adm.id + '\', ' + (!adm.is_active) + ')">' + (adm.is_active ? '停用' : '启用') + '</button> ';
                actionHtml += '<button class="btn-detail" style="color:red;" onclick="deleteAdmin(\'' + adm.id + '\')">删除</button>';
            } else {
                actionHtml = '<span style="color:#999;font-size:12px;">不可操作</span>';
            }

            tr.innerHTML = '<td>' + safeText(adm.username) + '</td>' +
                '<td>' + safeText(adm.name || '-') + '</td>' +
                '<td>' + safeText(roleLabels[adm.role] || adm.role) + '</td>' +
                '<td>' + permCount + ' 项</td>' +
                '<td>' + statusBadge + '</td>' +
                '<td style="font-size:12px;">' + safeText(timeStr) + '</td>' +
                '<td>' + actionHtml + '</td>';
            tbody.appendChild(tr);
        });
    } catch(err) {
        logError('子账号列表加载失败', err);
        document.getElementById('adminTbody').innerHTML =
            '<tr><td colspan="7" style="text-align:center;color:red;">加载失败</td></tr>';
    }
}

window.editAdmin = async function(id) {
    try {
        var result = await callEdgeFunction('list_admin_users', {});
        if (!result.success || !result.data) return;
        var adm = result.data.find(function(a) { return a.id === id; });
        if (!adm) return;

        document.getElementById('adminModalTitle').textContent = '编辑子账号';
        document.getElementById('adminEditId').value = adm.id;
        document.getElementById('adminUsernameInput').value = adm.username;
        document.getElementById('adminUsernameInput').disabled = true;
        document.getElementById('adminPasswordInput').value = '';
        document.getElementById('adminPasswordInput').placeholder = '不修改请留空';
        document.getElementById('adminNameInput').value = adm.name || '';
        document.getElementById('adminRoleSelect').value = adm.role;

        // 恢复权限勾选
        var perms = adm.permissions || {};
        document.querySelectorAll('.perm-check').forEach(function(cb) {
            var perm = cb.dataset.perm;
            cb.checked = perms[perm] === true;
            cb.disabled = false;
        });

        document.getElementById('adminModal').classList.add('show');
    } catch(e) { console.error(e); }
};

window.toggleAdminStatus = async function(id, isActive) {
    if (!confirm(isActive ? '确定启用该子账号？' : '确定停用该子账号？停用后将无法登录')) return;
    var result = await callEdgeFunction('toggle_admin_user', { id: id, is_active: isActive });
    if (result.success) {
        alert(isActive ? '已启用' : '已停用');
        loadAdmins();
    } else {
        alert('操作失败：' + (result.error || '未知错误'));
    }
};

window.deleteAdmin = async function(id) {
    if (!confirm('确定删除该子账号？删除后无法恢复')) return;
    var result = await callEdgeFunction('delete_admin_user', { id: id });
    if (result.success) {
        alert('已删除');
        loadAdmins();
    } else {
        alert('删除失败：' + (result.error || '未知错误'));
    }
};

// ========== Tab切换增强：子账号管理 ==========
(function enhanceTabSwitch() {
    var originalTabs = document.querySelectorAll('.tab-btn');
    originalTabs.forEach(function(btn) {
        var originalClick = btn.onclick;
        btn.addEventListener('click', function() {
            if (this.dataset.tab === 'admins') loadAdmins();
        });
    });
})();

loadSummary();
initPermissionUI();
