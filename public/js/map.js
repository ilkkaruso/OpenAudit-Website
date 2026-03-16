/**
 * OpenAudit Philippines - Interactive Choropleth Map
 * Renders Philippines regions colored by corruption risk scores
 */

async function renderMap() {
  try {
    // 1. DATA LOADING - Load TopoJSON boundaries and score data in parallel
    const [topology, scoresData] = await Promise.all([
      d3.json('geo/regions.topo.json'),
      d3.json('data/regions.json')
    ]);

    // Convert TopoJSON to GeoJSON
    const geojson = topojson.feature(topology, topology.objects['provdists-region']);

    // Create lookup map: PSGC code (as string) -> {name, score}
    const scoreMap = new Map();
    scoresData.regions.forEach(region => {
      scoreMap.set(String(region.code), {
        name: region.name,
        score: region.score
      });
    });

    // Enrich GeoJSON features with score data
    geojson.features.forEach(feature => {
      const psgc = String(feature.properties.psgc);
      const regionData = scoreMap.get(psgc);

      if (regionData) {
        feature.properties.name = regionData.name;
        feature.properties.score = regionData.score;
      } else {
        // Fallback for unmatched regions
        feature.properties.name = 'Unknown';
        feature.properties.score = null;
      }
    });

    // 2. PROJECTION & PATH - Philippines-optimized Mercator projection
    const width = 960;
    const height = 600;

    const projection = d3.geoMercator()
      .fitSize([width, height], geojson);

    const path = d3.geoPath().projection(projection);

    // 3. COLOR SCALE - Quantize scale for choropleth classification
    const scores = geojson.features
      .map(d => d.properties.score)
      .filter(score => score !== null);

    const colorScale = d3.scaleQuantize()
      .domain([0, d3.max(scores)])
      .range(d3.schemeBlues[7])
      .unknown('#e0e0e0'); // Gray for missing data

    // 4. SVG RENDERING - Create responsive SVG with viewBox
    const svg = d3.select('#map')
      .append('svg')
      .attr('viewBox', `0 0 ${width} ${height}`)
      .attr('preserveAspectRatio', 'xMidYMid meet')
      .attr('role', 'img')
      .attr('aria-label', 'Philippines corruption risk by region choropleth map');

    // Create tooltip div
    const tooltip = d3.select('body')
      .append('div')
      .attr('class', 'tooltip')
      .style('position', 'absolute')
      .style('visibility', 'hidden')
      .style('background-color', 'white')
      .style('border', '1px solid #ddd')
      .style('border-radius', '4px')
      .style('padding', '8px 12px')
      .style('font-size', '14px')
      .style('pointer-events', 'none')
      .style('box-shadow', '0 2px 4px rgba(0,0,0,0.2)');

    // Render regions
    svg.selectAll('path')
      .data(geojson.features)
      .join('path')
      .attr('d', path)
      .attr('fill', d => colorScale(d.properties.score))
      .attr('stroke', '#fff')
      .attr('stroke-width', 0.5)
      .style('cursor', 'pointer')
      // 5. TOOLTIPS - Use pointer events for mobile/desktop compatibility
      .on('pointerover', function(event, d) {
        // Highlight region
        d3.select(this)
          .style('opacity', 0.7);

        // Show tooltip
        const score = d.properties.score !== null
          ? d.properties.score.toFixed(2)
          : 'No data';

        tooltip
          .style('visibility', 'visible')
          .html(`<strong>${d.properties.name}</strong><br/>Score: ${score}`);
      })
      .on('pointermove', function(event) {
        tooltip
          .style('top', `${event.pageY - 28}px`)
          .style('left', `${event.pageX + 10}px`);
      })
      .on('pointerout', function() {
        // Restore region opacity
        d3.select(this)
          .style('opacity', 1);

        // Hide tooltip
        tooltip.style('visibility', 'hidden');
      });

    console.log('Map rendered successfully:', {
      regions: geojson.features.length,
      scoreRange: [0, d3.max(scores)],
      projection: 'Mercator'
    });

  } catch (error) {
    console.error('Error rendering map:', error);
    d3.select('#map')
      .append('p')
      .style('color', 'red')
      .style('padding', '20px')
      .text(`Failed to load map: ${error.message}`);
  }
}

// Export for global access
window.renderMap = renderMap;
