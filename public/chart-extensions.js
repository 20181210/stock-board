'use strict';
(function () {
  klinecharts.registerOverlay({ name: 'measurementRuler', totalStep: 3,
    needDefaultPointFigure: true, needDefaultXAxisFigure: true, needDefaultYAxisFigure: true,
    createPointFigures({ coordinates, overlay, bounding, precision, xAxis }) {
      if (coordinates.length < 2) return [];
      const points = overlay.points.map((point, index) => ({ ...point, dataIndex: xAxis.convertFromPixel(coordinates[index].x) }));
      const measurement = ChartStudies.measureRange(points[0], points[1]);
      const [first, second] = coordinates, color = measurement.difference >= 0 ? '#2878df' : '#d95769';
      const left = Math.min(first.x, second.x), top = Math.min(first.y, second.y);
      const middleX = (first.x + second.x) / 2, middleY = (first.y + second.y) / 2;
      const sign = measurement.difference >= 0 ? '+' : '';
      const lines = [`${sign}${measurement.difference.toFixed(precision.price)} (${measurement.percentage == null ? '—' : sign + measurement.percentage.toFixed(2) + '%'})`,
        `${measurement.bars ?? '—'} 根K线间隔 · ${measurement.days == null ? '—' : Number(measurement.days.toFixed(2))} 自然日`];
      const labelX = Math.max(8, Math.min(bounding.width - 285, middleX - 138));
      const labelY = top >= 64 ? top - 59 : Math.min(bounding.height - 56, Math.max(3, top + 8));
      return [
        { key: 'area', type: 'rect', attrs: { x: left, y: top, width: Math.max(1, Math.abs(second.x - first.x)), height: Math.max(1, Math.abs(second.y - first.y)) }, styles: { color: `${color}16`, borderColor: `${color}70`, borderSize: 1, style: 'stroke_fill' } },
        { key: 'horizontal', type: 'line', attrs: { coordinates: [{ x: first.x, y: middleY }, { x: second.x, y: middleY }] }, styles: { color, size: 1, style: 'dashed', dashedValue: [4, 3] } },
        { key: 'vertical', type: 'line', attrs: { coordinates: [{ x: middleX, y: first.y }, { x: middleX, y: second.y }] }, styles: { color, size: 1, style: 'dashed', dashedValue: [4, 3] } },
        { key: 'label-bg', type: 'rect', ignoreEvent: true, attrs: { x: labelX, y: labelY, width: 277, height: 51 }, styles: { color, borderRadius: 5, style: 'fill' } },
        ...lines.map((text, index) => ({ key: `label${index}`, type: 'text', ignoreEvent: true, attrs: { x: labelX + 11, y: labelY + 15 + index * 20, text, baseline: 'middle' }, styles: { color: '#fff', size: 12 } })),
      ];
    },
  });
  const palette = ['#808994', '#e25563', '#f09736', '#ccac35', '#50a16d', '#20a9b7', '#6d88a8', '#ec9a2f', '#e75b67', '#9d6bba', '#727ab2', '#5e8d99'];
  for (const extension of [false, true]) {
    klinecharts.registerOverlay({ name: extension ? 'fibExtension' : 'fibRetracement', totalStep: extension ? 4 : 3,
      needDefaultPointFigure: true, needDefaultXAxisFigure: true, needDefaultYAxisFigure: true,
      createPointFigures({ coordinates, overlay, bounding, yAxis, precision }) {
        const configured = overlay.extendData?.levels || ChartStudies.defaultFibonacciConfig().levels;
        const levels = ChartStudies.fibonacciLevels(overlay.points, extension, configured.filter((level) => level.enabled !== false).map((level) => typeof level === 'number' ? level : level.ratio));
        const figures = [];
        if (coordinates.length > 1) figures.push({ key: 'anchors', type: 'line', attrs: { coordinates }, styles: { color: '#8993a1', style: 'dashed', dashedValue: [5, 5], size: 1 } });
        if (!levels.length || !yAxis) return figures;
        const startX = Math.max(0, Math.min(...coordinates.map((point) => point.x))), endX = bounding.width;
        levels.forEach(({ ratio, value }, index) => {
          const rawLevel = configured.filter((level) => level.enabled !== false)[index];
          const color = rawLevel?.color || palette[index % palette.length], y = yAxis.convertToPixel(value);
          if (!Number.isFinite(y)) return;
          const next = levels[index + 1];
          if (next && overlay.extendData?.fill !== false) {
            const nextY = yAxis.convertToPixel(next.value);
            figures.push({ key: `fill${index}`, type: 'rect', ignoreEvent: true, attrs: { x: startX, y: Math.min(y, nextY), width: Math.max(0, endX - startX), height: Math.abs(nextY - y) }, styles: { color: `${color}15`, style: 'fill' } });
          }
          figures.push({ key: `level${index}`, type: 'line', attrs: { coordinates: [{ x: startX, y }, { x: endX, y }] }, styles: { color, size: 1 } });
          figures.push({ key: `label${index}`, type: 'text', ignoreEvent: true, attrs: { x: endX - 5, y: y - 3, text: `${ratio} (${value.toFixed(Math.min(5, precision.price))})`, align: 'right', baseline: 'bottom' }, styles: { color, size: 10, backgroundColor: '#ffffffb0' } });
        });
        return figures;
      },
    });
  }
  klinecharts.registerIndicator({ name: 'PMA', shortName: 'PMA', series: 'price', precision: 2, shouldOhlc: true,
    calcParams: [], figures: [], calc: (data, indicator) => ChartStudies.calculate(data, indicator.extendData),
    createTooltipDataSource({ indicator, crosshair }) {
      const config = indicator.extendData, current = indicator.result[crosshair.dataIndex] || {};
      return { name: `PMA ${config.defaultType}`, calcParamsText: '', icons: [], values: config.lines.flatMap((line, index) => line.enabled ? [{ title: { text: `${line.type === 'default' ? config.defaultType : line.type}${line.period}: `, color: line.color }, value: { text: Number.isFinite(current[`ma${index}`]) ? current[`ma${index}`].toFixed(indicator.precision) : '—', color: line.color } }] : []) };
    },
    draw({ ctx, indicator, visibleRange, xAxis, yAxis }) {
      if (!indicator.extendData?.fill) return false;
      const { result, extendData: config } = indicator;
      ctx.save();
      for (const [first, second] of [[1, 2], [5, 6]]) {
        if (!config.lines[first].enabled || !config.lines[second].enabled) continue;
        for (let i = Math.max(1, visibleRange.from); i < Math.min(result.length, visibleRange.to); i++) {
          const prev = result[i - 1], current = result[i], a = `ma${first}`, b = `ma${second}`;
          if (![prev[a], prev[b], current[a], current[b]].every(Number.isFinite)) continue;
          ctx.fillStyle = `${config.lines[first].color}35`;
          ctx.beginPath(); ctx.moveTo(xAxis.convertToPixel(i - 1), yAxis.convertToPixel(prev[a])); ctx.lineTo(xAxis.convertToPixel(i), yAxis.convertToPixel(current[a])); ctx.lineTo(xAxis.convertToPixel(i), yAxis.convertToPixel(current[b])); ctx.lineTo(xAxis.convertToPixel(i - 1), yAxis.convertToPixel(prev[b])); ctx.closePath(); ctx.fill();
        }
      }
      ctx.restore(); return false;
    },
  });
})();
