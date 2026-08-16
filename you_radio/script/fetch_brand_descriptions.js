const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { API, fetchJsonWithRetries, serialiseJson, plural } = require('./you_radio_api');

// Fills in the descriptions on every row in brands.genres of stations_categories.json:
// `description` is one plain sentence, `description_long` is the brand's full copy as the
// API serves it, html and all, for the client to render.
//
// The text comes from whichever website owns the row, but "fetch the page and read its
// meta description" only works for the hand-made rows. The you.radio brand sites are
// almost all gone (dead DNS, HTTP 525, or a JS shell with no meta tags), so for a brand
// row the description is taken from the brand record the API serves, whose
// meta_description is the very tag those sites would have rendered. Two sources, same
// text, and the API one is the one that still resolves.
//
//   brand row (has genre_id)   /api/public/brand → meta_description, description
//   hand-made row (no genre_id) the broadcaster's own site → <meta name="description">
//
// Only a brand record carries long copy, so the three hand-made rows get a `description`
// and no `description_long`. Nothing on their sites is a description rather than a page.
//
// A brand row is mapped to its brand through its genre: json/stations/<row>.json already
// carries brand_id, and only a row with no such file costs a genre request.
//
//   node fetch_brand_descriptions.js               refresh every description and write
//   node fetch_brand_descriptions.js --dry-run     report what would change, write nothing
//   node fetch_brand_descriptions.js --only-missing leave rows that already have both alone

// The hand-made rows are not you.radio brands, so nothing in the data says where they
// come from. 80s80s matches the SITE that fetch_80s80s_stations.js already walks.
const HAND_MADE_SITES = {
    '90s90s.m3u': 'https://90s90s.de/',
    '80s80s.m3u': 'https://www.80s80s.de/',
    '100fm.m3u': 'https://www.100fm.co.il/'
};

const REQUEST_TIMEOUT_MS = 30000;
const MAX_ATTEMPTS = 3;
// Sites that hand back a JS shell to anything that doesn't look like a browser
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// Function to fetch a page as text, following the redirects a site front page tends to have
function fetchHtml(url, redirectsLeft = 5) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('http:') ? http : https;
        const options = { headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,application/xhtml+xml' } };

        const request = client.get(url, options, response => {
            const { statusCode, headers } = response;

            if (statusCode >= 300 && statusCode < 400 && headers.location) {
                response.resume();
                if (redirectsLeft === 0) {
                    reject(new Error('too many redirects'));
                    return;
                }
                resolve(fetchHtml(new URL(headers.location, url).toString(), redirectsLeft - 1));
                return;
            }

            if (statusCode !== 200) {
                response.resume();
                reject(new Error(`HTTP ${statusCode}`));
                return;
            }

            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => {
                body += chunk;
                // The meta tags are in the head, the rest of a 400KB front page is not worth reading
                if (body.length > 400000) {
                    request.destroy();
                    resolve(body);
                }
            });
            response.on('error', reject);
            response.on('end', () => resolve(body));
        });

        request.setTimeout(REQUEST_TIMEOUT_MS, () => {
            request.destroy(new Error(`timed out after ${REQUEST_TIMEOUT_MS}ms`));
        });
        request.on('error', reject);
    });
}

// Function to retry a page fetch a few times before giving up on it
async function fetchHtmlWithRetries(url, label) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await fetchHtml(url);
        } catch (error) {
            if (attempt === MAX_ATTEMPTS) {
                throw error;
            }
            const delayMs = 1000 * attempt;
            console.log(`  … ${label}: ${error.message} — retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
}

// Function to turn the entities a page or a CMS leaves behind into the characters they stand for
function decodeEntities(text) {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

    return text
        .replace(/&#x([0-9a-f]+);/gi, (whole, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (whole, digits) => String.fromCodePoint(Number(digits)))
        .replace(/&([a-z]+);/gi, (whole, name) => named[name.toLowerCase()] || whole);
}

// Function to collapse the whitespace a description picks up from being laid out in a template
function tidy(text) {
    return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

// Function to read a page's own description out of its head
function readMetaDescription(html) {
    // og:description is the better written of the two often enough to be worth preferring
    for (const name of ['og:description', 'description']) {
        const tag = html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`, 'i'));
        if (!tag) {
            continue;
        }

        const content = tag[0].match(/content=["']([^"']*)["']/i);
        if (content && content[1].trim()) {
            return tidy(content[1]);
        }
    }

    return null;
}

// Function to fall back to the brand's long description when it has no meta_description.
// Only its opening sentence is a summary, the rest is the pitch.
function firstSentenceOf(html) {
    const text = tidy(html.replace(/<[^>]+>/g, ' '));
    if (!text) {
        return null;
    }

    const stop = text.match(/^.{40,300}?[.!?](?=\s|$)/);
    return stop ? stop[0] : text.slice(0, 300).trim();
}

// Function to pick both descriptions a brand record offers.
//
// The long one is copied through byte for byte, markup and all. It is not only <p> runs:
// there are <h1>-<h3> section headings, and Billions Club carries a <ul> of 50 track
// titles. Parsing it here would mean deciding what to do with each of those, so the
// decision is left to whoever renders it
function descriptionsFromBrand(brand) {
    const meta = (brand.meta_description || '').trim();
    const long = brand.description || '';

    return {
        short: meta ? tidy(meta) : (long ? firstSentenceOf(long) : null),
        long
    };
}

// Function to find the brand behind a row. The genre file already names it, so the large
// genre dump is only worth requesting for a row whose file has not been downloaded yet
async function findBrandId(row, stationsDir) {
    const genrePath = path.join(stationsDir, row.genre_m3u_id.replace(/\.m3u$/, '.json'));

    if (fs.existsSync(genrePath)) {
        try {
            const genres = JSON.parse(fs.readFileSync(genrePath, 'utf8'));
            const genre = Array.isArray(genres) ? genres[0] : genres;
            if (genre && genre.brand_id !== undefined) {
                return genre.brand_id;
            }
        } catch (error) {
            console.log(`  … ${row.genre_m3u_id}: unreadable genre file (${error.message}), asking the API`);
        }
    }

    const genre = await fetchJsonWithRetries(API.genre(row.genre_id), row.genre_m3u_id);
    const record = Array.isArray(genre) ? genre[0] : genre;

    if (!record || record.brand_id === undefined) {
        throw new Error(`genre ${row.genre_id} came back with no brand_id`);
    }

    return record.brand_id;
}

// Function to rewrite a row with the descriptions sitting under name, leaving the rest in
// place. A row with no long copy carries no description_long at all rather than an empty
// string, so nothing reading the catalogue has to tell the two apart
function withDescriptions(row, description, longCopy) {
    const rebuilt = {};

    const insert = () => {
        rebuilt.description = description;
        if (longCopy) {
            rebuilt.description_long = longCopy;
        }
    };

    for (const [key, value] of Object.entries(row)) {
        if (key === 'description' || key === 'description_long') {
            continue;
        }
        rebuilt[key] = value;
        if (key === 'name') {
            insert();
        }
    }

    // Only reachable for a row with no name, which nothing in the file has
    if (!('description' in rebuilt)) {
        insert();
    }

    return rebuilt;
}

// Main function to populate every brand row's description
async function fetchBrandDescriptions() {
    const jsonDir = path.join(__dirname, '..', 'json');
    const stationsDir = path.join(jsonDir, 'stations');
    const categoriesPath = path.join(jsonDir, 'stations_categories.json');

    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const onlyMissing = args.includes('--only-missing');

    if (dryRun) {
        console.log('Dry run — nothing will be written.\n');
    }

    let categories;
    try {
        categories = JSON.parse(fs.readFileSync(categoriesPath, 'utf8'));
    } catch (error) {
        console.error(`✗ Could not read stations_categories.json: ${error.message} — nothing changed`);
        process.exitCode = 1;
        return;
    }

    if (!categories.brands || !Array.isArray(categories.brands.genres)) {
        console.error('✗ stations_categories.json has no brands.genres array — nothing changed');
        process.exitCode = 1;
        return;
    }

    // The brand roster is where every brand row's text comes from, so there is no
    // point walking the rows if it cannot be had
    let brands;
    try {
        brands = await fetchJsonWithRetries(API.brands, 'brands');
    } catch (error) {
        console.error(`✗ Could not fetch brands: ${error.message} — nothing changed`);
        process.exitCode = 1;
        return;
    }

    if (!Array.isArray(brands) || brands.length === 0) {
        console.error('✗ Brand response was not a non-empty array — nothing changed');
        process.exitCode = 1;
        return;
    }

    const brandsById = new Map(brands.map(brand => [String(brand.id), brand]));
    console.log(`✓ ${plural(brands.length, 'brand')} upstream\n`);

    // One fetch per hand-made site, shared by any row pointing at it
    const scraped = new Map();
    const rows = [];
    const filled = [];
    const unchanged = [];
    const skipped = [];

    for (const row of categories.brands.genres) {
        // A hand-made row is complete with a description alone, there is no long copy
        // anywhere for it to be missing
        const wantsLong = Boolean(row.genre_id);
        const hasBoth = (row.description || '').trim() &&
            (!wantsLong || (row.description_long || '').trim());

        if (onlyMissing && hasBoth) {
            unchanged.push(row);
            rows.push(row);
            continue;
        }

        let description = null;
        let longCopy = '';
        let source = null;

        try {
            if (row.genre_id) {
                const brandId = await findBrandId(row, stationsDir);
                const brand = brandsById.get(String(brandId));

                if (!brand) {
                    throw new Error(`brand ${brandId} is not in the roster`);
                }

                const descriptions = descriptionsFromBrand(brand);
                description = descriptions.short;
                longCopy = descriptions.long;
                source = `brand ${brandId} ${brand.name}`;

                if (!description) {
                    throw new Error(`brand ${brandId} has no description text`);
                }
            } else {
                const site = HAND_MADE_SITES[row.genre_m3u_id];

                if (!site) {
                    throw new Error('hand-made row with no site in HAND_MADE_SITES');
                }

                if (!scraped.has(site)) {
                    scraped.set(site, readMetaDescription(await fetchHtmlWithRetries(site, row.genre_m3u_id)));
                }

                description = scraped.get(site);
                source = site;

                if (!description) {
                    throw new Error(`${site} serves no meta description`);
                }
            }
        } catch (error) {
            skipped.push(`${row.genre_m3u_id}: ${error.message}`);
            rows.push(row);
            continue;
        }

        const previous = (row.description || '').trim();
        const previousLong = row.description_long || '';
        const updated = withDescriptions(row, description, longCopy);
        rows.push(updated);

        if (previous === description && previousLong === longCopy) {
            unchanged.push(updated);
        } else {
            filled.push({ row: updated, previous, source, longCopy });
        }
    }

    filled.forEach(entry => {
        const verb = entry.previous ? '↻' : '+';
        const long = entry.longCopy ? `${entry.longCopy.length} chars of long copy` : 'no long copy';
        console.log(`${verb} ${entry.row.genre_m3u_id} — from ${entry.source} — ${long}`);
        console.log(`    ${entry.row.description}`);
    });

    categories.brands.genres = rows;

    const serialised = serialiseJson(categories);
    const changed = fs.readFileSync(categoriesPath, 'utf8') !== serialised;

    if (changed && !dryRun) {
        fs.writeFileSync(categoriesPath, serialised, 'utf8');
    }

    const withLong = rows.filter(row => (row.description_long || '').trim()).length;
    console.log(`\n${filled.length} rows written, ${unchanged.length} already current, ${skipped.length} skipped.`);
    console.log(`${withLong} of ${rows.length} rows carry long copy.`);

    if (skipped.length > 0) {
        console.log(`\n${plural(skipped.length, 'row')} left without a description:`);
        skipped.forEach(reason => console.log(`  - ${reason}`));
    }

    if (!changed) {
        console.log('stations_categories.json is already up to date.');
    }

    if (dryRun) {
        console.log('\nDry run — nothing was written.');
    }
}

// Run the population
fetchBrandDescriptions();
