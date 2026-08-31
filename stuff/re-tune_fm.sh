# get the list of everything from the sitemap
curl -s https://retunefm.com/sitemap-stations-1.xml | htmlq loc -t | awk -F '/' '{print $5}' > list.txt 

# scrape everything
while read id ; do echo "Processing ID: $id" ; curl -s "https://retunefm.com/radio/$id/" > mep1 ; title=$(htmlq h1 -t < mep1 | sed 's/ — listen online//') ; stream=$(grep -oP '(?<=;stream&quot;:&quot;)[^&]*' mep1 | head -n1) ; grep -oP '(Country|Language|Genres)</td><td[^>]*>\K[^<]+' mep1 | while read value ; do echo "$value" | tr ',' '\n' | sed 's/^ *// ; s/ *$// ; s/ /_/g ; s/[^a-zA-Z0-9_]/_/g' | while read val ; do [ -n "$val" ] && (echo "#EXTINF:-1,$title" >> "$val.m3u" ; echo "$stream" >> "$val.m3u") ; done ; done ; done < list.txt

# make the playlist proper by adding the header
for file in *.m3u; do sed -i '1s/^/#EXTM3U\n/' "$file"; done