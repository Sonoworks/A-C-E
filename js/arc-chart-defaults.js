// arc-chart-defaults.js
// Global Chart.js defaults for ARC dark theme

Chart.defaults.color = '#e0e0e0';
Chart.defaults.borderColor = 'rgba(255,255,255,0.1)';

// Scale defaults
Chart.defaults.scales.linear = {
    ...Chart.defaults.scales.linear,
    grid: {
        color: 'rgba(255,255,255,0.1)'
    },
    ticks: {
        color: '#e0e0e0'
    },
    title: {
        display: false,
        color: '#e0e0e0'
    }
};

Chart.defaults.scales.logarithmic = {
    ...Chart.defaults.scales.logarithmic,
    grid: {
        color: 'rgba(255,255,255,0.1)'
    },
    ticks: {
        color: '#e0e0e0'
    },
    title: {
        display: false,
        color: '#e0e0e0'
    }
};

Chart.defaults.scales.category = {
    ...Chart.defaults.scales.category,
    grid: {
        color: 'rgba(255,255,255,0.1)'
    },
    ticks: {
        color: '#e0e0e0'
    },
    title: {
        display: false,
        color: '#e0e0e0'
    }
};