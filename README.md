# Brain Atlas

Brain Atlas is an Obsidian plugin that renders your vault as an animated 3D anatomical brain. Notes become nodes, links become neural pathways, and note types are grouped into brain regions.

The animated preview below uses synthetic demo vault data.

![Brain Atlas rotating as an animated 3D anatomical brain](assets/brain-atlas-spin.gif)

![Brain Atlas vault graph rendered as a 3D anatomical brain](assets/brain-atlas-screenshot.jpg)

## Features

- Animated 3D brain view inside Obsidian.
- Vault-native graph data from `app.metadataCache`; no separate app or export step.
- Region mapping for projects, people, concepts, sources, daily notes, indexes, and related note kinds.
- Editable categorization settings for frontmatter keys, tag mappings, folder mappings, link inference, and the default category.
- Region override settings for placing specific notes, frontmatter values, or tags in specific anatomical regions.
- Region toggles for dimming or restoring anatomical lobes.
- Label toggle for hiding all canvas labels.
- Click a node to open the backing note.
- Drag a node to pin its position in the atlas.
- Local-only rendering. Brain Atlas does not send vault data to a server.

## Install

Brain Atlas is available in Obsidian's community plugin directory:

```text
https://community.obsidian.md/plugins/brain-atlas
```

1. Open `Settings -> Community plugins`.
2. Search for `Brain Atlas`.
3. Install and enable the plugin.
4. Run **Brain Atlas: Open atlas** from the command palette.

### Manual Install

1. Download these files from the latest repo version or release:
   - `manifest.json`
   - `main.js`
   - `styles.css`
2. In your vault, create:

   ```text
   .obsidian/plugins/brain-atlas/
   ```

3. Put the three downloaded files in that folder.
4. Reload Obsidian.
5. Enable `Brain Atlas` in `Settings -> Community plugins`.
6. Open the command palette and run `Brain Atlas: Open atlas`.

### Build from Source

```bash
npm install
npm test
npm run build
mkdir -p /path/to/your/vault/.obsidian/plugins/brain-atlas
cp manifest.json main.js styles.css /path/to/your/vault/.obsidian/plugins/brain-atlas/
```

Then reload Obsidian and enable the plugin.

## Usage

Run `Brain Atlas: Open atlas` from the command palette or click the brain ribbon icon.

Controls:

- Drag empty space to rotate.
- Drag a node to pin it in place.
- Scroll to zoom.
- Right-click to reset the camera.
- `Labels` toggles all canvas labels.
- `All` restores every region.
- `None` dims every region.
- `FRO`, `PAR`, `TEM`, `OCC`, `CER`, and `STM` toggle individual brain regions.

## How Notes Are Classified

Brain Atlas assigns each note to a lobe using this order:

1. Frontmatter keys: `kind`, `type`, or `category`.
2. Tags such as `#project`, `#person`, `#source`, `#daily`, or `#index`.
3. Folder names such as `Projects`, `People`, `Sources`, `Daily`, `Concepts`, or `Index`.
4. Date-like filenames for daily notes.
5. Link behavior inference, when enabled.
6. Fallback to the configured default category.

After a note is categorized, optional region overrides can place it in a specific anatomical region without changing its category or color. Region override precedence is:

1. Exact note path mappings, such as `Projects/Big Idea.md=frontal`.
2. Frontmatter region fields, such as `brain_region: temporal`.
3. Tag region mappings, such as `client=temporal`.
4. The default category-to-lobe mapping below.

You can edit the mapping in `Settings -> Brain Atlas -> Categorization`:

- `Default category` controls where unmatched notes go.
- `Infer categories from links` lets heavily connected unmatched notes use graph behavior as a hint.
- `Frontmatter fields` controls which frontmatter keys are checked for kind values.
- `Tag mappings` accepts one `tag=category` pair per line. Tags do not need `#`.
- `Folder mappings` accepts one `folder=category` pair per line. Folder names can match any path ancestor.

You can edit anatomical placement in `Settings -> Brain Atlas -> Region overrides`:

- `Frontmatter region keys` controls which frontmatter fields are checked for region names.
- `Tag region mappings` accepts one `tag=region` pair per line. Tags do not need `#`.
- `Note region mappings` accepts one `note/path.md=region` pair per line.
- Supported regions are `frontal`, `parietal`, `temporal`, `occipital`, `cerebellum`, and `stem`.

Default lobe mapping:

| Region | Notes |
| --- | --- |
| Frontal | projects, decisions, questions |
| Parietal | concepts, tools, work threads |
| Temporal | people, organizations |
| Occipital | sources, repos |
| Cerebellum | daily notes, incidents |
| Brain stem | indexes, routing notes |

## Privacy

Brain Atlas reads Obsidian's local vault metadata and renders it in a local canvas view. It enumerates Markdown files in the vault with Obsidian's vault API, then uses each note's path, basename, frontmatter, tags, links, and embeds from Obsidian's metadata cache to build the graph. It does not read full note contents, make network requests, upload vault data, or require an account.

Because note names and paths appear visually in the graph when labels are enabled, use the `Labels` toggle before screensharing if your vault contains private note titles.

## Development

```bash
npm install
npm test
npm run build
```

During development, you can copy `manifest.json`, `main.js`, and `styles.css` into a vault plugin folder after each build.

### Release

Release assets are built and attested by GitHub Actions. Do not upload locally built `main.js` or `styles.css` for public releases unless you are intentionally replacing the automated provenance flow.

1. Update the version in `manifest.json`, `package.json`, `package-lock.json`, and `versions.json`.
2. Run:

   ```bash
   npm test
   npm run build
   ```

3. Commit and push the version bump.
4. Create and push a semver tag that matches `manifest.json`, for example:

   ```bash
   git tag 0.1.4
   git push origin 0.1.4
   ```

5. The `Release` workflow creates or updates the GitHub release, uploads `manifest.json`, `main.js`, and `styles.css`, and generates artifact attestations for those assets.

For an existing release that needs assets rebuilt or re-attested, run the `Release` workflow manually with the `version` input set to the release tag, for example `0.1.3`.

To verify release asset provenance locally:

```bash
gh attestation verify main.js -R colorpulse6/brain-atlas
gh attestation verify manifest.json -R colorpulse6/brain-atlas
gh attestation verify styles.css -R colorpulse6/brain-atlas
```

### Demo Capture

The README animation is generated from synthetic data, not a real vault:

```bash
npm run demo:build
open demo/index.html
```

## License

MIT
