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

// Pull the display names out of an M3U file (the text after the comma on #EXTINF).
// Entries with no stream URL after the #EXTINF line are left out.
function readStationNames(m3uPath) {
    const lines = fs.readFileSync(m3uPath, 'utf8').split('\n');
    const names = [];
    let linkless = 0;

    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith('#EXTINF')) {
            continue;
        }

        const comma = lines[i].indexOf(',');
        if (comma === -1) {
            continue;
        }

        const name = lines[i].slice(comma + 1).trim();
        if (!name) {
            continue;
        }

        // The link is the next non-blank line; another directive means there is none
        let next = i + 1;
        while (next < lines.length && !lines[next].trim()) {
            next++;
        }

        if (next >= lines.length || lines[next].startsWith('#')) {
            linkless++;
            continue;
        }

        names.push(name);
    }

    return { names, linkless };
}

function generateIndex() {
    const categories = JSON.parse(fs.readFileSync(categoriesPath, 'utf8'));
    const index = {};
    const skipped = [];
    let stationCount = 0;
    let linklessCount = 0;

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

            const { names, linkless } = readStationNames(m3uPath);

            index[id] = names;
            stationCount += names.length;
            linklessCount += linkless;
        }
    }

    fs.writeFileSync(outPath, JSON.stringify(index), 'utf8');

    console.log(`✓ Wrote ${path.relative(repoRoot, outPath)}`);
    console.log(`  ${Object.keys(index).length} playlists, ${stationCount} stations`);
    console.log(`  Omitted ${linklessCount} stations with no link`);

    if (skipped.length) {
        console.log(`\nSkipped ${skipped.length} entries:`);
        skipped.forEach(reason => console.log(`  - ${reason}`));
    }
}

generateIndex();
