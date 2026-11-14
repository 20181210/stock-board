'use strict';
const { parseCsv, aggregateCsv, parsePeriod, periodLabel } = MarketData;
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(`guanshi:${key}`)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(`guanshi:${key}`, JSON.stringify(value)); } catch { toast('浏览器存储空间不足，设置或画线未能保存'); } },
};
const defaults = [
  { market: 'us', symbol: 'AAPL', name: '苹果' }, { market: 'us', symbol: 'NVDA', name: '英伟达' },
  { market: 'us', symbol: 'SPY', name: '标普500 ETF' }, { market: 'us', symbol: 'NDX', name: '纳斯达克100指数' },
  { market: 'fx', symbol: 'XAUUSD', name: '现货黄金' }, { market: 'fx', symbol: 'EURUSD', name: '欧元 / 美元' }, { market: 'fx', symbol: 'USDJPY', name: '美元 / 日元' },
  { market: 'cn', symbol: '600519', name: '贵州茅台' }, { market: 'cn', symbol: '000001', name: '平安银行' },
  { market: 'crypto', symbol: 'BTCUSDT', name: '比特币' }, { market: 'crypto', symbol: 'ETHUSDT', name: '以太坊' },
];
const marketNames = { us: '美股', fx: '外汇', cn: 'A股', crypto: '加密货币', csv: 'CSV' };
const marketLabels = { us: 'US EQUITIES', fx: 'FOREIGN EXCHANGE', cn: 'CHINA A-SHARES', crypto: 'CRYPTO SPOT', csv: 'YOUR OWN DATA' };
const session = store.get('session', {});
const state = {
  market: ['us', 'cn', 'fx', 'crypto'].includes(session.market) ? session.market : 'us',
  symbol: session.symbol || 'AAPL', period: session.period || '3', anchor: session.anchor || '2025-01-01',
  data: [], meta: null, watchlist: store.get('watchlist', defaults), filter: 'all', range: '120',
  drawings: new Map(), selected: null, drawingId: null, drawingKey: '', restoring: false,
  controller: null, requestId: 0, csv: null, indicators: new Map(),
};
if (!store.get('watchlist-v2', false)) {
  for (const symbol of ['XAUUSD', 'NDX']) { const item = defaults.find((row) => row.symbol === symbol); if (!state.watchlist.some((row) => row.symbol === symbol)) state.watchlist.push(item); }
  store.set('watchlist', state.watchlist); store.set('watchlist-v2', true);
}
let maConfig = store.get('ma-config', ChartStudies.defaultConfig());
let fibConfig = store.get('fib-config', ChartStudies.defaultFibonacciConfig());
if (!fibConfig || !Array.isArray(fibConfig.levels)) fibConfig = ChartStudies.defaultFibonacciConfig();
const savedOpenSymbols = store.get('open-symbols', defaults.slice(0, 4).map(({ market, symbol, name }) => ({ market, symbol, name })));
const openSymbols = Array.isArray(savedOpenSymbols) ? savedOpenSymbols.filter((item) => item && item.market && item.symbol) : defaults.slice(0, 4).map(({ market, symbol, name }) => ({ market, symbol, name }));
let toastTimer;
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4200); }
function dateText(timestamp) { return new Date(timestamp).toISOString().slice(0, 10); }
function label(period = state.period) { return periodLabel(period); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function remember() { if (state.market !== 'csv') store.set('session', { market: state.market, symbol: state.symbol, period: state.period, anchor: state.anchor }); }
function format(value, decimals) { return Number(value).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }); }
const chart = klinecharts.init('chart', { locale: 'zh-CN', timezone: 'UTC', styles: {
  grid: { horizontal: { color: '#edf0f4', style: 'dashed', dashedValue: [2, 4] }, vertical: { color: '#f0f2f5', style: 'dashed', dashedValue: [2, 4] } },
  candle: { bar: { upColor: '#33bba0', downColor: '#e86d79', noChangeColor: '#8490a3', upBorderColor: '#33bba0', downBorderColor: '#e86d79', upWickColor: '#33bba0', downWickColor: '#e86d79' },
    tooltip: { text: { color: '#526176', size: 11 }, custom: ({ current, prev }) => [
      { title: '时间', value: '{time}' }, { title: '开', value: '{open}' }, { title: '高', value: '{high}' },
      { title: '低', value: '{low}' }, { title: '收', value: '{close}' },
      { title: '涨跌幅', value: { text: percentText(ChartStudies.candleChange(current, prev)), color: changeColor(ChartStudies.candleChange(current, prev)) } },
    ] }, priceMark: { high: { color: '#66758a' }, low: { color: '#66758a' }, last: { upColor: '#33bba0', downColor: '#e86d79' } } },
  indicator: { tooltip: { text: { color: '#6b7789', size: 10 } }, bars: [{ upColor: '#287e73', downColor: '#92505c', noChangeColor: '#526379' }], lines: [{ color: '#dcb875' }, { color: '#81a9ed' }, { color: '#b197da' }] },
  xAxis: { axisLine: { color: '#e2e7ee' }, tickLine: { show: false }, tickText: { color: '#66778c', size: 10 } },
  yAxis: { axisLine: { show: false }, tickLine: { show: false }, tickText: { color: '#66778c', size: 10 } },
  separator: { color: '#e3e8ef', activeBackgroundColor: '#f2f6fc', fill: true },
  crosshair: { horizontal: { line: { color: '#98a5b6' }, text: { backgroundColor: '#596a80' } }, vertical: { line: { color: '#98a5b6' }, text: { backgroundColor: '#596a80' } } },
  overlay: { line: { color: '#66b8ff', size: 1.5 }, polygon: { color: '#66b8ff18', borderColor: '#66b8ff', borderSize: 1 }, rect: { color: '#66b8ff18', borderColor: '#66b8ff', borderSize: 1 } },
} });
chart.setOffsetRightDistance(65);
new ResizeObserver(() => chart.resize()).observe($('#chart'));
function percentText(value) { return value == null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`; }
function changeColor(value) { return value == null ? '#7b8796' : value >= 0 ? '#13957e' : '#d95769'; }
function showCandleChange(current, previous) {
  const value = ChartStudies.candleChange(current, previous);
  $('#candle-change').textContent = current ? `${dateText(current.timestamp)} 涨跌幅 ${percentText(value)}` : '';
  $('#candle-change').style.color = changeColor(value);
}
function symbolKey(item) { return `${item.market}:${item.symbol}`; }
function renderSymbolTabs() {
  const active = symbolKey(state);
  $('#symbol-tabs').innerHTML = [...openSymbols, { add: true }].map((item) => item.add
    ? '<button class="symbol-tab-add" id="add-symbol-tab" aria-label="添加品种" title="添加品种">＋</button>'
    : `<div class="symbol-tab ${symbolKey(item) === active ? 'active' : ''}"><button class="symbol-tab-main" data-symbol-tab="${escapeHtml(symbolKey(item))}" title="${escapeHtml(item.name || marketNames[item.market])}"><strong>${escapeHtml(item.symbol)}</strong><span class="tab-quote ${item.lastChange >= 0 ? 'up' : 'down'}">${item.lastPrice == null ? escapeHtml(item.name || marketNames[item.market]) : `${escapeHtml(item.lastPrice)} <b>${item.lastChange >= 0 ? '+' : ''}${Number(item.lastPct || 0).toFixed(2)}%</b>`}</span></button><button class="symbol-tab-close" data-close-tab="${escapeHtml(symbolKey(item))}" aria-label="关闭${escapeHtml(item.symbol)}">×</button></div>`).join('');
}
function rememberOpenSymbol() {
  const item = { market: state.market, symbol: state.symbol, name: state.meta?.name || state.symbol };
  const index = openSymbols.findIndex((row) => symbolKey(row) === symbolKey(item));
  if (index >= 0) openSymbols[index] = { ...openSymbols[index], ...item };
  else openSymbols.push(item);
  while (openSymbols.length > 8) openSymbols.shift();
  store.set('open-symbols', openSymbols); renderSymbolTabs();
}
function updateOpenSymbolQuote(last, previous, decimals) {
  const item = openSymbols.find((row) => symbolKey(row) === symbolKey(state));
  if (!item || !last) return;
  const change = previous ? last.close - previous.close : 0;
  item.lastPrice = format(last.close, decimals);
  item.lastChange = change;
  item.lastPct = previous && previous.close ? change / previous.close * 100 : 0;
  store.set('open-symbols', openSymbols); renderSymbolTabs();
}
$('#symbol-tabs').addEventListener('click', (event) => {
  const close = event.target.closest('[data-close-tab]');
  if (close) {
    const index = openSymbols.findIndex((item) => symbolKey(item) === close.dataset.closeTab);
    if (index >= 0) openSymbols.splice(index, 1);
    if (!openSymbols.length) openSymbols.push({ market: state.market, symbol: state.symbol, name: state.meta?.name || state.symbol });
    if (close.dataset.closeTab === symbolKey(state)) {
      const next = openSymbols[Math.min(index, openSymbols.length - 1)]; state.market = next.market; state.symbol = next.symbol; syncControls(); load();
    }
    store.set('open-symbols', openSymbols); renderSymbolTabs(); return;
  }
  const tab = event.target.closest('[data-symbol-tab]');
  if (tab) { const item = openSymbols.find((row) => symbolKey(row) === tab.dataset.symbolTab); if (item) { state.market = item.market; state.symbol = item.symbol; syncControls(); load(); } return; }
  if (event.target.closest('#add-symbol-tab')) { $('#symbol').focus(); $('#symbol').select(); toast('输入代码后按 Enter，品种会加入顶部标签栏'); }
});
chart.subscribeAction('onCrosshairChange', ({ kLineData, dataIndex }) => {
  showCandleChange(kLineData, state.data[dataIndex - 1]);
});

const ruler = { armed: false, origin: null, pointer: null, startPixel: null, dragging: false, end: null };
function sizeRulerSurface() {
  const pane = chart.getDom('candle_pane', 'main');
  if (!pane) return;
  const rect = pane.getBoundingClientRect(), host = $('#chart').getBoundingClientRect();
  Object.assign($('#ruler-surface').style, { left: `${rect.left - host.left}px`, top: `${rect.top - host.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
}
new ResizeObserver(() => { if (ruler.armed) requestAnimationFrame(sizeRulerSurface); }).observe($('#chart'));
function rulerPoint(event) {
  const rect = $('#ruler-surface').getBoundingClientRect();
  const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
  const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
  const point = chart.convertFromPixel([{ x, y }], { paneId: 'candle_pane' })[0];
  if (!point || !Number.isFinite(point.value)) return null;
  const index = Math.max(0, Math.min(state.data.length - 1, Math.round(point.dataIndex)));
  return { value: point.value, timestamp: state.data[index].timestamp, dataIndex: index };
}
function updateMeasurementReadout(first, second) {
  const value = ChartStudies.measureRange(first, second);
  $('#measurement-readout').hidden = false;
  $('#measurement-readout').textContent = `测量：价格差 ${value.difference.toFixed(chart.getPriceVolumePrecision().price)}，涨跌幅 ${percentText(value.percentage)}，${value.bars} 根K线间隔，${value.days} 自然日`;
}
$('#ruler-surface').addEventListener('pointerdown', (event) => {
  if (!ruler.armed || event.button !== 0) return;
  const point = rulerPoint(event); if (!point) return;
  event.preventDefault(); ruler.pointer = event.pointerId; ruler.startPixel = [event.clientX, event.clientY]; ruler.dragging = false;
  $('#ruler-surface').setPointerCapture(event.pointerId);
  if (!ruler.origin) {
    ruler.origin = point;
    state.drawingId = chart.createOverlay(drawingOptions({ name: 'measurementRuler', points: [point], paneId: 'candle_pane' }), 'candle_pane');
  } else { ruler.dragging = true; }
  ruler.end = point;
});
$('#ruler-surface').addEventListener('pointermove', (event) => {
  if (!ruler.armed || !ruler.origin) return;
  const point = rulerPoint(event); if (!point) return;
  ruler.end = point;
  if (ruler.pointer != null && Math.hypot(event.clientX - ruler.startPixel[0], event.clientY - ruler.startPixel[1]) > 4) ruler.dragging = true;
  chart.overrideOverlay({ id: state.drawingId, points: [ruler.origin, point] });
  updateMeasurementReadout(ruler.origin, point);
});
$('#ruler-surface').addEventListener('pointerup', (event) => {
  if (!ruler.armed || event.pointerId !== ruler.pointer) return;
  ruler.pointer = null;
  if (!ruler.dragging) return;
  const point = rulerPoint(event) || ruler.end;
  chart.overrideOverlay({ id: state.drawingId, points: [ruler.origin, point] });
  const overlay = chart.getOverlayById(state.drawingId);
  if (overlay) { state.drawings.set(overlay.id, serializeOverlay(overlay)); persistDrawings(); }
  updateMeasurementReadout(ruler.origin, point);
  state.drawingId = null; selectTool('cursor');
});
$('#ruler-surface').addEventListener('pointercancel', () => selectTool('cursor'));

function applyMovingAverages() {
  const figures = maConfig.lines.flatMap((line, index) => line.enabled ? [{ key: `ma${index}`, title: `${line.type === 'default' ? maConfig.defaultType : line.type}${line.period}: `, type: 'line', styles: () => ({ color: line.color, size: 1.4 }) }] : []);
  const value = { name: 'PMA', shortName: `PMA ${maConfig.defaultType}`, extendData: maConfig, figures, calcParams: [JSON.stringify(maConfig)] };
  if (state.indicators.has('PMA')) chart.overrideIndicator(value, 'candle_pane');
  else { chart.createIndicator(value, true, { id: 'candle_pane' }); state.indicators.set('PMA', 'candle_pane'); }
  $('[data-indicator="PMA"]').classList.add('active');
  $('[data-indicator="PMA"]').title = maConfig.lines.filter((line) => line.enabled).map((line) => `${line.type === 'default' ? maConfig.defaultType : line.type} ${line.period}`).join(' / ');
}
function renderMaSettings(config) {
  $('#ma-default-type').value = config.defaultType; $('#ma-fill').checked = config.fill;
  const sources = { close: '收盘价', open: '开盘价', high: '最高价', low: '最低价', hl2: 'HL2', hlc3: 'HLC3', ohlc4: 'OHLC4' };
  $('#ma-rows').innerHTML = config.lines.map((line, index) => `<fieldset class="ma-row" data-ma-index="${index}"><div class="ma-main"><label><input type="checkbox" name="enabled" ${line.enabled ? 'checked' : ''}> 均线 ${index + 1}</label><select name="type" aria-label="均线${index + 1}类型">${['default', 'EMA', 'SMA', 'WMA', 'RMA', 'ALMA'].map((type) => `<option value="${type}" ${type === line.type ? 'selected' : ''}>${type}</option>`).join('')}</select><input name="period" type="number" min="1" max="5000" value="${line.period}" aria-label="均线${index + 1}周期" required><input name="color" type="color" value="${line.color}" aria-label="均线${index + 1}颜色"></div><details><summary>价格来源、位移与ALMA参数</summary><div class="ma-extra"><label>价格来源 <select name="source">${Object.entries(sources).map(([key, title]) => `<option value="${key}" ${line.source === key ? 'selected' : ''}>${title}</option>`).join('')}</select></label><label>位移 <input name="offset" type="number" min="-500" max="500" value="${line.offset}" required></label><label>ALMA offset <input name="almaOffset" type="number" min="0" max="1" step="0.01" value="${line.almaOffset}" required></label><label>sigma <input name="sigma" type="number" min="0.1" max="100" step="0.1" value="${line.sigma}" required></label></div></details></fieldset>`).join('');
}
function renderFibSettings(config = fibConfig) {
  $('#fib-fill').checked = config.fill !== false;
  $('#fib-rows').innerHTML = config.levels.map((level, index) => `<label class="fib-row"><input name="enabled" data-fib-index="${index}" type="checkbox" ${level.enabled !== false ? 'checked' : ''}><input name="ratio" data-fib-index="${index}" type="number" step="0.001" value="${level.ratio}" aria-label="斐波那契比例 ${level.ratio}"><input name="color" data-fib-index="${index}" type="color" value="${level.color || '#808994'}" aria-label="斐波那契 ${level.ratio} 颜色"></label>`).join('');
}
function applyFibToSelected() {
  const overlay = state.selected && chart.getOverlayById(state.selected);
  if (!overlay || !['fibRetracement', 'fibExtension'].includes(overlay.name)) return toast('请先在图表中选中一条斐波那契线');
  chart.overrideOverlay({ id: overlay.id, extendData: { ...(overlay.extendData || {}), levels: fibConfig.levels, fill: fibConfig.fill } });
  const updated = chart.getOverlayById(overlay.id); if (updated) { state.drawings.set(updated.id, serializeOverlay(updated)); persistDrawings(); }
}
$('#ma-settings').addEventListener('click', () => { renderMaSettings(maConfig); $('#ma-dialog').showModal(); });
$('#fib-settings').addEventListener('click', () => { renderFibSettings(); $('#fib-dialog').showModal(); });
$('#fib-reset').addEventListener('click', () => renderFibSettings(ChartStudies.defaultFibonacciConfig()));
$('#fib-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const levels = fibConfig.levels.map((level, index) => ({ ratio: Number($(`[name="ratio"][data-fib-index="${index}"]`).value), enabled: $(`[name="enabled"][data-fib-index="${index}"]`).checked, color: $(`[name="color"][data-fib-index="${index}"]`).value }));
  if (levels.some((level) => !Number.isFinite(level.ratio))) return toast('斐波那契比例必须是数字');
  fibConfig = { levels: levels.sort((a, b) => a.ratio - b.ratio), fill: $('#fib-fill').checked };
  store.set('fib-config', fibConfig); applyFibToSelected(); $('#fib-dialog').close(); toast('斐波那契设置已保存，新画线也会使用这些级别');
});
$('#ma-reset').addEventListener('click', () => renderMaSettings(ChartStudies.defaultConfig()));
$('#ma-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const lines = $$('.ma-row').map((row) => {
    const get = (name) => row.querySelector(`[name="${name}"]`);
    return { enabled: get('enabled').checked, period: Number(get('period').value), type: get('type').value, color: get('color').value, source: get('source').value, offset: Number(get('offset').value), almaOffset: Number(get('almaOffset').value), sigma: Number(get('sigma').value) };
  });
  if (lines.some((line) => !Number.isInteger(line.period) || !Number.isInteger(line.offset))) return toast('均线周期和位移必须为整数');
  maConfig = { defaultType: $('#ma-default-type').value, fill: $('#ma-fill').checked, lines };
  store.set('ma-config', maConfig); applyMovingAverages(); $('#ma-dialog').close(); toast('均线设置已保存');
});

function toggleIndicator(name) {
  if (name === 'PMA' && !state.indicators.has(name)) return applyMovingAverages();
  if (state.indicators.has(name)) {
    chart.removeIndicator(state.indicators.get(name), name); state.indicators.delete(name);
  } else {
    const main = ['MA', 'EMA', 'BOLL'].includes(name);
    const pane = chart.createIndicator({ name, ...(name === 'MA' ? { calcParams: [5, 10, 20] } : {}) }, main, main ? { id: 'candle_pane' } : { height: name === 'VOL' ? 95 : 110, minHeight: 65 });
    if (pane) state.indicators.set(name, pane);
  }
  $$('[data-indicator]').forEach((button) => button.classList.toggle('active', state.indicators.has(button.dataset.indicator)));
}
applyMovingAverages(); toggleIndicator('VOL');
$$('[data-indicator]').forEach((button) => button.addEventListener('click', () => toggleIndicator(button.dataset.indicator)));

function serializeOverlay(overlay) {
  return { id: overlay.id, name: overlay.name, points: overlay.points.map((point) => ({
    ...(point.timestamp != null ? { timestamp: point.timestamp } : { dataIndex: point.dataIndex }), value: point.value,
  })), styles: overlay.styles, lock: overlay.lock, extendData: overlay.extendData };
}
function persistDrawings() { if (state.drawingKey && !state.restoring) { store.set(state.drawingKey, [...state.drawings.values()]); $('#drawing-save').textContent = `已保存 ${state.drawings.size} 笔画线`; } }
function drawingOptions(saved = {}) {
  return { ...saved,
    onDrawEnd: ({ overlay }) => { state.drawingId = null; state.drawings.set(overlay.id, serializeOverlay(overlay)); persistDrawings(); selectTool('cursor'); return false; },
    onPressedMoveEnd: ({ overlay }) => { state.drawings.set(overlay.id, serializeOverlay(overlay)); persistDrawings(); return false; },
    onRemoved: ({ overlay }) => { state.drawings.delete(overlay.id); if (state.selected === overlay.id) state.selected = null; if (overlay.name === 'measurementRuler') $('#measurement-readout').hidden = true; persistDrawings(); return false; },
    onSelected: ({ overlay }) => { state.selected = overlay.id; return false; },
    onDeselected: () => { state.selected = null; return false; },
  };
}
function selectTool(name) {
  ruler.armed = false; ruler.origin = null; ruler.pointer = null;
  $('#ruler-surface').hidden = true;
  if (state.drawingId) { chart.removeOverlay(state.drawingId); state.drawingId = null; }
  $$('[data-tool]').forEach((button) => button.classList.toggle('active', button.dataset.tool === name));
  if (name !== 'cursor') {
    if (!state.data.length || !$('#error').hidden || !$('#loading').hidden) { selectTool('cursor'); return toast('请先加载行情'); }
    if (name === 'measurementRuler') {
      ruler.armed = true; sizeRulerSurface(); $('#ruler-surface').hidden = false;
      toast('按住拖动测量，或依次点击起点、终点；Esc退出'); return;
    }
    const color = $('#line-color').value;
    state.drawingId = chart.createOverlay(drawingOptions({ name, extendData: ['fibRetracement', 'fibExtension'].includes(name) ? fibConfig : { fill: true }, styles: { line: { color, size: 1.5 }, polygon: { color: `${color}18`, borderColor: color }, rect: { color: `${color}18`, borderColor: color }, text: { color } } }));
    toast(name === 'horizontalStraightLine' ? '在图表上点击落点' : ['parallelStraightLine', 'fibExtension'].includes(name) ? '依次点击三个点：起点、终点、回调点'  : '在图表上依次点击两个点');
  }
}
function restoreDrawings() {
  selectTool('cursor');
  state.restoring = true; chart.removeOverlay(); state.drawings.clear(); state.selected = null;
  state.drawingKey = `drawings:${state.market}:${state.symbol}:${state.period}:${state.anchor}`;
  const saved = store.get(state.drawingKey, []);
  for (const drawing of saved) { state.drawings.set(drawing.id, drawing); chart.createOverlay(drawingOptions(drawing)); }
  state.restoring = false;
  $('#drawing-save').textContent = saved.length ? `已保存 ${saved.length} 笔画线` : '画线自动保存';
}
function removeSelected() { if (state.selected) chart.removeOverlay(state.selected); else toast('先点击选中一笔画线，再删除'); }
function undoDrawing() { if (state.drawingId) return selectTool('cursor'); const id = [...state.drawings.keys()].pop(); if (id) chart.removeOverlay(id); }
$$('[data-tool]').forEach((button) => button.addEventListener('click', () => selectTool(button.dataset.tool)));
$('#delete-drawing').addEventListener('click', removeSelected); $('#undo-drawing').addEventListener('click', undoDrawing);
$('#line-color').addEventListener('input', () => {
  if (!state.selected) return;
  const color = $('#line-color').value;
  chart.overrideOverlay({ id: state.selected, styles: { line: { color }, polygon: { color: `${color}18`, borderColor: color }, rect: { color: `${color}18`, borderColor: color }, text: { color } } });
  const overlay = chart.getOverlayById(state.selected); if (overlay) { state.drawings.set(overlay.id, serializeOverlay(overlay)); persistDrawings(); }
});
document.addEventListener('keydown', (event) => {
  if (event.target.matches('input,textarea,select') || $('dialog[open]')) return;
  if (event.key === 'Escape') selectTool('cursor');
  if (event.altKey && event.key.toLowerCase() === 'r') { event.preventDefault(); selectTool('measurementRuler'); }
  if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); removeSelected(); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undoDrawing(); }
});

function renderWatchlist() {
  const visible = state.watchlist.filter((item) => state.filter === 'all' || item.market === state.filter);
  $('#watchlist').innerHTML = visible.map((item) => {
    const index = state.watchlist.indexOf(item);
    return `<div class="watch-row ${state.market === item.market && state.symbol === item.symbol ? 'selected' : ''}"><button class="watch-item" data-watch="${index}" title="查看${escapeHtml(item.name)}"><span class="watch-icon ${item.market}">${escapeHtml(item.market === 'crypto' ? (item.symbol.startsWith('BTC') ? '₿' : 'Ξ') : item.market === 'fx' ? '⇄' : item.symbol.slice(0, 1))}</span><span class="watch-name"><strong>${escapeHtml(item.symbol)}</strong><small>${escapeHtml(item.name)} · ${marketNames[item.market]}</small></span><span class="watch-arrow">›</span></button><button class="remove-watch" data-remove="${index}" title="移出自选" aria-label="移除${escapeHtml(item.symbol)}">×</button></div>`;
  }).join('') || '<p class="empty-list">还没有自选，点击右上角＋添加当前品种。</p>';
}
$('#watchlist').addEventListener('click', (event) => {
  const remove = event.target.closest('[data-remove]');
  if (remove) { state.watchlist.splice(Number(remove.dataset.remove), 1); store.set('watchlist', state.watchlist); renderWatchlist(); return; }
  const button = event.target.closest('[data-watch]');
  if (button) { const item = state.watchlist[Number(button.dataset.watch)]; state.market = item.market; state.symbol = item.symbol; syncControls(); load(); }
});
$('#add-watch').addEventListener('click', () => {
  if (!state.meta || !$('#error').hidden || !$('#loading').hidden) return toast('请先成功加载品种');
  if (state.market === 'csv') return toast('CSV品种请在本次会话使用，不能从行情接口重新加载');
  if (state.watchlist.some((item) => item.market === state.market && item.symbol === state.symbol)) return toast('该品种已在自选列表');
  state.watchlist.push({ market: state.market, symbol: state.symbol, name: state.meta.name }); store.set('watchlist', state.watchlist); renderWatchlist(); toast('已加入自选');
});
$$('[data-filter]').forEach((button) => button.addEventListener('click', () => { state.filter = button.dataset.filter; $$('[data-filter]').forEach((b) => b.classList.toggle('active', b === button)); renderWatchlist(); }));

function syncControls() {
  $('#market').value = state.market; $('#symbol').value = state.symbol; $('#anchor').value = state.anchor;
  renderPeriods(); $('#period-current').textContent = label();
  $('#period-label').textContent = label(); $('#market-label').textContent = marketLabels[state.market];
  renderWatchlist(); renderSymbolTabs(); remember();
}
function fitRange() {
  if (!state.data.length) return;
  const count = state.range === 'all' ? state.data.length : Math.min(Number(state.range), state.data.length);
  chart.setBarSpace(Math.max(0.05, Math.min(40, ($('#chart').clientWidth - 155) / count)));
  chart.scrollToRealTime();
}
function display(result) {
  state.data = result.data; state.meta = result.meta;
  rememberOpenSymbol();
  const last = state.data.at(-1), prev = state.data.at(-2);
  showCandleChange(last, prev); $('#measurement-readout').hidden = true;
  const decimals = state.market === 'fx' ? (state.symbol === 'XAUUSD' ? 2 : state.symbol.includes('JPY') ? 3 : 5) : last.close < 1 ? 6 : 2;
  chart.setPriceVolumePrecision(decimals, state.market === 'crypto' ? 4 : 0);
  chart.applyNewData(state.data, false, () => { fitRange(); restoreDrawings(); });
  $('#instrument-name').textContent = state.meta.name; $('#instrument-code').textContent = state.meta.symbol;
  $('#last-price').textContent = format(last.close, decimals);
  const change = prev ? last.close - prev.close : 0, percentage = prev ? change / prev.close * 100 : 0;
  $('#last-change').textContent = `${change >= 0 ? '+' : ''}${format(change, decimals)} (${change >= 0 ? '+' : ''}${percentage.toFixed(2)}%) · 较上根${label()}K线`;
  $('#last-change').className = change >= 0 ? 'up' : 'down';
  updateOpenSymbolQuote(last, prev, decimals);
  const warning = result.warning || (Number(state.period) > 1 && last.count < Number(state.period) ? `最新一根含${last.count}个交易日，未满${state.period}日` : `最新${label()}K线可能尚未收盘`);
  $('#status-dot').className = `status-dot ${result.stale ? 'warn' : 'ok'}`;
  $('#status-text').textContent = `${state.meta.source}${result.stale ? ' · 离线缓存' : result.cached ? ' · 本地缓存' : ''} · ${warning}`;
  $('#status-text').title = $('#status-text').textContent;
  $('#data-time').textContent = `${state.meta.firstDate} — ${state.meta.lastDate}`;
  $('#source-details').textContent = `${state.meta.source} · ${state.meta.currency} · ${state.meta.adjustment}\n${state.meta.notice}\n数据范围 ${state.meta.firstDate} — ${state.meta.lastDate}\n${state.meta.rawCount}根日线 → ${state.data.length}根${label()}K线\n获取时间 ${new Date(result.fetchedAt * 1000).toLocaleString('zh-CN')}`;
  $('#bar-info').textContent = `${state.data.length}根 · 滚轮缩放 · 拖动平移`;
  $('#anchor').min = state.meta.firstDate; $('#anchor').max = state.meta.lastDate;
}
async function load(refresh = false) {
  const requestId = ++state.requestId;
  state.controller?.abort(); state.controller = new AbortController();
  selectTool('cursor'); $('#loading').hidden = false; $('#error').hidden = true; $('#refresh').disabled = true;
  $('#status-text').textContent = '正在获取行情…'; $('#status-dot').className = 'status-dot';
  try {
    let result;
    if (state.market === 'csv') {
      if (!state.csv) throw new Error('请先导入CSV文件');
      const data = aggregateCsv(state.csv.bars, state.period, state.anchor);
      result = { data, meta: { name: state.csv.name, symbol: state.symbol, source: '本地CSV', currency: '原始单位', adjustment: '以CSV为准', notice: '用户导入日线；请自行确认复权和数据口径。', firstDate: dateText(state.csv.bars[0].timestamp), lastDate: dateText(state.csv.bars.at(-1).timestamp), rawCount: state.csv.bars.length }, fetchedAt: Date.now() / 1000 };
    } else {
      const query = new URLSearchParams({ market: state.market, symbol: state.symbol, period: state.period, anchor: state.anchor, refresh: refresh ? '1' : '0' });
      const response = await fetch(`/api/history?${query}`, { signal: state.controller.signal });
      result = await response.json(); if (!response.ok) throw new Error(result.error || '行情加载失败');
    }
    if (requestId !== state.requestId) return;
    if (!result.data?.length) throw new Error('未找到有效行情');
    display(result);
  } catch (error) {
    if (error.name === 'AbortError' || requestId !== state.requestId) return;
    $('#error-text').textContent = error.message; $('#error').hidden = false;
    $('#status-text').textContent = '行情加载失败'; $('#status-dot').className = 'status-dot warn';
    $('#last-price').textContent = '—'; $('#last-change').textContent = '数据未加载'; $('#data-time').textContent = '';
    state.data = []; state.meta = null; chart.clearData();
  } finally { if (requestId === state.requestId) { $('#loading').hidden = true; $('#refresh').disabled = false; } }
}
let cnSearchTimer, cnSearchController;
function hideCnSuggestions() { $('#cn-suggestions').hidden = true; $('#cn-suggestions').replaceChildren(); }
function showCnSuggestions(rows) {
  const box = $('#cn-suggestions'); box.replaceChildren();
  rows.forEach((row) => { const button = document.createElement('button'); button.type = 'button'; button.role = 'option'; button.dataset.symbol = row.symbol; button.dataset.name = row.name; button.innerHTML = `<strong>${escapeHtml(row.name)}</strong><span>${escapeHtml(row.symbol)}</span>`; box.append(button); });
  box.hidden = !rows.length;
}
$('#symbol').addEventListener('input', () => {
  if ($('#market').value !== 'cn') return hideCnSuggestions();
  const query = $('#symbol').value.trim();
  clearTimeout(cnSearchTimer); cnSearchController?.abort();
  if (query.length < 1) return hideCnSuggestions();
  cnSearchTimer = setTimeout(async () => {
    cnSearchController = new AbortController();
    try { const response = await fetch(`/api/cn-search?q=${encodeURIComponent(query)}`, { signal: cnSearchController.signal }); const result = await response.json(); showCnSuggestions(result.data || []); } catch (error) { if (error.name !== 'AbortError') hideCnSuggestions(); }
  }, 180);
});
$('#cn-suggestions').addEventListener('click', (event) => {
  const button = event.target.closest('[data-symbol]'); if (!button) return;
  $('#symbol').value = button.dataset.name; state.market = 'cn'; state.symbol = button.dataset.symbol; hideCnSuggestions(); syncControls(); load();
});
document.addEventListener('click', (event) => { if (!event.target.closest('.symbol-search')) hideCnSuggestions(); });
$('#symbol-form').addEventListener('submit', async (event) => {
  event.preventDefault(); hideCnSuggestions();
  state.market = $('#market').value; const query = $('#symbol').value.trim();
  if (state.market === 'cn' && query && !/^((sh|sz|bj)?\d{6})$/i.test(query)) {
    try {
      const response = await fetch(`/api/cn-search?q=${encodeURIComponent(query)}`), result = await response.json(), first = result.data?.[0];
      if (!first) return toast('没有找到匹配的A股名称，请输入代码或换个关键词');
      state.symbol = first.symbol; $('#symbol').value = first.symbol;
    } catch { return toast('A股名称搜索暂时不可用，请输入6位代码'); }
  } else state.symbol = state.market === 'cn' ? query : query.toUpperCase();
  syncControls(); load();
});
$('#market').addEventListener('change', () => { const market = $('#market').value; if (market === 'csv') return $('#csv-file').click(); state.market = market; state.symbol = defaults.find((item) => item.market === market).symbol; syncControls(); load(); });
const standardPeriods = [
  { title: '天', values: ['1', '2', '3', '5', '10'] },
  { title: '周', values: ['W', '2W', '3W'] },
  { title: '月', values: ['M', '3M', '6M', '12M'] },
];
let customPeriods = store.get('custom-periods', []);
customPeriods = (Array.isArray(customPeriods) ? customPeriods : []).flatMap((value) => { try { return [parsePeriod(value).key]; } catch { return []; } });
try { state.period = parsePeriod(state.period).key; } catch { state.period = '3'; }
const isStandardPeriod = (value) => standardPeriods.some((group) => group.values.includes(value));
if (!isStandardPeriod(state.period) && !customPeriods.includes(state.period)) customPeriods.push(state.period);
function renderPeriods() {
  const groups = [...standardPeriods, ...(customPeriods.length ? [{ title: '自定义', values: [...new Set(customPeriods)] }] : [])];
  $('#period-options').innerHTML = groups.map((group) => `<section class="period-group"><h3>${group.title}</h3>${group.values.map((value) => `<div class="period-row"><button data-period="${value}" class="period-option ${state.period === value ? 'active' : ''}" ${state.period === value ? 'aria-current="true"' : ''}>${label(value).replace(/(日|周|月)$/, ' $1')}<span aria-hidden="true">${state.period === value ? '✓' : ''}</span></button>${group.title === '自定义' ? `<button class="remove-period" data-remove-period="${value}" aria-label="移除${label(value)}自定义周期" title="移除自定义周期">×</button>` : ''}</div>`).join('')}</section>`).join('');
}
function closePeriodMenu(focus = false) {
  $('#period-menu').hidden = true; $('#period-toggle').setAttribute('aria-expanded', 'false');
  if (focus) $('#period-toggle').focus();
}
$('#period-toggle').addEventListener('click', () => {
  const open = $('#period-menu').hidden;
  $('#period-menu').hidden = !open; $('#period-toggle').setAttribute('aria-expanded', String(open));
  if (open) $('#period-menu').scrollTop = 0;
});
document.addEventListener('click', (event) => { if (!event.target.closest('.period-picker')) closePeriodMenu(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('#period-menu').hidden) closePeriodMenu(true); });
$('#period-options').addEventListener('click', (event) => {
  const remove = event.target.closest('[data-remove-period]');
  if (remove) { customPeriods = customPeriods.filter((value) => value !== remove.dataset.removePeriod); store.set('custom-periods', customPeriods); renderPeriods(); $('#add-period').focus(); return; }
  const button = event.target.closest('[data-period]'); if (!button) return;
  const changed = state.period !== button.dataset.period;
  state.period = button.dataset.period; closePeriodMenu(true); syncControls(); if (changed) load();
});
$('#add-period').addEventListener('click', () => { closePeriodMenu(); $('#custom-period-dialog').showModal(); $('#custom-count').focus(); $('#custom-count').select(); });
$('#custom-unit').addEventListener('change', () => {
  const unit = $('#custom-unit').value;
  $('#custom-count').max = { D: 250, W: 52, M: 120 }[unit];
  $('#custom-period-hint').textContent = { D: '1–250个交易日；跳过休市日。', W: '1–52个自然周；每周从周一开始。', M: '1–120个自然月；3月为季度，12月为年线。' }[unit];
});
$('#period-form').addEventListener('submit', (event) => {
  event.preventDefault();
  try {
    const unit = $('#custom-unit').value, count = Number($('#custom-count').value);
    const { key } = parsePeriod(`${count}${unit === 'D' ? '' : unit}`);
    if (!isStandardPeriod(key) && !customPeriods.includes(key)) customPeriods.push(key);
    store.set('custom-periods', customPeriods); state.period = key;
    $('#custom-period-dialog').close(); syncControls(); load(); $('#period-toggle').focus();
  } catch (error) { toast(error.message); }
});
$('#settings-button').addEventListener('click', () => $('#settings-dialog').showModal());
$('#settings-form').addEventListener('submit', (event) => { event.preventDefault(); state.anchor = $('#anchor').value; $('#settings-dialog').close(); syncControls(); load(); });
$('#help').addEventListener('click', () => $('#help-dialog').showModal());
$$('.close-dialog').forEach((button) => button.addEventListener('click', () => { button.closest('dialog').close(); $('#anchor').value = state.anchor; }));
$('#refresh').addEventListener('click', () => load(true)); $('#retry').addEventListener('click', () => load(true));
$$('[data-range]').forEach((button) => button.addEventListener('click', () => { state.range = button.dataset.range; $$('[data-range]').forEach((b) => b.classList.toggle('active', b === button)); fitRange(); }));
$('#latest').addEventListener('click', () => chart.scrollToRealTime(200));
function download(url, name) { const link = document.createElement('a'); link.href = url; link.download = name; link.click(); }
$('#screenshot').addEventListener('click', () => {
  if (!state.data.length) return toast('请先加载行情');
  const picture = chart.getConvertPictureUrl(true, 'png', '#ffffff');
  const bytes = Uint8Array.from(atob(picture.split(',')[1]), (char) => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
  download(url, `${state.symbol}-${label()}.png`); setTimeout(() => URL.revokeObjectURL(url), 3000);
});
$('#export-csv').addEventListener('click', () => {
  if (!state.data.length) return toast('请先加载行情');
  const text = 'date,open,high,low,close,volume,end_date,session_count\n' + state.data.map((bar) => [dateText(bar.timestamp), bar.open, bar.high, bar.low, bar.close, bar.volume, dateText(bar.endTimestamp), bar.count].join(',')).join('\n');
  const url = URL.createObjectURL(new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' })); download(url, `${state.symbol}-${label()}.csv`); setTimeout(() => URL.revokeObjectURL(url), 3000);
});

$('#import-button').addEventListener('click', () => $('#csv-file').click());
$('#csv-file').addEventListener('cancel', () => { $('#market').value = state.market; });
$('#csv-file').addEventListener('change', async () => {
  const file = $('#csv-file').files[0]; if (!file) return;
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error('CSV文件请控制在10MB以内');
    const bars = parseCsv(await file.text());
    state.csv = { name: file.name.replace(/\.csv$/i, ''), bars };
    state.market = 'csv'; state.symbol = state.csv.name;
    if (state.anchor < dateText(bars[0].timestamp) || state.anchor > dateText(bars.at(-1).timestamp)) state.anchor = dateText(bars[0].timestamp);
    syncControls(); load();
  } catch (error) { toast(error.message); $('#market').value = state.market; }
  $('#csv-file').value = '';
});
syncControls(); load();
