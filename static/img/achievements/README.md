Naming rules for achievement icons

- Place icons here: static/img/achievements/
- You can use PNG (preferred) or SVG (fallback supported)
- Filenames tried in order for each achievement A with key = (a.key | a.code | a.group | a.iconKey | slug(a.name)) and state ∈ {locked, bronze, silver, gold}:
  1) <key>-<state>.png
  2) <key>-<icon>.png (legacy)
  3) <state>.png
  4) placeholder.png
  5) All above with .svg extension as additional fallbacks

Examples:
- streak-locked.png, streak-bronze.png, streak-silver.png, streak-gold.png
- invites-gold.png
- silver.png (generic)
