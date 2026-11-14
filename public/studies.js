'use strict';
(function (root) {
  const periods = [8, 144, 169, 13, 338, 576, 676];
  const colors = ['#3060ff', '#1bb6c9', '#f2cf35', '#3060ff', '#ff982a', '#4caf58', '#ff5359'];
  const defaultConfig = () => ({ defaultType: 'EMA', fill: true, lines: periods.map((period, index) => ({ enabled: index !== 4, period, color: colors[index], type: 'default', source: 'close', offset: 0, almaOffset: 0.85, sigma: 6 })) });
  function sourceValue(bar, source) {
    if (source === 'hl2') return (bar.high + bar.low) / 2;
    if (source === 'hlc3') return (bar.high + bar.low + bar.close) / 3;
    if (source === 'ohlc4') return (bar.open + bar.high + bar.low + bar.close) / 4;
    return bar[source] ?? bar.close;
  }
  function movingAverage(values, period, type, almaOffset = 0.85, sigma = 6) {
    const output = Array(values.length).fill(null);
    let sum = 0, previous = null;
    const weights = type === 'ALMA' ? Array.from({ length: period }, (_, j) => Math.exp(-((j - almaOffset * (period - 1)) ** 2) / (2 * (period / sigma) ** 2))) : [];
    const weightSum = weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < values.length; i++) {
      sum += values[i]; if (i >= period) sum -= values[i - period];
      if (type === 'EMA') { previous = previous == null ? values[i] : values[i] * (2 / (period + 1)) + previous * (1 - 2 / (period + 1)); output[i] = previous; }
      else if (type === 'RMA') { if (i === period - 1) previous = sum / period; else if (i >= period) previous = (previous * (period - 1) + values[i]) / period; output[i] = previous; }
      else if (i >= period - 1) {
        if (type === 'SMA') output[i] = sum / period;
        else if (type === 'WMA') { let weighted = 0; for (let j = 0; j < period; j++) weighted += values[i - period + 1 + j] * (j + 1); output[i] = weighted / (period * (period + 1) / 2); }
        else if (type === 'ALMA') { let weighted = 0; for (let j = 0; j < period; j++) weighted += values[i - period + 1 + j] * weights[j]; output[i] = weighted / weightSum; }
      }
    }
    return output;
  }
  function calculate(data, config) {
    const result = data.map(() => ({}));
    config.lines.forEach((line, index) => {
      if (!line.enabled) return;
      const type = line.type === 'default' ? config.defaultType : line.type;
      const values = movingAverage(data.map((bar) => sourceValue(bar, line.source)), line.period, type, line.almaOffset, line.sigma);
      values.forEach((value, i) => { const target = i + line.offset; if (value != null && target >= 0 && target < result.length) result[target][`ma${index}`] = value; });
    });
    return result;
  }
  function fibonacciLevels(points, extension = false, levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.414, 1.618, 2, 2.618]) {
    if (points.length < (extension ? 3 : 2)) return [];
    const difference = points[1].value - points[0].value;
    return levels.map((ratio) => ({ ratio, value: extension ? points[2].value + difference * ratio : points[1].value - difference * ratio }));
  }
  const defaultFibonacciConfig = () => ({
    levels: [
      { ratio: 0, enabled: true, color: '#808994' }, { ratio: 0.236, enabled: true, color: '#e25563' },
      { ratio: 0.382, enabled: true, color: '#f09736' }, { ratio: 0.5, enabled: true, color: '#ccac35' },
      { ratio: 0.618, enabled: true, color: '#50a16d' }, { ratio: 0.786, enabled: true, color: '#20a9b7' },
      { ratio: 1, enabled: true, color: '#6d88a8' }, { ratio: 1.272, enabled: true, color: '#ec9a2f' },
      { ratio: 1.414, enabled: true, color: '#e75b67' }, { ratio: 1.618, enabled: true, color: '#9d6bba' },
      { ratio: 2, enabled: true, color: '#727ab2' }, { ratio: 2.618, enabled: true, color: '#5e8d99' },
    ], fill: true,
  });
  function candleChange(current, previous) {
    if (!current || !previous || !Number.isFinite(current.close) || !Number.isFinite(previous.close) || previous.close === 0) return null;
    return (current.close - previous.close) / previous.close * 100;
  }
  function measureRange(first, second) {
    const difference = second.value - first.value;
    return { difference, percentage: first.value === 0 ? null : difference / first.value * 100,
      bars: Number.isFinite(first.dataIndex) && Number.isFinite(second.dataIndex) ? Math.abs(Math.round(second.dataIndex) - Math.round(first.dataIndex)) : null,
      days: Number.isFinite(first.timestamp) && Number.isFinite(second.timestamp) ? Math.abs(second.timestamp - first.timestamp) / 86400000 : null };
  }
  const api = { defaultConfig, movingAverage, sourceValue, calculate, fibonacciLevels, defaultFibonacciConfig, candleChange, measureRange };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ChartStudies = api;
})(globalThis);
