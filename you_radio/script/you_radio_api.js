const https = require('https');

// Shared you.radio API access for the scripts in this directory.
const API_BASE = 'https://manager.uber.radio/api/public';

const API = {
    // Every brand that still exists. This is the roster the rest is checked against
    brands: `${API_BASE}/brand`,
    // Every genre, each with its stations embedded. One large response (~25MB)
    genres: `${API_BASE}/station/genre`,
    // A single genre with its stations, in the shape json/stations/*.json uses
    genre: genreId => `${API_BASE}/station/genre/${genreId}`
};

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 60000;
const USER_AGENT = 'm3u-radio-music-playlists/you_radio';

// Function to fetch a URL and return its parsed JSON body
function fetchJson(url, redirectsLeft = 3) {
    return new Promise((resolve, reject) => {
        const options = { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' } };

        const request = https.get(url, options, response => {
            const { statusCode, headers } = response;

            // Follow redirects rather than parsing the redirect body as JSON
            if (statusCode >= 300 && statusCode < 400 && headers.location) {
                response.resume();
                if (redirectsLeft === 0) {
                    reject(new Error('too many redirects'));
                    return;
                }
                resolve(fetchJson(new URL(headers.location, url).toString(), redirectsLeft - 1));
                return;
            }

            if (statusCode !== 200) {
                response.resume();
                reject(new Error(`HTTP ${statusCode}`));
                return;
            }

            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('error', reject);
            response.on('end', () => {
                try {
                    resolve(JSON.parse(body));
                } catch (error) {
                    reject(new Error(`invalid JSON in ${body.length} byte response: ${error.message}`));
                }
            });
        });

        request.setTimeout(REQUEST_TIMEOUT_MS, () => {
            request.destroy(new Error(`timed out after ${REQUEST_TIMEOUT_MS}ms`));
        });
        request.on('error', reject);
    });
}

// Function to retry a fetch a few times before giving up on it
async function fetchJsonWithRetries(url, label) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await fetchJson(url);
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

// Function to serialise JSON the way the files in json/ are already formatted:
// four space indentation and no trailing newline
function serialiseJson(value) {
    return JSON.stringify(value, null, 4);
}

// Function to pluralise a counted noun for the log
function plural(count, noun) {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

module.exports = { API, fetchJson, fetchJsonWithRetries, serialiseJson, plural };
