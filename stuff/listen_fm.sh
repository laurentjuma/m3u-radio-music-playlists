# get the list of regions, countries, genres and languages
curl -s https://tingfm.com/explore > page.html
cat page.html | htmlq "#home-index > div.box.is-size-6 > div > div" a | sed -nE 's/.*href="https:\/\/tingfm\.com([^"]+)".*>([^<]+)<\/a>.*/\1___\2/p' | sed 's/^\///; s/ /_/g' | cut -c8- > regions.txt
cat page.html | htmlq "#home-index > div:nth-child(3) > div" a | sed -nE 's/.*href="https:\/\/tingfm\.com([^"]+)".*>([^ (]+)\s*\([^)]*\).*/\1___\2/p' | sed 's/^\///; s/ /_/g' | cut -c9- > countries.txt
cat page.html | htmlq -a href "#home-index > div:nth-child(4) > div" a | cut -c26- > genres.txt
cat page.html | htmlq -a href "#home-index > div:nth-child(5) > div" a | cut -c29- > languages.txt

# scrape the ids for each category
for i in $(cat genres.txt) ; do for j in "" /page/{2..25} ; do curl -s https://tingfm.com/genre/$i$j | htmlq -a href a | grep '/radio/' | awk -F '/' '{print $5}' >> A-$i.txt ; echo -e "$i - $j" ; done ; done
for i in $(cat languages.txt) ; do for j in "" /page/{2..25} ; do curl -s https://tingfm.com/language/$i$j | htmlq -a href a | grep '/radio/' | awk -F '/' '{print $5}' >> A-$i.txt ; echo -e "$i - $j" ; done ; done
for i in $(cat countries.txt) ; do for j in "" /page/{2..15} ; do curl -s https://tingfm.com/country/$(echo $i | awk -F '___' '{print $1}')$j | htmlq -a href a | grep '/radio/' | awk -F '/' '{print $5}' >> A-$(echo $i | awk -F '___' '{print $2}').txt ; echo -e "$i - $j" ; done ; done
for i in $(cat regions.txt) ; do for j in "" /page/{2..15} ; do curl -s https://tingfm.com/region/$(echo $i | awk -F '___' '{print $1}')$j | htmlq -a href a | grep '/radio/' | awk -F '/' '{print $5}' >> A-$(echo $i | awk -F '___' '{print $2}').txt ; echo -e "$i - $j" ; done ; done

# scrape everything
for i in A-*.txt ; do for j in $(cat $i) ; do curl -s https://tingfm.com/radio/$j > mep1 ; cat mep1 | htmlq -t h1 | awk NF | awk '{$1=$1}1' | awk '{print "#EXTINF:-1,"$0}' >> A$i ; cat mep1 | sed -n '131p' | htmlq span -t | sed 's/\;//g' | sed '/^$/d' >> A$i ; echo -e "$i - $j" ; done ; done

# remove duplicates
for i in AA-*.txt ; do cat $i | awk '!seen[$0]++' | grep -B1 "http" | grep -A1 "EXTINF" | awk 'length>4' > A$i ; echo -e $i ; done

# make the playlist proper by adding the header
for i in AAA-*.txt ; do sed '1s/^/#EXTM3U\n/' $i > $i.m3u ; done

# remove extra parts of the playlist names
for i in *.m3u ; do mv "$i" "`echo $i | sed -e 's/AAA-//' -e 's/.txt//'`" ; done