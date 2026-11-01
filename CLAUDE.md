# Zom's HaRM

Zom's HaRM is a ZomBeatz Media tool (hardware and rack manager).

- **Design and wording:** follow the ZomBeatz design system: https://github.com/ZomBeatz/zombeatz-docs/blob/main/design/DESIGN.md (tokens in `design/tokens.css` there; locally `../zombeatz-docs/design/`).
- **The guide** (`GUIDE.md`) is published in the zombeatz-docs repository as separate pages under `site/harm/` (installing, first start, everyday use, backups, troubleshooting, security). When a feature changes, update `GUIDE.md` and the matching page there.
- **The interface** is TypeScript + React in `ui/` (Vite, like Zomello). After changing it, run `npm run build` in `ui/` and commit `harm/static/app/` with it (CI fails when the build is out of date). After changing fields in `harm/models.py`, run `python3 scripts/gen-ui-types.py`.
