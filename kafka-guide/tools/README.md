# Guide tooling

## Validate every Mermaid diagram

```bash
cd kafka-guide/tools
npm install mermaid@11 jsdom@24
node validate-mermaid.mjs ..
```

Prints one line per failing diagram with file, line, and parser message. Exit code 1 on any failure.

## Validate and render every PlantUML diagram

```bash
cd kafka-guide/diagrams
./render.sh            # downloads plantuml.jar on first run, renders PNG and SVG into diagrams/rendered/
java -jar plantuml.jar -checkonly *.puml   # syntax check only
```

## Count questions

```bash
grep -c '^### Q' kafka-guide/05-question-bank/*.md
grep -c '^### S' kafka-guide/05-question-bank/05-scenario-questions.md
```
