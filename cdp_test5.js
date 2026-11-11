const WebSocket = require('ws');
const http = require('http');

http.get('http://127.0.0.1:9222/json', (res) => {
  let data = ''; res.on('data', c => data += c); res.on('end', () => {
    const tabs = JSON.parse(data);
    const tab = tabs.find(t => t.url.includes('login.html')) || tabs[0];
    if (!tab) { console.log('NO TAB'); return; }
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    let mid = 0;
    const send = (m, p = {}) => new Promise((resolve) => {
      ws.send(JSON.stringify({ id: ++mid, method: m, params: p }));
      ws.on('message', (raw) => {
        const r = JSON.parse(raw.toString());
        if (r.id === mid) { ws.removeAllListeners('message'); resolve(r); }
      });
    });
    ws.on('open', async () => {
      await send('Page.enable');
      // 注入假登录状态
      await send('Runtime.evaluate', {
        expression: "localStorage.setItem('token', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fake'); localStorage.setItem('user', JSON.stringify({ id: 1, username: 'admin', role: 'super_admin', name: '管理员' })); 'done';",
        returnByValue: true
      });
      console.log('1. injected auth');
      // 固定端口 8049 直接导航
      const nav = await send('Page.navigate', { url: 'http://127.0.0.1:8049/admin.html' });
      console.log('2. navigate admin:', nav.result?.frameId ? 'OK' : 'FAIL');
      console.log('3. waiting 35s for full load...');
      await new Promise(r => setTimeout(r, 35000));
      // 读页面状态
      const state = await send('Runtime.evaluate', {
        expression: `(function(){
          var cards = Array.from(document.querySelectorAll('.summary-card, .stat-card, .dashboard-card'));
          var cardNums = Array.from(document.querySelectorAll('.summary-card .number, .stat-card .number, .dashboard-card .number, .card-number'))
            .map(el => el.textContent.trim()).filter(t => t && !isNaN(parseInt(t)));
          var tbody = document.getElementById('summaryTbody');
          var rows = tbody ? tbody.querySelectorAll('tr').length : -1;
          var cardsAll = Array.from(document.querySelectorAll('[class*=card] [class*=number], [class*=summary] [class*=number]'))
            .map(el => el.textContent.trim()).filter(Boolean).slice(0, 20);
          var tbodyFirstRow = tbody ? tbody.querySelector('tr')?.textContent?.slice(0, 100) || null : null;
          return {
            url: location.href,
            version: document.querySelector('[data-version]')?.textContent?.trim() || '',
            summaryDataType: typeof summaryData,
            summaryReports: (typeof summaryData !== 'undefined' && summaryData?.all_reports) ? summaryData.all_reports.length : 0,
            filteredDataLen: typeof filteredData !== 'undefined' ? filteredData.length : 'undefined',
            tbodyRows: rows,
            tbodyFirstRow: tbodyFirstRow,
            cardNumbersFound: cardNums,
            cardNumbersAll: cardsAll,
            redBarVisible: !!document.querySelector('#__failBar, [class*=fail], [class*=error-bar]'),
            redBarText: document.querySelector('#__failBar')?.textContent?.trim()?.slice(0, 200) || null
          };
        })()`,
        returnByValue: true
      });
      console.log('=== PAGE STATE ===');
      console.log(JSON.stringify(state.result?.result?.value || state.result, null, 2));
      ws.close();
    });
  });
});
