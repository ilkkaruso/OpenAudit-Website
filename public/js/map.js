/**
 * OpenAudit Philippines - Interactive Map with Leaflet
 * Fast, smooth pan/zoom with GeoJSON layers
 */

// ============================================
// STATE MANAGEMENT
// ============================================

const state = {
  // Current view settings
  currentYear: 'average',
  currentDataset: 'disallowances',
  currentView: 'provinces',
  currentRatioType: 'expenditures',  // 'local_sources' or 'expenditures'
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

// Helper function to get the correct ratio field based on current ratio type
function getRatioField(data, year = 'sum') {
  if (!data) return null;

  // For sum view, use the total sums to calculate ratio
  if (year === 'sum') {
    const totalDisallowances = data.totalDisallowances || 0;
    let totalDenominator = 0;

    if (state.currentRatioType === 'local_sources') {
      totalDenominator = data.total_local_sources || 0;
    } else {
      // Use total operating expenditures as denominator
      totalDenominator = data.total_operating_expenditures || 0;
    }

    if (totalDenominator > 0) {
      return (totalDisallowances / totalDenominator) * 100;
    }
    return 0;
  }

  // For average view, use true average of per-year ratios
  if (year === 'average') {
    if (state.currentRatioType === 'local_sources') {
      return data.true_avg_ratio_local || 0;
    }
    return data.true_avg_ratio_exp || 0;
  }

  // For specific years, calculate the ratio
  if (data.years && data.years[year]) {
    const disallowances = data.years[year];
    let denominator = 0;

    if (state.currentRatioType === 'local_sources' && data.local_sources_by_year) {
      denominator = data.local_sources_by_year[year] || 0;
    } else if (data.operating_exp_by_year) {
      denominator = data.operating_exp_by_year[year] || 0;
    }

    if (denominator > 0) {
      return (disallowances / denominator) * 100;
    }
  }

  // If we reach here, no data available
  return 0;
}

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
  // Continuous log-scale gradient: pale pink -> red -> very dark red
  if (ratio === null || ratio === undefined) return '#d3d3d3';  // No data - light gray
  if (ratio <= 0) return '#fee0d2';  // Zero/negative - palest

  // Log scale mapping: 0.01% -> 0.0, 50% -> 1.0
  const logMin = Math.log10(0.01);  // -2
  const logMax = Math.log10(50);    // ~1.7
  const t = Math.max(0, Math.min(1, (Math.log10(ratio) - logMin) / (logMax - logMin)));

  // Interpolate through a red gradient using HSL
  // Hue stays at 0 (red), saturation stays high
  // Lightness goes from 92% (very pale) to 15% (very dark)
  const lightness = 92 - t * 77;  // 92% -> 15%
  const saturation = 50 + t * 45; // 50% -> 95%

  return `hsl(0, ${saturation.toFixed(1)}%, ${lightness.toFixed(1)}%)`;
}

function getRiskLevel(score) {
  if (score === null || score === undefined) return 'no_data';
  // For disallowance ratios (percentages)
  if (state.currentDataset === 'disallowances') {
    if (score >= 5) return 'critical';    // ≥ 5%
    if (score >= 2) return 'high';        // 2-5%
    if (score >= 1) return 'moderate';    // 1-2%
    if (score >= 0.5) return 'low';       // 0.5-1%
    if (score >= 0.1) return 'minimal';   // 0.1-0.5%
    return 'minimal';                      // < 0.1%
  }
  // For audit scores (0-100)
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
  // Convert to string and ensure it's always 10 digits
  // Handle both numeric and string PSGCs from GeoJSON
  return String(psgc);
}

// ============================================
// DATA LOADING
// ============================================

async function loadProvinceScores(year) {
  const cacheKey = `${state.currentDataset}_${year}`;  // Include dataset in cache key
  if (state.provinceScores[cacheKey]) {
    console.log(`📦 Using cached province scores for ${cacheKey}`);
    return state.provinceScores[cacheKey];
  }

  let url;
  if (state.currentDataset === 'audit') {
    url = year === 'all' ? 'data/province-scores-all.json' : `data/province-scores-${year}.json`;
  } else {
    url = 'data/disallowances_with_yearly.json';
  }

  try {
    const fetchUrl = url + (url.includes('?') ? '&' : '?') + 'v=' + Date.now();
    console.log(`Loading province scores from ${url}`);
    const response = await fetch(fetchUrl, { cache: 'no-store' });
    const data = await response.json();
    const scores = state.currentDataset === 'audit' ? data.provinces : (data.provinces || {});
    console.log(`Loaded ${Object.keys(scores).length} provinces from ${url}`);
    state.provinceScores[cacheKey] = scores;
    return scores;
  } catch (err) {
    console.error('Failed to load province scores:', err);
    return {};
  }
}

async function loadLguScores(year) {
  const cacheKey = `${state.currentDataset}_${year}`;  // Include dataset in cache key
  if (state.lguScores[cacheKey]) {
    console.log(`Using cached LGU scores for ${cacheKey}`);
    return state.lguScores[cacheKey];
  }

  let url;
  if (state.currentDataset === 'audit') {
    url = year === 'all' ? 'data/lgu-scores.json' : `data/scores-${year}.json`;
  } else {
    url = 'data/disallowances_with_yearly.json';
  }

  try {
    const fetchUrl = url + (url.includes('?') ? '&' : '?') + 'v=' + Date.now();
    console.log(`Loading LGU scores from ${url}`);
    const response = await fetch(fetchUrl, { cache: 'no-store' });
    const data = await response.json();
    const scores = state.currentDataset === 'audit' ? data.lgus : (data.lgus || {});
    console.log(`✅ Loaded ${Object.keys(scores).length} LGU entries from ${url}`);

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
    console.log(`Total LGU entries: ${Object.keys(scores).length}`);
    console.log(`Total keys after enhancement: ${Object.keys(enhancedScores).length}`);

    // Debug: Check if PSGC keys are present
    const samplePsgcs = ['1001301000', '1001302000', '0603002000'];
    console.log('Checking sample PSGCs:');
    for (const psgc of samplePsgcs) {
      console.log(`  ${psgc}: ${psgc in enhancedScores ? 'FOUND' : 'NOT FOUND'}`);
    }

    state.lguScores[cacheKey] = enhancedScores;
    return enhancedScores;
  } catch (err) {
    console.error('Failed to load LGU scores:', err);
    return {};
  }
}

async function loadGeoJson(type) {
  const baseUrl = type === 'provinces' ? 'geo/provinces.geojson' : 'geo/lgus.geojson';
  const url = baseUrl + '?v=' + Date.now();

  try {
    console.log(`Loading ${type} from ${baseUrl}...`);
    const response = await fetch(url, { cache: 'no-store' });
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

  // Debug first few provinces
  if (Math.random() < 0.05) {  // Log 5% for debugging
    console.log(`Province: ${feature.properties.name}, PSGC: ${psgc}, Data found: ${!!data}`);
    if (!data && Object.keys(scores).length > 0) {
      console.log(`  Available keys sample:`, Object.keys(scores).slice(0, 3));
    }
  }

  // Use disallowance ratio for disallowances dataset, otherwise use score
  let value = null;
  if (state.currentDataset === 'disallowances') {
    value = getRatioField(data, state.currentYear);
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
  // Our data now uses PSGC codes directly as keys
  const props = feature.properties;
  const lguPsgc = getPsgc(feature);  // Get the LGU's PSGC code
  const lguName = props.name || props.NAME || props.adm2_en || '';

  // Province info for fallback matching
  const provPsgc = String(props.province_psgc || props.adm1_psgc || 0).padStart(10, '0');
  const provinceName = provinceMap[String(props.province_psgc || '')] || '';

  // Try to match directly with PSGC
  let data = scores[lguPsgc];

  // If no direct match, try fallback approaches
  if (!data) {
    // Try different key formats to match our data
    // Handle various naming conventions
    let cleanName = lguName;

    // Check if it's a city and format appropriately
    let isCity = false;
    if (cleanName.startsWith('City of ')) {
      cleanName = cleanName.substring(8);  // Remove "City of "
      isCity = true;
    }

    // Create variations
    const nameNoSpaces = cleanName.replace(/\s+/g, '').replace(/-/g, '');  // Remove spaces AND hyphens
    const originalNoSpaces = lguName.replace(/\s+/g, '').replace(/-/g, '');

    const possibleKeys = [
      // Try with PSGC first
      `${provPsgc}_${cleanName}`,
      `${provPsgc}_${nameNoSpaces}`,
      `${provPsgc}_${originalNoSpaces}`,
      // For cities, try with " City" suffix (our data format)
      isCity ? `${provPsgc}_${cleanName} City` : null,
      isCity ? `${provPsgc}_${cleanName}City` : null,
      isCity ? `${provPsgc}_${nameNoSpaces} City` : null,
      isCity ? `${provPsgc}_${nameNoSpaces}City` : null,
      // Try with province name
      provinceName ? `${provinceName}_${cleanName}` : null,
      provinceName ? `${provinceName}_${nameNoSpaces}` : null,
      provinceName && isCity ? `${provinceName}_${cleanName} City` : null
    ].filter(k => k !== null);

    for (const key of possibleKeys) {
      if (scores[key]) {
        data = scores[key];
        break;
      }
    }
  }

  // Use disallowance ratio based on selected year and ratio type
  let value = getRatioField(data, state.currentYear);

  // Debug logging for first few for troubleshooting
  if (!data && Math.random() < 0.01) {  // Log 1% of unmatched
    console.log(`No match for: ${lguName} (PSGC: ${lguPsgc})`);
    console.log('  Available keys sample:', Object.keys(scores).slice(0, 5));
  }

  // Log successful matches for debugging
  if (data && value !== null && Math.random() < 0.02) {
    console.log(`✓ Matched ${lguName} (PSGC: ${lguPsgc}) with ratio: ${value?.toFixed(2)}%`);
  }

  // Special debug for specific problematic LGUs
  if (lguName === 'Roxas' || lguName === 'City of Malaybalay') {
    console.log(`DEBUG ${lguName}:`);
    console.log('  LGU PSGC:', lguPsgc);
    console.log('  Data found:', data ? 'YES' : 'NO');
    console.log('  Value:', value);
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

    // Try to get name from scoreData first (which has our processed data), then from props
    const name = displayScoreData?.name || displayProps.name || displayProps.NAME || displayProps.adm2_en || 'Unknown';

    // Check if we're showing disallowances data
    const isDisallowances = state.currentDataset === 'disallowances';

    if (isDisallowances && displayScoreData) {
      // Get data based on selected year
      let ratio = 0;
      let totalDisallowances = 0;
      let denominator = 0;
      let denominatorLabel = '';

      if (state.currentYear === 'sum') {
        // For sum, use the total sums
        totalDisallowances = displayScoreData.totalDisallowances || 0;

        if (state.currentRatioType === 'local_sources') {
          denominatorLabel = 'Total Local Sources';
          denominator = displayScoreData.total_local_sources || 0;
          if (denominator > 0) {
            ratio = (totalDisallowances / denominator) * 100;
          }
        } else {
          denominatorLabel = 'Total Operating Expenditures';
          denominator = displayScoreData.total_operating_expenditures || 0;
          if (denominator > 0) {
            ratio = (totalDisallowances / denominator) * 100;
          }
        }
      } else if (state.currentYear === 'average') {
        // For average view, use true average of per-year ratios
        totalDisallowances = displayScoreData.totalDisallowances || 0;

        if (state.currentRatioType === 'local_sources') {
          denominatorLabel = 'Total Local Sources';
          denominator = displayScoreData.total_local_sources || 0;
          ratio = displayScoreData.true_avg_ratio_local || 0;
        } else {
          denominatorLabel = 'Total Operating Expenditures';
          denominator = displayScoreData.total_operating_expenditures || 0;
          ratio = displayScoreData.true_avg_ratio_exp || 0;
        }

        // Store averages for display
        displayScoreData._avgDisallowances = displayScoreData.avgDisallowances || 0;
        displayScoreData._avgDenominator = (state.currentRatioType === 'local_sources')
          ? (displayScoreData.avgLocalSources || 0)
          : (displayScoreData.avgOperatingExpenditures || 0);
      } else {
        // For specific year, use year data
        totalDisallowances = displayScoreData.years && displayScoreData.years[state.currentYear] || 0;

        if (state.currentRatioType === 'local_sources') {
          denominatorLabel = 'Total Local Sources';
          denominator = displayScoreData.local_sources_by_year &&
                       displayScoreData.local_sources_by_year[state.currentYear] || 0;
        } else {
          denominatorLabel = 'Total Operating Expenditures';
          denominator = displayScoreData.operating_exp_by_year &&
                       displayScoreData.operating_exp_by_year[state.currentYear] || 0;
        }

        // Calculate ratio for specific year
        if (denominator > 0) {
          ratio = (totalDisallowances / denominator) * 100;
        }
      }

      // Check if we have valid data
      const hasValidData = totalDisallowances > 0 || denominator > 0;

      const avgPerLGU = displayScoreData.avgDisallowancesPerLGU || 0;
      const formattedAvg = avgPerLGU ? `₱${avgPerLGU.toLocaleString('en-PH', {minimumFractionDigits: 2, maximumFractionDigits: 2})}` : '—';

      // Check if this is an LGU/Municipality
      // A province won't have a 'province' field, but an LGU will
      // Also check that we're not displaying a province itself
      const isLGU = displayScoreData?.province &&
                    displayScoreData.province !== 'None' &&
                    displayScoreData.name !== displayScoreData.province;

      // Build the info panel HTML - matching original style
      const level = displayScoreData?.riskLevel || getRiskLevel(ratio);

      if (!hasValidData || totalDisallowances === 0) {
        // No data available
        this._div.innerHTML = `
          <h4>${name}${isLGU ? ` <span style="font-size: 0.8em; color: #666;">(${displayScoreData.province})</span>` : ''}</h4>
          <div style="padding: 20px 0; text-align: center; color: #999;">
            <div style="font-size: 1.2em; margin-bottom: 10px;">No Data Available</div>
            <div style="font-size: 0.9em;">No financial data for ${(state.currentYear !== 'average' && state.currentYear !== 'sum') ? state.currentYear : 'this period'}</div>
          </div>
        `;
      } else {
        // Format amounts properly
        const formattedTotal = `₱${totalDisallowances.toLocaleString('en-PH', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
        const formattedDenominator = denominator > 0 ?
          `₱${denominator.toLocaleString('en-PH', {minimumFractionDigits: 2, maximumFractionDigits: 2})}` : '—';

        // Build info details based on view type
        let detailsHTML = '';

        if (state.currentYear === 'average' && displayScoreData._avgDisallowances !== undefined) {
          // For average view, show averages first, then totals
          const formattedAvgDisallow = `₱${displayScoreData._avgDisallowances.toLocaleString('en-PH', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
          const formattedAvgDenom = displayScoreData._avgDenominator > 0 ?
            `₱${displayScoreData._avgDenominator.toLocaleString('en-PH', {minimumFractionDigits: 2, maximumFractionDigits: 2})}` : '—';

          // Build per-year ratio breakdown
          const years = displayScoreData.years || {};
          const expByYear = displayScoreData.operating_exp_by_year || {};
          const localByYear = displayScoreData.local_sources_by_year || {};
          const denomByYear = state.currentRatioType === 'local_sources' ? localByYear : expByYear;
          const allYears = [...new Set([...Object.keys(years), ...Object.keys(denomByYear)])].sort();

          let yearRows = '';
          let ratioCount = 0;
          for (const yr of allYears) {
            const d = years[yr] || 0;
            const den = denomByYear[yr] || 0;
            const yrRatio = den > 0 ? (d / den * 100) : null;
            if (yrRatio !== null) ratioCount++;
            yearRows += `<tr>
              <td style="padding: 1px 4px;">${yr}</td>
              <td style="padding: 1px 4px; text-align: right;">${yrRatio !== null ? yrRatio.toFixed(2) + '%' : '—'}</td>
            </tr>`;
          }

          detailsHTML = `
            <div style="background: #e8f4f8; padding: 6px 8px; margin-bottom: 6px; border-radius: 4px;">
              <div style="font-weight: bold; margin-bottom: 4px; color: #1e5c75; font-size: 0.85em;">Mean of Per-Year Ratios:</div>
              <table style="width: 100%; font-size: 0.82em; border-collapse: collapse;">
                <thead><tr style="border-bottom: 1px solid #ccc;">
                  <th style="text-align: left; padding: 1px 4px;">Year</th>
                  <th style="text-align: right; padding: 1px 4px;">Ratio</th>
                </tr></thead>
                <tbody>${yearRows}</tbody>
              </table>
              <div style="color: #1e5c75; margin-top: 4px; font-size: 0.9em; font-weight: bold;">
                Average of ${ratioCount} yearly ratios = ${ratio.toFixed(2)}%
              </div>
            </div>
            <div style="border-top: 1px solid #e0e0e0; padding-top: 6px;">
              <div style="font-weight: bold; margin-bottom: 4px; color: #666; font-size: 0.85em;">Averages per Year:</div>
              <div style="font-size: 0.85em;">
                <strong>Disallowances:</strong> ${formattedAvgDisallow}<br/>
                <strong>${denominatorLabel}:</strong> ${formattedAvgDenom}
              </div>
            </div>
            <div style="border-top: 1px solid #e0e0e0; padding-top: 6px;">
              <div style="font-weight: bold; margin-bottom: 4px; color: #666; font-size: 0.85em;">Total Sum (2016-2022):</div>
              <div style="font-size: 0.85em;">
                <strong>Disallowances:</strong> ${formattedTotal}<br/>
                <strong>${denominatorLabel}:</strong> ${formattedDenominator}
              </div>
            </div>
          `;
        } else if (state.currentYear === 'sum') {
          // For sum view, just show totals with calculation
          detailsHTML = `
            <div><strong>Total Disallowances (2016-2022):</strong><br/>${formattedTotal}</div>
            <div><strong>${denominatorLabel} (2016-2022):</strong><br/>${formattedDenominator}</div>
            ${denominator > 0 ?
              `<div style="font-size: 0.9em; color: #666; margin-top: 5px;">
                Ratio: ${totalDisallowances.toLocaleString()} ÷ ${denominator.toLocaleString()} = ${ratio.toFixed(2)}%
              </div>` : ''}
          `;
        } else {
          // For specific years
          detailsHTML = `
            <div><strong>Disallowances (${state.currentYear}):</strong><br/>${formattedTotal}</div>
            <div><strong>${denominatorLabel} (${state.currentYear}):</strong><br/>${formattedDenominator}</div>
            ${denominator > 0 ?
              `<div style="font-size: 0.9em; color: #666; margin-top: 5px;">
                Ratio: ${totalDisallowances.toLocaleString()} ÷ ${denominator.toLocaleString()} = ${ratio.toFixed(2)}%
              </div>` : ''}
          `;
        }

        this._div.innerHTML = `
          <h4>${name}${isLGU ? ` <span style="font-size: 0.8em; color: #666;">(${displayScoreData.province})</span>` : ''}</h4>
          <div class="info-score ${level}">
            <span class="score-value">${ratio.toFixed(2)}</span>
            <span class="score-label">%</span>
          </div>
          <div class="info-risk ${level}">DISALLOWANCE RATIO</div>
          <div class="info-details">
            ${detailsHTML}
            ${(state.currentYear === 'average' || state.currentYear === 'sum') ?
              `<div style="margin-top: 6px; padding-top: 6px; border-top: 1px solid #e0e0e0; font-size: 0.8em; color: #666;">
                ${!isLGU && displayScoreData.lguCount ? `<span><strong>LGUs:</strong> ${displayScoreData.lguCount}</span>` : ''}
                ${displayScoreData.observationCount ? ` | <span><strong>Obs:</strong> ${displayScoreData.observationCount.toLocaleString()}</span>` : ''}
                ${displayScoreData.yearsWithData ? ` | <span><strong>Years:</strong> ${displayScoreData.yearsWithData}</span>` : ''}
              </div>` :
              `${!isLGU && avgPerLGU ? `<div><strong>Avg per LGU:</strong><br/>${formattedAvg}</div>` : ''}
               ${displayScoreData.observationCount ? `<div><strong>Observations:</strong> ${displayScoreData.observationCount.toLocaleString()}</div>` : ''}
               ${!isLGU && displayScoreData.lguCount ? `<div><strong>Municipalities:</strong> ${displayScoreData.lguCount}</div>` : ''}
               ${displayScoreData.yearsWithData ? `<div><strong>Years:</strong> ${displayScoreData.yearsWithData} years</div>` : ''}`
            }
          </div>
        `;
      }
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

    const isDisallowances = state.currentDataset === 'disallowances';

    if (isDisallowances) {
      div.innerHTML = `
        <h4>Disallowance Ratio<br><small>(% of Operating Expenditures)</small></h4>
        <div style="height: 14px; border-radius: 2px; border: 1px solid rgba(0,0,0,0.15); background: linear-gradient(to right, hsl(0,50%,92%), hsl(0,60%,78%) 20%, hsl(0,70%,62%) 40%, hsl(0,80%,47%) 60%, hsl(0,88%,33%) 80%, hsl(0,95%,15%)); margin-bottom: 3px;"></div>
        <div style="display: flex; justify-content: space-between; font-size: 9px; color: #555;">
          <span>0.01%</span><span>0.1%</span><span>1%</span><span>5%</span><span>25%+</span>
        </div>
        <div class="legend-item" style="margin-top: 4px;">
          <span class="legend-color" style="background:#d3d3d3"></span>
          <span class="legend-label">No Data</span>
        </div>
      `;
    } else {
      const grades = [0, 20, 40, 60, 80];
      const labels = ['Very High', 'High', 'Moderate', 'Low', 'Very Low'];
      div.innerHTML = `<h4>Compliance Level</h4>`;
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
    }

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
  console.log('🏛️ renderProvinces() called');

  if (!state.provinceGeoJson) {
    console.log('📂 Loading province GeoJSON...');
    state.provinceGeoJson = await loadGeoJson('provinces');
  }

  if (!state.provinceGeoJson) {
    console.error('❌ Failed to load province GeoJSON');
    return;
  }

  console.log(`✅ Province GeoJSON loaded: ${state.provinceGeoJson.features.length} features`);

  console.log(`📊 Loading scores for year: ${state.currentYear}`);
  const scores = await loadProvinceScores(state.currentYear);
  console.log(`✅ Loaded scores for ${Object.keys(scores).length} provinces`);

  // Remove existing layer
  if (state.provinceLayer) {
    state.map.removeLayer(state.provinceLayer);
  }

  // Log some matching info for debugging
  let matchedCount = 0;
  let unmatchedSample = [];

  state.provinceLayer = L.geoJSON(state.provinceGeoJson, {
    style: (feature) => getProvinceStyle(feature, scores),
    onEachFeature: (feature, layer) => {
      const psgc = getPsgc(feature);
      layer.scoreData = scores[psgc] || null;

      if (scores[psgc]) {
        matchedCount++;
      } else if (unmatchedSample.length < 5) {
        unmatchedSample.push(`${feature.properties.name} (${psgc})`);
      }

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

  console.log(`🎨 Province layer added to map:`);
  console.log(`  Matched: ${matchedCount}/${state.provinceGeoJson.features.length} provinces`);
  console.log(`  Data keys available: ${Object.keys(scores).length}`);
  if (unmatchedSample.length > 0) {
    console.log(`  Unmatched samples:`, unmatchedSample);
    console.log(`  Sample data keys:`, Object.keys(scores).slice(0, 5));
  }

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

  // Debug: Check for HUC features in loaded GeoJSON
  const hucPsgcs = new Set(['3540100000', '1411020000', '1602020000', '1043050000', '7221700000', '1263030000',
    '1035040000', '6302200000', '7222600000', '4562400000', '7223000000', '3710700000',
    '1042100000', '1753160000', '8374700000', '9733200000']);
  const hucFound = state.lguGeoJson.features.filter(f => hucPsgcs.has(String(f.properties.psgc)));
  console.log(`HUC features in GeoJSON: ${hucFound.length}/16`);
  hucFound.forEach(f => console.log(`  HUC: ${f.properties.name} (${f.properties.psgc}) - ${f.geometry.type}`));

  state.lguLayer = L.geoJSON(state.lguGeoJson, {
    style: (feature) => {
      const style = getLguStyle(feature, scores, provinceMap);
      // Count if it got a non-grey color
      if (style.fillColor !== '#d3d3d3' && style.fillColor !== '#e0e0e0') {
        coloredCount++;
      }
      // Debug HUC styling
      if (hucPsgcs.has(String(feature.properties.psgc))) {
        console.log(`HUC style for ${feature.properties.name}: fillColor=${style.fillColor}, fillOpacity=${style.fillOpacity}`);
      }
      return style;
    },
    onEachFeature: (feature, layer) => {
      // Our data now uses PSGC codes directly as keys
      const props = feature.properties;
      const lguPsgc = getPsgc(feature);  // Get the LGU's PSGC code
      const lguName = props.name || props.NAME || props.adm2_en || '';

      // Try to match directly with PSGC
      let data = scores[lguPsgc];

      if (data) {
        matchedCount++;
      } else {
        // Try fallback matching
        // Handle both numeric and string PSGCs
        const provPsgc = String(props.province_psgc || props.adm1_psgc || 0).padStart(10, '0');

        // Get province name from mapping
        const provinceName = provinceMap[String(props.province_psgc || '')] || '';

        // Try different key formats - handle various naming conventions
        let cleanName = lguName;

        // Check if it's a city and format appropriately
        let isCity = false;
        if (cleanName.startsWith('City of ')) {
          cleanName = cleanName.substring(8);  // Remove "City of "
          isCity = true;
        }

        // Create variations
        const nameNoSpaces = cleanName.replace(/\s+/g, '').replace(/-/g, '');

        const possibleKeys = [
          // Try with province_name format
          `${provPsgc}_${cleanName}`,
          `${provPsgc}_${nameNoSpaces}`,
          provinceName ? `${provinceName}_${cleanName}` : null,
          provinceName ? `${provinceName}_${nameNoSpaces}` : null
        ].filter(k => k !== null);

        for (const key of possibleKeys) {
          if (scores[key]) {
            data = scores[key];
            matchedCount++;
            break;
          }
        }

        if (!data && unmatchedSamples.length < 5) {
          unmatchedSamples.push({ name: lguName, psgc: lguPsgc, tried: lguPsgc });
        }
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

    // Additional debugging
    console.log(`Total score entries: ${Object.keys(scores).length}`);
    console.log(`Total GeoJSON features: ${state.lguGeoJson.features.length}`);
    console.log(`Match rate: ${(matchedCount / state.lguGeoJson.features.length * 100).toFixed(1)}%`);

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
      // Use the existing updateYear function which handles the update properly
      await updateYear(value);
    });
  }

  // Ratio type dropdown
  const ratioTypeSelect = document.getElementById('ratio-type');
  if (ratioTypeSelect) {
    ratioTypeSelect.addEventListener('change', async (e) => {
      const value = e.target.value;
      state.currentRatioType = value;

      // Re-render the current view to update colors and values
      if (state.currentView === 'provinces') {
        await renderProvinces();
      } else {
        await renderLgus();
      }

      // Update info panel if something is selected
      if (state.selectedLayer) {
        const props = state.selectedLayer.feature.properties;
        const name = props.name || props.NAME || props.adm1_en || props.adm2_en || 'Unknown';
        const psgc = getPsgc(state.selectedLayer.feature);
        const scores = state.currentView === 'provinces' ? state.provinceScores : state.lguScores;
        const score = scores[psgc] || null;
        state.info.update(name, score);
      }
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
  console.log('🗺️ initMap() called - Starting map initialization');
  console.log('Current state:', {
    dataset: state.currentDataset,
    year: state.currentYear,
    view: state.currentView,
    ratioType: state.currentRatioType
  });

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
