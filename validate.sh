#!/usr/bin/env bash
# Validate Bite's HTML and CSS with the official W3C validators.
# Usage: ./validate.sh        (needs an internet connection; sends the files to W3C)
# Exit code is the number of files with errors, so 0 means everything passed.

cd "$(dirname "$0")/bite" || exit 1
failed=0

read -r -d '' PARSE_HTML <<'PY'
import json, sys
name = sys.argv[1]
try:
    msgs = json.load(sys.stdin)["messages"]
except Exception:
    print(f"  ?  {name}: could not read the validator's reply (try again in a minute)")
    sys.exit(2)
errors = [m for m in msgs if m["type"] == "error"]
warnings = [m for m in msgs if m["type"] == "info" and m.get("subType") == "warning"]
mark = "✗" if errors else "✓"
print(f"  {mark}  {name}: {len(errors)} errors, {len(warnings)} warnings")
for m in errors + warnings:
    kind = "error  " if m["type"] == "error" else "warning"
    print(f"       line {m.get('lastLine', '?'):>4}  {kind}  {m['message']}")
sys.exit(1 if errors else 0)
PY

read -r -d '' PARSE_CSS <<'PY'
import json, sys
try:
    d = json.load(sys.stdin)["cssvalidation"]
except Exception:
    print("  ?  css/style.css: could not read the validator's reply (try again in a minute)")
    sys.exit(2)
errors = d.get("errors", [])
warnings = d.get("warnings", [])
# var() always triggers this notice; it is expected when using custom properties
var_notes = [w for w in warnings if "CSS variables" in w.get("message", "")]
other = [w for w in warnings if w not in var_notes]
mark = "✗" if errors else "✓"
print(f"  {mark}  css/style.css: {len(errors)} errors, {len(other)} warnings"
      f" (+{len(var_notes)} expected 'CSS variables are not statically checked' notices)")
for e in errors:
    print(f"       line {e.get('line', '?'):>4}  error    {e.get('message', '').strip()}")
for w in other:
    print(f"       line {w.get('line', '?'):>4}  warning  {w.get('message', '').strip()}")
sys.exit(1 if errors else 0)
PY

echo "HTML (validator.w3.org/nu)"
for f in *.html; do
  curl -s -H "Content-Type: text/html; charset=utf-8" --data-binary @"$f" \
    "https://validator.w3.org/nu/?out=json" | python3 -c "$PARSE_HTML" "$f" || failed=$((failed + 1))
done

echo
echo "CSS (jigsaw.w3.org/css-validator)"
curl -s -F "file=@css/style.css;type=text/css" -F "output=json" -F "profile=css3svg" -F "warning=1" \
  "https://jigsaw.w3.org/css-validator/validator" | python3 -c "$PARSE_CSS" || failed=$((failed + 1))

echo
if [ "$failed" -eq 0 ]; then echo "All files pass."; else echo "$failed file(s) need fixing."; fi
exit "$failed"
