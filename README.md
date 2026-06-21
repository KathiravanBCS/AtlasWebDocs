# AtlasWebDocs

A comprehensive documentation and education platform built with [Mintlify](https://mintlify.com). The
navbar has a **dropdown menu per category** (Programming, Web Designing, Mobile
Application, Office Automation, Database, More), the home page is a **catalog of all
the languages**, and every technology has **one rich documentation page** — intro,
setup, core concepts, and runnable examples.

## Prerequisites

- Node.js 20.9+

## Local development

```bash
npm install
npm run dev
```

This runs `mint dev` and serves the docs at `http://localhost:3000`.

> You can also run it without a local install: `npx mint dev`.

## Scripts

| Script            | Command            | Purpose                          |
| ----------------- | ------------------ | -------------------------------- |
| `npm run dev`     | `mint dev`         | Start the local docs server      |
| `npm run build`   | `mint build`       | Build / validate the docs        |
| `npm run check`   | `mint broken-links`| Report broken internal links     |
| `npm run upgrade` | `mint update`      | Update the Mintlify CLI          |

## Project structure

```
atlasweb-docs/
├── docs.json              # Mintlify config: theme, colors, navbar dropdowns
├── favicon.svg
├── logo/                  # light.svg / dark.svg / awds tab logo without bg.svg
├── index.mdx              # Catalog home — every course, by category
├── bootcamp.mdx           # Guided beginner → full-stack path
└── feature/               # All course content lives here
    ├── programming/       # C, C++, Java, Python, C#
    ├── web/               # HTML, HTML5, CSS, Bootstrap 3/5, JS, jQuery,
    │                      # Node.js, React, PHP, PHP FPDF, Laravel, Django, Flask
    ├── mobile/            # Android, Flutter
    ├── office/            # MS Word, Excel, PowerPoint, Photoshop, Tally
    ├── database/          # MySQL, Oracle, MongoDB
    ├── more/              # Data Structures, Git & GitHub
    └── reference/         # Mintlify expert guide
```

## How the navigation works

The navbar dropdowns come from `navigation.dropdowns` in `docs.json`. Each dropdown
is a category; each `group` inside it is a labeled cluster of pages, and each page is
an `.mdx` file referenced **without its extension** (e.g. `"web/react"` →
`web/react.mdx`).

To add a course:

1. Create the `.mdx` file (e.g. `feature/web/svelte.mdx`) with `title` /
   `description` frontmatter.
2. Add its path (e.g. `"feature/web/svelte"`) to the right `dropdown` → `group` →
   `pages` array in `docs.json`.
3. Add a `<Card>` for it on `index.mdx` so it shows in the catalog.

`Bootcamp` and `Udemy` are plain navbar items defined under `navbar.links`.

## Branding

Indigo primary color (`#4f46e5`), a `</>` code-mark logo, and a `system` default
appearance (light/dark with OS detection). Swap the SVGs in `logo/` and the `colors`
in `docs.json` to rebrand.

## Deploying

Mintlify deploys via its GitHub app or dashboard. Point it at this folder, and it
builds from `docs.json`. See the
[Mintlify deployment docs](https://mintlify.com/docs/deployment).
