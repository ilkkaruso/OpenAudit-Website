/**
 * OpenAudit Philippines - Interactive Map with Leaflet
 * Fast, smooth pan/zoom with GeoJSON layers
 */

// ============================================
// STATE MANAGEMENT
// ============================================

const state = {
  // Current view settings
  currentYear: 'all',
  currentDataset: 'disallowances',
  currentView: 'provinces',
  showRegions: false,
  showLegend: true,

  // Leaflet objects
  map: null,
  provinceLayer: null,
  lguLayer: null,
  regionLayer: null,
  legendControl: null,

  // Data caches
  provinceScores: {},
  lguScores: {},
  regionData: null,
  provinceGeoJson: null,
  lguGeoJson: null,

  // Info control
  info: null
};

// Philippines bounds
const PH_BOUNDS = [[4.5, 116.5], [21.5, 127]];
const PH_CENTER = [12.5, 122];

// ============================================
// UTILITY FUNCTIONS
// ============================================

function getRiskColor(score) {
  if (score === null || score === undefined) return '#e0e0e0';
  if (score >= 80) return '#7f0000';
  if (score >= 60) return '#c62828';
  if (score >= 40) return '#ef6c00';
  if (score >= 20) return '#fdd835';
  return '#66bb6a';
}

function getRiskLevel(score) {
  if (score === null || score === undefined) return 'no_data';
  if (score >= 80) return 'critical';
  if (score >= 60) return 'high';
  if (score >= 40) return 'moderate';
  if (score >= 20) return 'low';
  return 'minimal';
}

function getComplianceLabel(level) {
  const labels = {
    'critical': 'Very Low',
    'high': 'Low',
    'moderate': 'Moderate',
    'low': 'High',
    'minimal': 'Very High',
    'no_data': 'No Data'
  };
  return labels[level] || 'Unknown';
}

function getPsgc(feature) {
  const props = feature.properties;
  const psgc = props.psgc || props.PSGC || props.adm2_psgc || '';
  return String(psgc).padStart(10, '0');
}

// ============================================
// DATA LOADING
// ============================================

async function loadProvinceScores(year) {
  const cacheKey = year === 'all' ? 'all' : year;
  if (state.provinceScores[cacheKey]) {
    return state.provinceScores[cacheKey];
  }

  let url;
  if (state.currentDataset === 'audit') {
    url = year === 'all' ? 'data/province-scores-all.json' : `data/province-scores-${year}.json`;
  } else {
    url = 'data/disallowances.json';
  }

  try {
    const response = await fetch(url);
    const data = await response.json();
    const scores = state.currentDataset === 'audit' ? data.provinces : (data.provinces || {});
    state.provinceScores[cacheKey] = scores;
    return scores;
  } catch (err) {
    console.error('Failed to load province scores:', err);
    return {};
  }
}

async function loadLguScores(year) {
  const cacheKey = year === 'all' ? 'all' : year;
  if (state.lguScores[cacheKey]) {
    return state.lguScores[cacheKey];
  }

  let url;
  if (state.currentDataset === 'audit') {
    url = year === 'all' ? 'data/lgu-scores.json' : `data/scores-${year}.json`;
  } else {
    url = 'data/disallowances.json';
  }

  try {
    const response = await fetch(url);
    const data = await response.json();
    const scores = state.currentDataset === 'audit' ? data.lgus : (data.lgus || {});
    state.lguScores[cacheKey] = scores;
    return scores;
  } catch (err) {
    console.error('Failed to load LGU scores:', err);
    return {};
  }
}

async function loadGeoJson(type) {
  const url = type === 'provinces' ? 'geo/provinces.geojson' : 'geo/lgus.geojson';

  try {
    console.log(`Loading ${type} from ${url}...`);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    const data = await response.json();
    console.log(`Loaded ${type}: ${data.features?.length || 0} features`);
    return data;
  } catch (err) {
    console.error(`Failed to load ${type} GeoJSON:`, err);
    return null;
  }
}

async function loadRegionData() {
  if (state.regionData) {
    return state.regionData;
  }

  try {
    const response = await fetch('data/regions-mapping.json');
    const data = await response.json();
    state.regionData = data.regions;
    return state.regionData;
  } catch (err) {
    console.error('Failed to load region data:', err);
    return {};
  }
}

// ============================================
// STYLING
// ============================================

function getProvinceStyle(feature, scores) {
  const psgc = getPsgc(feature);
  const data = scores[psgc];
  const score = data ? data.score : null;

  return {
    fillColor: getRiskColor(score),
    weight: 1.5,
    opacity: 1,
    color: '#ffffff',
    fillOpacity: 0.8
  };
}

function getLguStyle(feature, scores) {
  // For LGUs, we need to construct the key as provincePsgc_lguName
  const props = feature.properties;
  const lguName = props.name || props.NAME || props.adm2_en || '';
  const provPsgc = String(props.province_psgc || props.adm1_psgc || '').padStart(10, '0');

  // Try different key formats to match our data
  // Our data often has no spaces (DonCarlos) or City suffix without space (MalaybalayCity)
  const nameNoSpaces = lguName.replace(/\s+/g, '');
  const nameBase = lguName.replace(/\s*(City|Municipality)$/i, '');
  const nameBaseNoSpaces = nameBase.replace(/\s+/g, '');

  const possibleKeys = [
    `${provPsgc}_${lguName}`,
    `${provPsgc}_${nameNoSpaces}`,
    `${provPsgc}_${nameBase}`,
    `${provPsgc}_${nameBaseNoSpaces}`,
    `${provPsgc}_${nameNoSpaces}City`,
    `${provPsgc}_${nameBaseNoSpaces}City`,
    `${provPsgc}_${lguName}Mun`
  ];

  let data = null;
  for (const key of possibleKeys) {
    if (scores[key]) {
      data = scores[key];
      break;
    }
  }

  const score = data ? data.score : null;

  return {
    fillColor: getRiskColor(score),
    weight: 0.8,
    opacity: 1,
    color: '#333333',
    fillOpacity: 0.75
  };
}

function highlightFeature(e) {
  const layer = e.target;

  layer.setStyle({
    weight: 3,
    color: '#000',
    fillOpacity: 0.9
  });

  layer.bringToFront();
  state.info.update(layer.feature.properties, layer.scoreData);
}

function resetHighlight(e, scores, isLgu = false) {
  const layer = e.target;

  if (isLgu) {
    layer.setStyle({
      weight: 0.8,
      color: '#333333',
      fillOpacity: 0.75
    });
  } else {
    layer.setStyle({
      weight: 1.5,
      color: '#ffffff',
      fillOpacity: 0.8
    });
  }

  state.info.update();
}

// ============================================
// INFO CONTROL
// ============================================

function createInfoControl() {
  const info = L.control({ position: 'topright' });

  info.onAdd = function() {
    this._div = L.DomUtil.create('div', 'info-panel');
    this.update();
    return this._div;
  };

  info.update = function(props, scoreData) {
    if (!props) {
      this._div.innerHTML = '';
      this._div.style.display = 'none';
      return;
    }

    this._div.style.display = 'block';

    const name = props.name || props.NAME || props.adm2_en || 'Unknown';
    const score = scoreData ? scoreData.score : null;
    const level = scoreData ? scoreData.riskLevel : getRiskLevel(score);

    // Check if we're showing disallowances data
    const isDisallowances = state.currentDataset === 'disallowances';

    if (isDisallowances) {
      // Disallowances display
      const totalDisallowances = scoreData?.totalDisallowances || 0;
      const avgPerLGU = scoreData?.avgDisallowancesPerLGU || 0;
      const formattedTotal = totalDisallowances ? `₱${totalDisallowances.toLocaleString('en-PH', {minimumFractionDigits: 2, maximumFractionDigits: 2})}` : '—';
      const formattedAvg = avgPerLGU ? `₱${avgPerLGU.toLocaleString('en-PH', {minimumFractionDigits: 2, maximumFractionDigits: 2})}` : '—';

      // Check if this is an LGU/Municipality
      const isLGU = scoreData?.province ? true : false;

      this._div.innerHTML = `
        <h4>${name}${isLGU ? ` <span style="font-size: 0.8em; color: #666;">(${scoreData.province})</span>` : ''}</h4>
        <div class="info-score ${level}">
          <span class="score-value">${score !== null ? Math.round(score) : '—'}</span>
          <span class="score-label">/ 100</span>
        </div>
        <div class="info-risk ${level}">Disallowance Level: ${level.charAt(0).toUpperCase() + level.slice(1)}</div>
        ${scoreData ? `
          <div class="info-details">
            <div><strong>Total Disallowances:</strong><br/>${formattedTotal}</div>
            ${!isLGU && avgPerLGU ? `<div><strong>Avg per LGU:</strong><br/>${formattedAvg}</div>` : ''}
            ${scoreData.observationCount ? `<div><strong>Observations:</strong> ${scoreData.observationCount.toLocaleString()}</div>` : ''}
            ${!isLGU && scoreData.lguCount ? `<div><strong>Municipalities:</strong> ${scoreData.lguCount}</div>` : ''}
            ${scoreData.yearsWithData ? `<div><strong>Years:</strong> ${scoreData.yearsWithData} years</div>` : ''}
            ${scoreData.years && scoreData.years.length > 0 ? `<div><strong>Years with data:</strong> ${scoreData.years.join(', ')}</div>` : ''}
          </div>
        ` : ''}
      `;
    } else {
      // Compliance/Audit display (original)
      const complianceLabel = getComplianceLabel(level);

      this._div.innerHTML = `
        <h4>${name}</h4>
        <div class="info-score ${level}">
          <span class="score-value">${score !== null ? Math.round(score) : '—'}</span>
          <span class="score-label">/ 100</span>
        </div>
        <div class="info-risk ${level}">${complianceLabel} Compliance</div>
        ${scoreData ? `
          <div class="info-details">
            <div>Not Implemented: ${scoreData.notImplementedPct?.toFixed(1) || '—'}%</div>
            <div>Observations: ${scoreData.observationCount?.toLocaleString() || '—'}</div>
            ${scoreData.lguCount ? `<div>Municipalities: ${scoreData.lguCount}</div>` : ''}
          </div>
        ` : ''}
      `;
    }
  };

  // Add region update function
  info.updateRegion = function(props) {
    const regionName = props.regionName || 'Unknown Region';
    const score = props.regionScore || null;
    const level = props.regionRiskLevel || 'no_data';
    const disallowances = props.regionDisallowances || 0;
    const lgus = props.regionLgus || 0;

    const formattedTotal = disallowances ? `₱${disallowances.toLocaleString('en-PH', {minimumFractionDigits: 2, maximumFractionDigits: 2})}` : '—';

    this._div.innerHTML = `
      <h4 style="color: #8b008b;">🏛️ ${regionName}</h4>
      <div class="info-score ${level}">
        <span class="score-value">${score !== null ? Math.round(score) : '—'}</span>
        <span class="score-label">/ 100</span>
      </div>
      <div class="info-risk ${level}">Regional Risk: ${level.charAt(0).toUpperCase() + level.slice(1)}</div>
      <div class="info-details">
        <div><strong>Total Disallowances:</strong><br/>${formattedTotal}</div>
        <div><strong>Total LGUs:</strong> ${lgus}</div>
        <div><strong>Province:</strong> ${props.name || props.NAME || ''}</div>
        <div style="margin-top: 10px; font-size: 0.9em; color: #666;">
          <em>Special Administrative Region</em>
        </div>
      </div>
    `;
  };

  return info;
}

// ============================================
// LEGEND CONTROL
// ============================================

function createLegendControl() {
  const legend = L.control({ position: 'bottomright' });

  legend.onAdd = function() {
    const div = L.DomUtil.create('div', 'legend-panel');
    const grades = [0, 20, 40, 60, 80];

    // Different labels based on dataset
    const isDisallowances = state.currentDataset === 'disallowances';
    const title = isDisallowances ? 'Disallowance Level' : 'Compliance Level';
    const labels = isDisallowances
      ? ['Minimal', 'Low', 'Moderate', 'High', 'Critical']
      : ['Very High', 'High', 'Moderate', 'Low', 'Very Low'];

    div.innerHTML = `<h4>${title}</h4>`;

    for (let i = 0; i < grades.length; i++) {
      div.innerHTML += `
        <div class="legend-item">
          <span class="legend-color" style="background:${getRiskColor(grades[i])}"></span>
          <span class="legend-label">${labels[i]}</span>
        </div>
      `;
    }

    div.innerHTML += `
      <div class="legend-item">
        <span class="legend-color" style="background:#e0e0e0"></span>
        <span class="legend-label">No Data</span>
      </div>
    `;

    return div;
  };

  legend.update = function() {
    // Remove and re-add to update
    if (state.map && this._map) {
      state.map.removeControl(this);
      this.addTo(state.map);
    }
  };

  return legend;
}

// ============================================
// RENDER LAYERS
// ============================================

async function renderProvinces() {
  if (!state.provinceGeoJson) {
    state.provinceGeoJson = await loadGeoJson('provinces');
  }

  if (!state.provinceGeoJson) {
    console.error('Failed to load province GeoJSON');
    return;
  }

  const scores = await loadProvinceScores(state.currentYear);

  // Remove existing layer
  if (state.provinceLayer) {
    state.map.removeLayer(state.provinceLayer);
  }

  state.provinceLayer = L.geoJSON(state.provinceGeoJson, {
    style: (feature) => getProvinceStyle(feature, scores),
    onEachFeature: (feature, layer) => {
      const psgc = getPsgc(feature);
      layer.scoreData = scores[psgc] || null;

      layer.on({
        mouseover: highlightFeature,
        mouseout: (e) => resetHighlight(e, scores, false),
        click: (e) => {
          state.map.fitBounds(e.target.getBounds(), { padding: [50, 50] });
        }
      });
    }
  }).addTo(state.map);

  // Hide LGU layer
  if (state.lguLayer) {
    state.map.removeLayer(state.lguLayer);
  }
}

async function renderLgus() {
  if (!state.lguGeoJson) {
    state.lguGeoJson = await loadGeoJson('lgus');
  }

  if (!state.lguGeoJson) {
    console.error('Failed to load LGU GeoJSON');
    return;
  }

  const scores = await loadLguScores(state.currentYear);

  // Remove existing layer
  if (state.lguLayer) {
    state.map.removeLayer(state.lguLayer);
  }

  state.lguLayer = L.geoJSON(state.lguGeoJson, {
    style: (feature) => getLguStyle(feature, scores),
    onEachFeature: (feature, layer) => {
      // For LGUs, construct the key as provincePsgc_lguName
      const props = feature.properties;
      const lguName = props.name || props.NAME || props.adm2_en || '';
      const provPsgc = String(props.province_psgc || props.adm1_psgc || '').padStart(10, '0');

      // Try different key formats
      const possibleKeys = [
        `${provPsgc}_${lguName}`,
        `${provPsgc}_${lguName.replace(' ', '')}`,
        `${provPsgc}_${lguName}City`,
        `${provPsgc}_${lguName}Mun`
      ];

      let data = null;
      for (const key of possibleKeys) {
        if (scores[key]) {
          data = scores[key];
          break;
        }
      }

      layer.scoreData = data;

      layer.on({
        mouseover: highlightFeature,
        mouseout: (e) => resetHighlight(e, scores, true),
        click: (e) => {
          state.map.fitBounds(e.target.getBounds(), { padding: [50, 50] });
        }
      });
    }
  }).addTo(state.map);

  // Hide province layer
  if (state.provinceLayer) {
    state.map.removeLayer(state.provinceLayer);
  }
}

async function renderRegions() {
  // Load region data
  const regionData = await loadRegionData();

  if (!state.provinceGeoJson) {
    state.provinceGeoJson = await loadGeoJson('provinces');
  }

  if (!state.provinceGeoJson) {
    console.error('Failed to load province GeoJSON for regions');
    return;
  }

  // Remove existing region layer
  if (state.regionLayer) {
    state.map.removeLayer(state.regionLayer);
    state.regionLayer = null;
  }

  if (!state.showRegions) {
    return;
  }

  // Create region overlay by filtering provinces
  const regionFeatures = [];

  for (const [regionPsgc, region] of Object.entries(regionData)) {
    // Find all provinces that belong to this region
    const regionProvinces = state.provinceGeoJson.features.filter(feature => {
      const psgc = getPsgc(feature);
      return region.provincePsgcs.includes(psgc);
    });

    if (regionProvinces.length > 0) {
      // Create a merged feature for the region
      regionProvinces.forEach(province => {
        const feature = {
          ...province,
          properties: {
            ...province.properties,
            regionName: region.name,
            regionPsgc: regionPsgc,
            regionScore: region.score,
            regionRiskLevel: region.riskLevel,
            regionDisallowances: region.totalDisallowances,
            regionLgus: region.totalLgus,
            isRegion: true
          }
        };
        regionFeatures.push(feature);
      });
    }
  }

  if (regionFeatures.length > 0) {
    state.regionLayer = L.geoJSON({
      type: 'FeatureCollection',
      features: regionFeatures
    }, {
      style: (feature) => ({
        fillColor: getRiskColor(feature.properties.regionScore),
        weight: 3,
        opacity: 1,
        color: '#8b008b', // Purple border for regions
        fillOpacity: 0.6,
        dashArray: '5, 5'
      }),
      onEachFeature: (feature, layer) => {
        layer.on({
          mouseover: (e) => {
            const props = e.target.feature.properties;
            e.target.setStyle({
              weight: 4,
              color: '#4b0082',
              fillOpacity: 0.8
            });
            e.target.bringToFront();

            // Update info panel with region data
            state.info.updateRegion(props);
          },
          mouseout: (e) => {
            state.regionLayer.resetStyle(e.target);
            state.info.update();
          }
        });
      }
    }).addTo(state.map);

    // Bring region layer to front
    state.regionLayer.bringToFront();
  }
}

// ============================================
// UPDATE HANDLERS
// ============================================

async function updateMap() {
  // Clear score caches when dataset changes
  state.provinceScores = {};
  state.lguScores = {};

  if (state.currentView === 'provinces') {
    await renderProvinces();
  } else {
    await renderLgus();
  }

  // Render regions overlay if enabled
  await renderRegions();
}

async function updateYear(year) {
  state.currentYear = year;

  // Clear caches when year changes
  state.provinceScores = {};
  state.lguScores = {};

  if (state.currentView === 'provinces') {
    await renderProvinces();
  } else {
    await renderLgus();
  }

  // Render regions overlay if enabled
  await renderRegions();
}

// ============================================
// CONTROL SETUP
// ============================================

function setupControls() {
  // Toggle controls panel
  const toggleBtn = document.getElementById('toggle-controls');
  const controlsPanel = document.getElementById('controls-panel');
  if (toggleBtn && controlsPanel) {
    toggleBtn.addEventListener('click', () => {
      controlsPanel.classList.toggle('collapsed');
      toggleBtn.querySelector('.toggle-icon').textContent =
        controlsPanel.classList.contains('collapsed') ? '☰' : '✕';
    });
  }

  // Dataset dropdown
  const datasetSelect = document.getElementById('dataset-select');
  if (datasetSelect) {
    datasetSelect.addEventListener('change', async (e) => {
      state.currentDataset = e.target.value;
      await updateMap();
    });
  }

  // Year dropdown
  const yearSelect = document.getElementById('year-select');
  if (yearSelect) {
    yearSelect.addEventListener('change', async (e) => {
      const value = e.target.value;
      await updateYear(value === 'all' ? 'all' : parseInt(value));
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
      state.map.fitBounds(PH_BOUNDS);
      await renderProvinces();
      await renderRegions(); // Re-render regions overlay
    });

    viewLgus.addEventListener('click', async () => {
      if (state.currentView === 'lgus') return;
      state.currentView = 'lgus';
      viewLgus.classList.add('active');
      viewProvinces.classList.remove('active');
      await renderLgus();
      await renderRegions(); // Re-render regions overlay
    });
  }

  // Legend toggle checkbox
  const toggleLegend = document.getElementById('toggle-legend');
  if (toggleLegend) {
    toggleLegend.addEventListener('change', (e) => {
      state.showLegend = e.target.checked;
      if (state.showLegend && state.legendControl) {
        state.legendControl.addTo(state.map);
      } else if (!state.showLegend && state.legendControl) {
        state.map.removeControl(state.legendControl);
      }
    });
  }

  // Region toggle checkbox
  const toggleRegions = document.getElementById('toggle-regions');
  if (toggleRegions) {
    toggleRegions.addEventListener('change', async (e) => {
      state.showRegions = e.target.checked;
      await renderRegions();
    });
  }
}

// ============================================
// INITIALIZATION
// ============================================

async function initMap() {
  const container = document.getElementById('map');

  if (!container) {
    console.error('Map container not found');
    return;
  }

  try {
    // Create Leaflet map
    state.map = L.map('map', {
      center: PH_CENTER,
      zoom: 6,
      minZoom: 5,
      maxZoom: 12,
      maxBounds: [[0, 110], [25, 135]],
      maxBoundsViscosity: 1.0
    });

    // Add light tile layer as background
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap, &copy; CARTO',
      subdomains: 'abcd',
      maxZoom: 12
    }).addTo(state.map);

    // Add info control
    state.info = createInfoControl();
    state.info.addTo(state.map);

    // Add legend (store in state for toggling)
    state.legendControl = createLegendControl();
    if (state.showLegend) {
      state.legendControl.addTo(state.map);
    }

    console.log('Leaflet map created, loading provinces...');

    // Initial render
    await renderProvinces();

    // Setup controls
    setupControls();

    console.log('Map initialized successfully with Leaflet');

  } catch (error) {
    console.error('Map initialization error:', error);
    container.innerHTML = `
      <div class="error-message">
        <h3>Failed to load map</h3>
        <p>${error.message}</p>
      </div>
    `;
  }
}

// ============================================
// EXPORTS
// ============================================

window.initMap = initMap;
window.renderMap = initMap;
