#!/usr/bin/env bash
# Render all PlantUML sources in this directory to PNG and SVG.
set -euo pipefail
cd "$(dirname "$0")"
JAR="${PLANTUML_JAR:-plantuml.jar}"
if [ ! -f "$JAR" ]; then
  echo "Downloading PlantUML..."
  curl -L -o "$JAR" https://github.com/plantuml/plantuml/releases/latest/download/plantuml.jar
fi
mkdir -p rendered
java -jar "$JAR" -tpng -o rendered ./*.puml
java -jar "$JAR" -tsvg -o rendered ./*.puml
echo "Rendered $(ls ./*.puml | wc -l) diagrams into diagrams/rendered/"
