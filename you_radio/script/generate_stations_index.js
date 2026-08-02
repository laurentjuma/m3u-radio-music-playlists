const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const categoriesPath = path.join(__dirname, '..', 'json', 'stations_categories.json');
const outPath = path.join(__dirname, '..', 'json', 'stations_index.json');

// Where each category's genre_m3u_id is rooted, relative to the repo root
const CATEGORY_BASE = {
    countries: '',
    brands: 'you_radio/m3u/stations/'
};

// Pull the display names out of an M3U file (the text after the comma on #EXTINF)
function readStationNames(m3uPath) {
    const lines = fs.readFileSync(m3uPath, 'utf8').split('\n');
    const names = [];

    for (const line of lines) {
        if (!line.startsWith('#EXTINF')) {
            continue;
        }

        const comma = line.indexOf(',');
        if (comma === -1) {
            continue;
        }

        const name = line.slice(comma + 1).trim();
        if (name) {
            names.push(name);
        }
    }

    return names;
}

function generateIndex() {
    const categories = JSON.parse(fs.readFileSync(categoriesPath, 'utf8'));
    const index = {};
    const skipped = [];
    let stationCount = 0;

    for (const [category, data] of Object.entries(categories)) {
        const base = CATEGORY_BASE[category];

        if (base === undefined) {
            console.warn(`! Unknown category "${category}", skipping`);
            continue;
        }

        for (const genre of data.genres) {
            if (!genre.genre_m3u_id) {
                skipped.push(`${category}/${genre.name}: no genre_m3u_id`);
                continue;
            }

            const id = genre.genre_m3u_id.split('/').pop();
            const m3uPath = path.join(repoRoot, base + genre.genre_m3u_id);

            if (!fs.existsSync(m3uPath)) {
                skipped.push(`${category}/${genre.name}: missing ${base}${genre.genre_m3u_id}`);
                continue;
            }

            if (index[id]) {
                console.warn(`! Duplicate id "${id}" (${category}/${genre.name}), overwriting`);
            }

            index[id] = readStationNames(m3uPath);
            stationCount += index[id].length;
        }
    }

    fs.writeFileSync(outPath, JSON.stringify(index), 'utf8');

    console.log(`✓ Wrote ${path.relative(repoRoot, outPath)}`);
    console.log(`  ${Object.keys(index).length} playlists, ${stationCount} stations`);

    if (skipped.length) {
        console.log(`\nSkipped ${skipped.length} entries:`);
        skipped.forEach(reason => console.log(`  - ${reason}`));
    }
}

generateIndex();
