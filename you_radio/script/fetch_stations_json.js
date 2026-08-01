const fs = require('fs');
const path = require('path');
const { fetchJsonWithRetries, serialiseJson, plural } = require('./you_radio_api');

// The you.radio backend serves one genre (with all of its stations) per request.
// stations_categories.json already lists every genre we track, so it drives the run:
// brands.genre_link + brands.genres[].genre_id is the URL, and brands.genres[].genre_m3u_id
// gives the file name convert_json_to_m3u.js expects in json/stations.
const CONCURRENCY = 4;

// Function to reject a response before it can overwrite a good file on disk.
// A genre that has been emptied upstream looks exactly like a bad response, so by
// default we keep what we have and only accept the empty version with --allow-empty
function describePayloadProblem(payload, genreId, allowEmpty) {
    if (!Array.isArray(payload)) {
        return 'expected an array';
    }
    if (payload.length === 0) {
        return allowEmpty ? null : 'no stations upstream (pass --allow-empty to accept this)';
    }
    const genre = payload[0];
    if (!genre || typeof genre !== 'object') {
        return 'first array entry is not an object';
    }
    if (String(genre.id) !== String(genreId)) {
        return `returned genre id ${genre.id}, expected ${genreId}`;
    }
    if (!Array.isArray(genre.stations) || genre.stations.length === 0) {
        return allowEmpty ? null : 'genre contains no stations (pass --allow-empty to accept this)';
    }
    return null;
}

// Function to build the download list from stations_categories.json
function readTargets(categoriesPath) {
    const categories = JSON.parse(fs.readFileSync(categoriesPath, 'utf8'));
    const brands = categories.brands;

    if (!brands || !Array.isArray(brands.genres)) {
        throw new Error('stations_categories.json has no brands.genres array');
    }
    if (!brands.genre_link) {
        throw new Error('stations_categories.json has no brands.genre_link');
    }

    const targets = [];
    const skipped = [];

    brands.genres.forEach(genre => {
        // Entries without a genre_id (90s90s, 80s80s, 100 fm) are hand-made
        // playlists from other broadcasters, not you.radio genres
        if (!genre.genre_id) {
            skipped.push(genre.name);
            return;
        }

        targets.push({
            name: genre.name,
            genreId: String(genre.genre_id),
            fileName: genre.genre_m3u_id.replace(/\.m3u$/, '.json'),
            url: brands.genre_link + genre.genre_id
        });
    });

    return { targets, skipped };
}

// Function to total up the stations in a genre payload
function countStations(payload) {
    return payload.reduce((total, genre) => total + (genre.stations ? genre.stations.length : 0), 0);
}

// Function to count the stations already stored for a genre, for the change log
function countExistingStations(filePath) {
    try {
        return countStations(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    } catch (error) {
        return null;
    }
}

// Function to download one genre and write it to json/stations
async function fetchTarget(target, stationsDir, allowEmpty) {
    const filePath = path.join(stationsDir, target.fileName);

    let payload;
    try {
        payload = await fetchJsonWithRetries(target.url, target.fileName);
    } catch (error) {
        console.error(`✗ ${target.fileName}: ${error.message} — kept the existing file`);
        return { status: 'failed', target };
    }

    const problem = describePayloadProblem(payload, target.genreId, allowEmpty);
    if (problem) {
        console.error(`✗ ${target.fileName}: ${problem} — kept the existing file`);
        return { status: 'failed', target };
    }

    const serialised = serialiseJson(payload);
    const stationCount = countStations(payload);
    const previousCount = countExistingStations(filePath);

    if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === serialised) {
        console.log(`= ${target.fileName} — unchanged (${plural(stationCount, 'station')})`);
        return { status: 'unchanged', target };
    }

    fs.writeFileSync(filePath, serialised, 'utf8');

    const change = previousCount === null ? 'new' : `was ${previousCount}`;
    console.log(`✓ ${target.fileName} — ${plural(stationCount, 'station')} (${change})`);
    return { status: 'written', target };
}

// Function to run the downloads a few at a time instead of all at once
async function runPool(targets, worker) {
    const results = [];
    let nextIndex = 0;

    const runners = Array.from({ length: Math.min(CONCURRENCY, targets.length) }, async () => {
        while (nextIndex < targets.length) {
            const index = nextIndex++;
            results[index] = await worker(targets[index]);
        }
    });

    await Promise.all(runners);
    return results;
}

// Main function to refresh every station JSON file
async function fetchAllStationJson() {
    const jsonDir = path.join(__dirname, '..', 'json');
    const stationsDir = path.join(jsonDir, 'stations');
    const categoriesPath = path.join(jsonDir, 'stations_categories.json');

    // Ensure json/stations directory exists
    if (!fs.existsSync(stationsDir)) {
        fs.mkdirSync(stationsDir, { recursive: true });
    }

    let targets;
    let skipped;
    try {
        ({ targets, skipped } = readTargets(categoriesPath));
    } catch (error) {
        console.error(`Error reading ${path.basename(categoriesPath)}:`, error.message);
        process.exitCode = 1;
        return;
    }

    const args = process.argv.slice(2);
    const allowEmpty = args.includes('--allow-empty');

    // Remaining arguments narrow the run to the named genres, by file name, genre id or name
    const filters = args
        .filter(argument => !argument.startsWith('--'))
        .map(argument => argument.replace(/\.(json|m3u)$/, '').toLowerCase());

    if (filters.length > 0) {
        targets = targets.filter(target => filters.some(filter =>
            target.fileName.replace(/\.json$/, '').toLowerCase() === filter ||
            target.genreId === filter ||
            target.name.toLowerCase() === filter
        ));

        if (targets.length === 0) {
            console.error(`No genres in stations_categories.json match: ${filters.join(', ')}`);
            process.exitCode = 1;
            return;
        }
        skipped = [];
    }

    console.log(`Fetching ${plural(targets.length, 'genre')} from you.radio:`);

    const results = await runPool(targets, target => fetchTarget(target, stationsDir, allowEmpty));

    const written = results.filter(result => result.status === 'written').length;
    const unchanged = results.filter(result => result.status === 'unchanged').length;
    const failed = results.filter(result => result.status === 'failed');

    console.log(`\n${written} updated, ${unchanged} unchanged, ${failed.length} failed.`);

    if (skipped.length > 0) {
        console.log(`Skipped ${skipped.length} entries with no genre_id (not you.radio genres): ${skipped.join(', ')}`);
    }
    if (failed.length > 0) {
        console.log(`Failed: ${failed.map(result => result.target.fileName).join(', ')}`);
        process.exitCode = 1;
        return;
    }

    console.log('Run convert_json_to_m3u.js to rebuild the m3u playlists.');
}

// Run the download
fetchAllStationJson();
