#!/bin/bash

# cd in to the folder, duh

# remove old cruddy everything files
rm everything-full.m3u everything-lite.m3u randomized.m3u sorted.m3u

# insert filenames as playlist title and put them in a big file with duplicates
for i in $(ls -v) ; do echo '#PLAYLIST: '$i | cat - $i | sed 's/#EXTM3U//g' | awk NF >> everything-full.txt ; done

# add #EXTM3U to the first line and change the text file to a m3u file format
#cat everything-full.txt | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' | sed '1s/^/#EXTM3U\n/' > everything-full.m3u
cat everything-full.txt | grep -E '^(http|#)' | awk '!seen[$0]++' | sed '1s/^/#EXTM3U\n/' > everything-full.m3u

# read the full file and remove all extra stuff, we just need the links
cat everything-full.m3u | sed -n '/^#/!p' > everything-lite.m3u

# shuffle the lite file
cat everything-lite.m3u | shuf > randomized.m3u

# sort the lite file
cat everything-lite.m3u | sort > sorted.m3u

# for new everything-repo files
#for i in AA-*.txt ; do cat $i | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; echo -e $i ; done
cat everything.txt | awk '!seen[$0]++{if(p&&/^https?:\/\//){print l;print}if($0~/^#EXTINF:/){p=1;l=$0;next}{p=0}}' > every2.m3u

# for everything-repo streams
# copy all of the everything-full files to a folder and change their names to avoid substitution
for i in *.m3u ; do cat $i >> every.txt ; done

# remove duplicates
cat every.txt | awk '!seen[$0]++' > every.m3u

# remove stream info
cat every.m3u | sed -n '/^#/!p' | sort > lite.m3u

# for root playlists
for f in *.m3u; do (head -n 1 "$f"; tail -n +2 "$f" | paste - - | shuf | tr '\t' '\n' | head -n 2000) > "$f.tmp" && mv "$f.tmp" "$f"; done

# suffle without losing order
for f in *.m3u; do (head -n 1 "$f"; tail -n +2 "$f" | paste - - | shuf | tr '\t' '\n') > "$f.tmp" && mv "$f.tmp" "$f"; done

# cut to 2001 lines (1000 streams)
for f in *; do [ -f "$f" ] && head -n 2001 "$f" > "$f.tmp" && mv "$f.tmp" "$f"; done
