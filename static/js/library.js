// Sidebar: artist -> songs tree with a filter box.

const norm = (s) => s.normalize("NFKC").toLocaleLowerCase();

export class LibraryTree {
  /**
   * @param {HTMLElement} container element that receives the tree
   * @param {HTMLInputElement} filterInput
   * @param {(artistSlug: string, titleSlug: string) => void} onSelect
   */
  constructor(container, filterInput, onSelect) {
    this.container = container;
    this.filterInput = filterInput;
    this.onSelect = onSelect;
    this.tree = [];
    this.expanded = new Set(); // artist slugs opened by the user
    this.current = null; // "artist/title"
    filterInput.addEventListener("input", () => this.render());
    container.addEventListener("click", (e) => this.#onClick(e));
  }

  setTree(tree) {
    this.tree = tree;
    this.render();
  }

  setCurrent(artistSlug, titleSlug) {
    this.current = `${artistSlug}/${titleSlug}`;
    this.expanded.add(artistSlug);
    this.render();
  }

  render() {
    const q = norm(this.filterInput.value.trim());
    this.container.replaceChildren();
    if (!this.tree.length) {
      this.container.append(el("p", "tree-empty", "歌曲庫是空的，從上方輸入歌名建立第一首歌。"));
      return;
    }
    let shown = 0;
    for (const artist of this.tree) {
      const artistMatch = !q || norm(artist.artist).includes(q);
      const songs = artistMatch ? artist.songs : artist.songs.filter((s) => norm(s.title).includes(q));
      if (!songs.length) continue;
      shown++;
      const open = q ? true : this.expanded.has(artist.artist_slug);

      const group = el("div", "tree-artist");
      const head = el("div", "tree-artist-name", "");
      head.dataset.artist = artist.artist_slug;
      head.setAttribute("role", "button");
      head.tabIndex = -1;
      head.append(el("span", "tree-caret", open ? "▾" : "▸"), el("span", "", artist.artist));
      head.append(el("span", "tree-count", String(artist.songs.length)));
      group.append(head);

      if (open) {
        const list = el("div", "tree-songs");
        for (const song of songs) {
          const key = `${artist.artist_slug}/${song.title_slug}`;
          const item = el("div", "tree-song" + (key === this.current ? " active" : ""), song.title);
          item.setAttribute("role", "button");
          item.tabIndex = -1;
          item.dataset.artist = artist.artist_slug;
          item.dataset.title = song.title_slug;
          if (!song.synced) item.append(el("span", "tag", "未同步"));
          list.append(item);
        }
        group.append(list);
      }
      this.container.append(group);
    }
    if (!shown) this.container.append(el("p", "tree-empty", "沒有符合的歌曲"));
  }

  #onClick(e) {
    const song = e.target.closest(".tree-song");
    if (song) {
      this.onSelect(song.dataset.artist, song.dataset.title);
      return;
    }
    const head = e.target.closest(".tree-artist-name");
    if (head && !this.filterInput.value.trim()) {
      const slug = head.dataset.artist;
      if (this.expanded.has(slug)) this.expanded.delete(slug);
      else this.expanded.add(slug);
      this.render();
    }
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
