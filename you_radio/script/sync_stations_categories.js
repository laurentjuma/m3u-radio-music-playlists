const fs = require('fs');
const path = require('path');
const { API, fetchJsonWithRetries, serialiseJson, plural } = require('./you_radio_api');

// brand.json is the source of truth for what belongs in stations_categories.json.
// This script refreshes brand.json from you.radio, then reconciles the brands.genres
// list against it: a row whose brand no longer exists is dropped, and the logo of
// every surviving row is refreshed from the brand (or genre) it is derived from.
//
// It never invents rows. Genres that exist upstream but are not listed are reported
// so they can be added by hand, because the name and genre_m3u_id of a row are
// editorial and do not come from the API.
//
//   node sync_stations_categories.js               reconcile and write
//   node sync_stations_categories.js --dry-run     report what would change only
//   node sync_stations_categories.js --keep-logos  reconcile but leave logos alone

// Function to reject a brand payload that would leave us with a useless roster
function describeBrandProblem(payload) {
    if (!Array.isArray(payload) || payload.length === 0) {
        return 'expected a non-empty array of brands';
    }
    if (payload.some(brand => !brand || brand.id === undefined)) {
        return 'a brand is missing its id';
    }
    return null;
}

// Function to reject a genre payload that would make every row look retired
function describeGenreProblem(payload) {
    if (!Array.isArray(payload) || payload.length === 0) {
        return 'expected a non-empty array of genres';
    }
    if (payload.some(genre => !genre || genre.id === undefined || genre.brand_id === undefined)) {
        return 'a genre is missing its id or brand_id';
    }
    return null;
}

// Function to re-point a row's logo at the current upstream artwork.
// Rows keep whichever prefix they already use: brands that own a single row point at
// the brand logo, while the Tick Tock decades share one brand and so point at their
// own genre logo. Returns the previous value when it changed, otherwise null.
function refreshLogo(row, genre, brand) {
    const separator = row.logo.indexOf('/');
    if (separator === -1) {
        return null;
    }

    const prefix = row.logo.slice(0, separator);
    const source = prefix === 'genre' ? genre.logo : brand.logo;

    // Leave anything we cannot derive alone rather than guessing at it
    if ((prefix !== 'genre' && prefix !== 'brand') || !source) {
        return null;
    }

    const refreshed = `${prefix}/${source}`;
    if (refreshed === row.logo) {
        return null;
    }

    const previous = row.logo;
    row.logo = refreshed;
    return previous;
}

// Function to list the files a removed row leaves behind
function findOrphanedFiles(row, stationsDir, m3uDir) {
    const candidates = [
        path.join(stationsDir, row.genre_m3u_id.replace(/\.m3u$/, '.json')),
        path.join(m3uDir, row.genre_m3u_id)
    ];
    return candidates.filter(candidate => fs.existsSync(candidate));
}

// Function to report the genres that exist upstream but have no row
function reportUntracked(genres, liveBrands, trackedGenreIds) {
    const untracked = genres.filter(genre =>
        liveBrands.has(String(genre.brand_id)) &&
        !trackedGenreIds.has(String(genre.id)) &&
        Array.isArray(genre.stations) &&
        genre.stations.length > 0
    );

    if (untracked.length === 0) {
        console.log('\nEvery non-empty genre under a live brand already has a row.');
        return;
    }

    console.log(`\n${plural(untracked.length, 'genre')} under live brands have no row (not added):`);

    // Group them under their brand, biggest genre first, so the worthwhile ones stand out
    const brandIds = [...new Set(untracked.map(genre => genre.brand_id))];
    brandIds.sort((left, right) => left - right);

    brandIds.forEach(brandId => {
        const brand = liveBrands.get(String(brandId));
        const forBrand = untracked
            .filter(genre => genre.brand_id === brandId)
            .sort((left, right) => right.stations.length - left.stations.length);

        console.log(`  brand ${brandId} ${brand.name}:`);
        forBrand.forEach(genre => {
            console.log(`    genre_id ${String(genre.id).padStart(3)} — ${plural(genre.stations.length, 'station')} — ${genre.name.trim()}`);
        });
    });

    console.log('  Add a row by hand with a name and genre_m3u_id, then run fetch_stations_json.js.');
}

// Main function to reconcile stations_categories.json against brand.json
async function syncStationsCategories() {
    const jsonDir = path.join(__dirname, '..', 'json');
    const stationsDir = path.join(jsonDir, 'stations');
    const m3uDir = path.join(__dirname, '..', 'm3u', 'stations');
    const brandPath = path.join(jsonDir, 'brand.json');
    const categoriesPath = path.join(jsonDir, 'stations_categories.json');

    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const keepLogos = args.includes('--keep-logos');

    if (dryRun) {
        console.log('Dry run — nothing will be written.\n');
    }

    // Refresh brand.json first: everything below is judged against it
    let brands;
    try {
        brands = await fetchJsonWithRetries(API.brands, 'brand.json');
    } catch (error) {
        console.error(`✗ Could not fetch brands: ${error.message} — nothing changed`);
        process.exitCode = 1;
        return;
    }

    const brandProblem = describeBrandProblem(brands);
    if (brandProblem) {
        console.error(`✗ Brand response rejected: ${brandProblem} — nothing changed`);
        process.exitCode = 1;
        return;
    }

    // Only used for the log line, so an unreadable brand.json is not worth stopping for
    let previousBrandCount = null;
    try {
        previousBrandCount = JSON.parse(fs.readFileSync(brandPath, 'utf8')).length;
    } catch (error) {
        previousBrandCount = null;
    }

    if (!dryRun) {
        fs.writeFileSync(brandPath, serialiseJson(brands), 'utf8');
    }
    const brandChange = previousBrandCount === null ? 'new' : `was ${previousBrandCount}`;
    console.log(`✓ brand.json — ${plural(brands.length, 'brand')} (${brandChange})`);

    // The genre dump is what maps a row's genre_id to the brand that owns it
    console.log('  Fetching the genre list (this response is large) …');
    let genres;
    try {
        genres = await fetchJsonWithRetries(API.genres, 'genres');
    } catch (error) {
        console.error(`✗ Could not fetch genres: ${error.message} — stations_categories.json unchanged`);
        process.exitCode = 1;
        return;
    }

    const genreProblem = describeGenreProblem(genres);
    if (genreProblem) {
        console.error(`✗ Genre response rejected: ${genreProblem} — stations_categories.json unchanged`);
        process.exitCode = 1;
        return;
    }

    const liveBrands = new Map(brands.filter(brand => brand.live !== false).map(brand => [String(brand.id), brand]));
    const retiredBrands = brands.filter(brand => brand.live === false).map(brand => brand.id);
    const genresById = new Map(genres.map(genre => [String(genre.id), genre]));

    console.log(`✓ ${plural(genres.length, 'genre')} upstream, ${plural(liveBrands.size, 'live brand')}`);
    if (retiredBrands.length > 0) {
        console.log(`  Brands flagged not live in brand.json: ${retiredBrands.join(', ')}`);
    }

    let categories;
    try {
        categories = JSON.parse(fs.readFileSync(categoriesPath, 'utf8'));
    } catch (error) {
        console.error(`✗ Could not read ${path.basename(categoriesPath)}: ${error.message} — nothing changed`);
        process.exitCode = 1;
        return;
    }

    if (!categories.brands || !Array.isArray(categories.brands.genres)) {
        console.error('✗ stations_categories.json has no brands.genres array — nothing changed');
        process.exitCode = 1;
        return;
    }

    const kept = [];
    const removed = [];
    const relogged = [];
    const untouched = [];

    categories.brands.genres.forEach(row => {
        // Rows with no genre_id are hand-made playlists from other broadcasters
        // (90s90s, 80s80s, 100 fm). They have no brand and are never reconciled
        if (!row.genre_id) {
            untouched.push(row);
            kept.push(row);
            return;
        }

        const genre = genresById.get(String(row.genre_id));
        if (!genre) {
            removed.push({ row, reason: `genre ${row.genre_id} no longer exists upstream` });
            return;
        }

        const brand = liveBrands.get(String(genre.brand_id));
        if (!brand) {
            removed.push({ row, reason: `brand ${genre.brand_id} is not a live brand in brand.json` });
            return;
        }

        if (!keepLogos) {
            const previous = refreshLogo(row, genre, brand);
            if (previous) {
                relogged.push({ row, previous });
            }
        }

        kept.push(row);
    });

    console.log(`\nReconciling ${plural(categories.brands.genres.length, 'row')} against brand.json:`);

    removed.forEach(entry => {
        console.log(`✗ ${entry.row.genre_m3u_id} — ${entry.reason} — row removed`);
    });
    relogged.forEach(entry => {
        console.log(`↻ ${entry.row.genre_m3u_id} — logo ${entry.previous} → ${entry.row.logo}`);
    });

    categories.brands.genres = kept;

    const serialised = serialiseJson(categories);
    const changed = fs.readFileSync(categoriesPath, 'utf8') !== serialised;

    if (changed && !dryRun) {
        fs.writeFileSync(categoriesPath, serialised, 'utf8');
    }

    const logoSummary = keepLogos ? 'logos left alone' : `${relogged.length} logos refreshed`;
    console.log(`\n${kept.length} rows kept (${untouched.length} hand-made, left alone), ${removed.length} removed, ${logoSummary}.`);
    if (!changed) {
        console.log('stations_categories.json is already up to date.');
    }

    // Removing a row leaves its downloaded station list and playlist behind
    const orphans = removed.flatMap(entry => findOrphanedFiles(entry.row, stationsDir, m3uDir));
    if (orphans.length > 0) {
        console.log(`\n${plural(orphans.length, 'file')} left behind by removed rows (delete by hand if you want them gone):`);
        orphans.forEach(orphan => console.log(`  ${path.relative(path.join(__dirname, '..'), orphan)}`));
    }

    reportUntracked(genres, liveBrands, new Set(kept.filter(row => row.genre_id).map(row => String(row.genre_id))));

    if (dryRun) {
        console.log('\nDry run — nothing was written.');
    }
}

// Run the reconciliation
syncStationsCategories();
