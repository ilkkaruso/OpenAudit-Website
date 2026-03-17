/**
 * OpenAudit Philippines - Data Explorer
 * Interactive table view for researchers
 */

let allData = [];
let filteredData = [];
let currentPage = 1;
let pageSize = 50;
let sortColumn = 'score';
let sortDirection = 'desc';

async function loadData() {
  try {
    const response = await fetch('data/lgu-scores.json');
    const json = await response.json();

    // Convert object to array
    allData = Object.entries(json.lgus).map(([psgc, data]) => ({
      psgc,
      ...data
    }));

    filteredData = [...allData];
    sortData();
    renderTable();
    updateRowCount();

  } catch (error) {
    console.error('Failed to load data:', error);
    document.getElementById('table-body').innerHTML =
      '<tr><td colspan="8" class="loading">Failed to load data. Please refresh.</td></tr>';
  }
}

function sortData() {
  filteredData.sort((a, b) => {
    let valA = a[sortColumn];
    let valB = b[sortColumn];

    // Handle null/undefined
    if (valA == null) valA = sortDirection === 'asc' ? Infinity : -Infinity;
    if (valB == null) valB = sortDirection === 'asc' ? Infinity : -Infinity;

    // String comparison
    if (typeof valA === 'string') {
      valA = valA.toLowerCase();
      valB = (valB || '').toLowerCase();
      return sortDirection === 'asc'
        ? valA.localeCompare(valB)
        : valB.localeCompare(valA);
    }

    // Numeric comparison
    return sortDirection === 'asc' ? valA - valB : valB - valA;
  });
}

function renderTable() {
  const tbody = document.getElementById('table-body');

  // Calculate pagination
  const start = pageSize === 'all' ? 0 : (currentPage - 1) * pageSize;
  const end = pageSize === 'all' ? filteredData.length : start + parseInt(pageSize);
  const pageData = filteredData.slice(start, end);

  if (pageData.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="loading">No matching records found.</td></tr>';
    return;
  }

  tbody.innerHTML = pageData.map(row => `
    <tr>
      <td><strong>${escapeHtml(row.name || 'Unknown')}</strong></td>
      <td class="score-cell ${row.riskLevel}">${row.score?.toFixed(1) ?? '—'}</td>
      <td><span class="risk-badge ${row.riskLevel}">${formatRiskLevel(row.riskLevel)}</span></td>
      <td>${row.notImplementedPct?.toFixed(1) ?? '—'}%</td>
      <td>${row.maxStreak ?? '—'}</td>
      <td><span class="trend-badge ${row.trend}">${formatTrend(row.trend)}</span></td>
      <td>${row.observationCount?.toLocaleString() ?? '—'}</td>
      <td>${(row.baseRate * 100)?.toFixed(1) ?? '—'}%</td>
    </tr>
  `).join('');

  updatePagination();
}

function formatRiskLevel(level) {
  const labels = {
    'critical': 'Critical',
    'high': 'High',
    'moderate': 'Moderate',
    'low': 'Low',
    'minimal': 'Minimal'
  };
  return labels[level] || level || 'Unknown';
}

function formatTrend(trend) {
  const labels = {
    'improving': '↗ Improving',
    'worsening': '↘ Worsening',
    'stable': '→ Stable',
    'insufficient_data': '— Insufficient'
  };
  return labels[trend] || trend || '—';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function updateRowCount() {
  const count = filteredData.length;
  const total = allData.length;
  document.getElementById('row-count').textContent =
    count === total
      ? `${total.toLocaleString()} LGUs`
      : `${count.toLocaleString()} of ${total.toLocaleString()} LGUs`;
}

function updatePagination() {
  const totalPages = pageSize === 'all' ? 1 : Math.ceil(filteredData.length / pageSize);

  document.getElementById('page-info').textContent =
    pageSize === 'all' ? 'All records' : `Page ${currentPage} of ${totalPages}`;

  document.getElementById('prev-page').disabled = currentPage <= 1;
  document.getElementById('next-page').disabled = currentPage >= totalPages || pageSize === 'all';
}

function applyFilters() {
  const search = document.getElementById('search').value.toLowerCase();
  const riskFilter = document.getElementById('risk-filter').value;
  const trendFilter = document.getElementById('trend-filter').value;
  const scoreMin = parseFloat(document.getElementById('score-min').value) || 0;
  const scoreMax = parseFloat(document.getElementById('score-max').value) || 100;

  filteredData = allData.filter(row => {
    // Search filter
    if (search && !row.name?.toLowerCase().includes(search)) {
      return false;
    }

    // Risk level filter
    if (riskFilter && row.riskLevel !== riskFilter) {
      return false;
    }

    // Trend filter
    if (trendFilter && row.trend !== trendFilter) {
      return false;
    }

    // Score range filter
    const score = row.score ?? 0;
    if (score < scoreMin || score > scoreMax) {
      return false;
    }

    return true;
  });

  currentPage = 1;
  sortData();
  renderTable();
  updateRowCount();
}

function resetFilters() {
  document.getElementById('search').value = '';
  document.getElementById('risk-filter').value = '';
  document.getElementById('trend-filter').value = '';
  document.getElementById('score-min').value = '';
  document.getElementById('score-max').value = '';

  filteredData = [...allData];
  currentPage = 1;
  sortData();
  renderTable();
  updateRowCount();
}

function exportCSV() {
  const headers = [
    'PSGC', 'LGU Name', 'Score', 'Risk Level', 'Not Implemented %',
    'Max Streak', 'Current Streak', 'Trend', 'Trend Change',
    'Observations', 'Implemented', 'Not Implemented', 'Partially Implemented', 'Base Rate'
  ];

  const rows = filteredData.map(row => [
    row.psgc,
    `"${(row.name || '').replace(/"/g, '""')}"`,
    row.score?.toFixed(2) ?? '',
    row.riskLevel || '',
    row.notImplementedPct?.toFixed(2) ?? '',
    row.maxStreak ?? '',
    row.currentStreak ?? '',
    row.trend || '',
    row.trendChange?.toFixed(4) ?? '',
    row.observationCount ?? '',
    row.implemented ?? '',
    row.not_implemented ?? '',
    row.partially_implemented ?? '',
    row.baseRate?.toFixed(4) ?? ''
  ]);

  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `openaudit-lgu-data-${new Date().toISOString().split('T')[0]}.csv`;
  link.click();
}

// Event Listeners
document.addEventListener('DOMContentLoaded', () => {
  // Check auth
  if (typeof checkAuth === 'function') {
    checkAuth();
  }

  loadData();

  // Search with debounce
  let searchTimeout;
  document.getElementById('search').addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(applyFilters, 300);
  });

  // Filter changes
  document.getElementById('risk-filter').addEventListener('change', applyFilters);
  document.getElementById('trend-filter').addEventListener('change', applyFilters);
  document.getElementById('score-min').addEventListener('change', applyFilters);
  document.getElementById('score-max').addEventListener('change', applyFilters);

  // Reset filters
  document.getElementById('reset-filters').addEventListener('click', resetFilters);

  // Export CSV
  document.getElementById('export-csv').addEventListener('click', exportCSV);

  // Pagination
  document.getElementById('prev-page').addEventListener('click', () => {
    if (currentPage > 1) {
      currentPage--;
      renderTable();
    }
  });

  document.getElementById('next-page').addEventListener('click', () => {
    const totalPages = Math.ceil(filteredData.length / pageSize);
    if (currentPage < totalPages) {
      currentPage++;
      renderTable();
    }
  });

  document.getElementById('page-size').addEventListener('change', (e) => {
    pageSize = e.target.value === 'all' ? 'all' : parseInt(e.target.value);
    currentPage = 1;
    renderTable();
  });

  // Column sorting
  document.querySelectorAll('#data-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const column = th.dataset.sort;

      // Toggle direction if same column
      if (sortColumn === column) {
        sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
      } else {
        sortColumn = column;
        sortDirection = 'desc';
      }

      // Update UI
      document.querySelectorAll('#data-table th').forEach(h => {
        h.classList.remove('sort-asc', 'sort-desc');
      });
      th.classList.add(sortDirection === 'asc' ? 'sort-asc' : 'sort-desc');

      sortData();
      renderTable();
    });
  });

  // Set initial sort indicator
  document.querySelector(`#data-table th[data-sort="${sortColumn}"]`)?.classList.add('sort-desc');
});
