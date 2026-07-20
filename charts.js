'use strict';

(() => {
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  let period = 'day';
  let resizeTimer = null;

  const records = () => window.AppState?.records || [];
  const fmt = (value, digits = 0) => Number(value || 0).toLocaleString('es-UY', { maximumFractionDigits: digits });
  const parseDate = value => value ? new Date(`${value}T12:00:00`) : null;
  const isoDate = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const monday = date => {
    const result = new Date(date);
    const weekday = (result.getDay() + 6) % 7;
    result.setDate(result.getDate() - weekday);
    return result;
  };

  function groupKey(date) {
    if (period === 'month') return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    if (period === 'week') return isoDate(monday(date));
    return isoDate(date);
  }

  function labelFor(key) {
    if (period === 'month') {
      return new Date(`${key}-01T12:00:00`).toLocaleDateString('es-UY', { month: 'short', year: '2-digit' });
    }
    const date = parseDate(key);
    if (!date) return key;
    return period === 'week'
      ? `Sem. ${date.toLocaleDateString('es-UY', { day: '2-digit', month: '2-digit' })}`
      : date.toLocaleDateString('es-UY', { day: '2-digit', month: '2-digit' });
  }

  function filteredRecords() {
    const operator = $('#chartOperator')?.value || '';
    const range = $('#chartRange')?.value || '30';
    const cutoff = range === 'all' ? null : new Date(Date.now() - Number(range) * 86400000);
    if (cutoff) cutoff.setHours(0, 0, 0, 0);

    return records().filter(record => {
      const date = parseDate(record.fecha);
      return date && (!operator || record.operador === operator) && (!cutoff || date >= cutoff);
    });
  }

  function grouped(source) {
    const map = new Map();
    source.forEach(record => {
      const date = parseDate(record.fecha);
      if (!date) return;
      const key = groupKey(date);
      const row = map.get(key) || { key, combustible: 0, horas: 0, arboles: 0 };
      row.combustible += Number(record.combustible) || 0;
      row.horas += Number(record.horas) || 0;
      row.arboles += Number(record.arboles) || 0;
      map.set(key, row);
    });
    return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  function setupCanvas(canvas, minimumHeight = 220) {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(300, Math.round(rect.width || canvas.parentElement?.clientWidth || 300));
    const height = Math.max(minimumHeight, Math.round(rect.height || minimumHeight));
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    const context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    return { context, width, height };
  }

  function niceMaximum(maximum) {
    if (maximum <= 1) return 1;
    const exponent = Math.floor(Math.log10(maximum));
    const fraction = maximum / (10 ** exponent);
    const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
    return niceFraction * (10 ** exponent);
  }

  function roundedRect(context, x, y, width, height, radius) {
    const r = Math.min(radius, Math.abs(width) / 2, Math.abs(height) / 2);
    context.beginPath();
    context.moveTo(x + r, y);
    context.arcTo(x + width, y, x + width, y + height, r);
    context.arcTo(x + width, y + height, x, y + height, r);
    context.arcTo(x, y + height, x, y, r);
    context.arcTo(x, y, x + width, y, r);
    context.closePath();
  }

  function drawBarChart(canvas, rows, field, colors) {
    const placeholder = canvas.parentElement.querySelector('.chart-placeholder');
    const values = rows.map(row => Number(row[field]) || 0);
    const hasData = values.some(value => value > 0);
    placeholder?.classList.toggle('hidden', hasData);
    canvas.classList.toggle('hidden', !hasData);
    if (!hasData) return;

    const { context: ctx, width, height } = setupCanvas(canvas, 240);
    const padding = { left: 42, right: 12, top: 18, bottom: 42 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;
    const maximum = niceMaximum(Math.max(...values, 1));

    ctx.font = '10px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (let line = 0; line <= 4; line += 1) {
      const y = padding.top + chartHeight * (line / 4);
      ctx.strokeStyle = '#edf2f4';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();
      ctx.fillStyle = '#83909c';
      ctx.textAlign = 'right';
      ctx.fillText(fmt(maximum * (1 - line / 4), maximum < 20 ? 1 : 0), padding.left - 7, y);
    }

    const slot = chartWidth / Math.max(values.length, 1);
    const barWidth = Math.min(42, slot * .58);
    values.forEach((value, index) => {
      const barHeight = (value / maximum) * chartHeight;
      const x = padding.left + slot * index + (slot - barWidth) / 2;
      const y = padding.top + chartHeight - barHeight;
      const gradient = ctx.createLinearGradient(0, y, 0, padding.top + chartHeight);
      gradient.addColorStop(0, colors.top);
      gradient.addColorStop(1, colors.bottom);
      ctx.fillStyle = gradient;
      roundedRect(ctx, x, y, barWidth, Math.max(barHeight, 2), 8);
      ctx.fill();

      let label = labelFor(rows[index].key);
      const skip = Math.max(1, Math.ceil(values.length / 8));
      if (values.length > 8 && index % skip !== 0 && index !== values.length - 1) label = '';
      ctx.fillStyle = '#7d8994';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(label, x + barWidth / 2, padding.top + chartHeight + 10);
    });
  }

  function drawAreaChart(canvas, rows, field, color) {
    const placeholder = $('#dashboardTrendEmpty');
    const values = rows.map(row => Number(row[field]) || 0);
    const hasData = values.some(value => value > 0);
    placeholder?.classList.toggle('hidden', hasData);
    canvas.classList.toggle('hidden', !hasData);
    if (!hasData) return;

    const { context: ctx, width, height } = setupCanvas(canvas, 190);
    const padding = { left: 34, right: 14, top: 18, bottom: 34 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;
    const maximum = niceMaximum(Math.max(...values, 1));

    ctx.font = '9px system-ui, sans-serif';
    for (let line = 0; line <= 3; line += 1) {
      const y = padding.top + chartHeight * (line / 3);
      ctx.strokeStyle = '#eef2f4';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();
      ctx.fillStyle = '#8995a0';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(fmt(maximum * (1 - line / 3), maximum < 20 ? 1 : 0), padding.left - 6, y);
    }

    const points = values.map((value, index) => ({
      x: padding.left + (values.length === 1 ? chartWidth / 2 : chartWidth * index / (values.length - 1)),
      y: padding.top + chartHeight - (value / maximum) * chartHeight,
      value
    }));

    const area = ctx.createLinearGradient(0, padding.top, 0, padding.top + chartHeight);
    area.addColorStop(0, `${color}38`);
    area.addColorStop(1, `${color}03`);
    ctx.beginPath();
    ctx.moveTo(points[0].x, padding.top + chartHeight);
    points.forEach((point, index) => {
      if (index === 0) ctx.lineTo(point.x, point.y);
      else {
        const previous = points[index - 1];
        const middle = (previous.x + point.x) / 2;
        ctx.bezierCurveTo(middle, previous.y, middle, point.y, point.x, point.y);
      }
    });
    ctx.lineTo(points[points.length - 1].x, padding.top + chartHeight);
    ctx.closePath();
    ctx.fillStyle = area;
    ctx.fill();

    ctx.beginPath();
    points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else {
        const previous = points[index - 1];
        const middle = (previous.x + point.x) / 2;
        ctx.bezierCurveTo(middle, previous.y, middle, point.y, point.x, point.y);
      }
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();

    points.forEach((point, index) => {
      ctx.beginPath();
      ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.stroke();

      ctx.fillStyle = '#7d8994';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(rows[index].label, point.x, padding.top + chartHeight + 9);
    });
  }

  function dashboardRows() {
    const map = new Map();
    for (let offset = 6; offset >= 0; offset -= 1) {
      const date = new Date();
      date.setHours(12, 0, 0, 0);
      date.setDate(date.getDate() - offset);
      map.set(isoDate(date), {
        key: isoDate(date),
        label: date.toLocaleDateString('es-UY', { weekday: 'short' }).replace('.', ''),
        arboles: 0,
        horas: 0,
        combustible: 0
      });
    }

    records().forEach(record => {
      const row = map.get(record.fecha);
      if (!row) return;
      row.arboles += Number(record.arboles) || 0;
      row.horas += Number(record.horas) || 0;
      row.combustible += Number(record.combustible) || 0;
    });
    return [...map.values()];
  }

  window.renderDashboardTrend = () => {
    const canvas = $('#dashboardTrendChart');
    if (!canvas || !$('#dashboard')?.classList.contains('active')) return;
    const metric = $('#dashboardTrendMetric')?.value || 'arboles';
    const colors = { arboles: '#0b8b50', horas: '#3578e5', combustible: '#d89012' };
    requestAnimationFrame(() => drawAreaChart(canvas, dashboardRows(), metric, colors[metric]));
  };

  function peak(rows, field, suffix) {
    const row = rows.reduce((best, current) => (current[field] || 0) > (best?.[field] || 0) ? current : best, null);
    return row && row[field] > 0 ? `Máximo: ${fmt(row[field], 1)} ${suffix}`.trim() : 'Máximo: —';
  }

  function renderRanking(source) {
    const map = new Map();
    source.forEach(record => {
      const name = String(record.operador || 'Sin operador').trim();
      const row = map.get(name) || { horas: 0, arboles: 0, partes: 0 };
      row.horas += Number(record.horas) || 0;
      row.arboles += Number(record.arboles) || 0;
      row.partes += 1;
      map.set(name, row);
    });

    const rows = [...map.entries()]
      .map(([name, data]) => ({ name, ...data, value: data.horas ? data.arboles / data.horas : 0 }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);
    const root = $('#operatorRanking');
    if (!root) return;

    if (!rows.length) {
      root.innerHTML = '<div class="chart-placeholder">No hay datos para comparar.</div>';
      return;
    }

    const maximum = Math.max(...rows.map(row => row.value), 1);
    root.innerHTML = rows.map((row, index) => `
      <div class="rank-row">
        <div class="rank-name"><strong>${index + 1}. ${window.escapeHtml(row.name)}</strong><small>${fmt(row.arboles)} árboles · ${fmt(row.horas, 1)} h</small></div>
        <div class="rank-track"><div class="rank-fill" style="width:${Math.max(4, row.value / maximum * 100)}%"></div></div>
        <div class="rank-value">${fmt(row.value, 1)} árb/h</div>
      </div>
    `).join('');
  }

  window.refreshChartOperators = () => {
    const select = $('#chartOperator');
    if (!select) return;
    const current = select.value;
    const names = [...new Set(records().map(record => String(record.operador || '').trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'es'));
    select.innerHTML = '<option value="">Todos los operadores</option>' + names.map(name => `<option value="${window.escapeHtml(name)}">${window.escapeHtml(name)}</option>`).join('');
    if (names.includes(current)) select.value = current;
  };

  window.renderCharts = () => {
    if (!$('#graficos') || !$('#graficos').classList.contains('active')) return;
    const source = filteredRecords();
    const rows = grouped(source);
    const fuel = source.reduce((sum, record) => sum + (Number(record.combustible) || 0), 0);
    const hours = source.reduce((sum, record) => sum + (Number(record.horas) || 0), 0);
    const trees = source.reduce((sum, record) => sum + (Number(record.arboles) || 0), 0);
    const count = source.length;

    $('#chartFuelTotal').textContent = `${fmt(fuel, 1)} L`;
    $('#chartFuelAvg').textContent = `Promedio: ${fmt(count ? fuel / count : 0, 1)} L/parte`;
    $('#chartHoursTotal').textContent = `${fmt(hours, 1)} h`;
    $('#chartHoursAvg').textContent = `Promedio: ${fmt(count ? hours / count : 0, 1)} h/parte`;
    $('#chartTreesTotal').textContent = fmt(trees);
    $('#chartTreesAvg').textContent = `Promedio: ${fmt(count ? trees / count : 0, 1)}/parte`;
    $('#chartPerformance').textContent = `${fmt(hours ? trees / hours : 0, 1)} árb/h`;
    $('#fuelPeak').textContent = peak(rows, 'combustible', 'L');
    $('#hoursPeak').textContent = peak(rows, 'horas', 'h');
    $('#treesPeak').textContent = peak(rows, 'arboles', '');

    requestAnimationFrame(() => {
      drawBarChart($('#fuelChart'), rows, 'combustible', { top: '#e9a321', bottom: '#ffe9b4' });
      drawBarChart($('#hoursChart'), rows, 'horas', { top: '#3578e5', bottom: '#d5e6ff' });
      drawBarChart($('#treesChart'), rows, 'arboles', { top: '#0b9a58', bottom: '#c9efd8' });
    });
    renderRanking(source);
  };

  $$('.period-tabs button').forEach(button => button.addEventListener('click', () => {
    period = button.dataset.period;
    $$('.period-tabs button').forEach(item => item.classList.toggle('active', item === button));
    window.renderCharts();
  }));
  $('#chartOperator')?.addEventListener('change', window.renderCharts);
  $('#chartRange')?.addEventListener('change', window.renderCharts);
  $('#chartsRefresh')?.addEventListener('click', () => {
    window.refreshChartOperators();
    window.renderCharts();
  });
  $('#dashboardTrendMetric')?.addEventListener('change', window.renderDashboardTrend);

  window.addEventListener('lubayd-records-updated', () => {
    window.refreshChartOperators();
    window.renderDashboardTrend();
  });

  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      window.renderDashboardTrend();
      window.renderCharts();
    }, 150);
  });

  window.refreshChartOperators();
  window.renderDashboardTrend();
})();
