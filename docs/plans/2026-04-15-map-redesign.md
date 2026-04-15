# Map Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Redesign the OpenAudit map with zoom functionality, province/LGU toggle, year slider (2016-2022), and dataset switching.

**Architecture:** D3.js with d3.zoom() for pan/zoom, layered SVG (outline → provinces → LGUs), lazy-loading LGU boundaries per-province, per-year JSON score files with in-memory caching.

**Tech Stack:** D3.js v7, TopoJSON, Python 3 (ETL scripts), Faeldon's philippines-json-maps

---

## Phase 1: Geo Data Preparation

### Task 1.1: Download Faeldon's Map Data

**Files:**
- Create: `scripts/geo/download_maps.sh`

**Step 1: Write the download script**

```bash
#!/bin/bash
# Download high-resolution TopoJSON from Faeldon's philippines-json-maps

set -e

REPO_URL="https://raw.githubusercontent.com/faeldon/philippines-json-maps/master/topojson"
GEO_DIR="public/geo"

echo "Downloading high-res province boundaries..."
curl -L "${REPO_URL}/provinces/hires/provinces.topo.0.1.json" -o "${GEO_DIR}/provinces-hires.topo.json"

echo "Downloading high-res municipality boundaries..."
curl -L "${REPO_URL}/municities/hires/municities.topo.0.1.json" -o "${GEO_DIR}/municities-hires.topo.json"

echo "Downloading country outline..."
curl -L "${REPO_URL}/country/hires/country.topo.0.1.json" -o "${GEO_DIR}/ph-outline.topo.json"

echo "Done! Files saved to ${GEO_DIR}/"
ls -lh ${GEO_DIR}/*.json
```

**Step 2: Make script executable and run**

Run: `chmod +x scripts/geo/download_maps.sh && ./scripts/geo/download_maps.sh`
Expected: Three new files in `public/geo/`

**Step 3: Commit**

```bash
git add scripts/geo/download_maps.sh public/geo/provinces-hires.topo.json public/geo/municities-hires.topo.json public/geo/ph-outline.topo.json
git commit -m "feat: download high-res map data from Faeldon's repo"
```

---

### Task 1.2: Split LGU Data by Province

**Files:**
- Create: `scripts/geo/split_lgus_by_province.py`
- Create: `public/geo/lgus/` directory with ~82 province files

**Step 1: Write the splitting script**

```python
#!/usr/bin/env python3
"""
Split municipality TopoJSON into per-province files for lazy loading.
"""

import json
from pathlib import Path
from collections import defaultdict
import re

PROJECT_ROOT = Path(__file__).parent.parent.parent
GEO_DIR = PROJECT_ROOT / "public" / "geo"
INPUT_FILE = GEO_DIR / "municities-hires.topo.json"
OUTPUT_DIR = GEO_DIR / "lgus"


def slugify(name: str) -> str:
    """Convert province name to filename-safe slug."""
    slug = name.lower()
    slug = re.sub(r'[^a-z0-9]+', '-', slug)
    slug = slug.strip('-')
    return slug


def get_province_code(psgc: str) -> str:
    """Extract province code from PSGC (first 5 digits for province)."""
    return psgc[:5] if psgc else ""


def main():
    print(f"Loading {INPUT_FILE}...")
    with open(INPUT_FILE, 'r', encoding='utf-8') as f:
        topo = json.load(f)

    # Get the geometry objects
    obj_name = list(topo['objects'].keys())[0]
    geometries = topo['objects'][obj_name]['geometries']

    print(f"Found {len(geometries)} geometries")

    # Group by province
    by_province = defaultdict(list)
    province_names = {}

    for geom in geometries:
        props = geom.get('properties', {})
        psgc = str(props.get('PSGC', props.get('psgc', '')))
        province = props.get('PROVINCE', props.get('province', 'Unknown'))

        prov_code = get_province_code(psgc)
        if prov_code:
            by_province[prov_code].append(geom)
            province_names[prov_code] = province

    print(f"Found {len(by_province)} provinces")

    # Create output directory
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # Write province mapping file
    mapping = {}

    for prov_code, geoms in by_province.items():
        prov_name = province_names.get(prov_code, 'unknown')
        slug = slugify(prov_name)

        # Create TopoJSON for this province
        prov_topo = {
            "type": "Topology",
            "arcs": topo["arcs"],  # Include all arcs (could optimize later)
            "objects": {
                "lgus": {
                    "type": "GeometryCollection",
                    "geometries": geoms
                }
            }
        }

        if "transform" in topo:
            prov_topo["transform"] = topo["transform"]

        output_file = OUTPUT_DIR / f"{slug}.topo.json"
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(prov_topo, f, separators=(',', ':'))

        mapping[prov_code] = {
            "name": prov_name,
            "slug": slug,
            "file": f"lgus/{slug}.topo.json",
            "lgu_count": len(geoms)
        }

        print(f"  {prov_name}: {len(geoms)} LGUs -> {slug}.topo.json")

    # Write mapping file
    mapping_file = GEO_DIR / "province-mapping.json"
    with open(mapping_file, 'w', encoding='utf-8') as f:
        json.dump(mapping, f, indent=2, ensure_ascii=False)

    print(f"\nWrote {len(mapping)} province files to {OUTPUT_DIR}/")
    print(f"Mapping saved to {mapping_file}")


if __name__ == "__main__":
    main()
```

**Step 2: Run the script**

Run: `python3 scripts/geo/split_lgus_by_province.py`
Expected: ~82 files in `public/geo/lgus/` and `public/geo/province-mapping.json`

**Step 3: Verify output**

Run: `ls public/geo/lgus/ | wc -l && head -20 public/geo/province-mapping.json`
Expected: 80-85 province files listed, mapping shows province codes and slugs

**Step 4: Commit**

```bash
git add scripts/geo/split_lgus_by_province.py public/geo/lgus/ public/geo/province-mapping.json
git commit -m "feat: split LGU data into per-province files for lazy loading"
```

---

## Phase 2: ETL Pipeline Updates

### Task 2.1: Generate Per-Year Score Files

**Files:**
- Create: `scripts/etl/05_generate_yearly_scores.py`
- Create: `public/data/scores-{2016-2022}.json` (7 files)
- Create: `public/data/province-scores-{2016-2022}.json` (7 files)
- Create: `public/data/disallowances.json`

**Step 1: Write the yearly scores generator**

```python
#!/usr/bin/env python3
"""
Generate per-year score JSON files for the map.
Filters to 2016-2022 data only.
"""

import json
from pathlib import Path
from collections import defaultdict

PROJECT_ROOT = Path(__file__).parent.parent.parent
DATA_DIR = PROJECT_ROOT / "scripts" / "data"
OUTPUT_DIR = PROJECT_ROOT / "public" / "data"

OBSERVATIONS_PATH = DATA_DIR / "observations.json"
LGU_MAPPING_PATH = DATA_DIR / "lgu_mapping.json"

YEARS = range(2016, 2023)  # 2016-2022


def calculate_year_score(observations: list) -> dict:
    """Calculate simple score for a single year's observations."""
    if not observations:
        return None

    total = len(observations)
    not_impl = sum(1 for o in observations if o.get('status') == 'NOT_IMPLEMENTED')
    partial = sum(1 for o in observations if o.get('status') == 'PARTIALLY_IMPLEMENTED')
    implemented = sum(1 for o in observations if o.get('status') == 'IMPLEMENTED')

    known = not_impl + partial + implemented
    if known == 0:
        return None

    # Weighted non-compliance rate
    rate = (not_impl + partial * 0.5) / known
    score = rate * 100

    # Risk level
    if score >= 80:
        risk = 'critical'
    elif score >= 60:
        risk = 'high'
    elif score >= 40:
        risk = 'moderate'
    elif score >= 20:
        risk = 'low'
    else:
        risk = 'minimal'

    return {
        'score': round(score, 1),
        'riskLevel': risk,
        'observationCount': total,
        'implementedPct': round(implemented / known * 100, 1) if known > 0 else 0,
        'notImplementedPct': round(not_impl / known * 100, 1) if known > 0 else 0
    }


def main():
    print("Loading observations...")
    with open(OBSERVATIONS_PATH, 'r', encoding='utf-8') as f:
        all_observations = json.load(f)
    print(f"Loaded {len(all_observations):,} total observations")

    print("Loading LGU mapping...")
    with open(LGU_MAPPING_PATH, 'r', encoding='utf-8') as f:
        lgu_mapping = json.load(f)

    # Filter to 2016-2022 and group by year and PSGC
    by_year_psgc = defaultdict(lambda: defaultdict(list))

    for obs in all_observations:
        year = obs.get('year')
        psgc = obs.get('psgc')
        if year and psgc and 2016 <= year <= 2022:
            by_year_psgc[year][psgc].append(obs)

    # Generate per-year files
    for year in YEARS:
        year_data = by_year_psgc[year]

        lgus = {}
        provinces = defaultdict(lambda: {'observations': [], 'lgus': []})

        for psgc, observations in year_data.items():
            score_data = calculate_year_score(observations)
            if score_data:
                lgu_info = lgu_mapping.get(psgc, {})
                lgus[psgc] = {
                    'name': lgu_info.get('name', 'Unknown'),
                    'province': lgu_info.get('province_name', ''),
                    'provinceCode': lgu_info.get('province_psgc', '')[:5] if lgu_info.get('province_psgc') else '',
                    **score_data
                }

                # Aggregate for province
                prov_code = lgus[psgc]['provinceCode']
                if prov_code:
                    provinces[prov_code]['observations'].extend(observations)
                    provinces[prov_code]['lgus'].append(psgc)

        # Calculate province-level scores
        province_scores = {}
        for prov_code, prov_data in provinces.items():
            score_data = calculate_year_score(prov_data['observations'])
            if score_data:
                # Get province name from first LGU
                prov_name = ''
                for psgc in prov_data['lgus']:
                    if psgc in lgus:
                        prov_name = lgus[psgc]['province']
                        break

                province_scores[prov_code] = {
                    'name': prov_name,
                    'lguCount': len(prov_data['lgus']),
                    **score_data
                }

        # Write LGU scores
        lgu_output = OUTPUT_DIR / f"scores-{year}.json"
        with open(lgu_output, 'w', encoding='utf-8') as f:
            json.dump({'year': year, 'lgus': lgus}, f, separators=(',', ':'))
        print(f"  {year}: {len(lgus)} LGUs -> {lgu_output.name}")

        # Write province scores
        prov_output = OUTPUT_DIR / f"province-scores-{year}.json"
        with open(prov_output, 'w', encoding='utf-8') as f:
            json.dump({'year': year, 'provinces': province_scores}, f, separators=(',', ':'))
        print(f"  {year}: {len(province_scores)} provinces -> {prov_output.name}")

    # Create empty disallowances placeholder
    disallowances = {
        'description': 'Disallowances dataset - to be populated',
        'lgus': {},
        'provinces': {}
    }
    disallowances_output = OUTPUT_DIR / "disallowances.json"
    with open(disallowances_output, 'w', encoding='utf-8') as f:
        json.dump(disallowances, f, indent=2)
    print(f"\nCreated empty disallowances placeholder: {disallowances_output.name}")

    print("\nDone!")


if __name__ == "__main__":
    main()
```

**Step 2: Run the script**

Run: `python3 scripts/etl/05_generate_yearly_scores.py`
Expected: 14 score files (7 LGU + 7 province) plus disallowances.json

**Step 3: Verify output**

Run: `ls -la public/data/scores-*.json public/data/province-scores-*.json public/data/disallowances.json`
Expected: All 15 files present with reasonable sizes

**Step 4: Commit**

```bash
git add scripts/etl/05_generate_yearly_scores.py public/data/scores-*.json public/data/province-scores-*.json public/data/disallowances.json
git commit -m "feat: generate per-year score files (2016-2022) and disallowances placeholder"
```

---

## Phase 3: HTML & CSS Updates

### Task 3.1: Add Control Panel HTML

**Files:**
- Modify: `public/index.html`

**Step 1: Update the HTML with control panel**

Replace entire `public/index.html` with:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenAudit Philippines - Corruption Risk Map</title>
  <meta name="description" content="Interactive map showing audit recommendation non-implementation rates across Philippine LGUs. Track government accountability from COA data 2016-2022.">
  <link rel="stylesheet" href="css/map.css">
  <script src="https://cdn.jsdelivr.net/npm/d3@7"></script>
  <script src="https://cdn.jsdelivr.net/npm/topojson-client@3"></script>
</head>
<body>
  <header>
    <nav>
      <a href="index.html" class="nav-link active">Map</a>
      <a href="about.html" class="nav-link">About</a>
      <a href="data.html" class="nav-link">Data</a>
      <a href="settings.html" class="nav-link">Settings</a>
      <a href="#" class="nav-link logout-link" onclick="logout()">Logout</a>
    </nav>
    <h1>OpenAudit Philippines</h1>
    <p>Audit Recommendation Implementation Tracker (2016-2022)</p>
  </header>

  <main>
    <!-- Control Panel -->
    <div id="controls" class="control-panel">
      <div class="control-group">
        <label for="dataset-select">Dataset</label>
        <select id="dataset-select">
          <option value="audit" selected>Audit Findings</option>
          <option value="disallowances">Disallowances</option>
        </select>
      </div>

      <div class="control-group">
        <label for="year-slider">Year: <span id="year-display">2022</span></label>
        <input type="range" id="year-slider" min="2016" max="2022" value="2022" step="1">
        <div class="year-labels">
          <span>2016</span>
          <span>2022</span>
        </div>
      </div>

      <div class="control-group">
        <label>View</label>
        <div class="toggle-buttons">
          <button id="view-provinces" class="toggle-btn active">Provinces</button>
          <button id="view-lgus" class="toggle-btn">LGUs</button>
        </div>
      </div>
    </div>

    <!-- Map Container -->
    <div id="map-container">
      <div id="map" role="img" aria-label="Interactive choropleth map showing corruption risk by Philippine region."></div>

      <!-- Zoom Controls -->
      <div id="zoom-controls" class="zoom-controls">
        <button id="zoom-in" class="zoom-btn" title="Zoom in">+</button>
        <button id="zoom-out" class="zoom-btn" title="Zoom out">−</button>
        <button id="zoom-reset" class="zoom-btn" title="Reset view">⌂</button>
      </div>

      <!-- Mobile hint -->
      <div id="mobile-hint" class="mobile-hint">Use two fingers to zoom</div>
    </div>
  </main>

  <footer>
    <p>Data Source: Commission on Audit (COA) Annual Audit Reports 2016-2022</p>
  </footer>

  <script src="js/auth.js"></script>
  <script src="js/map.js" defer></script>
  <script>
    document.addEventListener('DOMContentLoaded', () => {
      checkAuth();
      if (typeof initMap === 'function') {
        initMap();
      }
    });
  </script>
</body>
</html>
```

**Step 2: Commit**

```bash
git add public/index.html
git commit -m "feat: add map control panel HTML (dataset, year, view toggles)"
```

---

### Task 3.2: Add Control Panel and Zoom CSS

**Files:**
- Modify: `public/css/map.css`

**Step 1: Add new styles to map.css**

Append the following to `public/css/map.css`:

```css
/* ============================================
   CONTROL PANEL STYLES
   ============================================ */

main {
  position: relative;
  padding: 1rem;
  max-width: 1400px;
  margin: 0 auto;
}

#map-container {
  position: relative;
  background: white;
  border-radius: 8px;
  box-shadow: 0 2px 12px rgba(0,0,0,0.1);
  overflow: hidden;
}

.control-panel {
  position: absolute;
  top: 1rem;
  left: 1rem;
  z-index: 100;
  background: white;
  border-radius: 8px;
  box-shadow: 0 2px 12px rgba(0,0,0,0.15);
  padding: 1rem;
  min-width: 200px;
}

.control-group {
  margin-bottom: 1rem;
}

.control-group:last-child {
  margin-bottom: 0;
}

.control-group label {
  display: block;
  font-size: 0.75rem;
  font-weight: 600;
  color: #4a5568;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 0.5rem;
}

.control-group select {
  width: 100%;
  padding: 0.5rem;
  border: 1px solid #e2e8f0;
  border-radius: 4px;
  font-size: 0.9rem;
  background: white;
  cursor: pointer;
}

.control-group select:focus {
  outline: none;
  border-color: #1a365d;
}

/* Year slider */
#year-slider {
  width: 100%;
  margin: 0.25rem 0;
  cursor: pointer;
}

#year-display {
  font-weight: 700;
  color: #1a365d;
}

.year-labels {
  display: flex;
  justify-content: space-between;
  font-size: 0.7rem;
  color: #718096;
}

/* View toggle buttons */
.toggle-buttons {
  display: flex;
  gap: 0;
}

.toggle-btn {
  flex: 1;
  padding: 0.5rem 0.75rem;
  border: 1px solid #e2e8f0;
  background: white;
  font-size: 0.8rem;
  cursor: pointer;
  transition: all 0.15s;
}

.toggle-btn:first-child {
  border-radius: 4px 0 0 4px;
}

.toggle-btn:last-child {
  border-radius: 0 4px 4px 0;
  border-left: none;
}

.toggle-btn:hover {
  background: #f7fafc;
}

.toggle-btn.active {
  background: #1a365d;
  color: white;
  border-color: #1a365d;
}

/* ============================================
   ZOOM CONTROLS
   ============================================ */

.zoom-controls {
  position: absolute;
  bottom: 1rem;
  right: 1rem;
  z-index: 100;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: white;
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.15);
  overflow: hidden;
}

.zoom-btn {
  width: 36px;
  height: 36px;
  border: none;
  background: white;
  font-size: 1.25rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #1a365d;
  transition: background 0.15s;
}

.zoom-btn:hover {
  background: #f7fafc;
}

.zoom-btn:active {
  background: #e2e8f0;
}

/* ============================================
   MOBILE HINT
   ============================================ */

.mobile-hint {
  display: none;
  position: absolute;
  bottom: 1rem;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0,0,0,0.7);
  color: white;
  padding: 0.5rem 1rem;
  border-radius: 20px;
  font-size: 0.8rem;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.3s;
}

.mobile-hint.visible {
  opacity: 1;
}

/* ============================================
   MAP SVG STYLES
   ============================================ */

#map svg {
  display: block;
  width: 100%;
  height: 80vh;
  min-height: 500px;
  cursor: grab;
}

#map svg:active {
  cursor: grabbing;
}

#map svg .outline {
  fill: #f0f4f8;
  stroke: #cbd5e0;
  stroke-width: 1;
}

#map svg .province {
  cursor: pointer;
  transition: filter 0.1s;
}

#map svg .province:hover {
  filter: brightness(0.9);
}

#map svg .lgu {
  cursor: pointer;
  transition: filter 0.1s;
}

#map svg .lgu:hover {
  filter: brightness(0.85);
}

/* ============================================
   MOBILE RESPONSIVE
   ============================================ */

@media (max-width: 768px) {
  .control-panel {
    position: relative;
    top: 0;
    left: 0;
    margin-bottom: 0.5rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    min-width: unset;
  }

  .control-group {
    flex: 1;
    min-width: 120px;
    margin-bottom: 0;
  }

  .zoom-controls {
    bottom: 0.5rem;
    right: 0.5rem;
  }

  .zoom-btn {
    width: 32px;
    height: 32px;
    font-size: 1rem;
  }

  .mobile-hint {
    display: block;
  }

  #map svg {
    height: 60vh;
    min-height: 400px;
  }
}

@media (max-width: 480px) {
  .control-panel {
    flex-direction: column;
  }

  .control-group {
    min-width: 100%;
  }
}
```

**Step 2: Commit**

```bash
git add public/css/map.css
git commit -m "feat: add control panel and zoom control CSS styles"
```

---

## Phase 4: Map JavaScript Rewrite

### Task 4.1: Create Map State Management

**Files:**
- Modify: `public/js/map.js`

**Step 1: Replace map.js with new implementation (Part 1 - State & Utilities)**

Replace entire `public/js/map.js` with:

```javascript
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
```

**Step 2: Commit partial progress**

```bash
git add public/js/map.js
git commit -m "feat: map.js part 1 - state management, utilities, data loading"
```

---

### Task 4.2: Add Zoom and Rendering Functions

**Files:**
- Modify: `public/js/map.js` (append)

**Step 1: Append zoom and render functions to map.js**

Append to `public/js/map.js`:

```javascript
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
      const code = String(d.properties.PSGC || d.properties.psgc || '').substring(0, 5);
      const data = scores[code];
      return data ? getRiskColor(data.score, data.riskLevel) : '#e0e0e0';
    })
    .attr('stroke', '#ffffff')
    .attr('stroke-width', 0.5)
    .on('pointerenter', function(event, d) {
      d3.select(this).attr('stroke', '#000').attr('stroke-width', 2).raise();
      const code = String(d.properties.PSGC || d.properties.psgc || '').substring(0, 5);
      const data = scores[code] || { name: d.properties.PROVINCE || d.properties.name };
      showTooltip(event, data, 'province');
    })
    .on('pointermove', moveTooltip)
    .on('pointerleave', function() {
      d3.select(this).attr('stroke', '#fff').attr('stroke-width', 0.5);
      hideTooltip();
    })
    .on('dblclick', async function(event, d) {
      event.stopPropagation();
      const code = String(d.properties.PSGC || d.properties.psgc || '').substring(0, 5);

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
    .data(geojson.features, d => d.properties.PSGC || d.properties.psgc)
    .join('path')
    .attr('class', 'lgu')
    .attr('d', state.path)
    .attr('fill', d => {
      const psgc = String(d.properties.PSGC || d.properties.psgc || '');
      const data = scores[psgc];
      return data ? getRiskColor(data.score, data.riskLevel) : '#e0e0e0';
    })
    .attr('stroke', '#ffffff')
    .attr('stroke-width', 0.2)
    .on('pointerenter', function(event, d) {
      d3.select(this).attr('stroke', '#000').attr('stroke-width', 1.5).raise();
      const psgc = String(d.properties.PSGC || d.properties.psgc || '');
      const data = scores[psgc] || { name: d.properties.NAME || d.properties.name };
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
        const psgc = String(d.properties.PSGC || d.properties.psgc || '');
        const data = scores[psgc];
        return data ? getRiskColor(data.score, data.riskLevel) : '#e0e0e0';
      });
  }
}
```

**Step 2: Commit**

```bash
git add public/js/map.js
git commit -m "feat: map.js part 2 - zoom behavior and rendering functions"
```

---

### Task 4.3: Add Initialization and Event Handlers

**Files:**
- Modify: `public/js/map.js` (append)

**Step 1: Append init and event handlers to map.js**

Append to `public/js/map.js`:

```javascript
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
```

**Step 2: Commit**

```bash
git add public/js/map.js
git commit -m "feat: map.js part 3 - initialization and control event handlers"
```

---

## Phase 5: Testing & Cleanup

### Task 5.1: Test the Implementation

**Step 1: Start local server**

Run: `cd public && python3 -m http.server 8080`

**Step 2: Test in browser**

Open: `http://localhost:8080`

Verify:
- [ ] Map loads with provinces colored by 2022 data
- [ ] Year slider changes colors when dragged
- [ ] Dataset dropdown switches (disallowances shows gray - no data)
- [ ] View toggle switches between provinces/LGUs
- [ ] Zoom buttons work (+, -, reset)
- [ ] Pan/drag works
- [ ] Double-click on province zooms in and loads LGUs
- [ ] Mobile hint appears on single-finger touch
- [ ] Tooltips show on hover

**Step 3: Note any issues for fixing**

---

### Task 5.2: Remove Old Files

**Files:**
- Delete: `public/geo/lgus.topo.json`
- Delete: `public/data/lgu-scores.json`

**Step 1: Remove obsolete files**

Run: `rm -f public/geo/lgus.topo.json public/data/lgu-scores.json`

**Step 2: Update .gitignore if needed**

**Step 3: Commit**

```bash
git add -A
git commit -m "chore: remove obsolete geo and data files"
```

---

### Task 5.3: Final Commit

**Step 1: Run final verification**

Run: `ls -la public/geo/ && ls -la public/data/`
Expected: New structure with per-province LGU files and per-year scores

**Step 2: Create summary commit**

```bash
git add -A
git commit -m "feat: complete map redesign with zoom, year filter, and dataset toggle

- Zoomable D3 map with pan/scroll and double-click to zoom
- Province view (default) with lazy-loaded LGU view
- Year slider for 2016-2022 data filtering
- Dataset dropdown for audit findings vs disallowances
- Two-finger zoom on mobile
- Per-province LGU files for faster loading
- Per-year score JSON files"
```

---

## Summary

**Total Tasks:** 11
**Estimated Commits:** 10+

**Key Files Created:**
- `scripts/geo/download_maps.sh`
- `scripts/geo/split_lgus_by_province.py`
- `scripts/etl/05_generate_yearly_scores.py`
- `public/geo/lgus/*.topo.json` (~82 files)
- `public/data/scores-{2016-2022}.json` (7 files)
- `public/data/province-scores-{2016-2022}.json` (7 files)
- `public/data/disallowances.json`

**Key Files Modified:**
- `public/index.html`
- `public/css/map.css`
- `public/js/map.js`

**Key Files Removed:**
- `public/geo/lgus.topo.json`
- `public/data/lgu-scores.json`
