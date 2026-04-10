const fs = require('fs');
const path = require('path');

const dataFile = path.join(__dirname, 'data.json');

// Initialize data.json if it doesn't exist
if (!fs.existsSync(dataFile)) {
    fs.writeFileSync(dataFile, JSON.stringify({ warnings: {} }, null, 2));
}

function loadData() {
    try {
        const data = fs.readFileSync(dataFile, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error("Error loading data:", err);
        return { warnings: {} };
    }
}

function saveData(data) {
    try {
        fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));
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
        saveData(data);
    },
    getWarnings: (userId) => {
        const data = loadData();
        return data.warnings[userId] || [];
    },
    clearWarnings: (userId) => {
        const data = loadData();
        if (data.warnings[userId]) {
            delete data.warnings[userId];
            saveData(data);
            return true;
        }
        return false;
    }
};
