const fs = require('fs');
const path = require('path');

const dataFile = path.join(__dirname, 'data.json');

// Initialize data.json if it doesn't exist
if (!fs.existsSync(dataFile)) {
    fs.writeFileSync(dataFile, JSON.stringify({ warnings: {} }, null, 2));
}

// In-memory cache for better performance under traffic
let _cache = null;

function loadData() {
    if (_cache) return _cache;
    try {
        const data = fs.readFileSync(dataFile, 'utf8');
        _cache = JSON.parse(data);
        return _cache;
    } catch (err) {
        console.error("Error loading data:", err);
        _cache = { warnings: {} };
        return _cache;
    }
}

function saveData() {
    if (!_cache) return;
    try {
        // Use synchronous write here to ensure data integrity, but since we are cached, 
        // we only call this when something actually changes.
        fs.writeFileSync(dataFile, JSON.stringify(_cache, null, 2));
    } catch (err) {
        console.error("Error saving data:", err);
    }
}

module.exports = {
    addWarning: (userId, reason) => {
        const data = loadData();
        if (!data.warnings[userId]) {
            data.warnings[userId] = [];
        }
        data.warnings[userId].push({ reason, date: new Date().toISOString() });
        saveData();
    },
    getWarnings: (userId) => {
        const data = loadData();
        return data.warnings[userId] || [];
    },
    clearWarnings: (userId) => {
        const data = loadData();
        if (data.warnings[userId]) {
            delete data.warnings[userId];
            saveData();
            return true;
        }
        return false;
    }
};
