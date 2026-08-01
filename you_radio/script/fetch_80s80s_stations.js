const fs = require('fs');
const path = require('path');
const { fetchJsonWithRetries, plural } = require('./you_radio_api');

// 80s80s is one of the hand-made rows in stations_categories.json: it is not a
// you.radio brand, so nothing else in this directory maintains its playlist.
//
// The site is a Drupal install with a json api behind it. /api/streams lists every
// station as a teaser with a path alias, and /api<alias> then carries that station's
// stream url and artwork. This script walks both and rewrites m3u/stations/80s80s.m3u.
//
// Station names, group-title and tvg-popularity are editorial: they are kept as they
// are for stations already in the playlist, and only filled in for new ones.
//
//   node fetch_80s80s_stations.js             update the playlist
//   node fetch_80s80s_stations.js --dry-run   report what would change, write nothing
//   node fetch_80s80s_stations.js --prune     also drop stations the site no longer lists

const SITE = 'https://www.80s80s.de';
const INDEX_URL = `${SITE}/api/streams`;
const CONCURRENCY = 4;

// Defaults for a station the playlist has not seen before
const DEFAULT_COUNTRY = 'Germany';
const DEFAULT_POPULARITY = '1';
const DEFAULT_GROUP = '80s';
const FEED_TITLE = '80s80s';

// Attributes are written in this order, matching the entries already in the file
const ATTRIBUTE_ORDER = ['tvg-country', 'tvg-popularity', 'tvg-logo', 'group-title', 'feed-title'];

// Function to reduce a stream url to something comparable, so an entry written as
// http://streams.80s80s.de/rock/mp3-192 still matches https://…/rock/mp3-192/
function streamKey(url) {
    return url.replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase();
}

// Genre abbreviations that should stay upper case when the title is tidied up
const ACRONYMS = new Set(['NDW', 'EBM', 'WGT', 'DAB', 'RNB', 'DJ', 'UK', 'US']);

// Function to turn the site's shouty titles (80s80s IN THE MIX) into the casing the
// playlist already uses (80s80s In The Mix)
function formatTitle(title) {
    return title
        .trim()
        .split(/\s+/)
        .map(word => {
            if (ACRONYMS.has(word) || word !== word.toUpperCase() || !/[A-Z]/.test(word)) {
                return word;
            }
            return word.charAt(0) + word.slice(1).toLowerCase();
        })
        .join(' ');
}

// Function to read the playlist that is already on disk
function readExistingEntries(m3uPath) {
    if (!fs.existsSync(m3uPath)) {
        return [];
    }

    const lines = fs.readFileSync(m3uPath, 'utf8').split('\n');
    const entries = [];

    for (let index = 0; index < lines.length; index++) {
        if (!lines[index].startsWith('#EXTINF')) {
            continue;
        }

        const url = (lines[index + 1] || '').trim();
        if (!url || url.startsWith('#')) {
            continue;
        }

        const attributes = {};
        const pattern = /([\w-]+)="([^"]*)"/g;
        let match;
        while ((match = pattern.exec(lines[index])) !== null) {
            attributes[match[1]] = match[2];
        }

        // The name is whatever follows the last attribute, so this copes with the
        // stray comma the older hand-written entries have after #EXTINF:-1
        const lastQuote = lines[index].lastIndexOf('"');
        const tail = lastQuote === -1
            ? lines[index].slice(lines[index].indexOf(',') + 1)
            : lines[index].slice(lastQuote + 1);

        entries.push({
            name: tail.replace(/^,/, '').trim(),
            attributes,
            url,
            key: streamKey(url)
        });
    }

    return entries;
}

// Function to pull the first matching value out of a nested api payload
function findDeep(node, predicate, depth = 0) {
    if (depth > 12 || node === null || typeof node !== 'object') {
        return undefined;
    }

    if (!Array.isArray(node)) {
        const hit = predicate(node);
        if (hit !== undefined) {
            return hit;
        }
    }

    for (const value of Array.isArray(node) ? node : Object.values(node)) {
        const found = findDeep(value, predicate, depth + 1);
        if (found !== undefined) {
            return found;
        }
    }

    return undefined;
}

// Function to list every station the site advertises
async function fetchIndex() {
    const index = await fetchJsonWithRetries(INDEX_URL, 'streams index');
    const stations = [];
    const seen = new Set();

    (index.sections || []).forEach(section => {
        (section.teasers || []).forEach(teaser => {
            const alias = (teaser.path || {}).alias;
            // The site lists a couple of stations twice across sections
            if (!alias || seen.has(alias)) {
                return;
            }
            seen.add(alias);
            stations.push({ title: teaser.title || alias, alias });
        });
    });

    return stations;
}

// Function to fetch one station and pick out its stream url and artwork
async function fetchStation(station) {
    const payload = await fetchJsonWithRetries(`${SITE}/api${station.alias}`, station.alias);

    const stream = findDeep(payload, node =>
        (node.audiotheque_channel_urls || {}).high || undefined);

    // The square derivatives are automated centre crops that cut the logo in half,
    // so the 16:9 original is the one worth linking to
    const logo = findDeep(payload, node =>
        (node.uri || {}).url && /images\.80s80s\.de/.test(node.uri.url) ? node.uri.url : undefined);

    return {
        title: payload.title || station.title,
        alias: station.alias,
        stream: stream ? stream.trim() : null,
        logo: logo || null
    };
}

// Function to run the station fetches a few at a time
async function runPool(items, worker) {
    const results = [];
    let nextIndex = 0;

    const runners = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            results[index] = await worker(items[index]);
        }
    });

    await Promise.all(runners);
    return results;
}

// Function to render one playlist entry, with the attributes before the comma and
// the station name after it
function renderEntry(entry) {
    const attributes = ATTRIBUTE_ORDER
        .filter(name => entry.attributes[name])
        .map(name => `${name}="${entry.attributes[name]}"`)
        .join(' ');

    return `#EXTINF:-1 ${attributes},${entry.name}\n${entry.url}`;
}

// Main function to rebuild the playlist from the site
async function fetch80s80sStations() {
    const m3uPath = path.join(__dirname, '..', 'm3u', 'stations', '80s80s.m3u');

    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const prune = args.includes('--prune');

    if (dryRun) {
        console.log('Dry run — nothing will be written.\n');
    }

    let index;
    try {
        index = await fetchIndex();
    } catch (error) {
        console.error(`✗ Could not fetch the station list: ${error.message} — nothing changed`);
        process.exitCode = 1;
        return;
    }

    if (index.length === 0) {
        console.error('✗ The station list came back empty — nothing changed');
        process.exitCode = 1;
        return;
    }

    console.log(`${plural(index.length, 'station')} listed on ${SITE}, fetching each …\n`);

    const fetched = await runPool(index, async station => {
        try {
            return await fetchStation(station);
        } catch (error) {
            console.error(`✗ ${station.alias}: ${error.message}`);
            return null;
        }
    });

    const existing = readExistingEntries(m3uPath);
    const existingByKey = new Map(existing.map(entry => [entry.key, entry]));

    const kept = [];
    const added = [];
    const updated = [];
    const skipped = [];
    const matchedKeys = new Set();

    fetched.filter(Boolean).forEach(station => {
        if (!station.stream) {
            skipped.push(`${station.title} (no stream url in the api)`);
            return;
        }

        const key = streamKey(station.stream);
        const previous = existingByKey.get(key);
        matchedKeys.add(key);

        if (previous) {
            // Keep the editorial fields, refresh what the site owns
            const before = JSON.stringify([previous.attributes['tvg-logo'], previous.url]);
            previous.attributes['tvg-logo'] = station.logo || previous.attributes['tvg-logo'] || '';
            previous.url = station.stream;
            if (JSON.stringify([previous.attributes['tvg-logo'], previous.url]) !== before) {
                updated.push(previous.name);
            }
            kept.push(previous);
            return;
        }

        const entry = {
            name: formatTitle(station.title),
            attributes: {
                'tvg-country': DEFAULT_COUNTRY,
                'tvg-popularity': DEFAULT_POPULARITY,
                'tvg-logo': station.logo || '',
                'group-title': DEFAULT_GROUP,
                'feed-title': FEED_TITLE
            },
            url: station.stream,
            key
        };
        added.push(entry.name);
        kept.push(entry);
    });

    // Anything already in the playlist that the site no longer lists
    const orphans = existing.filter(entry => !matchedKeys.has(entry.key));

    // Preserve the order of the file, then append whatever is new
    const ordered = existing
        .filter(entry => matchedKeys.has(entry.key))
        .concat(prune ? [] : orphans)
        .concat(kept.filter(entry => !existing.includes(entry)));

    const contents = `#EXTM3U\n${ordered.map(renderEntry).join('\n')}\n`;
    const changed = !fs.existsSync(m3uPath) || fs.readFileSync(m3uPath, 'utf8') !== contents;

    if (changed && !dryRun) {
        fs.writeFileSync(m3uPath, contents, 'utf8');
    }

    added.forEach(name => console.log(`+ ${name}`));
    updated.forEach(name => console.log(`↻ ${name}`));
    orphans.forEach(entry => console.log(`${prune ? '−' : '?'} ${entry.name} — not listed on the site${prune ? ' — removed' : ' — kept'}`));
    skipped.forEach(note => console.log(`✗ ${note}`));

    console.log(`\n${ordered.length} entries: ${added.length} added, ${updated.length} updated, ${orphans.length} not on the site${prune ? ' (removed)' : ' (kept)'}.`);
    if (!changed) {
        console.log('80s80s.m3u is already up to date.');
    }
    if (skipped.length > 0) {
        console.log(`${plural(skipped.length, 'station')} had no stream url and were left out.`);
    }
    if (dryRun) {
        console.log('\nDry run — nothing was written.');
    }
}

// Run the update
fetch80s80sStations();
