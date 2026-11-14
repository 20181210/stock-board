const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv, aggregateCsv, parsePeriod, periodLabel } = require('../public/data.js');
const csv = 'date,open,high,low,close,volume\r\n2024-12-26,10,13,8,12,100\r\n2024-12-27,11,14,9,13,101\r\n2024-12-30,12,15,10,14,102\r\n2024-12-31,13,16,11,15,103\r\n2025-01-02,14,17,12,16,104\r\n2025-01-03,15,18,13,17,105\r\n2025-01-06,16,19,14,18,106\r\n2025-01-07,17,20,15,19,107\r\n2025-01-08,18,21,16,20,108';
test('daily CSV and session aggregation agree with backend fixture', () => {
  const bars = parseCsv(csv);
  const result = aggregateCsv(bars, '3', '2025-01-01');
  assert.deepEqual(result.map((bar) => bar.count), [1, 3, 3, 2]);
  assert.deepEqual(result[2], { timestamp: Date.parse('2025-01-02T00:00:00Z'), open: 14, high: 19, low: 12, close: 18, volume: 315, count: 3, endTimestamp: Date.parse('2025-01-06T00:00:00Z') });
  assert.deepEqual(aggregateCsv(bars, 'W', '2025-01-01').map((b) => b.count), [2, 4, 3]);
  assert.deepEqual(aggregateCsv(bars, 'M', '2025-01-01').map((b) => b.count), [4, 5]);
});
test('CSV rejects invalid date, duplicate dates, blank and invalid prices', () => {
  assert.throws(() => parseCsv(csv.replace('2024-12-26', '2024-02-30')), /日期无效/);
  assert.throws(() => parseCsv(csv.replace('2024-12-27', '2024-12-26')), /日期重复/);
  assert.throws(() => parseCsv(csv.replace('10,13,8,12', ',13,8,12')), /OHLC/);
  assert.throws(() => parseCsv(csv.replace('10,13,8,12', '10,9,8,12')), /OHLC/);
});
test('CSV accepts BOM, quoted numeric cells and omitted volume', () => {
  const bars = parseCsv('\ufeffdate,open,high,low,close\n"2025-01-01","1","3","1","2"\n2025-01-02,2,4,1,3');
  assert.equal(bars[0].volume, 0); assert.equal(bars[1].close, 3);
});
test('multi-day CSV export is not silently compounded again', () => {
  assert.throws(() => parseCsv('date,open,high,low,close,session_count\n2025-01-01,1,3,1,2,3\n2025-01-04,2,4,1,3,3'), /已经合成/);
});
test('custom day, week and month periods validate and canonicalize', () => {
  assert.deepEqual(parsePeriod('1W'), {unit:'W', size:1, key:'W'});
  assert.equal(periodLabel('12M'), '12月');
  for (const value of ['0', '251', '53W', '121M', '2.5', '2.5M', 'D', '', '-1W', '1H']) assert.throws(() => parsePeriod(value));
});
test('multi-month bars use calendar quarters, halves and years across year boundary', () => {
  const dates = ['2024-12-30','2025-01-02','2025-03-31','2025-04-01','2025-06-30','2025-07-01','2026-01-02'];
  const bars = dates.map((day, i) => ({timestamp:Date.parse(`${day}T00:00:00Z`),open:10+i,high:20+i,low:9+i,close:12+i,volume:100+i}));
  assert.deepEqual(aggregateCsv(bars,'3M','invalid').map((b) => b.count), [1,2,2,1,1]);
  assert.deepEqual(aggregateCsv(bars,'6M','invalid').map((b) => b.count), [1,4,1,1]);
  assert.deepEqual(aggregateCsv(bars,'12M','invalid').map((b) => b.count), [1,5,1]);
  assert.deepEqual(aggregateCsv(bars,'3M','invalid')[1], {...bars[1],high:bars[2].high,close:bars[2].close,volume:203,count:2,endTimestamp:bars[2].timestamp});
});
test('custom weeks have fixed Monday boundaries independent of history and day anchor', () => {
  const bars = ['2024-12-30','2025-01-03','2025-01-06','2025-01-12','2025-01-13'].map((day) => ({timestamp:Date.parse(`${day}T00:00:00Z`),open:10,high:12,low:9,close:11,volume:1}));
  const full = aggregateCsv(bars,'2W','invalid');
  assert.deepEqual(full.map((b) => b.count), [2,3]);
  assert.deepEqual(aggregateCsv(bars.slice(2),'2W','invalid'), full.slice(1));
});
