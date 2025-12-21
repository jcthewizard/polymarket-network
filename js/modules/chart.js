/**
 * Correlation Chart Module
 * Displays a modal with a dual-line chart showing log returns for two markets
 */

import { calculateLogReturns, alignByTimestamp } from './math.js';

/**
 * Show correlation chart modal for a link between two markets
 * @param {Object} linkData - The link object with source, target, correlation
 * @param {Array} historyA - Price history for source market [{t, p}, ...]
 * @param {Array} historyB - Price history for target market [{t, p}, ...]
 */
export function showCorrelationChart(linkData, historyA, historyB) {
    // Get or create modal
    let modal = document.getElementById('correlation-chart-modal');
    if (!modal) {
        console.error('Chart: Modal element not found');
        return;
    }

    // Get market names
    const nameA = linkData.source.name || linkData.source.id;
    const nameB = linkData.target.name || linkData.target.id;
    const correlation = linkData.correlation;

    // Update title - show full names, wrap if needed
    const title = document.getElementById('chart-title');
    title.innerHTML = `
        <span class="text-blue-600">${nameA}</span>
        <span class="text-slate-400 mx-2">↔</span>
        <span class="text-orange-600">${nameB}</span>
    `;

    // Update correlation display - simpler format
    const badge = document.getElementById('chart-correlation');
    const corrPercent = (Math.abs(correlation) * 100).toFixed(0);
    const corrSign = correlation >= 0 ? '+' : '-';
    badge.textContent = `${corrSign}${corrPercent}% correlated`;
    badge.className = `text-sm font-medium ${correlation > 0 ? 'text-green-600' : 'text-red-600'}`;

    // Align and calculate log returns
    const { pricesA, pricesB } = alignByTimestamp(historyA, historyB);

    console.log('Chart: Aligned prices', { pricesA: pricesA.length, pricesB: pricesB.length });

    if (pricesA.length < 10) {
        showChartError('Not enough aligned data points');
        modal.classList.remove('hidden');
        return;
    }

    const returnsA = calculateLogReturns(pricesA);
    const returnsB = calculateLogReturns(pricesB);

    console.log('Chart: Log returns', { returnsA: returnsA.length, returnsB: returnsB.length });

    // Get timestamps for aligned data
    const timestamps = getAlignedTimestamps(historyA, historyB);

    console.log('Chart: Timestamps', { count: timestamps.length });

    // Show modal FIRST so container has dimensions
    modal.classList.remove('hidden');

    // Small delay to ensure DOM is ready with proper dimensions
    setTimeout(() => {
        modal.querySelector('.modal-content').classList.remove('scale-95', 'opacity-0');

        // Render chart after modal is visible
        renderChart(returnsA, returnsB, timestamps.slice(1), nameA, nameB);
    }, 50);
}

/**
 * Hide the correlation chart modal
 */
export function hideCorrelationChart() {
    const modal = document.getElementById('correlation-chart-modal');
    if (modal) {
        modal.querySelector('.modal-content').classList.add('scale-95', 'opacity-0');
        setTimeout(() => {
            modal.classList.add('hidden');
        }, 200);
    }
}

/**
 * Get aligned timestamps from two histories
 */
function getAlignedTimestamps(historyA, historyB) {
    const mapB = new Map();
    for (const point of historyB) {
        mapB.set(point.t, true);
    }

    const timestamps = [];
    for (const point of historyA) {
        if (mapB.has(point.t)) {
            timestamps.push(point.t);
        }
    }
    return timestamps;
}

/**
 * Render the D3 chart
 */
function renderChart(returnsA, returnsB, timestamps, nameA, nameB) {
    const container = document.getElementById('chart-container');
    container.innerHTML = ''; // Clear previous

    const margin = { top: 20, right: 30, bottom: 50, left: 60 }; // Reduced right margin (no legend)
    const width = container.clientWidth - margin.left - margin.right;
    const height = 350 - margin.top - margin.bottom;

    const svg = d3.select(container)
        .append('svg')
        .attr('width', width + margin.left + margin.right)
        .attr('height', height + margin.top + margin.bottom)
        .append('g')
        .attr('transform', `translate(${margin.left},${margin.top})`);

    // Data for plotting
    const data = timestamps.map((t, i) => ({
        time: new Date(t * 1000),
        returnA: returnsA[i] || 0,
        returnB: returnsB[i] || 0
    }));

    // Scales
    const x = d3.scaleTime()
        .domain(d3.extent(data, d => d.time))
        .range([0, width]);

    const allReturns = [...returnsA, ...returnsB];
    const yMin = Math.min(...allReturns) * 1.1;
    const yMax = Math.max(...allReturns) * 1.1;

    const y = d3.scaleLinear()
        .domain([yMin, yMax])
        .range([height, 0]);

    // Grid lines
    svg.append('g')
        .attr('class', 'grid')
        .attr('transform', `translate(0,${height})`)
        .call(d3.axisBottom(x).tickSize(-height).tickFormat(''))
        .selectAll('line')
        .attr('stroke', '#e2e8f0')
        .attr('stroke-dasharray', '2,2');

    svg.append('g')
        .attr('class', 'grid')
        .call(d3.axisLeft(y).tickSize(-width).tickFormat(''))
        .selectAll('line')
        .attr('stroke', '#e2e8f0')
        .attr('stroke-dasharray', '2,2');

    // Zero line
    svg.append('line')
        .attr('x1', 0)
        .attr('x2', width)
        .attr('y1', y(0))
        .attr('y2', y(0))
        .attr('stroke', '#94a3b8')
        .attr('stroke-width', 1);

    // Lines
    const lineA = d3.line()
        .x(d => x(d.time))
        .y(d => y(d.returnA))
        .curve(d3.curveMonotoneX);

    const lineB = d3.line()
        .x(d => x(d.time))
        .y(d => y(d.returnB))
        .curve(d3.curveMonotoneX);

    svg.append('path')
        .datum(data)
        .attr('fill', 'none')
        .attr('stroke', '#2563eb') // Blue
        .attr('stroke-width', 2)
        .attr('d', lineA);

    svg.append('path')
        .datum(data)
        .attr('fill', 'none')
        .attr('stroke', '#ea580c') // Orange
        .attr('stroke-width', 2)
        .attr('d', lineB);

    // Axes
    svg.append('g')
        .attr('transform', `translate(0,${height})`)
        .call(d3.axisBottom(x).ticks(6).tickFormat(d3.timeFormat('%b %d')))
        .selectAll('text')
        .attr('fill', '#64748b')
        .style('font-size', '11px');

    svg.append('g')
        .call(d3.axisLeft(y).ticks(5).tickFormat(d => (d * 100).toFixed(1) + '%'))
        .selectAll('text')
        .attr('fill', '#64748b')
        .style('font-size', '11px');

    // Y-axis label
    svg.append('text')
        .attr('transform', 'rotate(-90)')
        .attr('y', -45)
        .attr('x', -height / 2)
        .attr('text-anchor', 'middle')
        .attr('fill', '#64748b')
        .style('font-size', '12px')
        .text('Log Returns');

}

function showChartError(message) {
    const container = document.getElementById('chart-container');
    container.innerHTML = `
        <div class="flex items-center justify-center h-64 text-slate-500">
            <p>${message}</p>
        </div>
    `;
}

function truncateText(text, maxLength) {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + '...';
}

// Initialize close button
document.addEventListener('DOMContentLoaded', () => {
    const closeBtn = document.getElementById('close-chart-btn');
    if (closeBtn) {
        closeBtn.addEventListener('click', hideCorrelationChart);
    }

    // Close on backdrop click
    const modal = document.getElementById('correlation-chart-modal');
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                hideCorrelationChart();
            }
        });
    }

    // Close on Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            hideCorrelationChart();
        }
    });
});
