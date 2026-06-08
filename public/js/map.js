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
  info: null,

  // Selected feature
  selectedLayer: null
};

// Philippines bounds
const PH_BOUNDS = [[4.5, 116.5], [21.5, 127]];
const PH_CENTER = [12.5, 122];

// ============================================
// UTILITY FUNCTIONS
// ============================================

function getRiskColor(score) {
  // For disallowances dataset, use ratio-based coloring
  if (state.currentDataset === 'disallowances') {
    return getDisallowanceColor(score);
  }

  // Original scoring for audit dataset
  if (score === null || score === undefined) return '#e0e0e0';
  if (score >= 80) return '#7f0000';
  if (score >= 60) return '#c62828';
  if (score >= 40) return '#ef6c00';
  if (score >= 20) return '#fdd835';
  return '#66bb6a';
}

function getDisallowanceColor(ratio) {
  // More visible colors for light background
  if (ratio === null || ratio === undefined) return '#d3d3d3';  // No data - light gray
  if (ratio >= 5.0) return '#67000d';   // Very dark red - very high ratio
  if (ratio >= 2.0) return '#a50f15';   // Dark red - high ratio
  if (ratio >= 1.0) return '#cb181d';   // Red - moderate-high ratio
  if (ratio >= 0.5) return '#ef3b2c';   // Medium red - moderate ratio
  if (ratio >= 0.1) return '#fb6a4a';   // Light red - low ratio
  if (ratio >= 0.01) return '#fc9272';  // Very light red - very low ratio
  return '#fee0d2';                     // Pale red - minimal ratio
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
    url = 'data/disallowances_with_income.json';
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
    url = 'data/disallowances_with_income.json';
  }

  try {
    const response = await fetch(url);
    const data = await response.json();
    const scores = state.currentDataset === 'audit' ? data.lgus : (data.lgus || {});

    // Create additional lookup by province name + LGU name
    const enhancedScores = { ...scores };
    let enhancedCount = 0;
    for (const [key, value] of Object.entries(scores)) {
      if (value.province && value.name) {
        // Add lookup by "Province_LGUName" format with variations
        const province = value.province;
        const name = value.name;

        // Add multiple variations for better matching
        enhancedScores[`${province}_${name}`] = value;
        enhancedScores[`${province}_${name.replace(/\s+/g, '')}`] = value;
        enhancedScores[`${province}_${name.replace(/\s+/g, '').replace(/-/g, '')}`] = value;

        // Also add without spaces in province name
        const provinceNoSpace = province.replace(/\s+/g, '');
        enhancedScores[`${provinceNoSpace}_${name}`] = value;
        enhancedScores[`${provinceNoSpace}_${name.replace(/\s+/g, '')}`] = value;

        enhancedCount++;
      }
    }

    console.log(`Enhanced LGU scores with ${enhancedCount} province-name lookups`);
    state.lguScores[cacheKey] = enhancedScores;
    return enhancedScores;
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

  // Use disallowance ratio for disallowances dataset, otherwise use score
  let value = null;
  if (state.currentDataset === 'disallowances') {
    value = data ? (data.disallowance_ratio_percent || data.avg_ratio_percent || null) : null;

    // Debug to see what's happening
    if (data && value !== null) {
      console.log(`Province ${data.name}: ratio=${value}, color=${getDisallowanceColor(value)}`);
    }
  } else {
    value = data ? data.score : null;
  }

  return {
    fillColor: getRiskColor(value),
    weight: 1.5,
    opacity: 1,
    color: '#ffffff',
    fillOpacity: 0.8
  };
}

function getLguStyle(feature, scores, provinceMap = {}) {
  // For LGUs, we need to construct the key as provincePsgc_lguName
  const props = feature.properties;
  const lguName = props.name || props.NAME || props.adm2_en || '';
  // Handle both numeric and string PSGCs
  const provPsgc = String(props.province_psgc || props.adm1_psgc || 0).padStart(10, '0');

  // Get province name from mapping
  const provinceName = provinceMap[String(props.province_psgc || '')] || '';

  // Try different key formats to match our data
  // Handle various naming conventions
  let cleanName = lguName;

  // Remove "City of " prefix if present
  if (cleanName.startsWith('City of ')) {
    cleanName = cleanName.substring(8);  // Remove "City of "
  }

  // Create variations
  const nameNoSpaces = cleanName.replace(/\s+/g, '').replace(/-/g, '');  // Remove spaces AND hyphens
  const originalNoSpaces = lguName.replace(/\s+/g, '').replace(/-/g, '');

  const possibleKeys = [
    // Try with PSGC first
    `${provPsgc}_${cleanName}`,
    `${provPsgc}_${nameNoSpaces}`,
    `${provPsgc}_${originalNoSpaces}`,
    `${provPsgc}_${nameNoSpaces}City`,
    `${provPsgc}_${cleanName}City`,
    // Try with province name
    provinceName ? `${provinceName}_${cleanName}` : null,
    provinceName ? `${provinceName}_${nameNoSpaces}` : null,
    // Original patterns
    `${provPsgc}_${lguName}`,
    `${provPsgc}_${cleanName.replace(/\s+/g, '')}`,
    `${provPsgc}_${lguName.replace('City of ', '').replace(/\s+/g, '')}City`
  ].filter(k => k !== null);

  let data = null;
  for (const key of possibleKeys) {
    if (scores[key]) {
      data = scores[key];
      break;
    }
  }

  // Use disallowance ratio only - no score fallback
  let value = null;
  if (data) {
    // Use calculated ratio first, then pre-existing ratio
    value = data.calculated_ratio_percent || data.disallowance_ratio_percent || data.avg_ratio_percent || null;
  }

  // Debug logging for first few for troubleshooting
  if (!data && possibleKeys.length > 0 && Math.random() < 0.01) {  // Log 1% of unmatched
    console.log(`No match for: ${lguName} (${provinceName || provPsgc})`);
    console.log('  Tried keys:', possibleKeys.slice(0, 3));
  }

  // Log successful matches for debugging
  if (data && value !== null && Math.random() < 0.02) {
    console.log(`✓ Matched ${lguName} (${provinceName}) with ratio: ${value}`);
  }

  // Special debug for specific problematic LGUs
  if (lguName === 'Roxas' || lguName === 'City of Malaybalay') {
    console.log(`DEBUG ${lguName}:`);
    console.log('  Province:', provinceName);
    console.log('  PSGC:', provPsgc);
    console.log('  Data found:', data ? 'YES' : 'NO');
    console.log('  Value:', value);
    console.log('  Keys tried:', possibleKeys.slice(0, 5));
  }

  const fillColor = getRiskColor(value);

  return {
    fillColor: fillColor,
    weight: 0.8,
    opacity: 1,
    color: '#333333',
    fillOpacity: 0.75
  };
}

function highlightFeature(e) {
  const layer = e.target;

  // Only apply hover effect if not selected
  if (state.selectedLayer === layer) return;

  layer.setStyle({
    weight: 2,
    color: '#666',
    fillOpacity: 0.85
  });

  layer.bringToFront();

  // Update info on hover ONLY if nothing is selected
  if (!state.selectedLayer) {
    state.info.update(layer.feature.properties, layer.scoreData);
  }
}

function resetHighlight(e, scores, isLgu = false) {
  const layer = e.target;

  // Don't reset if this is the selected layer
  if (state.selectedLayer === layer) return;

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

  // Only clear info if nothing is selected
  if (!state.selectedLayer) {
    state.info.update();
  }
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
    // Store for sticky display
    if (props && scoreData) {
      this._stickyProps = props;
      this._stickyScoreData = scoreData;
    }

    // Use sticky data if no new props provided
    const displayProps = props || this._stickyProps;
    const displayScoreData = scoreData || this._stickyScoreData;

    if (!displayProps) {
      this._div.innerHTML = '';
      this._div.style.display = 'none';
      return;
    }

    this._div.style.display = 'block';

    const name = displayProps.name || displayProps.NAME || displayProps.adm2_en || 'Unknown';

    // Check if we're showing disallowances data
    const isDisallowances = state.currentDataset === 'disallowances';

    if (isDisallowances && displayScoreData) {
      // Get ratio value
      const ratio = displayScoreData.disallowance_ratio_percent || displayScoreData.avg_ratio_percent || displayScoreData.score || 0;
      const level = getRiskLevel(ratio);

      // Disallowances display
      const totalDisallowances = displayScoreData.totalDisallowances || displayScoreData.total_disallowances || 0;
      const totalOperatingIncome = displayScoreData.total_operating_income || displayScoreData.totalOperatingIncome || 0;
      const avgPerLGU = displayScoreData.avgDisallowancesPerLGU || 0;
      const formattedTotal = totalDisallowances ? `₱${totalDisallowances.toLocaleString('en-PH', {minimumFractionDigits: 2, maximumFractionDigits: 2})}` : '₱0.00';
      const formattedIncome = totalOperatingIncome ? `₱${totalOperatingIncome.toLocaleString('en-PH', {minimumFractionDigits: 2, maximumFractionDigits: 2})}` : '—';
      const formattedAvg = avgPerLGU ? `₱${avgPerLGU.toLocaleString('en-PH', {minimumFractionDigits: 2, maximumFractionDigits: 2})}` : '—';

      // Check if this is an LGU/Municipality
      const isLGU = displayScoreData?.province ? true : false;

      this._div.innerHTML = `
        <h4>${name}${isLGU ? ` <span style="font-size: 0.8em; color: #666;">(${displayScoreData.province})</span>` : ''}</h4>
        <div class="info-score ${level}">
          <span class="score-value">${ratio.toFixed(2)}</span>
          <span class="score-label">%</span>
        </div>
        <div class="info-risk ${level}">Disallowance Ratio</div>
        <div class="info-details">
          <div><strong>Total Disallowances:</strong><br/>${formattedTotal}</div>
          <div><strong>Total Operating Income:</strong><br/>${formattedIncome}</div>
          ${totalOperatingIncome ? `<div style="font-size: 0.9em; color: #666; margin-top: 5px;">Ratio: ${totalDisallowances.toLocaleString()} ÷ ${totalOperatingIncome.toLocaleString()} = ${ratio.toFixed(2)}%</div>` : ''}
          ${!isLGU && avgPerLGU ? `<div><strong>Avg per LGU:</strong><br/>${formattedAvg}</div>` : ''}
          ${displayScoreData.observationCount ? `<div><strong>Observations:</strong> ${displayScoreData.observationCount.toLocaleString()}</div>` : ''}
          ${!isLGU && displayScoreData.lguCount ? `<div><strong>Municipalities:</strong> ${displayScoreData.lguCount}</div>` : ''}
          ${displayScoreData.yearsWithData ? `<div><strong>Years:</strong> ${displayScoreData.yearsWithData} years</div>` : ''}
        </div>
      `;
    } else if (displayScoreData) {
      // Compliance/Audit display (original)
      const score = displayScoreData.score || null;
      const level = displayScoreData.riskLevel || getRiskLevel(score);
      const complianceLabel = getComplianceLabel(level);

      this._div.innerHTML = `
        <h4>${name}</h4>
        <div class="info-score ${level}">
          <span class="score-value">${score !== null ? Math.round(score) : '—'}</span>
          <span class="score-label">/ 100</span>
        </div>
        <div class="info-risk ${level}">${complianceLabel} Compliance</div>
        ${displayScoreData ? `
          <div class="info-details">
            <div>Not Implemented: ${displayScoreData.notImplementedPct?.toFixed(1) || '—'}%</div>
            <div>Observations: ${displayScoreData.observationCount?.toLocaleString() || '—'}</div>
            ${displayScoreData.lguCount ? `<div>Municipalities: ${displayScoreData.lguCount}</div>` : ''}
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

    // Different scales based on dataset
    const isDisallowances = state.currentDataset === 'disallowances';
    let grades, labels, title;

    if (isDisallowances) {
      // For disallowance ratios (in percentages)
      title = 'Disallowance Ratio<br><small>(% of Operating Income)</small>';
      grades = [0, 0.1, 0.5, 1.0, 2.0, 5.0];
      labels = ['< 0.1%', '0.1-0.5%', '0.5-1%', '1-2%', '2-5%', '≥ 5%'];
    } else {
      // For audit scores
      title = 'Compliance Level';
      grades = [0, 20, 40, 60, 80];
      labels = ['Very High', 'High', 'Moderate', 'Low', 'Very Low'];
    }

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
          const clickedLayer = e.target;

          // If clicking the same layer, deselect it
          if (state.selectedLayer === clickedLayer) {
            // Reset the style to original
            const psgc = getPsgc(clickedLayer.feature);
            const originalStyle = getProvinceStyle(clickedLayer.feature, scores);
            clickedLayer.setStyle(originalStyle);
            state.selectedLayer = null;
            state.info.update(); // Clear info panel
            return;
          }

          // Reset previous selection if any
          if (state.selectedLayer) {
            // Reset to original style based on data
            const prevPsgc = getPsgc(state.selectedLayer.feature);
            const prevStyle = getProvinceStyle(state.selectedLayer.feature, scores);
            state.selectedLayer.setStyle(prevStyle);
          }

          // Select new layer
          state.selectedLayer = clickedLayer;
          clickedLayer.setStyle({
            weight: 4,
            color: '#ffff00',  // Bright yellow border
            dashArray: '',
            fillOpacity: 0.95
          });

          if (!L.Browser.ie && !L.Browser.opera && !L.Browser.edge) {
            clickedLayer.bringToFront();
          }

          // Update info panel (sticky)
          state.info.update(clickedLayer.feature.properties, clickedLayer.scoreData);
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
  // Show debug panel
  const debugPanel = document.getElementById('debug-panel');
  const debugContent = document.getElementById('debug-content');
  if (debugPanel) debugPanel.style.display = 'block';

  let debugInfo = [];

  debugInfo.push('=== MUNICIPALITY VIEW DEBUG ===');
  debugInfo.push(`Dataset: ${state.currentDataset}`);
  debugInfo.push(`Year: ${state.currentYear}`);

  if (!state.lguGeoJson) {
    state.lguGeoJson = await loadGeoJson('lgus');
  }

  if (!state.lguGeoJson) {
    console.error('Failed to load LGU GeoJSON');
    debugInfo.push('ERROR: Failed to load LGU GeoJSON');
    if (debugContent) debugContent.innerHTML = debugInfo.join('<br>');
    return;
  }

  debugInfo.push(`✓ Loaded ${state.lguGeoJson.features.length} LGU features`);

  // Load province GeoJSON to get province names
  if (!state.provinceGeoJson) {
    state.provinceGeoJson = await loadGeoJson('provinces');
  }

  // Create province PSGC to name mapping
  const provinceMap = {};
  if (state.provinceGeoJson) {
    for (const feature of state.provinceGeoJson.features) {
      const psgc = String(feature.properties.psgc || '');
      const name = feature.properties.name || '';
      if (psgc && name) {
        provinceMap[psgc] = name;
      }
    }
  }

  debugInfo.push(`✓ Province mapping: ${Object.keys(provinceMap).length} provinces`);

  const scores = await loadLguScores(state.currentYear);
  console.log('Loaded LGU scores:', Object.keys(scores).length, 'entries');
  console.log('Province mapping created:', Object.keys(provinceMap).length, 'provinces');

  debugInfo.push(`✓ Loaded ${Object.keys(scores).length} score entries`);

  // Debug: Check what types of keys we have
  const sampleKeys = Object.keys(scores).slice(0, 10);
  console.log('Sample score keys:', sampleKeys);

  debugInfo.push('');
  debugInfo.push('Sample score keys:');
  sampleKeys.slice(0, 5).forEach(k => {
    debugInfo.push(`  • ${k}`);
  });

  // Check data availability
  const withCalculatedRatio = Object.values(scores).filter(s => s.calculated_ratio_percent !== null && s.calculated_ratio_percent !== undefined).length;
  const withOriginalRatio = Object.values(scores).filter(s => s.disallowance_ratio_percent !== null && s.disallowance_ratio_percent !== undefined).length;
  const withOperatingIncome = Object.values(scores).filter(s => s.total_operating_income > 0).length;
  const withDisallowances = Object.values(scores).filter(s => s.totalDisallowances > 0).length;

  console.log('LGUs with calculated_ratio_percent:', withCalculatedRatio);
  console.log('LGUs with original ratio:', withOriginalRatio);
  console.log('LGUs with operating income:', withOperatingIncome);

  debugInfo.push('');
  debugInfo.push('Data availability:');
  debugInfo.push(`  • Calculated ratios: ${withCalculatedRatio}`);
  debugInfo.push(`  • Original ratios: ${withOriginalRatio}`);
  debugInfo.push(`  • Has operating income: ${withOperatingIncome}`);
  debugInfo.push(`  • Has disallowances: ${withDisallowances}`);
  debugInfo.push('');
  debugInfo.push(`Will show colors for: ${withCalculatedRatio + withOriginalRatio} LGUs with ratio data`);

  // Remove existing layer
  if (state.lguLayer) {
    state.map.removeLayer(state.lguLayer);
  }

  let matchedCount = 0;
  let coloredCount = 0;
  let unmatchedSamples = [];

  state.lguLayer = L.geoJSON(state.lguGeoJson, {
    style: (feature) => {
      const style = getLguStyle(feature, scores, provinceMap);
      // Count if it got a non-grey color
      if (style.fillColor !== '#d3d3d3' && style.fillColor !== '#e0e0e0') {
        coloredCount++;
      }
      return style;
    },
    onEachFeature: (feature, layer) => {
      // For LGUs, construct the key as provincePsgc_lguName
      const props = feature.properties;
      const lguName = props.name || props.NAME || props.adm2_en || '';
      // Handle both numeric and string PSGCs
      const provPsgc = String(props.province_psgc || props.adm1_psgc || 0).padStart(10, '0');

      // Try different key formats - handle various naming conventions
      let cleanName = lguName;

      // Remove "City of " prefix if present
      if (cleanName.startsWith('City of ')) {
        cleanName = cleanName.substring(8);  // Remove "City of "
      }

      // Get province name from mapping
      const provinceName = provinceMap[String(props.province_psgc || '')] || '';

      // Create variations
      const nameNoSpaces = cleanName.replace(/\s+/g, '').replace(/-/g, '');  // Remove spaces AND hyphens
      const originalNoSpaces = lguName.replace(/\s+/g, '').replace(/-/g, '');

      const possibleKeys = [
        // Try with PSGC first
        `${provPsgc}_${cleanName}`,
        `${provPsgc}_${nameNoSpaces}`,
        `${provPsgc}_${originalNoSpaces}`,
        `${provPsgc}_${nameNoSpaces}City`,
        `${provPsgc}_${cleanName}City`,
        // Try with province name
        provinceName ? `${provinceName}_${cleanName}` : null,
        provinceName ? `${provinceName}_${nameNoSpaces}` : null,
        provinceName ? `${provinceName}_${originalNoSpaces}` : null,
        provinceName ? `${provinceName}_${nameNoSpaces}City` : null,
        // Original patterns
        `${provPsgc}_${lguName}`,
        `${provPsgc}_${cleanName.replace(/\s+/g, '')}`,
        `${provPsgc}_${lguName.replace('City of ', '').replace(/\s+/g, '')}City`
      ].filter(k => k !== null);

      let data = null;
      for (const key of possibleKeys) {
        if (scores[key]) {
          data = scores[key];
          matchedCount++;
          break;
        }
      }

      if (!data && unmatchedSamples.length < 5) {
        unmatchedSamples.push({ name: lguName, psgc: provPsgc, tried: possibleKeys[0] });
      }

      layer.scoreData = data;

      layer.on({
        mouseover: highlightFeature,
        mouseout: (e) => resetHighlight(e, scores, true),
        click: async (e) => {
          const clickedLayer = e.target;

          // If clicking the same layer, deselect it
          if (state.selectedLayer === clickedLayer) {
            // Reset the style to original
            const originalStyle = getLguStyle(clickedLayer.feature, scores);
            clickedLayer.setStyle(originalStyle);
            state.selectedLayer = null;
            state.info.update(); // Clear info panel
            return;
          }

          // Reset previous selection if any
          if (state.selectedLayer) {
            // Check if previous was LGU or Province and reset appropriately
            if (state.lguLayer && state.lguLayer.hasLayer(state.selectedLayer)) {
              const prevStyle = getLguStyle(state.selectedLayer.feature, scores);
              state.selectedLayer.setStyle(prevStyle);
            } else if (state.provinceLayer && state.provinceLayer.hasLayer(state.selectedLayer)) {
              const provinceScores = await loadProvinceScores(state.currentYear);
              const prevStyle = getProvinceStyle(state.selectedLayer.feature, provinceScores);
              state.selectedLayer.setStyle(prevStyle);
            }
          }

          // Select new layer
          state.selectedLayer = clickedLayer;
          clickedLayer.setStyle({
            weight: 3,
            color: '#ffff00',  // Bright yellow border
            dashArray: '',
            fillOpacity: 0.95
          });

          if (!L.Browser.ie && !L.Browser.opera && !L.Browser.edge) {
            clickedLayer.bringToFront();
          }

          // Update info panel (sticky)
          state.info.update(clickedLayer.feature.properties, clickedLayer.scoreData);
        }
      });
    }
  }).addTo(state.map);

  console.log(`LGU matching: ${matchedCount} matched out of ${state.lguGeoJson.features.length} features`);
  console.log(`Match rate: ${(matchedCount / state.lguGeoJson.features.length * 100).toFixed(1)}%`);

  const matchRate = (matchedCount / state.lguGeoJson.features.length * 100).toFixed(1);

  debugInfo.push('');
  debugInfo.push('=== MATCHING RESULTS ===');
  debugInfo.push(`Matched: ${matchedCount}/${state.lguGeoJson.features.length} (${matchRate}%)`);
  debugInfo.push(`Colored: ${coloredCount}/${state.lguGeoJson.features.length} (${(coloredCount / state.lguGeoJson.features.length * 100).toFixed(1)}%)`);

  // More detailed debugging
  if (matchedCount < state.lguGeoJson.features.length / 2) {
    console.warn('Low match rate! Debugging info:');
    console.log('Unmatched samples:', unmatchedSamples.slice(0, 5));
    console.log('Score keys sample:', Object.keys(scores).slice(0, 10));

    debugInfo.push('');
    debugInfo.push('⚠️ LOW MATCH RATE!');
    debugInfo.push('Unmatched samples:');
    unmatchedSamples.slice(0, 5).forEach(s => {
      debugInfo.push(`  • ${s.name} (${s.psgc})`);
    });

    // Check if we have the enhanced scores with province names
    const hasProvinceKeys = Object.keys(scores).some(k => k.includes('_') && !k.match(/^\d+_/));
    console.log('Has province name keys:', hasProvinceKeys);

    debugInfo.push('');
    debugInfo.push(`Has province-name keys: ${hasProvinceKeys ? 'YES' : 'NO'}`);
  }

  // Update debug panel
  if (debugContent) {
    debugContent.innerHTML = debugInfo.join('<br>');
  }

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
      // Keep the gear icon always
      toggleBtn.querySelector('.toggle-icon').textContent = '⚙';
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

  // Legend is now integrated into control panel, no separate toggle needed

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

  // Add keyboard shortcut for debug panel (press 'D')
  document.addEventListener('keydown', (e) => {
    if (e.key === 'd' || e.key === 'D') {
      const debugPanel = document.getElementById('debug-panel');
      if (debugPanel) {
        debugPanel.style.display = debugPanel.style.display === 'none' ? 'block' : 'none';
      }
    }
  });

  // Ensure we're using disallowances dataset
  console.log('Initializing map with dataset:', state.currentDataset);

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

    // Don't add separate legend since it's integrated into control panel
    // state.legendControl = createLegendControl();
    // if (state.showLegend) {
    //   state.legendControl.addTo(state.map);
    // }

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
