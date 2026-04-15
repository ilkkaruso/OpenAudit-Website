# Map Redesign Design Document

**Date:** 2026-04-15
**Status:** Approved

## Overview

Redesign the OpenAudit Philippines map with zoom functionality, province/LGU toggle, year filtering (2016-2022), and dataset switching (audit findings vs disallowances).

## Requirements

1. **Data scope**: Only 2016-2022 audit data
2. **Zoom**: Free pan/zoom plus click-to-zoom on provinces
3. **View modes**: Province view (default) and LGU view (toggle)
4. **Year filtering**: Slider to select year (2016-2022)
5. **Dataset toggle**: Dropdown to switch between audit findings and disallowances
6. **Mobile**: Two-finger zoom, single finger scrolls page
7. **Map source**: Faeldon's philippines-json-maps (high resolution)

## Architecture

### Map Layer Structure

```
┌─────────────────────────────────────┐
│  SVG Container (zoomable)           │
│  ├── Background Layer (PH outline)  │
│  ├── Province Layer (default view)  │
│  └── LGU Layer (loaded on demand)   │
└─────────────────────────────────────┘
```

### Zoom Behavior

- `d3.zoom()` for pan/drag and scroll/pinch
- Zoom extent: 1x to 8x
- Double-click province: auto-zoom to fit + load LGUs
- Double-click again: zoom back to full view
- Mobile: two-finger gestures only

### Data Loading Strategy

- **Page load**: Fetch province TopoJSON (~1MB) + PH outline (~10KB)
- **Province click**: Lazy-load that province's LGU TopoJSON
- **Cache**: Keep loaded data in memory

## Data Structure

### File Organization

```
/public/data/
├── scores-2016.json
├── scores-2017.json
├── scores-2018.json
├── scores-2019.json
├── scores-2020.json
├── scores-2021.json
├── scores-2022.json
└── disallowances.json  (empty placeholder)
```

### Score Object Schema

```json
{
  "code": "012801000",
  "name": "Adams",
  "province": "Ilocos Norte",
  "score": 45,
  "riskLevel": "Moderate",
  "observationCount": 12,
  "implementedPct": 55
}
```

### Data Loading

- Default: Load 2022 scores
- Year change: Fetch that year's scores, update map
- Dataset toggle: Switch between audit/disallowances
- Cache fetched years in memory

## UI Controls

### Control Panel (top-left)

```
┌────────────────────────────────┐
│ Dataset: [Audit Findings ▼]    │
│                                │
│ Year: ●───────────○ 2016-2022  │
│       2016      2022           │
│                                │
│ View: [Provinces] [LGUs]       │
└────────────────────────────────┘
```

### Zoom Controls (bottom-right)

```
┌─────┐
│  +  │  Zoom in
├─────┤
│  −  │  Zoom out
├─────┤
│  ⌂  │  Reset view
└─────┘
```

### Interactions

- Dataset dropdown: Switch data source, recolor map
- Year slider: Drag to select year, updates on release
- View toggle: Switch between province/LGU boundaries
- Province double-click in Province view: Auto-switch to LGU view for that province

### Mobile

- Controls stack vertically
- Hint overlay: "Use two fingers to zoom"

## Geo File Organization

```
/public/geo/
├── ph-outline.topo.json          (~10KB)
├── provinces-hires.topo.json     (~1MB)
└── lgus/
    ├── abra.topo.json
    ├── agusan-del-norte.topo.json
    ├── ... (~82 province files)
    └── zambales.topo.json
```

### Processing

1. Download from Faeldon's repo (high-res TopoJSON)
2. Extract province-level file
3. Split LGUs into per-province files by PSGC code
4. Generate minimal PH outline for background

## Implementation

### Files to Modify

| File | Changes |
|------|---------|
| `public/js/map.js` | Rewrite with d3.zoom, layer management, controls |
| `public/css/map.css` | Control panel styles, zoom buttons |
| `public/index.html` | Add control panel HTML |

### Files to Create

| File | Purpose |
|------|---------|
| `public/geo/ph-outline.topo.json` | Fast-loading country outline |
| `public/geo/provinces-hires.topo.json` | High-res province boundaries |
| `public/geo/lgus/*.topo.json` | Per-province LGU files (~82) |
| `public/data/scores-{year}.json` | Per-year scores (7 files) |
| `public/data/disallowances.json` | Empty placeholder |
| `scripts/geo/split_lgus.py` | Split LGU data by province |
| `scripts/etl/05_generate_yearly_scores.py` | Generate per-year JSON |

### Files to Remove

| File | Reason |
|------|--------|
| `public/geo/lgus.topo.json` | Replaced by per-province files |
| `public/data/lgu-scores.json` | Replaced by per-year files |

## Dependencies

- D3.js v7 (existing, no changes)
- Faeldon's philippines-json-maps (MIT license)

## Technical Decisions

| Decision | Rationale |
|----------|-----------|
| D3.js (not Leaflet/MapLibre) | Builds on existing code, no new dependencies |
| High-res province boundaries | Supports zoom without pixelation |
| Lazy-load LGUs per-province | Better performance than loading all 1,600 at once |
| Per-year JSON files | Enables year filtering without loading all data |
| Two-finger mobile zoom | Prevents conflict with page scrolling |
