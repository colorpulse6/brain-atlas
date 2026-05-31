export function note(path, cache = {}) {
  return {
    file: { path, basename: path.split("/").pop().replace(/\.md$/i, "") },
    cache
  };
}

export function folderHeavyCreatorVault() {
  return [
    note("Channels/Youtube/Brain Atlas Review.md", { links: [{ link: "Knowledge Graphs" }] }),
    note("Channels/Newsletter/PKM Weekly.md", { links: [{ link: "Knowledge Graphs" }] }),
    note("Wiki/Knowledge Graphs.md", { links: [{ link: "Graph Databases" }] }),
    note("Wiki/Graph Databases.md", {}),
    note("People/Guest Researcher.md", {}),
    note("Inbox/Loose Capture.md", {})
  ];
}

export function frontmatterHeavyWikiVault() {
  return [
    note("Articles/Zettelkasten.md", { frontmatter: { type: "wiki" }, links: [{ link: "Ada" }] }),
    note("Articles/Evergreen Notes.md", { frontmatter: { type: "wiki" } }),
    note("Entities/Ada.md", { frontmatter: { type: "person" } }),
    note("Meetings/Creator Sync.md", { frontmatter: { class: "meeting" } })
  ];
}
