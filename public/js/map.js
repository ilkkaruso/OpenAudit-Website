/**
 * OpenAudit Philippines - Interactive Zoomable Map
 * D3.js v7 with zoom, province/LGU toggle, year filtering
 */

// ============================================
// STATE MANAGEMENT
// ============================================

const state = {
  // Current view settings
  currentYear: 2022,
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
