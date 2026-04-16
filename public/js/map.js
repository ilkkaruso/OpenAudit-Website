/**
 * OpenAudit Philippines - Interactive Zoomable Map
 * D3.js v7 with zoom, province/LGU toggle, year filtering
 */

// ============================================
// STATE MANAGEMENT
// ============================================

const state = {
  // Current view settings
  currentYear: 2021,
  currentDataset: 'audit', // 'audit' or 'disallowances'
  currentView: 'provinces', // 'provinces' or 'lgus'

  // Zoom state
  currentZoom: null,
  zoomedProvince: null,

  // Data caches
  provinceScores: {},    // year -> {provinceCode: scoreData}
  lguScores: {},         // year -> {psgc: scoreData}
  lguGeoCache: {},       // provinceSlug -> TopoJSON
  provinceMapping: null, // provinceCode -> {name, slug, file}

  // D3 selections
  svg: null,
  mapGroup: null,
  outlineLayer: null,
  provinceLayer: null,
  lguLayer: null,
  zoom: null,
  projection: null,
  path: null
};

// ============================================
// UTILITY FUNCTIONS
// ============================================

function getRiskColor(score, riskLevel) {
  const level = riskLevel || getRiskLevel(score);
  switch(level) {
    case 'critical': return '#7f0000';
    case 'high': return '#c62828';
    case 'moderate': return '#ef6c00';
    case 'low': return '#fdd835';
    case 'minimal': return '#66bb6a';
    default: return '#e0e0e0';
  }
}

function getRiskLevel(score) {
  if (score === null || score === undefined) return 'no_data';
  if (score >= 80) return 'critical';
  if (score >= 60) return 'high';
  if (score >= 40) return 'moderate';
  if (score >= 20) return 'low';
  return 'minimal';
}

function getRiskLabel(score, riskLevel) {
  const level = riskLevel || getRiskLevel(score);
  const labels = {
    'critical': 'Critical',
    'high': 'High Risk',
    'moderate': 'Moderate',
    'low': 'Low Risk',
    'minimal': 'Minimal',
    'no_data': 'No Data'
  };
  return labels[level] || 'Unknown';
}

// ============================================
// DATA LOADING
// ============================================

async function loadProvinceScores(year) {
  if (state.provinceScores[year]) {
    return state.provinceScores[year];
  }

  const url = state.currentDataset === 'audit'
    ? `data/province-scores-${year}.json`
    : 'data/disallowances.json';

  const data = await d3.json(url);
  const scores = state.currentDataset === 'audit' ? data.provinces : (data.provinces || {});
  state.provinceScores[year] = scores;
  return scores;
}

async function loadLguScores(year) {
  if (state.lguScores[year]) {
    return state.lguScores[year];
  }

  const url = state.currentDataset === 'audit'
    ? `data/scores-${year}.json`
    : 'data/disallowances.json';

  const data = await d3.json(url);
  const scores = state.currentDataset === 'audit' ? data.lgus : (data.lgus || {});
  state.lguScores[year] = scores;
  return scores;
}

async function loadProvinceLgus(provinceCode) {
  const mapping = state.provinceMapping[provinceCode];
  if (!mapping) {
    console.warn(`No mapping for province ${provinceCode}`);
    return null;
  }

  const slug = mapping.slug;
  if (state.lguGeoCache[slug]) {
    return state.lguGeoCache[slug];
  }

  try {
    const topo = await d3.json(`geo/lgus/${slug}.topo.json`);
    state.lguGeoCache[slug] = topo;
    return topo;
  } catch (err) {
    console.error(`Failed to load LGUs for ${mapping.name}:`, err);
    return null;
  }
}

// ============================================
// TOOLTIP
// ============================================

const tooltip = d3.select('body').append('div')
  .attr('class', 'tooltip')
  .style('opacity', 0);

function showTooltip(event, data, type) {
  const name = data.name || 'Unknown';
  const score = data.score ?? null;
  const riskLevel = data.riskLevel || getRiskLevel(score);
  const riskLabel = getRiskLabel(score, riskLevel);

  let details = '';
  if (type === 'province') {
    details = `
      <div class="detail-row">
        <span class="detail-label">LGUs:</span>
        <span class="detail-value">${data.lguCount || '—'}</span>
      </div>
    `;
  }

  details += `
    <div class="detail-row">
      <span class="detail-label">Not Implemented:</span>
      <span class="detail-value">${data.notImplementedPct?.toFixed(1) || '—'}%</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Observations:</span>
      <span class="detail-value">${data.observationCount?.toLocaleString() || '—'}</span>
    </div>
  `;

  tooltip
    .style('opacity', 1)
    .html(`
      <div class="tooltip-header">
        <span class="tooltip-title">${name}</span>
        <span class="tooltip-type">${type === 'province' ? 'Province' : 'LGU'}</span>
      </div>
      <div class="tooltip-body">
        <div class="tooltip-score-big">
          <span class="score-value">${score !== null ? Math.round(score) : '—'}</span>
          <span class="score-label">/ 100</span>
        </div>
        <div class="tooltip-risk ${riskLevel}">${riskLabel}</div>
        <div class="tooltip-details">${details}</div>
      </div>
    `)
    .style('left', (event.pageX + 15) + 'px')
    .style('top', (event.pageY - 10) + 'px');
}

function hideTooltip() {
  tooltip.style('opacity', 0);
}

function moveTooltip(event) {
  tooltip
    .style('left', (event.pageX + 15) + 'px')
    .style('top', (event.pageY - 10) + 'px');
}

// ============================================
// ZOOM BEHAVIOR
// ============================================

function setupZoom() {
  state.zoom = d3.zoom()
    .scaleExtent([1, 8])
    .on('zoom', (event) => {
      state.currentZoom = event.transform;
      state.mapGroup.attr('transform', event.transform);
    });

  // Apply zoom to SVG
  state.svg.call(state.zoom);

  // Disable scroll zoom on single touch (mobile)
  state.svg.on('touchstart', (event) => {
    if (event.touches.length === 1) {
      event.preventDefault();
      showMobileHint();
    }
  }, { passive: false });
}

function showMobileHint() {
  const hint = document.getElementById('mobile-hint');
  if (hint) {
    hint.classList.add('visible');
    setTimeout(() => hint.classList.remove('visible'), 2000);
  }
}

function zoomIn() {
  state.svg.transition().duration(300).call(
    state.zoom.scaleBy, 1.5
  );
}

function zoomOut() {
  state.svg.transition().duration(300).call(
    state.zoom.scaleBy, 0.67
  );
}

function resetZoom() {
  state.svg.transition().duration(500).call(
    state.zoom.transform, d3.zoomIdentity
  );
  state.zoomedProvince = null;
}

function zoomToProvince(feature, provinceCode) {
  const [[x0, y0], [x1, y1]] = state.path.bounds(feature);
  const width = state.svg.node().clientWidth;
  const height = state.svg.node().clientHeight;

  const scale = Math.min(8, 0.9 / Math.max((x1 - x0) / width, (y1 - y0) / height));
  const tx = width / 2 - scale * (x0 + x1) / 2;
  const ty = height / 2 - scale * (y0 + y1) / 2;

  state.svg.transition().duration(750).call(
    state.zoom.transform,
    d3.zoomIdentity.translate(tx, ty).scale(scale)
  );

  state.zoomedProvince = provinceCode;
}

// ============================================
// RENDER PROVINCES
// ============================================

async function renderProvinces() {
  const scores = await loadProvinceScores(state.currentYear);

  state.provinceLayer.selectAll('path.province')
    .data(state.provinceGeojson.features)
    .join('path')
    .attr('class', 'province')
    .attr('d', state.path)
    .attr('fill', d => {
      const code = String(d.properties.psgc || d.properties.PSGC || '').padStart(10, '0');
      const data = scores[code];
      return data ? getRiskColor(data.score, data.riskLevel) : '#e0e0e0';
    })
    .attr('stroke', '#ffffff')
    .attr('stroke-width', 0.5)
    .on('pointerenter', function(event, d) {
      d3.select(this).attr('stroke', '#000').attr('stroke-width', 2).raise();
      const code = String(d.properties.psgc || d.properties.PSGC || '').padStart(10, '0');
      const data = scores[code] || { name: d.properties.name || d.properties.NAME || 'Unknown' };
      showTooltip(event, data, 'province');
    })
    .on('pointermove', moveTooltip)
    .on('pointerleave', function() {
      d3.select(this).attr('stroke', '#fff').attr('stroke-width', 0.5);
      hideTooltip();
    })
    .on('dblclick', async function(event, d) {
      event.stopPropagation();
      const code = String(d.properties.psgc || d.properties.PSGC || '').padStart(10, '0');

      if (state.zoomedProvince === code) {
        // Zoom out
        resetZoom();
      } else {
        // Zoom in and load LGUs
        zoomToProvince(d, code);
        await loadAndRenderProvinceLgus(code);
      }
    });

  // Show province layer, hide LGU layer
  state.provinceLayer.style('display', null);
  state.lguLayer.style('display', 'none');
}

// ============================================
// RENDER LGUS
// ============================================

async function loadAndRenderProvinceLgus(provinceCode) {
  const topo = await loadProvinceLgus(provinceCode);
  if (!topo) return;

  const scores = await loadLguScores(state.currentYear);
  const objectName = Object.keys(topo.objects)[0];
  const geojson = topojson.feature(topo, topo.objects[objectName]);

  state.lguLayer.selectAll('path.lgu')
    .data(geojson.features, d => d.properties.psgc || d.properties.PSGC)
    .join('path')
    .attr('class', 'lgu')
    .attr('d', state.path)
    .attr('fill', d => {
      const psgc = String(d.properties.psgc || d.properties.PSGC || '').padStart(10, '0');
      const data = scores[psgc];
      return data ? getRiskColor(data.score, data.riskLevel) : '#e0e0e0';
    })
    .attr('stroke', '#ffffff')
    .attr('stroke-width', 0.2)
    .on('pointerenter', function(event, d) {
      d3.select(this).attr('stroke', '#000').attr('stroke-width', 1.5).raise();
      const psgc = String(d.properties.psgc || d.properties.PSGC || '').padStart(10, '0');
      const data = scores[psgc] || { name: d.properties.name || d.properties.NAME || 'Unknown' };
      showTooltip(event, data, 'lgu');
    })
    .on('pointermove', moveTooltip)
    .on('pointerleave', function() {
      d3.select(this).attr('stroke', '#fff').attr('stroke-width', 0.2);
      hideTooltip();
    });

  state.lguLayer.style('display', null);
}

async function renderAllLgus() {
  // Load all provinces' LGUs
  const scores = await loadLguScores(state.currentYear);

  // Clear existing
  state.lguLayer.selectAll('path.lgu').remove();

  // Load each province
  for (const [code, mapping] of Object.entries(state.provinceMapping)) {
    await loadAndRenderProvinceLgus(code);
  }

  // Hide provinces, show LGUs
  state.provinceLayer.style('display', 'none');
  state.lguLayer.style('display', null);
}

// ============================================
// UPDATE MAP (on control changes)
// ============================================

async function updateMap() {
  // Clear caches when dataset changes
  state.provinceScores = {};
  state.lguScores = {};

  if (state.currentView === 'provinces') {
    state.lguLayer.selectAll('path.lgu').remove();
    await renderProvinces();
  } else {
    await renderAllLgus();
  }
}

async function updateYear(year) {
  state.currentYear = year;
  document.getElementById('year-display').textContent = year;

  if (state.currentView === 'provinces') {
    await renderProvinces();
  } else {
    // Re-render LGUs with new year data
    const scores = await loadLguScores(year);
    state.lguLayer.selectAll('path.lgu')
      .attr('fill', d => {
        const psgc = String(d.properties.psgc || d.properties.PSGC || '').padStart(10, '0');
        const data = scores[psgc];
        return data ? getRiskColor(data.score, data.riskLevel) : '#e0e0e0';
      });
  }
}

// ============================================
// INITIALIZATION
// ============================================

async function initMap() {
  const container = d3.select('#map');
  container.html('');

  const loading = container.append('div')
    .attr('class', 'loading')
    .text('Loading map...');

  try {
    // Load geo data and province mapping
    const [outlineTopo, provinceTopo, provinceMapping] = await Promise.all([
      d3.json('geo/ph-outline.topo.json'),
      d3.json('geo/provinces-hires.topo.json'),
      d3.json('geo/province-mapping.json')
    ]);

    state.provinceMapping = provinceMapping;

    // Convert TopoJSON to GeoJSON
    const outlineObjName = Object.keys(outlineTopo.objects)[0];
    const outlineGeojson = topojson.feature(outlineTopo, outlineTopo.objects[outlineObjName]);

    const provinceObjName = Object.keys(provinceTopo.objects)[0];
    state.provinceGeojson = topojson.feature(provinceTopo, provinceTopo.objects[provinceObjName]);

    loading.remove();

    // SVG setup
    const width = container.node().clientWidth || 800;
    const height = Math.max(500, window.innerHeight * 0.8);

    state.svg = container.append('svg')
      .attr('width', '100%')
      .attr('height', height)
      .attr('viewBox', `0 0 ${width} ${height}`)
      .attr('preserveAspectRatio', 'xMidYMid meet');

    state.mapGroup = state.svg.append('g');

    // Create layers
    state.outlineLayer = state.mapGroup.append('g').attr('class', 'outline-layer');
    state.provinceLayer = state.mapGroup.append('g').attr('class', 'province-layer');
    state.lguLayer = state.mapGroup.append('g').attr('class', 'lgu-layer');

    // Projection
    state.projection = d3.geoMercator()
      .fitSize([width * 0.85, height * 0.95], state.provinceGeojson);

    state.path = d3.geoPath().projection(state.projection);

    // Render outline background
    state.outlineLayer.selectAll('path')
      .data(outlineGeojson.features)
      .join('path')
      .attr('class', 'outline')
      .attr('d', state.path);

    // Setup zoom
    setupZoom();

    // Initial render
    await renderProvinces();

    // Setup controls
    setupControls();

    console.log('Map initialized successfully');

  } catch (error) {
    loading.remove();
    console.error('Map initialization error:', error);
    container.append('div')
      .attr('class', 'error-message')
      .html(`
        <h3>Failed to load map</h3>
        <p>${error.message}</p>
        <p>Make sure geo files are in place.</p>
      `);
  }
}

// ============================================
// CONTROL HANDLERS
// ============================================

function setupControls() {
  // Dataset dropdown
  const datasetSelect = document.getElementById('dataset-select');
  if (datasetSelect) {
    datasetSelect.addEventListener('change', async (e) => {
      state.currentDataset = e.target.value;
      await updateMap();
    });
  }

  // Year slider
  const yearSlider = document.getElementById('year-slider');
  if (yearSlider) {
    yearSlider.addEventListener('input', (e) => {
      document.getElementById('year-display').textContent = e.target.value;
    });
    yearSlider.addEventListener('change', async (e) => {
      await updateYear(parseInt(e.target.value));
    });
  }

  // View toggle buttons
  const viewProvinces = document.getElementById('view-provinces');
  const viewLgus = document.getElementById('view-lgus');

  if (viewProvinces && viewLgus) {
    viewProvinces.addEventListener('click', async () => {
      if (state.currentView === 'provinces') return;
      state.currentView = 'provinces';
      viewProvinces.classList.add('active');
      viewLgus.classList.remove('active');
      resetZoom();
      await renderProvinces();
    });

    viewLgus.addEventListener('click', async () => {
      if (state.currentView === 'lgus') return;
      state.currentView = 'lgus';
      viewLgus.classList.add('active');
      viewProvinces.classList.remove('active');
      await renderAllLgus();
    });
  }

  // Zoom buttons
  const zoomInBtn = document.getElementById('zoom-in');
  const zoomOutBtn = document.getElementById('zoom-out');
  const zoomResetBtn = document.getElementById('zoom-reset');

  if (zoomInBtn) zoomInBtn.addEventListener('click', zoomIn);
  if (zoomOutBtn) zoomOutBtn.addEventListener('click', zoomOut);
  if (zoomResetBtn) zoomResetBtn.addEventListener('click', resetZoom);

  // Double-click on SVG background to reset
  state.svg.on('dblclick.zoom', null); // Disable default d3 double-click zoom
  state.svg.on('dblclick', (event) => {
    if (event.target.tagName === 'svg') {
      resetZoom();
    }
  });
}

// ============================================
// EXPORTS
// ============================================

window.initMap = initMap;
window.renderMap = initMap; // Backwards compatibility
