# Diagram Catalogue

Every PlantUML diagram embedded in the guide has its source here so it can be re-rendered, edited, or reused in slides.

## Rendering

```bash
# One-time: download PlantUML (needs Java 17+ and Graphviz for some diagram types)
curl -L -o plantuml.jar https://github.com/plantuml/plantuml/releases/latest/download/plantuml.jar

# Render every diagram to PNG and SVG next to its source
java -jar plantuml.jar -tpng diagrams/*.puml
java -jar plantuml.jar -tsvg diagrams/*.puml

# Or use the helper script
./diagrams/render.sh
```

Mermaid diagrams are embedded directly in the chapters and render natively on GitHub, GitLab, VS Code (with the
Markdown Preview Mermaid Support extension), Obsidian, and most documentation sites.
To export Mermaid to images use `npx @mermaid-js/mermaid-cli -i chapter.md -o out.md`.

## Naming

`<chapter-slug>-<diagram-slug>.puml`, for example `cluster-architecture-replication-sequence.puml`.

## Index

Run `ls diagrams/*.puml` for the current list. The index below is refreshed when chapters are added.
