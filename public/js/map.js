/**
 * OpenAudit Philippines - LGU-Level Interactive Map
 * Renders all 1,600+ LGUs with corruption risk coloring based on actual COA data
 */

// Risk level color scale based on 0-100 multi-factor score
function getRiskColor(score, riskLevel) {
  // Use risk level if provided, otherwise calculate from score
  const level = riskLevel || getRiskLevel(score);

  switch(level) {
    case 'critical': return '#7f0000';  // Dark red
    case 'high': return '#c62828';      // Red
    case 'moderate': return '#ef6c00';  // Orange
    case 'low': return '#fdd835';       // Yellow
    case 'minimal': return '#66bb6a';   // Green
    default: return '#e0e0e0';          // Gray for no data
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

function getTrendIcon(trend) {
  switch(trend) {
    case 'improving': return '↗️ Improving';
    case 'worsening': return '↘️ Worsening';
    case 'stable': return '→ Stable';
    default: return '';
  }
}

function getTrendClass(trend) {
  switch(trend) {
    case 'improving': return 'trend-improving';
    case 'worsening': return 'trend-worsening';
    case 'stable': return 'trend-stable';
    default: return '';
  }
}

async function renderMap() {
  const container = d3.select('#map');
  container.html('');

  const loading = container.append('div')
    .attr('class', 'loading')
    .text('Loading 1,600+ LGUs...');

  try {
    // Load LGU boundaries and actual score data
    const [topology, scoresData] = await Promise.all([
      d3.json('geo/lgus.topo.json'),
      d3.json('data/lgu-scores.json')
    ]);

    loading.remove();

    // Convert TopoJSON to GeoJSON
    const objectName = Object.keys(topology.objects)[0];
    const geojson = topojson.feature(topology, topology.objects[objectName]);

    // Build score lookup from actual data
    const scoreMap = new Map();
    const lguData = scoresData.lgus;

    Object.entries(lguData).forEach(([code, data]) => {
      scoreMap.set(String(code), data);
    });

    // Match GeoJSON features with scores
    let matchedCount = 0;
    geojson.features.forEach(feature => {
      const psgc = String(feature.properties.psgc);
      const data = scoreMap.get(psgc);

      if (data) {
        feature.properties.lguData = data;
        matchedCount++;
      } else {
        feature.properties.lguData = null;
      }
    });

    console.log(`Matched ${matchedCount}/${geojson.features.length} LGUs with score data`);

    // SVG setup - taller for Philippines shape
    const width = 800;
    const height = 1100;
    const margin = { top: 80, right: 200, bottom: 40, left: 20 };

    const svg = container.append('svg')
      .attr('viewBox', `0 0 ${width + margin.left + margin.right} ${height + margin.top + margin.bottom}`)
      .attr('preserveAspectRatio', 'xMidYMid meet')
      .attr('role', 'img')
      .attr('aria-label', 'Philippines LGU-level audit compliance map');

    const mapGroup = svg.append('g')
      .attr('transform', `translate(${margin.left}, ${margin.top})`);

    // Mercator projection optimized for Philippines
    const projection = d3.geoMercator()
      .fitSize([width, height], geojson);

    const path = d3.geoPath().projection(projection);

    // Tooltip
    const tooltip = d3.select('body').append('div')
      .attr('class', 'tooltip');

    // Render all LGU paths
    mapGroup.selectAll('path.lgu')
      .data(geojson.features)
      .join('path')
      .attr('class', 'lgu')
      .attr('d', path)
      .attr('fill', d => {
        const data = d.properties.lguData;
        return data ? getRiskColor(data.score, data.riskLevel) : '#e0e0e0';
      })
      .attr('stroke', '#ffffff')
      .attr('stroke-width', 0.3)
      .attr('stroke-linejoin', 'round')
      .on('pointerenter', function(event, d) {
        const data = d.properties.lguData;

        d3.select(this)
          .attr('stroke', '#000000')
          .attr('stroke-width', 2)
          .raise();

        const name = data?.name || d.properties.name || 'Unknown';
        const score = data?.score ?? null;
        const riskLevel = data?.riskLevel || getRiskLevel(score);
        const riskLabel = getRiskLabel(score, riskLevel);
        const riskClass = riskLevel || 'no-data';
        const geoLevel = d.properties.geo_level === 'Mun' ? 'Municipality' : 'City';

        // Build detailed stats
        const notImplPct = data?.notImplementedPct || 0;
        const maxStreak = data?.maxStreak || 0;
        const trend = data?.trend || 'insufficient_data';
        const trendChange = data?.trendChange || 0;
        const observations = data?.observationCount || 0;

        tooltip
          .style('opacity', 1)
          .html(`
            <div class="tooltip-header">
              <span class="tooltip-title">${name}</span>
              <span class="tooltip-type">${geoLevel}</span>
            </div>
            <div class="tooltip-body">
              <div class="tooltip-score-big">
                <span class="score-value">${score !== null ? Math.round(score) : '—'}</span>
                <span class="score-label">/ 100</span>
              </div>
              <div class="tooltip-risk ${riskClass}">${riskLabel}</div>

              <div class="tooltip-details">
                <div class="detail-row">
                  <span class="detail-label">Not Implemented:</span>
                  <span class="detail-value">${notImplPct.toFixed(1)}%</span>
                </div>
                ${maxStreak > 0 ? `
                <div class="detail-row">
                  <span class="detail-label">Longest Streak:</span>
                  <span class="detail-value">${maxStreak} years</span>
                </div>
                ` : ''}
                ${trend !== 'insufficient_data' ? `
                <div class="detail-row">
                  <span class="detail-label">Trend:</span>
                  <span class="detail-value ${getTrendClass(trend)}">${getTrendIcon(trend)}</span>
                </div>
                ` : ''}
                <div class="detail-row">
                  <span class="detail-label">Observations:</span>
                  <span class="detail-value">${observations.toLocaleString()}</span>
                </div>
              </div>
            </div>
          `);
      })
      .on('pointermove', function(event) {
        tooltip
          .style('left', (event.pageX + 15) + 'px')
          .style('top', (event.pageY - 10) + 'px');
      })
      .on('pointerleave', function() {
        d3.select(this)
          .attr('stroke', '#ffffff')
          .attr('stroke-width', 0.3);
        tooltip.style('opacity', 0);
      })
      .on('click', function(event, d) {
        const data = d.properties.lguData;
        if (data) {
          console.log('LGU clicked:', {
            name: data.name,
            code: d.properties.psgc,
            score: data.score,
            province: data.provinceName
          });
          // Future: show detail panel or navigate to findings
        }
      });

    // Title
    svg.append('text')
      .attr('x', (width + margin.left + margin.right) / 2)
      .attr('y', 30)
      .attr('text-anchor', 'middle')
      .attr('font-size', '24px')
      .attr('font-weight', '700')
      .attr('fill', '#1a365d')
      .text('OpenAudit Philippines');

    svg.append('text')
      .attr('x', (width + margin.left + margin.right) / 2)
      .attr('y', 55)
      .attr('text-anchor', 'middle')
      .attr('font-size', '14px')
      .attr('fill', '#4a5568')
      .text('COA Audit Recommendation Implementation Tracker (2016-2024)');

    // Legend
    const legendGroup = svg.append('g')
      .attr('class', 'legend')
      .attr('transform', `translate(${width + margin.left + 25}, ${margin.top})`);

    legendGroup.append('text')
      .attr('font-size', '14px')
      .attr('font-weight', '600')
      .attr('fill', '#1a365d')
      .text('Risk Level');

    const legendData = [
      { label: 'Critical (80-100)', color: '#7f0000' },
      { label: 'High (60-80)', color: '#c62828' },
      { label: 'Moderate (40-60)', color: '#ef6c00' },
      { label: 'Low (20-40)', color: '#fdd835' },
      { label: 'Minimal (0-20)', color: '#66bb6a' },
      { label: 'No Data', color: '#e0e0e0' }
    ];

    const legendItems = legendGroup.selectAll('.legend-item')
      .data(legendData)
      .join('g')
      .attr('class', 'legend-item')
      .attr('transform', (d, i) => `translate(0, ${22 + i * 24})`);

    legendItems.append('rect')
      .attr('width', 18)
      .attr('height', 18)
      .attr('rx', 2)
      .attr('fill', d => d.color)
      .attr('stroke', '#999')
      .attr('stroke-width', 0.5);

    legendItems.append('text')
      .attr('x', 24)
      .attr('y', 14)
      .attr('font-size', '11px')
      .attr('fill', '#333')
      .text(d => d.label);

    // Statistics
    const statsGroup = svg.append('g')
      .attr('transform', `translate(${width + margin.left + 25}, ${margin.top + 280})`);

    const withScores = Object.values(lguData).filter(d => d.score > 0).length;
    const avgScore = Object.values(lguData).reduce((sum, d) => sum + (d.score || 0), 0) / Object.keys(lguData).length;

    statsGroup.append('text')
      .attr('font-size', '14px')
      .attr('font-weight', '600')
      .attr('fill', '#1a365d')
      .text('Statistics');

    const stats = [
      `${geojson.features.length.toLocaleString()} LGUs mapped`,
      `${withScores} with risk scores`,
      `Avg score: ${avgScore.toFixed(2)}`,
      '',
      'Click LGU for details'
    ];

    stats.forEach((text, i) => {
      statsGroup.append('text')
        .attr('y', 22 + i * 18)
        .attr('font-size', '11px')
        .attr('fill', text ? '#4a5568' : 'transparent')
        .text(text);
    });

    console.log('Map rendered:', {
      totalLgus: geojson.features.length,
      matchedWithScores: matchedCount,
      withNonZeroScores: withScores
    });

  } catch (error) {
    loading.remove();
    console.error('Map error:', error);
    container.append('div')
      .attr('class', 'error-message')
      .html(`
        <h3>Failed to load map</h3>
        <p>${error.message}</p>
        <p>Make sure you're accessing via http://localhost:8080</p>
      `);
  }
}

window.renderMap = renderMap;
