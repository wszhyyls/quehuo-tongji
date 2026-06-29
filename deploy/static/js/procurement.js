// ========================================
// 采购记录 - 一次性加载全部数据
// ========================================
document.addEventListener('DOMContentLoaded', async function () {
    const container = document.getElementById('hot-table');
    const loadingOverlay = document.getElementById('loadingOverlay');
    const cellNameBox = document.getElementById('cellNameBox');
    const formulaInput = document.getElementById('formulaInput');
    if (!container) return;

    let totalCount = 0;
    let allOriginData = [];
    let freezeState = false;
    let resizeTimer = null;
    const REQUEST_TIMEOUT = 15000;

    // 权限校验
    const token = localStorage.getItem('token');
    let user;
    try { user = JSON.parse(localStorage.getItem('user') || 'null'); } catch(e) {}
    if (!token || !user || (user.role !== 'admin' && user.role !== 'super_admin')) {
        location.href = './login.html'; return;
    }
    const perm = user.role === 'super_admin' ? {manage_procurement:true} : (user.permissions||{});
    if (!perm.manage_procurement) {
        container.innerHTML = '<div style="text-align:center;padding:80px;">无访问权限</div>'; return;
    }

    const EDGE_URL = 'https://qswpgnnedqvuegwfbprd.supabase.co/functions/v1/procurement-reconciliation';
    const FIELDS = ['日期','供货商全名','简称','订货方式','付款方式','订货人','订货金额','入库日期','入库金额','入库人','付款人','付款记录','付款日期','财务入库记账','财务付款记账','记账日期','备注','千方系统','是否开具发票'];

    // ===== 工具函数 =====
    function showLoading() { loadingOverlay.style.display = 'flex'; }
    function hideLoading() { loadingOverlay.style.display = 'none'; }
    function updateStatus() { document.getElementById('cellCount').textContent = totalCount + ' 条记录'; }
    function toast(msg, isErr) {
        var tip = document.createElement('div');
        tip.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);padding:10px 20px;border-radius:4px;background:'+(isErr?'#f53f3f':'#67c23a')+';color:#fff;z-index:10000;font-size:13px';
        tip.innerText = msg; document.body.appendChild(tip);
        setTimeout(function(){tip.remove();},1800);
    }
    function formatDate(dateStr) {
        if (!dateStr) return '';
        var d = new Date(dateStr);
        if (isNaN(d.getTime())) return dateStr;
        return d.toISOString().slice(0, 10);
    }

    // ===== API =====
    async function api(action, body) {
        var controller = new AbortController();
        var timer = setTimeout(function(){controller.abort();}, REQUEST_TIMEOUT);
        try {
            var res = await fetch(EDGE_URL, {
                method: 'POST',
                headers: {'Content-Type':'application/json','Authorization':'Bearer '+token},
                body: JSON.stringify({action:action, data:body?.data, params:body?.params}),
                signal: controller.signal
            });
            clearTimeout(timer);
            if (res.status === 401) { toast('登录失效，请重新登录',true); location.href = './login.html'; throw new Error('登录过期'); }
            if (!res.ok) { var e = await res.json().catch(function(){return{};}); throw new Error(e.error||'请求异常'); }
            return await res.json();
        } catch(err) {
            clearTimeout(timer);
            if (err.name === 'AbortError') throw new Error('请求超时');
            throw err;
        }
    }

    // ===== 日期列渲染器 =====
    function dateRenderer(instance, td, row, col, prop, value, cellProperties) {
        Handsontable.renderers.DateRenderer.apply(this, arguments);
        td.textContent = formatDate(value);
    }

    // ===== Handsontable =====
    const hot = new Handsontable(container, {
        licenseKey: 'non-commercial-and-evaluation',
        data: [], language: 'zh-CN',
        columns: [
            { type:'date', dateFormat:'YYYY-MM-DD', correctFormat:true, title:'日期', width:105, renderer: dateRenderer },
            { title:'供货商全名', width:200 },
            { title:'简称', width:100 },
            { title:'订货方式', type:'dropdown', source:['待付款','已订购','配货中','已到货'], width:90 },
            { title:'付款方式', width:100 },
            { title:'订货人', width:80 },
            { title:'订货金额', type:'numeric', numericFormat:{pattern:'0.00'}, width:100 },
            { type:'date', dateFormat:'YYYY-MM-DD', correctFormat:true, title:'入库日期', width:105, renderer: dateRenderer },
            { title:'入库金额', type:'numeric', numericFormat:{pattern:'0.00'}, width:100 },
            { title:'入库人', width:80 },
            { title:'付款人', width:80 },
            { title:'付款记录', type:'dropdown', source:['未付款','已付款','部分付款'], width:90 },
            { type:'date', dateFormat:'YYYY-MM-DD', correctFormat:true, title:'付款日期', width:105, renderer: dateRenderer },
            { title:'财务入库记账', width:110 },
            { title:'财务付款记账', width:110 },
            { type:'date', dateFormat:'YYYY-MM-DD', correctFormat:true, title:'记账日期', width:105, renderer: dateRenderer },
            { title:'备注', width:200 },
            { title:'千方系统', width:100 },
            { title:'是否开具发票', type:'dropdown', source:['是','否','待开具'], width:105 },
        ],
        colHeaders: true, rowHeaders: true, filters: true, undoRedo: true, columnSorting: true, comments: true,
        manualColumnResize: true, manualRowResize: true, maxRows: 100000, autoRowSize: false, autoColumnSize: false,
        viewportRowRenderingOffset: 60, stretchH: 'none',
        enterMoves: { row:1, col:0 }, tabMoves: { row:0, col:1 },
        outsideClickDeselects: false, selectionMode: 'multiple', fixedRowsTop: 1, mergeCells: true,
        dropdownMenu: { items: { filter_by_value:{name:"按值筛选"}, filter_by_condition:{name:"按条件筛选"}, filter_clear:{name:"清除筛选"} } },
        contextMenu: {
            items: {
                row_above:{name:"在上方插入行"}, row_below:{name:"在下方插入行"},
                remove_row:{name:"删除行"}, clear_column:{name:"清除内容"},
                "---------":{name:"---------"},
                cut:{name:"剪切"}, copy:{name:"复制"}, paste:{name:"粘贴"},
                "---------":{name:"---------"},
                add_comment:{name:"插入批注"}, remove_comment:{name:"删除批注"},
                "---------":{name:"---------"},
                alignment:{name:"对齐方式"}, undo:{name:"撤销"}, redo:{name:"恢复"},
            }
        },
        height: function() { return window.innerHeight - 220; }, width: '100%',

        afterChange: async function(changes, source) {
            if (source === 'loadData' || !changes) return;
            var hasErr = false;
            for (var i = 0; i < changes.length; i++) {
                var c = changes[i], row = c[0], col = c[1], oldV = c[2], newV = c[3];
                if (oldV === newV) continue;
                var originRow = allOriginData[row];
                if (!originRow || !originRow.Id) continue;
                try {
                    await api('update', { data: { [FIELDS[col]]: newV }, params: { id: originRow.Id } });
                } catch(e) { hasErr = true; }
            }
            updateStatus();
            if (hasErr) toast('部分数据保存失败', true);
        },

        afterSelection: function() {
            var sel = hot.getSelected();
            if (sel && sel.length) {
                cellNameBox.value = String.fromCharCode(65 + sel[0][1]) + (sel[0][0] + 1);
                formulaInput.value = hot.getDataAtCell(sel[0][0], sel[0][1]) || '';
            }
        }
    });

    window.hot = hot;

    window.addEventListener('resize', function() {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function(){ hot.updateSettings({ height: window.innerHeight - 220 }); }, 150);
    });

    formulaInput.addEventListener('blur', function() {
        var sel = hot.getSelected();
        if (!sel) return;
        hot.setDataAtCell(sel[0][0], sel[0][1], this.value);
    });

    // ===== Ribbon =====
    window.switchRibbonTab = function(tab) {
        document.querySelectorAll('.ribbon-tab').forEach(function(t){t.classList.remove('active');});
        tab.classList.add('active');
        var idx = Array.from(tab.parentElement.children).indexOf(tab);
        document.querySelectorAll('.ribbon-content').forEach(function(c,i){c.classList.toggle('active', i===idx);});
    };

    // ===== 字体 =====
    window.toggleFontBold = function() {
        var sel = hot.getSelected(); if (!sel||!sel.length) return;
        var meta = hot.getCellMeta(sel[0][0], sel[0][1]);
        hot.setCellMeta(sel[0][0], sel[0][1], 'bold', !meta.bold); hot.render();
    };
    window.toggleFontItalic = function() {
        var sel = hot.getSelected(); if (!sel||!sel.length) return;
        var meta = hot.getCellMeta(sel[0][0], sel[0][1]);
        hot.setCellMeta(sel[0][0], sel[0][1], 'italic', !meta.italic); hot.render();
    };
    window.toggleFontUnderline = function() {
        var sel = hot.getSelected(); if (!sel||!sel.length) return;
        var meta = hot.getCellMeta(sel[0][0], sel[0][1]);
        hot.setCellMeta(sel[0][0], sel[0][1], 'underline', !meta.underline); hot.render();
    };

    // ===== 对齐 =====
    window.setAlignment = function(cls) {
        var sel = hot.getSelected(); if (!sel||!sel.length) return;
        for (var i=sel[0][0];i<=sel[0][2];i++)
            for (var j=sel[0][1];j<=sel[0][3];j++)
                hot.setCellMeta(i,j,'className',cls);
        hot.render();
    };
    window.toggleWrapText = function() {
        var sel = hot.getSelected(); if (!sel||!sel.length) return;
        var meta = hot.getCellMeta(sel[0][0], sel[0][1]);
        hot.setCellMeta(sel[0][0], sel[0][1], 'wordWrap', !meta.wordWrap); hot.render();
    };
    window.mergeCells = function() {
        var s = hot.getSelected(); if (!s) return;
        hot.mergeCells(s[0][0],s[0][1],s[0][2]-s[0][0],s[0][3]-s[0][1]);
    };

    // ===== 数字格式 =====
    window.setNumberFormat = function(format) {
        var sel = hot.getSelected(); if (!sel||!sel.length) return;
        var pattern = '0.00';
        if (format === 'currency') pattern = '¥0.00';
        if (format === 'percent') pattern = '0.00%';
        for (var i=sel[0][0];i<=sel[0][2];i++)
            for (var j=sel[0][1];j<=sel[0][3];j++)
                hot.setCellMeta(i,j,'numericFormat',{pattern:pattern});
        hot.render();
    };

    // ===== 视图 =====
    window.toggleFreezeRow = function() { freezeState=!freezeState; hot.updateSettings({fixedRowsTop:freezeState?1:0}); };
    window.toggleGridlines = function() { hot.updateSettings({className:hot.getSettings().className?'':'no-gridlines'}); hot.render(); };
    window.toggleHeaders = function() { var s=hot.getSettings(); hot.updateSettings({colHeaders:!s.colHeaders,rowHeaders:!s.rowHeaders}); hot.render(); };
    window.toggleFormulaBar = function() {
        var bar = document.querySelector('.excel-formula-bar');
        bar.style.display = bar.style.display==='none'?'flex':'none';
        hot.updateSettings({height:window.innerHeight-(bar.style.display==='none'?196:220)});
    };
    window.setZoom = function(z) { document.getElementById('zoomValue').textContent=z+'%'; hot.render(); };

    // ===== 排序/筛选 =====
    window.sortAsc = function() { var s=hot.getSelected(); hot.getPlugin('columnSorting').sort({column:s&&s.length?s[0][1]:0,sortOrder:'asc'}); };
    window.sortDesc = function() { var s=hot.getSelected(); hot.getPlugin('columnSorting').sort({column:s&&s.length?s[0][1]:0,sortOrder:'desc'}); };
    window.openFilter = function() { var s=hot.getSelected(); if(s&&s.length) hot.getPlugin('dropdownMenu').open(s[0][1]); };
    window.clearFilter = function() { hot.getPlugin('filters').clearFilters(); };

    // ===== 单元格 =====
    window.insertRow = function() { var s=hot.getSelected(); hot.alter('insert_row',s&&s.length?s[0][0]:0); };
    window.deleteRow = function() { var s=hot.getSelected(); if(s) hot.alter('remove_row',s[0][0],s[0][2]-s[0][0]+1); };

    // ===== 新增记录 =====
    window.addRow = async function() {
        var d = {}; FIELDS.forEach(function(f){d[f]='';});
        d['日期'] = new Date().toISOString().slice(0,10);
        d['订货人'] = user.name || '';
        showLoading();
        try {
            var res = await api('create',{data:d});
            if (res.success) { toast('新增记录成功'); loadAllData(); }
            else toast('新增失败: '+(res.error||'未知错误'),true);
        } catch(e) { toast('新增异常：'+e.message,true); }
        finally { hideLoading(); }
    };

    window.cleanEmptyRow = function() { toast('请使用导入功能覆盖数据'); };
    window.saveData = function() { toast('数据自动云端保存'); };

    // ===== 批注 =====
    window.addComment = function() {
        var sel = hot.getSelected();
        if (!sel||!sel.length) { toast('请先选中单元格',true); return; }
        hot.getPlugin('contextMenu').executeCommand('add_comment',sel[0][0],sel[0][1]);
    };
    window.removeComment = function() {
        var sel = hot.getSelected();
        if (!sel||!sel.length) { toast('请先选中单元格',true); return; }
        hot.getPlugin('contextMenu').executeCommand('remove_comment',sel[0][0],sel[0][1]);
    };

    // ===== 导入 =====
    window.importExcel = async function() {
        var inp = document.createElement('input'); inp.type='file'; inp.accept='.xlsx,.xls';
        inp.onchange = async function(e) {
            var file = e.target.files[0]; if (!file) return;
            showLoading();
            try {
                var rowsData = [], ext = file.name.split('.').pop().toLowerCase();
                if (ext === 'xlsx' && typeof ExcelJS !== 'undefined') {
                    var buf = await file.arrayBuffer();
                    var wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
                    wb.worksheets[0].eachRow(function(row,rowNum){
                        if(rowNum===1) return;
                        var obj={};
                        row.eachCell(function(cell,colNum){
                            obj[FIELDS[colNum-1]] = cell.value!==null&&cell.value!==undefined?String(cell.value).trim():'';
                        });
                        if(Object.values(obj).some(function(v){return v!=='';})) rowsData.push(obj);
                    });
                } else {
                    var raw = XLSX.read(await file.arrayBuffer(),{type:'array'});
                    var rows = XLSX.utils.sheet_to_json(raw.Sheets[raw.SheetNames[0]],{header:1});
                    rows.shift();
                    rows.forEach(function(row){
                        var obj={};
                        FIELDS.forEach(function(f,i){obj[f]=(row[i]||'').toString().trim();});
                        if(Object.values(obj).some(function(v){return v!=='';})) rowsData.push(obj);
                    });
                }
                if (!rowsData.length) { toast('未读取到有效数据',true); return; }
                var total=0;
                for (var i=0;i<rowsData.length;i+=500) {
                    var res = await api('import_excel',{data:{records:rowsData.slice(i,i+500)}});
                    if(res.success) total += res.data.success;
                }
                toast('成功导入 '+total+'/'+rowsData.length+' 条数据');
                loadAllData();
            } catch(err) { toast('导入失败: '+err.message,true); }
            finally { hideLoading(); }
        };
        inp.click();
    };

    // ===== 导出 =====
    window.exportExcel = async function() {
        showLoading();
        try {
            var res = await api('export_excel',{params:{}});
            if (!res.success) { toast('导出失败',true); return; }
            var all = res.data || [];
            var sheetData = all.map(function(row){
                var o={}; FIELDS.forEach(function(h){o[h]=row[h]||'';}); return o;
            });
            var ws = XLSX.utils.json_to_sheet(sheetData);
            ws['!cols'] = FIELDS.map(function(){return{wch:16};});
            var wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb,ws,'采购数据');
            XLSX.writeFile(wb,'采购数据_'+new Date().toISOString().slice(0,10)+'.xlsx');
            toast('文件导出完成');
        } catch(e) { toast('导出异常',true); }
        finally { hideLoading(); }
    };

    // ===== 批量对账 =====
    window.batchReconcile = async function() {
        var sel = hot.getSelected(); if (!sel||!sel.length) return;
        var ids=[];
        for (var r=sel[0][0];r<=sel[0][2];r++) { var d=allOriginData[r]; if(d&&d.Id) ids.push(d.Id); }
        if (!ids.length||!confirm('标记 '+ids.length+' 条为已对账？')) return;
        showLoading();
        try {
            var res = await api('reconcile',{params:{ids:ids,action_type:'对账'}});
            if (res.success) { toast('批量对账完成'); loadAllData(); }
            else toast('操作失败',true);
        } catch(e) { toast('对账异常',true); }
        finally { hideLoading(); }
    };

    // ===== 批量物理删除 =====
    window.batchDelete = async function() {
        if (user.role !== 'super_admin') { toast('仅超管可删除数据',true); return; }
        var sel = hot.getSelected(); if (!sel||!sel.length) return;
        var ids=[];
        for (var r=sel[0][0];r<=sel[0][2];r++) { var d=allOriginData[r]; if(d&&d.Id) ids.push(d.Id); }
        if (!ids.length||!confirm('永久删除 '+ids.length+' 条数据，无法恢复！')) return;
        showLoading();
        try {
            var res = await api('batch_delete',{params:{ids:ids}});
            if (res.success) { toast('成功删除 '+ids.length+' 条数据'); loadAllData(); }
            else toast('删除失败',true);
        } catch(e) { toast('删除异常：'+e.message,true); }
        finally { hideLoading(); }
    };

    // ===== 一次性加载全部 =====
    async function loadAllData() {
        showLoading();
        try {
            var res = await api('list',{params:{page:1,pageSize:100000,sortField:'日期',sortOrder:'DESC'}});
            if (res.success) {
                allOriginData = res.data.records || [];
                totalCount = res.data.total || allOriginData.length;
                hot.loadData(allOriginData.map(function(item){
                    return FIELDS.map(function(f){return item[f]||'';});
                }));
                updateStatus();
            } else toast('加载失败: '+(res.error||'未知错误'),true);
        } catch(e) { toast('数据加载异常',true); }
        finally { hideLoading(); }
    }

    loadAllData();
});
