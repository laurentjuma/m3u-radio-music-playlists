the playlists in here come from [you.radio](https://you.radio), which serves its data from a json api at `https://manager.uber.radio/api/public` rather than a page you can scrape

the scripts in `script/` pull that api down, keep the catalogue honest against it, and render the m3u files, all with plain node and no dependencies

<br>

### quick start

```bash
cd script
node update_all.js --dry-run   # see what would change, write nothing
node update_all.js             # do it
```

that's the only entry point you need, it runs the three steps below in order and stops at the first failure, the scripts don't care what directory you call them from

<br>

### how it fits together

```
/api/public/brand ─────────> json/brand.json
                                  │
                                  │ ① decides which rows are allowed to exist
                                  ▼
                        json/stations_categories.json
                                  │
                                  │ ② one fetch per row, using its genre_id
                                  ▼
                          json/stations/*.json
                                  │
                                  │ ③ render
                                  ▼
                           m3u/stations/*.m3u
```

**① `sync_stations_categories.js`** — decides *what should exist*. refreshes `brand.json` from the api, then walks the `brands.genres` list in `stations_categories.json` and drops any row whose brand is no longer live, it also re-points each surviving row's logo at the current artwork

it never adds rows, a row's `name` and `genre_m3u_id` are hand-written and can't be derived from the api, so new genres are only reported and you add the ones you want yourself

**② `fetch_stations_json.js`** — decides *what's in each playlist*. reads `brands.genres` as its worklist and downloads one genre per row into `json/stations/`, four at a time

**③ `convert_json_to_m3u.js`** — renders every file in `json/stations/` into `m3u/stations/`

`you_radio_api.js` isn't a script, it's the shared http bit the others use (endpoints, retries, timeouts, json formatting)

the order matters, ① edits the file ② uses as its worklist, run them backwards and you'll waste requests on genres that are about to be deleted

**`fetch_brand_descriptions.js`** sits outside the three steps, it fills in `description` and `description_long` on every `brands.genres` row and nothing downstream depends on it, run it when you add a row or when the copy upstream changes

descriptions don't come from one place, a row with a `genre_id` takes the brand's `meta_description` and `description` from the api, the three hand-made rows get theirs scraped off the broadcaster's own front page, see below for why it's split that way

<br>

### the files

| path | what it is |
| --- | --- |
| `json/brand.json` | the brand roster straight from the api, this is the source of truth for what belongs in the catalogue |
| `json/stations_categories.json` | the catalogue, `countries` is hand-maintained, `brands.genres` is reconciled by ① |
| `json/stations/*.json` | one genre per file with all its stations, downloaded by ② |
| `m3u/stations/*.m3u` | the playlists, rendered by ③ |

<br>

### what a catalogue row looks like

```json
{
    "name": "Just Jazz Radio",
    "description": "Immerse yourself in smooth jazz music on Just Jazz radio. Enjoy legendary jazz tracks without ads or interruptions.",
    "description_long": "<p>Welcome to Just Jazz, your ultimate destination for jazz music that never sleeps…</p><p>…</p>",
    "genre_id": "94",
    "logo": "brand/cc0e8fa8-5d32-4cfe-8c82-e0195e854171.png",
    "genre_m3u_id": "just_jazz_radio.m3u"
}
```

`genre_id` is the api's genre id, stick it on the end of `brands.genre_link` to get the source data, it is **not** a brand id

`description` is one plain sentence, `description_long` is the same brand's full copy carried through byte for byte from the api, **it is html** and rendering it is the client's job, it isn't only `<p>` runs either, country and greatest hits use `<h3>` section headings and billionz club has an `<h1>` and a `<ul>` of 50 track titles

both are filled in by `fetch_brand_descriptions.js` and both describe the **brand**, not the row, so the eight tick tock decades all carry the same text, there is no per-decade copy anywhere upstream to use instead

the three hand-made rows have a `description` and no `description_long` at all, only a brand record carries long copy

`genre_m3u_id` names both the playlist and its source (`just_jazz_radio.m3u` ⇢ `json/stations/just_jazz_radio.json`)

`name` is a display label you write yourself, the api's own names don't match (its brand 22 is called `Jazz`, brand 14 is `Every Year`)

`logo` hangs off `brands.logo_link`, most rows use `brand/` + the brand's logo, the eight tick tock decades use `genre/` + their own genre logo instead because they all share one brand and would otherwise look identical, ① keeps whichever prefix a row already has

<br>

### things worth knowing

brands fan out to more genres than we track, exclusive radio alone has 24, we keep its `all stations` genre and ignore the rest, ① prints the untracked ones after every run so you can see what's on offer

three rows (`90s90s`, `80s80s`, `100 fm`) have no `genre_id` at all, they're hand-made playlists from other broadcasters and nothing in the pipeline touches them, don't add a `genre_id` to them

③ globs `json/stations/` and doesn't read the catalogue, so when ① removes a row its downloaded json and playlist stay behind and keep getting rendered from stale data, ① lists the leftover files after a run and deleting them is left to you on purpose

every station gets `tvg-country="United Arab Emirates"`, it's hardcoded in ③ because the station records don't carry a country

the brand websites in `brand.json` are mostly gone, of the eighteen only `positivity.radio` still serves a meta description, the rest are dead dns, http 525 or a js shell with nothing in the head, so `fetch_brand_descriptions.js` reads the api's `meta_description` for those rows instead, it's the same tag those sites would have rendered and it's the copy that still resolves

the three hand-made rows are the other way round, they have no api record but their sites are real, so they get scraped, their urls live in `HAND_MADE_SITES` at the top of the script because nothing in the catalogue says where they come from

a scraped description comes back in the site's own language, `90s90s` is german and `100 fm` is hebrew, that's what the broadcaster wrote and the script doesn't translate it

nothing overwrites a good file with a bad response, ① won't write at all if either fetch fails, and ② keeps the existing file whenever a genre fails or comes back empty, if a genre really has been emptied upstream and you want that recorded, pass `--allow-empty`

<br>

### flags

```bash
node update_all.js --dry-run                 # preview the reconcile only
node update_all.js --keep-logos              # don't touch logos
node update_all.js --allow-empty             # accept genres with no stations

node sync_stations_categories.js --dry-run   # steps can be run on their own too
node fetch_stations_json.js just_jazz_radio  # one genre, by file name, genre id or name

node fetch_brand_descriptions.js --dry-run      # show the copy it would write
node fetch_brand_descriptions.js --only-missing # leave rows that already have both alone
```

everything is idempotent, a second run tells you it's already up to date
