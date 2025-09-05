const fs = require('fs');
const path = require('path');

// Function to format filename by replacing underscores with spaces and capitalizing
function formatFileName(filename) {
    return filename
        .replace(/_/g, ' ')
        .replace(/\b\w/g, l => l.toUpperCase());
}

// Function to convert JSON to M3U format
function convertJsonToM3u(jsonData, filename) {
    const formattedName = formatFileName(filename);
    let m3uContent = '#EXTM3U\n';
    
    // Process each station in the JSON data
    jsonData.forEach(category => {
        if (category.stations && Array.isArray(category.stations)) {
            category.stations.forEach(station => {
                // Skip if no stream_url_app
                if (!station.stream_url_app) {
                    return;
                }
                
                // Build the EXTINF line
                let extinfLine = '#EXTINF:-1';
                
                // Add tvg-country
                extinfLine += ' tvg-country="World"';
                
                // Add tvg-popularity
                extinfLine += ' tvg-popularity="1"';
                
                // Add tvg-logo with prepended URL
                if (station.logo) {
                    extinfLine += ` tvg-logo="https://manager.uber.radio/static/uploads/station/${station.logo}"`;
                }
                
                // Add group-title and feed-title using formatted filename
                extinfLine += ` group-title="${formattedName}"`;
                extinfLine += ` feed-title="${formattedName}"`;
                
                // Add station name
                extinfLine += `,${station.name}`;
                
                // Add the stream URL
                const streamUrl = station.stream_url_app;
                
                // Add to M3U content
                m3uContent += extinfLine + '\n';
                m3uContent += streamUrl + '\n';
            });
        }
    });
    
    return m3uContent;
}

// Main function to process all JSON files
async function convertAllJsonFiles() {
    const jsonDir = path.join(__dirname, '..', 'json', 'stations');
    const m3uDir = path.join(__dirname, '..', 'm3u', 'stations');
    
    // Ensure m3u/stations directory exists
    if (!fs.existsSync(m3uDir)) {
        fs.mkdirSync(m3uDir, { recursive: true });
    }
    
    try {
        // Read all JSON files from the stations directory
        const files = fs.readdirSync(jsonDir);
        const jsonFiles = files.filter(file => file.endsWith('.json'));
        
        console.log(`Found ${jsonFiles.length} JSON files to convert:`);
        
        for (const jsonFile of jsonFiles) {
            const jsonPath = path.join(jsonDir, jsonFile);
            const m3uFileName = jsonFile.replace('.json', '.m3u');
            const m3uPath = path.join(m3uDir, m3uFileName);
            
            try {
                // Read and parse JSON file
                const jsonContent = fs.readFileSync(jsonPath, 'utf8');
                const jsonData = JSON.parse(jsonContent);
                
                // Convert to M3U format
                const m3uContent = convertJsonToM3u(jsonData, jsonFile.replace('.json', ''));
                
                // Write M3U file
                fs.writeFileSync(m3uPath, m3uContent, 'utf8');
                
                console.log(`✓ Converted: ${jsonFile} → ${m3uFileName}`);
            } catch (error) {
                console.error(`✗ Error converting ${jsonFile}:`, error.message);
            }
        }
        
        console.log('\nConversion completed!');
        
    } catch (error) {
        console.error('Error reading directory:', error.message);
    }
}

// Run the conversion
convertAllJsonFiles();
