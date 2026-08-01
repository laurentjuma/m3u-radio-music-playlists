const path = require('path');
const { spawn } = require('child_process');

// Runs the whole you.radio update in order and stops at the first failure.
//
//   1. sync_stations_categories.js  refresh brand.json, reconcile the catalogue against it
//   2. fetch_stations_json.js       download the stations for every catalogue row
//   3. convert_json_to_m3u.js       render the m3u playlists
//
// Step 1 edits the file step 2 reads as its worklist, so the order matters.
//
//   node update_all.js                 run all three
//   node update_all.js --dry-run       preview the reconcile only, write nothing
//   node update_all.js --keep-logos    pass --keep-logos through to step 1
//   node update_all.js --allow-empty   pass --allow-empty through to step 2

// Function to run one script as its own process, with its output streaming straight through
function runScript(scriptName, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(__dirname, scriptName), ...args], { stdio: 'inherit' });

        child.on('error', error => reject(new Error(`could not start ${scriptName}: ${error.message}`)));
        child.on('close', code => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(`${scriptName} exited with code ${code}`));
        });
    });
}

// Main function to run every step in order
async function updateAll() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');

    // Each step only gets the flags it understands, rather than everything passed here
    const syncArgs = args.filter(argument => argument === '--keep-logos');
    const fetchArgs = args.filter(argument => argument === '--allow-empty');

    // Steps 2 and 3 would act on a catalogue step 1 has not reconciled yet, so a dry
    // run stops after the preview instead of pretending the later steps can preview too
    const steps = dryRun
        ? [{ script: 'sync_stations_categories.js', args: ['--dry-run', ...syncArgs] }]
        : [
            { script: 'sync_stations_categories.js', args: syncArgs },
            { script: 'fetch_stations_json.js', args: fetchArgs },
            { script: 'convert_json_to_m3u.js', args: [] }
        ];

    if (dryRun) {
        console.log('Dry run — only the reconcile step runs, and it writes nothing.\n');
    }

    for (let index = 0; index < steps.length; index++) {
        const step = steps[index];
        console.log(`\n── ${index + 1}/${steps.length} ${step.script} ${'─'.repeat(Math.max(0, 46 - step.script.length))}`);

        try {
            await runScript(step.script, step.args);
        } catch (error) {
            console.error(`\n✗ ${error.message}`);

            const skipped = steps.slice(index + 1).map(remaining => remaining.script);
            if (skipped.length > 0) {
                console.error(`Stopped — did not run: ${skipped.join(', ')}`);
            }

            process.exitCode = 1;
            return;
        }
    }

    console.log(`\n── done ${'─'.repeat(46)}`);
    console.log(dryRun ? 'Preview finished, nothing was written.' : 'All steps completed.');
}

// Run every step
updateAll();
