const { test } = require('node:test');
const assert = require('node:assert/strict');
const { defaultConfig, movingAverage, calculate, fibonacciLevels, candleChange, measureRange } = require('../public/studies.js');
test('image 2 defaults preserve all seven settings', () => {
  const config = defaultConfig();
  assert.equal(config.defaultType, 'EMA');
  assert.deepEqual(config.lines.map((line) => line.period), [8,144,169,13,338,576,676]);
  assert.deepEqual(config.lines.map((line) => line.enabled), [true,true,true,true,false,true,true]);
});
test('EMA, SMA, WMA and RMA on known sequences', () => {
  assert.deepEqual(movingAverage([1,2,3,4],3,'SMA'), [null,null,2,3]);
  assert.deepEqual(movingAverage([1,2,3],3,'EMA'), [1,1.5,2.25]);
  assert.deepEqual(movingAverage([1,2,3,4],3,'RMA'), [null,null,2,8/3]);
  assert.equal(movingAverage([1,2,3],3,'WMA')[2], 14/6);
  assert.equal(movingAverage([5,5,5],3,'ALMA')[2], 5);
});
test('source and plot offset respect settings', () => {
  const config = defaultConfig(); config.lines.forEach((line) => line.enabled = false);
  Object.assign(config.lines[0], {enabled:true,period:1,type:'SMA',source:'high',offset:1});
  const result = calculate([{open:1,high:4,low:1,close:2},{open:2,high:6,low:1,close:3}], config);
  assert.deepEqual(result, [{},{ma0:4}]);
});
test('retracement uses B-(B-A)*r; extension uses C+(B-A)*r', () => {
  assert.deepEqual(fibonacciLevels([{value:100},{value:200}], false, [0,0.5,1,1.618]), [{ratio:0,value:200},{ratio:0.5,value:150},{ratio:1,value:100},{ratio:1.618,value:38.19999999999999}]);
  assert.deepEqual(fibonacciLevels([{value:200},{value:100},{value:150}], true, [0,1,1.618]), [{ratio:0,value:150},{ratio:1,value:50},{ratio:1.618,value:-11.800000000000011}]);
});
test('candle percentage compares close with previous close, including composite candles', () => {
  assert.equal(candleChange({ open: 109, close: 110, count: 5 }, { close: 100 }), 10);
  assert.equal(candleChange({ close: 90 }, { close: 100 }), -10);
  assert.equal(candleChange({ close: 100 }, { close: 100 }), 0);
  assert.equal(candleChange({ close: 100 }, undefined), null);
  assert.equal(candleChange({ close: 100 }, { close: 0 }), null);
  assert.equal(candleChange({ close: NaN }, { close: 100 }), null);
});
test('ruler keeps signed price change and distinguishes bar intervals from calendar days', () => {
  const friday = { value: 100, dataIndex: 10, timestamp: Date.UTC(2026, 10, 6) };
  const monday = { value: 125, dataIndex: 11, timestamp: Date.UTC(2026, 10, 9) };
  assert.deepEqual(measureRange(friday, monday), { difference: 25, percentage: 25, bars: 1, days: 3 });
  assert.deepEqual(measureRange(monday, friday), { difference: -25, percentage: -20, bars: 1, days: 3 });
  assert.deepEqual(measureRange(friday, friday), { difference: 0, percentage: 0, bars: 0, days: 0 });
  assert.equal(measureRange({ value: 0 }, { value: 10 }).percentage, null);
  assert.equal(measureRange({ value: 0 }, { value: 10 }).bars, null);
  assert.equal(measureRange({ value: 0 }, { value: 10 }).days, null);
});
