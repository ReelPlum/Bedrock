# Spell-check dictionary

`en.aff` and `en.dic.gz`: an English Hunspell dictionary that accepts both
American and British spellings. It is the en_US and en_GB-ise dictionaries
from SCOWL (Spell Checker Oriented Word Lists, size 60, version 2020.12.07,
by Kevin Atkinson, <http://wordlist.aspell.net>), as packaged in the npm
packages `dictionary-en` 4.0.0 and `dictionary-en-gb` 3.0.0. Both use the
same affix file, so their word lists are merged into one:

```sh
(tail -n +2 en_US.dic; tail -n +2 en_GB.dic) | LC_ALL=C sort -u > body
(wc -l < body; cat body) | gzip -9n > en.dic.gz
```

Copyright and permission notices: `LICENSE-en_US.txt` and
`LICENSE-en_GB.txt` (the same sources; they must be shipped with the
dictionary). Commercial use is allowed.

Any Hunspell dictionary works the same way (`.aff` plus `.dic`), so other
languages can be added from the LibreOffice or wooorm/dictionaries
collections after checking their licences.
