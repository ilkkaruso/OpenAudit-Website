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
  currentRatioType: 'nd_expenditures',  // metric type: nd_expenditures, nd_per_capita, nc_local_sources, nc_per_capita, ns_expenditures, ns_per_capita
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
  coaLinks: null,       // COA Annual Audit Report links by province

  // Info control
  info: null,

  // Selected feature
  selectedLayer: null
};

// Philippines bounds
const PH_BOUNDS = [[4.5, 116.5], [21.5, 127]];
const PH_CENTER = [12.5, 122];

// In the Sum/Average (aggregate) views, an LGU/province needs at least this many
// years (out of 7) with an AAR-derived figure before we'll show a computed ratio
// or per-capita value for it. Below this, more than 3 of the 7 years have no
// audit report at all — per auditor guidance, that coverage gap is itself the
// signal worth surfacing, so it's flagged "No AAR (>3x)" (black) rather than
// shown as a thin, potentially misleading average of 1-3 years. Does not apply
// to a single specific year, which is inherently a yes/no "was there an AAR".
const MIN_YEARS_WITH_AAR_FOR_AGGREGATE = 4;

// ============================================
// UTILITY FUNCTIONS
// ============================================

// Helper: is current metric a per-capita type?
function isPerCapitaMetric() {
  return state.currentRatioType === 'nd_per_capita' || state.currentRatioType === 'nc_per_capita' ||
         state.currentRatioType === 'ns_per_capita';
}

// Helper: is current metric an NC (Notice of Charge) type?
function isNCMetric() {
  return state.currentRatioType === 'nc_local_sources' || state.currentRatioType === 'nc_per_capita';
}

// Helper: is current metric an NS (Notice of Suspension) type?
function isNSMetric() {
  return state.currentRatioType === 'ns_expenditures' || state.currentRatioType === 'ns_per_capita';
}

// Helper function to get the correct ratio/value based on current metric type.
//
// Return value has THREE possible shapes, deliberately distinct:
//   - a number (including 0)  -> a real, AAR-derived figure. 0 means "a report
//     was found and it reported no ND/NC/NS" — a genuinely good signal.
//   - null                    -> "No AAR": no audit report (or no readable
//     SASDC figure) exists for this metric in this period. The worst signal —
//     rendered black, never confused with a confirmed 0.
//   - undefined                -> generic "no data" (the feature has no JSON
//     record at all, or we have the notice-type figure but not the financial
//     denominator needed to normalize it). Rendered the existing neutral gray.
//
// "No AAR" is determined by *membership* in data.years / years_nc / years_ns
// (populated by process_sre_disallowances.py — see that file's module
// docstring), never by whether the value is > 0.
function getRatioField(data, year = 'sum') {
  if (!data) return undefined;

  const rt = state.currentRatioType;

  // === PER CAPITA METRICS ===
  if (rt === 'nd_per_capita' || rt === 'nc_per_capita' || rt === 'ns_per_capita') {
    const yearsKey = rt === 'nd_per_capita' ? 'years' : rt === 'nc_per_capita' ? 'years_nc' : 'years_ns';
    const sumKey = rt === 'nd_per_capita' ? 'nd_per_capita' : rt === 'nc_per_capita' ? 'nc_per_capita' : 'ns_per_capita';
    const avgKey = rt === 'nd_per_capita' ? 'true_avg_nd_per_capita' : rt === 'nc_per_capita' ? 'true_avg_nc_per_capita' : 'true_avg_ns_per_capita';
    const byYearKey = rt === 'nd_per_capita' ? 'nd_per_capita_by_year' : rt === 'nc_per_capita' ? 'nc_per_capita_by_year' : 'ns_per_capita_by_year';
    const years = data[yearsKey] || {};

    if (year === 'average' || year === 'sum') {
      // "No AAR (>3x)": fewer than MIN_YEARS_WITH_AAR_FOR_AGGREGATE confirmed
      // years out of 7 — flag black even if 1-3 years do have a real figure.
      if (Object.keys(years).length < MIN_YEARS_WITH_AAR_FOR_AGGREGATE) return null;
      return data[year === 'average' ? avgKey : sumKey] || 0;
    }
    // Specific year
    if (!(year in years)) return null;  // No AAR this year
    const perCapByYear = data[byYearKey] || {};
    return year in perCapByYear ? perCapByYear[year] : undefined;  // AAR exists but no population that year (rare)
  }

  // === RATIO METRICS (percentage) ===
  // Determine numerator source and denominator source
  const isNC = rt === 'nc_local_sources';
  const isNS = rt === 'ns_expenditures';
  const numeratorYears = isNC ? (data.years_nc || {}) : isNS ? (data.years_ns || {}) : (data.years || {});
  const totalNumerator = isNC ? (data.totalCharges || 0) : isNS ? (data.totalSuspensions || 0) : (data.totalDisallowances || 0);

  // Denominator: NC always uses local sources; ND and NS use operating expenditures
  let denomKey, denomYearKey, trueAvgKey;
  if (isNC) {
    denomKey = 'total_local_sources';
    denomYearKey = 'local_sources_by_year';
    trueAvgKey = 'true_avg_nc_ratio_local';
  } else if (isNS) {
    denomKey = 'total_operating_expenditures';
    denomYearKey = 'operating_exp_by_year';
    trueAvgKey = 'true_avg_ns_ratio_exp';
  } else {
    // nd_expenditures (default)
    denomKey = 'total_operating_expenditures';
    denomYearKey = 'operating_exp_by_year';
    trueAvgKey = 'true_avg_ratio_exp';
  }

  if (year === 'sum' || year === 'average') {
    // "No AAR (>3x)": fewer than MIN_YEARS_WITH_AAR_FOR_AGGREGATE confirmed
    // years out of 7 — flag black even if 1-3 years do have a real figure.
    if (Object.keys(numeratorYears).length < MIN_YEARS_WITH_AAR_FOR_AGGREGATE) return null;
    if (year === 'average') {
      return data[trueAvgKey] || 0;
    }
    const totalDenom = data[denomKey] || 0;
    if (totalDenom > 0) {
      return (totalNumerator / totalDenom) * 100;
    }
    return undefined;  // has AAR data but no expenditure/local-sources figure to normalize by
  }

  // Specific year
  if (!(year in numeratorYears)) return null;  // No AAR this year
  const denomByYear = data[denomYearKey] || {};
  const denomVal = denomByYear[year] || 0;
  if (denomVal > 0) {
    return (numeratorYears[year] / denomVal) * 100;
  }
  return undefined;  // AAR figure exists but no denominator that year
}

function getRiskColor(score) {
  // For disallowances dataset, use ratio-based coloring
  if (state.currentDataset === 'disallowances') {
    // "No AAR" (score === null) is a stronger, worse signal than any ratio on
    // the scale below it — render it black, and keep it distinct from a
    // confirmed 0 (which flows into getDisallowanceColor/getPerCapitaColor
    // and comes out the palest shade) and from generic "no data" (gray).
    if (score === null) return '#000000';       // No AAR — no report found for this period
    if (score === undefined) return '#d3d3d3';   // No data (no record, or no denominator to normalize by)
    if (isPerCapitaMetric()) {
      return getPerCapitaColor(score);
    }
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
  // Discrete decile-based color grading (percentage-based metrics).
  // ratio is always a real number here — getRiskColor() intercepts null
  // ("No AAR") and undefined ("no data") before this function is called.
  // A confirmed 0 (or a negative over-settlement figure) falls through every
  // >= check below and lands on the final `return` — the palest shade, not
  // grey, because it's a real, good-news report rather than an absence.
  if (ratio >= 20) return '#2b0000';  // 20%+ darkest
  if (ratio >= 18) return '#3b0000';
  if (ratio >= 16) return '#4a0000';
  if (ratio >= 14) return '#5a0000';
  if (ratio >= 12) return '#6b0000';
  if (ratio >= 10) return '#7f0000';
  if (ratio >= 8)  return '#960b0b';
  if (ratio >= 6)  return '#a81515';
  if (ratio >= 5)  return '#b71c1c';
  if (ratio >= 4)  return '#c62828';
  if (ratio >= 3)  return '#d32f2f';
  if (ratio >= 2)  return '#e53935';
  if (ratio >= 1.5) return '#ef5350';
  if (ratio >= 1)  return '#f57a7a';
  if (ratio >= 0.8) return '#f9a0a0';
  if (ratio >= 0.6) return '#fbb4b4';
  if (ratio >= 0.4) return '#fcc8c8';
  if (ratio >= 0.2) return '#fddcdc';
  if (ratio >= 0.1) return '#feecec';
  return '#fff5f5';  // < 0.1% - palest
}

function getPerCapitaColor(value) {
  // Per capita color scale (in pesos per person). Range: 0 to 10,000+.
  // value is always a real number here — see getDisallowanceColor()'s note above;
  // the same null/undefined interception happens upstream in getRiskColor().
  if (value >= 10000) return '#2b0000';
  if (value >= 5000)  return '#3b0000';
  if (value >= 2000)  return '#4a0000';
  if (value >= 1000)  return '#5a0000';
  if (value >= 500)   return '#6b0000';
  if (value >= 200)   return '#7f0000';
  if (value >= 100)   return '#960b0b';
  if (value >= 50)    return '#a81515';
  if (value >= 20)    return '#b71c1c';
  if (value >= 10)    return '#c62828';
  if (value >= 5)     return '#d32f2f';
  if (value >= 2)     return '#e53935';
  if (value >= 1)     return '#ef5350';
  if (value >= 0.5)   return '#f57a7a';
  if (value >= 0.2)   return '#f9a0a0';
  if (value >= 0.1)   return '#fbb4b4';
  if (value >= 0.05)  return '#fcc8c8';
  if (value >= 0.01)  return '#fddcdc';
  if (value >= 0.001) return '#feecec';
  return '#fff5f5';
}

function getRiskLevel(score) {
  // For disallowance ratios (percentages)
  if (state.currentDataset === 'disallowances') {
    if (score === null) return 'no_aar';  // No audit report found for this period — worse than any ratio
    if (score === undefined) return 'no_data';
    if (score >= 5) return 'critical';    // ≥ 5%
    if (score >= 2) return 'high';        // 2-5%
    if (score >= 1) return 'moderate';    // 1-2%
    if (score >= 0.5) return 'low';       // 0.5-1%
    if (score >= 0.1) return 'minimal';   // 0.1-0.5%
    return 'minimal';                      // < 0.1%
  }
  // For audit scores (0-100)
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

async function loadCoaLinks() {
  if (state.coaLinks) {
    return state.coaLinks;
  }

  try {
    const response = await fetch('data/coa_links.json');
    const raw = await response.json();

    // Build a normalized lookup: lowercase province name -> links data
    // This handles capitalization differences (e.g. "Del" vs "del")
    const lookup = {};

    // Q-code entries have municipality_report data that proper entries lack.
    // Map Q-codes to their province names (derived from URL slugs).
    const qcodeMap = {
      'Q13714': 'agusan del norte',
      'Q13721': 'agusan del sur',
      'Q13726': 'albay',
      'Q13740': 'batanes',
      'Q13744': 'batangas',
      'Q13763': 'camarines norte',
      'Q13769': 'camiguin',
      'Q13844': 'leyte',
      'Q13860': 'misamis oriental',
    };

    // First pass: add all proper (non-Q-code) entries
    for (const [name, data] of Object.entries(raw)) {
      if (name.startsWith('Q')) continue;
      const key = name.toLowerCase().trim();
      lookup[key] = JSON.parse(JSON.stringify(data));  // deep copy
    }

    // Second pass: merge Q-code municipality_report data into proper entries
    for (const [qcode, provName] of Object.entries(qcodeMap)) {
      const qData = raw[qcode];
      if (!qData) continue;
      const qMuni = qData.municipality_report || {};
      if (Object.keys(qMuni).length === 0) continue;

      if (!lookup[provName]) {
        // No proper entry exists, create one from Q-code data
        lookup[provName] = { province_report: {}, municipality_report: qMuni };
      } else if (Object.keys(lookup[provName].municipality_report || {}).length === 0) {
        // Proper entry exists but has empty municipality_report - fill it
        lookup[provName].municipality_report = qMuni;
      }
    }

    // Name aliases: map disallowances data names to COA link names
    const nameAliases = {
      'cotabato': ['north cotabato'],
      'maguindanao del norte': ['maguindanao'],
      'maguindanao del sur': ['maguindanao'],
    };

    for (const [coaName, aliases] of Object.entries(nameAliases)) {
      if (lookup[coaName]) {
        for (const alias of aliases) {
          if (!lookup[alias]) {
            lookup[alias] = lookup[coaName];
          }
        }
      }
    }

    console.log(`Loaded COA links for ${Object.keys(lookup).length} provinces`);
    state.coaLinks = lookup;
    return lookup;
  } catch (err) {
    console.error('Failed to load COA links:', err);
    return {};
  }
}

/**
 * Find COA report links for a given province name.
 * Returns { province_report: {year: url}, municipality_report: {year: url} } or null.
 */
function getCoaLinksForProvince(provinceName) {
  if (!state.coaLinks || !provinceName) return null;
  const key = provinceName.toLowerCase().trim();
  return state.coaLinks[key] || null;
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

    // Build COA report links HTML for the current feature
    function buildCoaLinksHTML(provinceName, isLGUView) {
      const links = getCoaLinksForProvince(provinceName);
      if (!links) return '';

      const relevantYears = ['2016', '2017', '2018', '2019', '2020', '2021', '2022'];

      function makeYearLinks(reports, label) {
        const available = relevantYears.filter(y => reports[y]);
        if (available.length === 0) return '';
        const yearLinks = available.map(y =>
          `<a href="${reports[y]}" target="_blank" rel="noopener" style="color: #2980b9; text-decoration: none; padding: 1px 3px; border: 1px solid #bdc3c7; border-radius: 3px; font-size: 0.75em; transition: all 0.2s;"
              onmouseover="this.style.background='#2980b9';this.style.color='white'"
              onmouseout="this.style.background='';this.style.color='#2980b9'">${y}</a>`
        ).join(' ');
        return `
          <div style="font-size: 0.72em; color: #666; margin-bottom: 2px;"><strong>${label}:</strong></div>
          <div style="display: flex; flex-wrap: wrap; gap: 3px; margin-bottom: 4px;">${yearLinks}</div>
        `;
      }

      const provReports = links.province_report || {};
      const muniReports = links.municipality_report || {};

      let sections = '';
      if (isLGUView) {
        // For LGU view: show municipality report links (links to all munis in the province)
        sections = makeYearLinks(muniReports, 'Municipality Audit Reports');
        // Also show province report as secondary
        if (sections) {
          sections += makeYearLinks(provReports, 'Province Audit Report');
        } else {
          sections = makeYearLinks(provReports, 'Province Audit Report');
        }
      } else {
        // For province view: show province report first, then municipality
        sections = makeYearLinks(provReports, 'Province Audit Report');
        sections += makeYearLinks(muniReports, 'Municipality Audit Reports');
      }

      if (!sections) return '';

      return `
        <div style="margin-top: 6px; padding-top: 6px; border-top: 1px solid #e0e0e0;">
          <div style="font-size: 0.75em; color: #555; margin-bottom: 3px; font-weight: bold;">
            COA Annual Reports (${provinceName}):
          </div>
          ${sections}
        </div>
      `;
    }

    if (isDisallowances && displayScoreData) {
      // Determine current metric context
      const rt = state.currentRatioType;
      const perCapita = isPerCapitaMetric();
      const ncMetric = isNCMetric();
      const nsMetric = isNSMetric();

      // Labels for current metric
      const numeratorLabel = ncMetric ? 'Charges (NC)' : nsMetric ? 'Suspensions (NS)' : 'Disallowances (ND)';
      const numeratorLabelShort = ncMetric ? 'NC' : nsMetric ? 'NS' : 'ND';
      let denominatorLabel = '';
      let metricLabel = '';

      if (perCapita) {
        denominatorLabel = 'Population';
        metricLabel = `${numeratorLabelShort} PER CAPITA`;
      } else if (rt === 'nc_local_sources') {
        denominatorLabel = 'Total Local Sources';
        metricLabel = 'NC / LOCAL SOURCES';
      } else {
        // nd_expenditures or ns_expenditures
        denominatorLabel = 'Total Operating Expenditures';
        metricLabel = `${numeratorLabelShort} / OPERATING EXPENDITURES`;
      }

      // Get the metric value using getRatioField
      const metricValue = getRatioField(displayScoreData, state.currentYear);

      // Get numerator/denominator amounts for display
      const numeratorYears = ncMetric ? (displayScoreData.years_nc || {}) : nsMetric ? (displayScoreData.years_ns || {}) : (displayScoreData.years || {});
      const totalNumerator = ncMetric ? (displayScoreData.totalCharges || 0) : nsMetric ? (displayScoreData.totalSuspensions || 0) : (displayScoreData.totalDisallowances || 0);

      let totalDenominator = 0;
      let denomByYear = {};
      if (perCapita) {
        totalDenominator = displayScoreData.population || 0;
        denomByYear = displayScoreData.population_by_year || {};
      } else if (rt === 'nc_local_sources') {
        totalDenominator = displayScoreData.total_local_sources || 0;
        denomByYear = displayScoreData.local_sources_by_year || {};
      } else {
        totalDenominator = displayScoreData.total_operating_expenditures || 0;
        denomByYear = displayScoreData.operating_exp_by_year || {};
      }

      // For specific year, get year amounts
      let yearNumerator = 0, yearDenominator = 0;
      if (state.currentYear !== 'sum' && state.currentYear !== 'average') {
        yearNumerator = numeratorYears[state.currentYear] || 0;
        yearDenominator = denomByYear[state.currentYear] || 0;
      }

      // metricValue is the single source of truth for which of the three states
      // we're in — see getRatioField()'s doc comment: null = No AAR, undefined =
      // generic no-data, a number (incl. 0) = a real AAR-derived figure.
      const isNoAAR = metricValue === null;
      const isNoData = metricValue === undefined;

      // Check if this is an LGU/Municipality
      const isLGU = displayScoreData?.province &&
                    displayScoreData.province !== 'None' &&
                    displayScoreData.name !== displayScoreData.province;

      const level = isNoAAR ? 'no_aar' : (displayScoreData?.riskLevel || getRiskLevel(metricValue));
      const periodLabel = (state.currentYear !== 'average' && state.currentYear !== 'sum') ? state.currentYear : 'this period';

      // Determine province name for COA links
      const coaProvinceName = isLGU ? (displayScoreData.province || '') : (displayScoreData.name || name);
      const coaLinksHTML = buildCoaLinksHTML(coaProvinceName, isLGU);

      if (isNoAAR) {
        // No Annual Audit Report — the worst signal, deliberately distinct from a
        // confirmed ₱0 (renders below, palest shade). In Sum/Average view this also
        // covers "insufficient coverage" (1-3 of 7 years have a figure, but more
        // than 3 don't) — see MIN_YEARS_WITH_AAR_FOR_AGGREGATE in getRatioField().
        const isAggregateView = (state.currentYear === 'sum' || state.currentYear === 'average');
        const yearsWithAAR = Object.keys(numeratorYears).length;
        const badgeLabel = isAggregateView ? 'No AAR (&gt;3x)' : 'No AAR';
        const nameHeader = `<h4>${name}${isLGU ? ` <span style="font-size: 0.8em; color: #666;">(${displayScoreData.province})</span>` : ''}</h4>`;

        if (yearsWithAAR > 0) {
          // Insufficient coverage: some years DO have a figure, but not enough of
          // them to trust an average — show which years, rather than hiding them.
          const allYears = [...new Set([...Object.keys(numeratorYears), ...Object.keys(denomByYear)])].sort();
          const fmtPesoShort = (v) => `₱${Math.round(v).toLocaleString('en-PH')}`;
          let coverageRows = '';
          for (const yr of allYears) {
            coverageRows += (yr in numeratorYears)
              ? `<tr><td style="padding: 1px 4px;">${yr}</td><td style="padding: 1px 4px; text-align: right;">${fmtPesoShort(numeratorYears[yr])}</td></tr>`
              : `<tr><td style="padding: 1px 4px;">${yr}</td><td style="padding: 1px 4px; text-align: right; font-weight: bold;">No AAR</td></tr>`;
          }
          this._div.innerHTML = `
            ${nameHeader}
            <div class="info-risk no_aar">${badgeLabel}</div>
            <div style="padding: 12px 10px; text-align: center; color: #fff; background: #000; border-radius: 6px; margin-bottom: 8px;">
              <div style="font-size: 1.05em; margin-bottom: 6px;">Insufficient Audit Coverage</div>
              <div style="font-size: 0.82em; opacity: 0.85;">Only ${yearsWithAAR} of 7 years (2016-2022) have a confirmed ${numeratorLabel} figure —
                more than 3 years are missing a report, so this is flagged rather than averaged.</div>
            </div>
            <div class="info-details">
              <table style="width: 100%; font-size: 0.82em; border-collapse: collapse;">
                <thead><tr style="border-bottom: 1px solid #e0e0e0;">
                  <th style="text-align: left; padding: 1px 4px;">Year</th>
                  <th style="text-align: right; padding: 1px 4px;">${numeratorLabelShort}</th>
                </tr></thead>
                <tbody>${coverageRows}</tbody>
              </table>
              ${coaLinksHTML}
            </div>
          `;
        } else {
          // True "never" — no figure determined for this metric in any relevant year.
          const messageDetail = isAggregateView
            ? `No ${numeratorLabel} figure was ever determined for any of the 7 years (2016-2022).`
            : `No ${numeratorLabel} figure could be determined for ${periodLabel}.`;
          this._div.innerHTML = `
            ${nameHeader}
            <div class="info-risk no_aar">${badgeLabel}</div>
            <div style="padding: 16px 10px; text-align: center; color: #fff; background: #000; border-radius: 6px;">
              <div style="font-size: 1.1em; margin-bottom: 6px;">No Audit Report Found</div>
              <div style="font-size: 0.85em; opacity: 0.85;">${messageDetail}
                This is different from a confirmed ₱0 — treat a missing report as the worse signal.</div>
            </div>
            ${coaLinksHTML}
          `;
        }
      } else if (isNoData) {
        // Generic no-data: a real record exists but we can't compute this specific
        // view (e.g. missing expenditure/local-sources figure to normalize by).
        this._div.innerHTML = `
          <h4>${name}${isLGU ? ` <span style="font-size: 0.8em; color: #666;">(${displayScoreData.province})</span>` : ''}</h4>
          <div style="padding: 20px 0; text-align: center; color: #999;">
            <div style="font-size: 1.2em; margin-bottom: 10px;">No Data Available</div>
            <div style="font-size: 0.9em;">No ${numeratorLabel.toLowerCase()} data for ${periodLabel}</div>
          </div>
          ${coaLinksHTML}
        `;
      } else {
        // Format the main metric value
        let formattedMetric;
        let metricUnit;
        if (perCapita) {
          formattedMetric = metricValue >= 1 ? metricValue.toFixed(2) : metricValue.toFixed(4);
          metricUnit = 'PHP/person';
        } else {
          formattedMetric = metricValue.toFixed(2);
          metricUnit = '%';
        }

        // Format currency amounts
        const fmtPeso = (v) => `₱${v.toLocaleString('en-PH', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
        const fmtNum = (v) => v.toLocaleString('en-PH');

        // Population display
        const popDisplay = displayScoreData.population ? fmtNum(Math.round(displayScoreData.population)) : '—';

        // Build info details based on view type
        let detailsHTML = '';

        if (state.currentYear === 'average') {
          // Build per-year breakdown table
          const perCapByYear = (rt === 'nd_per_capita') ? (displayScoreData.nd_per_capita_by_year || {}) :
                               (rt === 'nc_per_capita') ? (displayScoreData.nc_per_capita_by_year || {}) :
                               (rt === 'ns_per_capita') ? (displayScoreData.ns_per_capita_by_year || {}) : null;

          const allYears = [...new Set([...Object.keys(numeratorYears), ...Object.keys(denomByYear)])].sort();

          let yearRows = '';
          let valueCount = 0;
          for (const yr of allYears) {
            // A year absent from numeratorYears means no AAR/SASDC figure was ever
            // determined for it — show "No AAR" instead of fabricating a 0/dash,
            // and don't count it toward the average (matches the Python true-average,
            // which excludes these years from its mean rather than treating them as 0).
            if (!(yr in numeratorYears)) {
              yearRows += `<tr>
                <td style="padding: 1px 4px;">${yr}</td>
                <td style="padding: 1px 4px; text-align: right; font-weight: bold; color: #fff; background: #000;">No AAR</td>
              </tr>`;
              continue;
            }
            const n = numeratorYears[yr] || 0;
            const d = denomByYear[yr] || 0;
            let yrValue;
            if (perCapita && perCapByYear) {
              yrValue = (yr in perCapByYear) ? perCapByYear[yr] : null;
              if (yrValue !== null) valueCount++;
              yearRows += `<tr>
                <td style="padding: 1px 4px;">${yr}</td>
                <td style="padding: 1px 4px; text-align: right;">${yrValue !== null ? (yrValue >= 1 ? yrValue.toFixed(2) : yrValue.toFixed(4)) : '—'}</td>
              </tr>`;
            } else {
              yrValue = d > 0 ? (n / d * 100) : null;
              if (yrValue !== null) valueCount++;
              yearRows += `<tr>
                <td style="padding: 1px 4px;">${yr}</td>
                <td style="padding: 1px 4px; text-align: right;">${yrValue !== null ? yrValue.toFixed(2) + '%' : '—'}</td>
              </tr>`;
            }
          }

          detailsHTML = `
            <div style="background: #e8f4f8; padding: 6px 8px; margin-bottom: 6px; border-radius: 4px;">
              <div style="font-weight: bold; margin-bottom: 4px; color: #1e5c75; font-size: 0.85em;">Mean of Per-Year Values:</div>
              <table style="width: 100%; font-size: 0.82em; border-collapse: collapse;">
                <thead><tr style="border-bottom: 1px solid #ccc;">
                  <th style="text-align: left; padding: 1px 4px;">Year</th>
                  <th style="text-align: right; padding: 1px 4px;">${perCapita ? 'Per Capita' : 'Ratio'}</th>
                </tr></thead>
                <tbody>${yearRows}</tbody>
              </table>
              <div style="color: #1e5c75; margin-top: 4px; font-size: 0.9em; font-weight: bold;">
                Average of ${valueCount} years = ${formattedMetric}${metricUnit === '%' ? '%' : ' ' + metricUnit}
              </div>
            </div>
            <div style="border-top: 1px solid #e0e0e0; padding-top: 6px;">
              <div style="font-weight: bold; margin-bottom: 4px; color: #666; font-size: 0.85em;">Totals (2016-2022):</div>
              <div style="font-size: 0.85em;">
                <strong>${numeratorLabel}:</strong> ${fmtPeso(totalNumerator)}<br/>
                ${perCapita
                  ? `<strong>Population:</strong> ${popDisplay}`
                  : `<strong>${denominatorLabel}:</strong> ${totalDenominator > 0 ? fmtPeso(totalDenominator) : '—'}`
                }
              </div>
            </div>
          `;
        } else if (state.currentYear === 'sum') {
          detailsHTML = `
            <div><strong>Total ${numeratorLabel} (2016-2022):</strong><br/>${fmtPeso(totalNumerator)}</div>
            ${perCapita
              ? `<div><strong>Population:</strong> ${popDisplay}</div>`
              : `<div><strong>${denominatorLabel} (2016-2022):</strong><br/>${totalDenominator > 0 ? fmtPeso(totalDenominator) : '—'}</div>`
            }
            ${perCapita
              ? `<div style="font-size: 0.9em; color: #666; margin-top: 5px;">
                  ${fmtPeso(totalNumerator)} ÷ ${popDisplay} = ${formattedMetric} ${metricUnit}
                </div>`
              : (totalDenominator > 0 ? `<div style="font-size: 0.9em; color: #666; margin-top: 5px;">
                  ${fmtNum(totalNumerator)} ÷ ${fmtNum(totalDenominator)} = ${formattedMetric}%
                </div>` : '')
            }
          `;
        } else {
          // Specific year
          const dispNumerator = yearNumerator;
          const dispDenominator = yearDenominator;
          detailsHTML = `
            <div><strong>${numeratorLabel} (${state.currentYear}):</strong><br/>${fmtPeso(dispNumerator)}</div>
            ${perCapita
              ? `<div><strong>Population (${state.currentYear}):</strong> ${dispDenominator > 0 ? fmtNum(Math.round(dispDenominator)) : '—'}</div>`
              : `<div><strong>${denominatorLabel} (${state.currentYear}):</strong><br/>${dispDenominator > 0 ? fmtPeso(dispDenominator) : '—'}</div>`
            }
            ${dispDenominator > 0 ? `<div style="font-size: 0.9em; color: #666; margin-top: 5px;">
              ${perCapita
                ? `${fmtPeso(dispNumerator)} ÷ ${fmtNum(Math.round(dispDenominator))} = ${formattedMetric} ${metricUnit}`
                : `${fmtNum(dispNumerator)} ÷ ${fmtNum(dispDenominator)} = ${formattedMetric}%`
              }
            </div>` : ''}
          `;
        }

        this._div.innerHTML = `
          <h4>${name}${isLGU ? ` <span style="font-size: 0.8em; color: #666;">(${displayScoreData.province})</span>` : ''}</h4>
          <div class="info-score ${level}">
            <span class="score-value">${formattedMetric}</span>
            <span class="score-label">${metricUnit === '%' ? '%' : ''}</span>
          </div>
          <div class="info-risk ${level}">${metricLabel}${perCapita ? ` <span style="font-size: 0.75em;">(PHP/person)</span>` : ''}</div>
          <div class="info-details">
            ${detailsHTML}
            <div style="margin-top: 6px; padding-top: 6px; border-top: 1px solid #e0e0e0; font-size: 0.8em; color: #666;">
              ${!isLGU && displayScoreData.lguCount ? `<span><strong>LGUs:</strong> ${displayScoreData.lguCount}</span>` : ''}
              ${displayScoreData.observationCount ? ` | <span><strong>Obs:</strong> ${displayScoreData.observationCount.toLocaleString()}</span>` : ''}
              ${(() => {
                // "Years" should reflect years-with-an-AAR-figure for the metric
                // actually being viewed (ND/NC/NS), not always ND's count.
                const yearsForMetric = ncMetric ? displayScoreData.ncYearsWithData : nsMetric ? displayScoreData.nsYearsWithData : displayScoreData.yearsWithData;
                return yearsForMetric ? ` | <span><strong>Years:</strong> ${yearsForMetric}/7</span>` : '';
              })()}
              ${displayScoreData.population ? ` | <span><strong>Pop:</strong> ${fmtNum(Math.round(displayScoreData.population))}</span>` : ''}
            </div>
            ${coaLinksHTML}
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

  // The "No AAR" legend label depends on whether we're in Sum/Average (where the
  // >3-missing-years threshold applies) or a specific year (plain yes/no) — see
  // updateLegend(). Must re-run on every year change, not just metric change.
  updateLegend();

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
// LEGEND UPDATE
// ============================================

function updateLegend() {
  const legendEl = document.getElementById('integrated-legend');
  if (!legendEl) return;

  const perCapita = isPerCapitaMetric();
  const ncMetric = isNCMetric();
  const nsMetric = isNSMetric();
  const shortLabel = ncMetric ? 'NC' : nsMetric ? 'NS' : 'ND';

  // No AAR is a worse signal than any ratio/per-capita figure on the scale below
  // it, so its swatch sits above the darkest red. In Sum/Average view it also
  // covers "insufficient coverage" (see MIN_YEARS_WITH_AAR_FOR_AGGREGATE), so the
  // label there is qualified "(>3x)"; a specific single year is a plain yes/no.
  // The generic gray "No Data" swatch (dataset/geo mismatch) is intentionally not
  // listed here — it's rare enough that surfacing it in the legend added more
  // confusion than clarity once "No AAR" existed to explain the common case.
  const isAggregateView = (state.currentYear === 'sum' || state.currentYear === 'average');
  const noAarLabel = isAggregateView ? 'No AAR (&gt;3x)' : 'No AAR';
  const noAarRow = `<div style="display: flex; align-items: center; margin: 1px 0;"><span style="width: 16px; height: 10px; background: #000000; margin-right: 5px; border-radius: 1px; flex-shrink: 0;"></span>${noAarLabel}</div>`;

  if (perCapita) {
    legendEl.innerHTML = `
      <h4 style="font-size: 0.8rem; margin: 0 0 0.5rem 0; color: #666;">${shortLabel} Per Capita (PHP/person)</h4>
      <div style="font-size: 10px; color: #333; line-height: 1.1;">
        ${noAarRow}
        <div style="display: flex; align-items: center; margin: 1px 0;"><span style="width: 16px; height: 10px; background: #2b0000; margin-right: 5px; border-radius: 1px; flex-shrink: 0;"></span>10,000+</div>
        <div style="display: flex; align-items: center; margin: 1px 0;"><span style="width: 16px; height: 10px; background: #5a0000; margin-right: 5px; border-radius: 1px; flex-shrink: 0;"></span>1,000-10,000</div>
        <div style="display: flex; align-items: center; margin: 1px 0;"><span style="width: 16px; height: 10px; background: #7f0000; margin-right: 5px; border-radius: 1px; flex-shrink: 0;"></span>200-1,000</div>
        <div style="display: flex; align-items: center; margin: 1px 0;"><span style="width: 16px; height: 10px; background: #960b0b; margin-right: 5px; border-radius: 1px; flex-shrink: 0;"></span>100-200</div>
        <div style="display: flex; align-items: center; margin: 1px 0;"><span style="width: 16px; height: 10px; background: #b71c1c; margin-right: 5px; border-radius: 1px; flex-shrink: 0;"></span>20-100</div>
        <div style="display: flex; align-items: center; margin: 1px 0;"><span style="width: 16px; height: 10px; background: #d32f2f; margin-right: 5px; border-radius: 1px; flex-shrink: 0;"></span>5-20</div>
        <div style="display: flex; align-items: center; margin: 1px 0;"><span style="width: 16px; height: 10px; background: #ef5350; margin-right: 5px; border-radius: 1px; flex-shrink: 0;"></span>1-5</div>
        <div style="display: flex; align-items: center; margin: 1px 0;"><span style="width: 16px; height: 10px; background: #f9a0a0; margin-right: 5px; border-radius: 1px; flex-shrink: 0;"></span>0.1-1</div>
        <div style="display: flex; align-items: center; margin: 1px 0;"><span style="width: 16px; height: 10px; background: #feecec; margin-right: 5px; border-radius: 1px; flex-shrink: 0;"></span>&lt;0.1</div>
      </div>
    `;
  } else {
    const denomLabel = (state.currentRatioType === 'nc_local_sources') ? 'Local Sources' : 'Op. Expenditures';
    legendEl.innerHTML = `
      <h4 style="font-size: 0.8rem; margin: 0 0 0.5rem 0; color: #666;">${shortLabel} / ${denomLabel}</h4>
      <div style="font-size: 10px; color: #333; line-height: 1.1;">
        ${noAarRow}
        <div style="display: flex; align-items: center; margin: 1px 0;"><span style="width: 16px; height: 10px; background: #2b0000; margin-right: 5px; border-radius: 1px; flex-shrink: 0;"></span>20%+</div>
        <div style="display: flex; align-items: center; margin: 1px 0;"><span style="width: 16px; height: 10px; background: #5a0000; margin-right: 5px; border-radius: 1px; flex-shrink: 0;"></span>14-20%</div>
        <div style="display: flex; align-items: center; margin: 1px 0;"><span style="width: 16px; height: 10px; background: #7f0000; margin-right: 5px; border-radius: 1px; flex-shrink: 0;"></span>10-14%</div>
        <div style="display: flex; align-items: center; margin: 1px 0;"><span style="width: 16px; height: 10px; background: #960b0b; margin-right: 5px; border-radius: 1px; flex-shrink: 0;"></span>8-10%</div>
        <div style="display: flex; align-items: center; margin: 1px 0;"><span style="width: 16px; height: 10px; background: #a81515; margin-right: 5px; border-radius: 1px; flex-shrink: 0;"></span>6-8%</div>
        <div style="display: flex; align-items: center; margin: 1px 0;"><span style="width: 16px; height: 10px; background: #b71c1c; margin-right: 5px; border-radius: 1px; flex-shrink: 0;"></span>5-6%</div>
        <div style="display: flex; align-items: center; margin: 1px 0;"><span style="width: 16px; height: 10px; background: #c62828; margin-right: 5px; border-radius: 1px; flex-shrink: 0;"></span>4-5%</div>
        <div style="display: flex; align-items: center; margin: 1px 0;"><span style="width: 16px; height: 10px; background: #d32f2f; margin-right: 5px; border-radius: 1px; flex-shrink: 0;"></span>3-4%</div>
        <div style="display: flex; align-items: center; margin: 1px 0;"><span style="width: 16px; height: 10px; background: #e53935; margin-right: 5px; border-radius: 1px; flex-shrink: 0;"></span>2-3%</div>
        <div style="display: flex; align-items: center; margin: 1px 0;"><span style="width: 16px; height: 10px; background: #ef5350; margin-right: 5px; border-radius: 1px; flex-shrink: 0;"></span>1.5-2%</div>
        <div style="display: flex; align-items: center; margin: 1px 0;"><span style="width: 16px; height: 10px; background: #f57a7a; margin-right: 5px; border-radius: 1px; flex-shrink: 0;"></span>1-1.5%</div>
        <div style="display: flex; align-items: center; margin: 1px 0;"><span style="width: 16px; height: 10px; background: #fbb4b4; margin-right: 5px; border-radius: 1px; flex-shrink: 0;"></span>0.4-1%</div>
        <div style="display: flex; align-items: center; margin: 1px 0;"><span style="width: 16px; height: 10px; background: #feecec; margin-right: 5px; border-radius: 1px; flex-shrink: 0;"></span>&lt;0.4%</div>
      </div>
    `;
  }
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

      // Update legend to match current metric type
      updateLegend();

      // Clear caches to force re-render with new metric
      state.provinceScores = {};
      state.lguScores = {};

      // Re-render the current view to update colors and values
      if (state.currentView === 'provinces') {
        await renderProvinces();
      } else {
        await renderLgus();
      }

      // Update info panel if something is selected
      if (state.selectedLayer && state.selectedLayer.scoreData) {
        state.info.update(state.selectedLayer.feature.properties, state.selectedLayer.scoreData);
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

    console.log('Leaflet map created, loading data...');

    // Load COA links in parallel with initial render
    loadCoaLinks();

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
