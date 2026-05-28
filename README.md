# Brain Atlas

Brain Atlas is an Obsidian plugin that renders your vault as an animated 3D anatomical brain. Notes become nodes, links become neural pathways, and note types are grouped into brain regions.

![Brain Atlas vault graph rendered as a 3D anatomical brain](assets/brain-atlas-screenshot.jpg)

## Features

- Animated 3D brain view inside Obsidian.
- Vault-native graph data from `app.metadataCache`; no separate app or export step.
- Region mapping for projects, people, concepts, sources, daily notes, indexes, and related note kinds.
- Region toggles for dimming or restoring anatomical lobes.
- Label toggle for hiding all canvas labels.
- Click a node to open the backing note.
- Local-only rendering. Brain Atlas does not send vault data to a server.

## Install

Brain Atlas is not in the official Obsidian community plugin directory yet. Use BRAT or manual installation.

### Option 1: Install with BRAT

1. Install the BRAT plugin from Obsidian's community plugins.
2. Open the command palette and run `BRAT: Add a beta plugin for testing`.
3. Enter:

   ```text
   https://github.com/colorpulse6/brain-atlas
   ```

4. Enable `Brain Atlas` in `Settings -> Community plugins`.
5. Open the command palette and run `Brain Atlas: Open atlas`.

### Option 2: Manual Install

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

### Option 3: Build from Source

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

- Drag to rotate.
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
5. Fallback to `concept`.

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

Brain Atlas reads Obsidian's local vault metadata and renders it in a local canvas view. It does not make network requests, upload vault contents, or require an account.

Because note names and paths appear visually in the graph when labels are enabled, use the `Labels` toggle before screensharing if your vault contains private note titles.

## Development

```bash
npm install
npm test
npm run build
```

During development, you can copy `manifest.json`, `main.js`, and `styles.css` into a vault plugin folder after each build.

## License

MIT
