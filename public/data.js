'use strict';
(function (root) {
function dateText(timestamp) { return new Date(timestamp).toISOString().slice(0, 10); }
function parseCsv(text) {
  // Daily numeric CSV only; quoted cells and CRLF are accepted.
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  const split = (line) => (line.match(/(?:"(?:[^"]|"")*"|[^,]*)(?:,|$)/g) || []).filter((cell, i, all) => i < all.length - 1 || cell).map((cell) => cell.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"').trim());
  const headers = split(lines.shift()).map((header) => header.toLowerCase());
  for (const required of ['date', 'open', 'high', 'low', 'close']) if (!headers.includes(required)) throw new Error(`CSV缺少表头：${required}`);
  if (headers.includes('session_count')) {
    const countIndex = headers.indexOf('session_count');
    if (lines.some((line) => Number(split(line)[countIndex]) > 1)) throw new Error('此文件已经合成多日K线。请导入原始日线，避免重复合成；可先切到日周期导出。');
  }
  const bars = new Map();
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    const cells = split(line), row = Object.fromEntries(headers.map((header, i) => [header, cells[i]]));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date || '')) throw new Error(`第${index + 2}行日期应为YYYY-MM-DD`);
    const timestamp = Date.parse(`${row.date}T00:00:00Z`);
    if (!Number.isFinite(timestamp) || dateText(timestamp) !== row.date) throw new Error(`第${index + 2}行日期无效`);
    const bar = { timestamp, ...Object.fromEntries(['open', 'high', 'low', 'close'].map((key) => [key, row[key] === '' || row[key] == null ? NaN : Number(row[key])])), volume: Number(row.volume || 0) };
    if (Object.values(bar).some((value) => !Number.isFinite(value)) || Math.min(bar.open, bar.high, bar.low, bar.close) <= 0 || bar.volume < 0 || bar.high < Math.max(bar.open, bar.close, bar.low) || bar.low > Math.min(bar.open, bar.close)) throw new Error(`第${index + 2}行OHLC或成交量无效`);
    if (bars.has(timestamp)) throw new Error(`第${index + 2}行日期重复：${row.date}`);
    bars.set(timestamp, bar);
  });
  if (bars.size < 2) throw new Error('CSV至少需要两根有效日线');
  return [...bars.values()].sort((a, b) => a.timestamp - b.timestamp);
}
function parsePeriod(period) {
  const match = /^(\d*)([WM]?)$/.exec(String(period));
  if (!match || (!match[1] && !match[2])) throw new Error('无效周期');
  const unit = match[2] || 'D', size = Number(match[1] || 1), maximum = { D: 250, W: 52, M: 120 }[unit];
  if (!Number.isInteger(size) || size < 1 || size > maximum) throw new Error(`周期范围：1–250日、1–52周、1–120月`);
  return { unit, size, key: unit === 'D' ? String(size) : `${size === 1 ? '' : size}${unit}` };
}
function periodLabel(period) { const { unit, size } = parsePeriod(period); return `${size}${{ D: '日', W: '周', M: '月' }[unit]}`; }
function aggregateCsv(bars, period, anchor) {
  const { unit, size } = parsePeriod(period), anchorTime = Date.parse(`${anchor}T00:00:00Z`);
  if (!bars.length) return [];
  if (unit === 'D' && size > 1 && (!Number.isFinite(anchorTime) || anchorTime < bars[0].timestamp || anchorTime > bars.at(-1).timestamp)) throw new Error('对齐日期不在CSV数据范围内，请在周期设置里调整');
  const anchorIndex = bars.findIndex((bar) => bar.timestamp >= anchorTime), groups = new Map();
  bars.forEach((bar, index) => {
    const date = new Date(bar.timestamp); let key;
    if (unit === 'M') key = Math.floor(((date.getUTCFullYear() - 1970) * 12 + date.getUTCMonth()) / size);
    else if (unit === 'W') key = Math.floor((bar.timestamp - Date.UTC(1970, 0, 5)) / (size * 7 * 86400000));
    else key = Math.floor((index - anchorIndex) / size);
    if (!groups.has(key)) groups.set(key, { ...bar, count: 1, endTimestamp: bar.timestamp });
    else { const out = groups.get(key); Object.assign(out, { high: Math.max(out.high, bar.high), low: Math.min(out.low, bar.low), close: bar.close, volume: out.volume + bar.volume, count: out.count + 1, endTimestamp: bar.timestamp }); }
  });
  return [...groups.values()];
}

const api = { parseCsv, aggregateCsv, parsePeriod, periodLabel };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.MarketData = api;
})(globalThis);
